import { invoke } from '@tauri-apps/api/core';
import type { ThreadArchive } from '@threads-archiver/core';

export interface EngineInfo {
  status: 'starting' | 'ready' | 'error';
  port?: number;
  token?: string;
  message: string;
}

export interface Job {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  message: string;
  result?: {
    archive: ThreadArchive;
    outputDir: string;
    manifestPath: string;
    markdownPath?: string;
    files: Array<{ kind: string; path: string; bytes: number }>;
  };
  error?: { code: string; message: string; hint?: string };
  /** 같은 게시물을 이미 저장한 폴더에 다시 저장했는지 */
  alreadySaved?: boolean;
}

export interface AppSettings {
  clipboardWatch: boolean;
  autostart: boolean;
}

export class EngineError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    if (hint) this.hint = hint;
  }
}

export async function waitForEngine(timeoutMs = 60_000): Promise<EngineInfo> {
  const started = Date.now();

  for (;;) {
    const info = await invoke<EngineInfo>('engine_info');
    if (info.status === 'ready') return info;
    if (info.status === 'error') throw new EngineError('ENGINE_UNAVAILABLE', info.message);
    if (Date.now() - started > timeoutMs) {
      throw new EngineError('ENGINE_TIMEOUT', '엔진이 제한 시간 안에 시작되지 않았습니다.', info.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

export class EngineClient {
  private readonly base: string;
  private readonly token: string;

  constructor(info: EngineInfo) {
    if (!info.port || !info.token) {
      throw new EngineError('ENGINE_UNAVAILABLE', '엔진 주소를 알 수 없습니다.');
    }
    this.base = `http://127.0.0.1:${info.port}`;
    this.token = info.token;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-engine-token': this.token,
        ...(init?.headers ?? {}),
      },
    });

    const payload = (await response.json().catch(() => null)) as
      | { error?: { code: string; message: string; hint?: string } }
      | null;

    if (!response.ok) {
      const error = payload?.error;
      throw new EngineError(
        error?.code ?? 'ENGINE_ERROR',
        error?.message ?? `엔진 오류 (HTTP ${response.status})`,
        error?.hint,
      );
    }

    return payload as T;
  }

  config(): Promise<{ defaultOutputDir: string }> {
    return this.request('/api/config');
  }

  extract(url: string): Promise<{ archive: ThreadArchive; folderName: string; suggestedDir: string }> {
    return this.request('/api/extract', { method: 'POST', body: JSON.stringify({ url }) });
  }

  /** baseDir 아래에 게시물별 하위 폴더를 만들어 저장한다. */
  startArchive(url: string, baseDir: string): Promise<{ jobId: string }> {
    return this.request('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ url, baseDir: baseDir.trim() || undefined }),
    });
  }

  async job(id: string): Promise<Job> {
    const { job } = await this.request<{ job: Job }>(`/api/jobs/${id}`);
    return job;
  }

  cancel(id: string): Promise<unknown> {
    return this.request(`/api/jobs/${id}/cancel`, { method: 'POST' });
  }
}
