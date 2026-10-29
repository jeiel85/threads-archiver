import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { ThreadsSession } from './extract/session.js';
import { saveArchive, defaultBaseDir, defaultFolderName, resolveArchiveDir } from './download.js';
import { defaultProfileDir } from './paths.js';
import { ArchiveError, type ArchiveResult, type DownloadProgress, type ThreadArchive } from './types.js';

/**
 * 데스크톱 앱이 사용하는 로컬 엔진.
 *
 * - 127.0.0.1 에만 바인딩한다.
 * - 임의 토큰(x-engine-token)을 요구해 다른 로컬 프로세스의 무단 호출을 막는다.
 * - 시작 시 stdout에 `ENGINE_READY {"port":...,"token":"..."}` 한 줄을 출력한다.
 */

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

interface Job {
  id: string;
  status: JobStatus;
  url: string;
  /** 상위 저장 폴더. 게시물별 하위 폴더는 엔진이 정한다. */
  baseDir?: string;
  progress: number;
  message: string;
  createdAt: number;
  finishedAt?: number;
  result?: ArchiveResult;
  error?: { code: string; message: string; hint?: string };
}

const TOKEN = process.env.THREADS_ARCHIVER_TOKEN ?? randomBytes(24).toString('hex');
const PORT = Number(process.env.THREADS_ARCHIVER_PORT ?? 0);
const PROFILE_DIR = process.env.THREADS_ARCHIVER_PROFILE ?? defaultProfileDir();

const jobs = new Map<string, Job>();
const abortControllers = new Map<string, AbortController>();
let queue: Promise<void> = Promise.resolve();
let session: ThreadsSession | null = null;

function getSession(): ThreadsSession {
  session ??= new ThreadsSession({ profileDir: PROFILE_DIR });
  return session;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-engine-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, error: unknown): void {
  if (error instanceof ArchiveError) {
    sendJson(response, status, { error: { code: error.code, message: error.message, hint: error.hint } });
    return;
  }
  sendJson(response, 500, {
    error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1_000_000) throw new ArchiveError('EXTRACTION_FAILED', '요청 본문이 너무 큽니다.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new ArchiveError('INVALID_URL', 'JSON 본문을 해석하지 못했습니다.');
  }
}

function enqueue(job: Job): void {
  job.status = 'queued';
  job.message = '대기 중…';
  queue = queue
    .then(() => runJob(job))
    .catch(() => undefined);
}

async function runJob(job: Job): Promise<void> {
  if (job.status === 'cancelled') return;

  job.status = 'running';
  job.message = 'Threads 페이지를 여는 중…';
  const controller = new AbortController();
  abortControllers.set(job.id, controller);

  const onProgress = (progress: DownloadProgress) => {
    job.progress = progress.ratio;
    job.message = progress.message;
  };

  try {
    const target = getSession();
    onProgress({ ratio: 0.05, message: 'Threads 페이지를 여는 중…' });
    const archive: ThreadArchive = await target.extract(job.url);
    onProgress({ ratio: 0.3, message: '게시물을 읽었습니다. 저장을 시작합니다…' });

    const outputDir = await resolveArchiveDir(job.baseDir ?? defaultBaseDir(), archive);

    const result = await saveArchive(target, archive, {
      outputDir,
      onProgress,
      signal: controller.signal,
    });

    job.result = result;
    job.status = 'done';
    job.progress = 1;
    job.message = `저장 완료: ${result.outputDir}`;
  } catch (error) {
    if (controller.signal.aborted) {
      job.status = 'cancelled';
      job.message = '취소되었습니다.';
    } else if (error instanceof ArchiveError) {
      job.status = 'error';
      job.error = { code: error.code, message: error.message, hint: error.hint };
      job.message = error.message;
    } else {
      job.status = 'error';
      job.error = { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
      job.message = job.error.message;
    }
  } finally {
    abortControllers.delete(job.id);
    job.finishedAt = Date.now();
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-engine-token',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    response.end();
    return;
  }

  if (url.pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, { ok: true, version: '0.2.0' });
    return;
  }

  const token = request.headers['x-engine-token'];
  if (token !== TOKEN) {
    sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: '엔진 토큰이 올바르지 않습니다.' } });
    return;
  }

  if (url.pathname === '/api/config' && request.method === 'GET') {
    sendJson(response, 200, { defaultOutputDir: defaultBaseDir(), profileDir: PROFILE_DIR });
    return;
  }

  if (url.pathname === '/api/extract' && request.method === 'POST') {
    const body = await readJson(request);
    const link = String(body.url ?? '');
    const target = getSession();
    const archive = await target.extract(link);
    const folderName = defaultFolderName(archive);
    sendJson(response, 200, {
      archive,
      folderName,
      suggestedDir: path.join(defaultBaseDir(), folderName),
    });
    return;
  }

  if (url.pathname === '/api/jobs' && request.method === 'POST') {
    const body = await readJson(request);
    const link = String(body.url ?? '').trim();
    if (!link) throw new ArchiveError('INVALID_URL', '다운로드할 링크가 없습니다.');

    const job: Job = {
      id: randomBytes(8).toString('hex'),
      status: 'queued',
      url: link,
      baseDir: typeof body.baseDir === 'string' && body.baseDir.trim() ? body.baseDir.trim() : undefined,
      progress: 0,
      message: '대기 중…',
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    enqueue(job);
    sendJson(response, 202, { jobId: job.id });
    return;
  }

  const jobMatch = /^\/api\/jobs\/([a-f0-9]+)(\/cancel)?$/.exec(url.pathname);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]!);
    if (!job) {
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '작업을 찾지 못했습니다.' } });
      return;
    }
    if (jobMatch[2] && request.method === 'POST') {
      abortControllers.get(job.id)?.abort();
      if (job.status === 'queued') {
        job.status = 'cancelled';
        job.message = '취소되었습니다.';
      }
      sendJson(response, 200, { job });
      return;
    }
    if (request.method === 'GET') {
      sendJson(response, 200, { job });
      return;
    }
  }

  sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '알 수 없는 경로입니다.' } });
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    try {
      sendError(response, error instanceof ArchiveError ? 400 : 500, error);
    } catch {
      response.destroy();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  process.stdout.write(`ENGINE_READY ${JSON.stringify({ port: actualPort, token: TOKEN })}\n`);
});

const shutdown = async () => {
  await session?.close();
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
