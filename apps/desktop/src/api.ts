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
  /** 목록에서 받은 작업에만 있다 (작업을 막 만들었을 때의 임시 값에는 없음) */
  url?: string;
  createdAt?: number;
  finishedAt?: number;
  /** 게시물을 읽은 뒤 채워지는 작성자·본문 요약 */
  post?: { owner: string; text: string };
  /** 저장을 마친 뒤 채워지는 저장 위치 요약 (앱을 다시 켜도 남는다) */
  saved?: { outputDir: string; manifestPath: string; mediaCount: number };
  progress: number;
  message: string;
  /** 미디어를 받는 중일 때: 몇 번째 파일인지, 받은/전체 바이트 */
  transfer?: { fileIndex: number; fileCount: number; received: number; total?: number };
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
  /** 이미 다 저장된 게시물이라 받지 않고 그 폴더로 끝냈는지 */
  skipped?: boolean;
}

/** `62%` */
export function percentText(job: Job): string {
  return `${Math.round((job.progress ?? 0) * 100)}%`;
}

/** 받는 중인 파일의 용량: `18.4 / 29.7MB` (전체 크기를 모르면 `18.4MB`). 받는 중이 아니면 빈 문자열. */
export function transferText(job: Job): string {
  const transfer = job.transfer;
  if (!transfer) return '';
  const received = toMegabytes(transfer.received);
  return transfer.total ? `${received} / ${toMegabytes(transfer.total)}MB` : `${received}MB`;
}

function toMegabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export function isActive(job: Job): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/** 트레이 툴팁에 다운로드 진행을 알린다. `null`이면 끝남. `waiting`은 뒤에 대기 중인 건수. */
export function reportDownloadStatus(job: Job | null, waiting = 0): void {
  const status = job
    ? ['다운로드 중', percentText(job), transferText(job), waiting ? `(대기 ${waiting}건)` : ''].filter(Boolean).join(' ')
    : null;
  void invoke('set_download_status', { status }).catch(() => undefined);
}

export interface AppSettings {
  clipboardWatch: boolean;
  autoDownload: boolean;
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

  /** 이번 실행의 작업과 지난 내역 (최근 순) */
  async jobs(): Promise<Job[]> {
    const { jobs } = await this.request<{ jobs: Job[] }>('/api/jobs');
    return jobs;
  }

  /** 저장을 마친 작업의 post.json을 다시 읽는다 (내역 미리보기). */
  savedArchive(id: string): Promise<{ archive: ThreadArchive; outputDir: string }> {
    return this.request(`/api/jobs/${id}/archive`);
  }

  /** 저장된 미디어 파일 주소. <img>·<video>가 헤더를 못 붙이므로 토큰을 쿼리로 넘긴다. */
  savedMediaUrl(id: string, fileName: string): string {
    return `${this.base}/api/jobs/${id}/media/${encodeURIComponent(fileName)}?token=${encodeURIComponent(this.token)}`;
  }

  cancel(id: string): Promise<unknown> {
    return this.request(`/api/jobs/${id}/cancel`, { method: 'POST' });
  }

  /** 끝난 작업을 같은 항목으로 다시 받는다. */
  async retry(id: string): Promise<Job> {
    const { job } = await this.request<{ job: Job }>(`/api/jobs/${id}/retry`, { method: 'POST' });
    return job;
  }

  /** 끝난 작업 하나를 내역에서 지운다. 저장된 파일은 그대로 둔다. */
  deleteJob(id: string): Promise<{ removed: number }> {
    return this.request(`/api/jobs/${id}/delete`, { method: 'POST' });
  }

  /** 끝난 작업을 모두 내역에서 지운다. 받는 중인 작업과 저장된 파일은 그대로 둔다. */
  clearHistory(): Promise<{ removed: number }> {
    return this.request('/api/jobs/clear', { method: 'POST' });
  }

  /** Threads 로그인 창을 띄운다. 바로 돌아오고, 진행은 loginStatus()로 확인한다. */
  login(): Promise<LoginStatus> {
    return this.request('/api/login', { method: 'POST' });
  }

  loginStatus(): Promise<LoginStatus> {
    return this.request('/api/login');
  }
}

/** state: 로그인 창 진행(대기열에서 기다림 → 열림 → 끝), loggedIn: 마지막으로 확인한 로그인 여부(모르면 null) */
export interface LoginStatus {
  state: 'idle' | 'waiting' | 'open';
  loggedIn: boolean | null;
  checkedAt?: number;
  /** 마지막 로그인 시도가 실패한 이유 */
  error?: string;
}
