import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ThreadsSession } from './extract/session.js';
import { saveArchive, defaultBaseDir, defaultFolderName, resolveArchiveDir } from './download.js';
import { loadHistory, postSummary, savedSummary, saveHistory, trimHistory, type EngineJob } from './history.js';
import { defaultProfileDir } from './paths.js';
import { ArchiveError, type DownloadProgress, type ThreadArchive } from './types.js';

/**
 * 데스크톱 앱이 사용하는 로컬 엔진.
 *
 * - 127.0.0.1 에만 바인딩한다.
 * - 임의 토큰(x-engine-token)을 요구해 다른 로컬 프로세스의 무단 호출을 막는다.
 * - 시작 시 stdout에 `ENGINE_READY {"port":...,"token":"..."}` 한 줄을 출력한다.
 * - 작업은 한 번에 하나씩 순서대로 처리하고, 내역은 history.json에 남긴다.
 */

type Job = EngineJob;

const TOKEN = process.env.THREADS_ARCHIVER_TOKEN ?? randomBytes(24).toString('hex');
const PORT = Number(process.env.THREADS_ARCHIVER_PORT ?? 0);
const PROFILE_DIR = process.env.THREADS_ARCHIVER_PROFILE ?? defaultProfileDir();
const HISTORY_FILE = process.env.THREADS_ARCHIVER_HISTORY ?? path.join(path.dirname(PROFILE_DIR), 'history.json');
const LOGIN_URL = 'https://www.threads.com/login';
/** 로그인 창을 닫지 않고 둬도 다운로드가 영영 막히지 않게 하는 상한 */
const LOGIN_TIMEOUT_MS = 15 * 60_000;

const jobs = new Map<string, Job>();
const abortControllers = new Map<string, AbortController>();
/** 작업별 마지막 대기열 등록 번호. 대기 중 취소 후 다시 받으면 앞서 줄 선 실행은 건너뛴다. */
const attempts = new Map<string, number>();
let queue: Promise<void> = Promise.resolve();
let session: ThreadsSession | null = null;

let historyWrite: Promise<void> = Promise.resolve();

/** 쓰기가 겹치지 않도록 줄 세워 내역을 저장한다. 실패해도 다운로드는 계속한다. */
function persistHistory(): void {
  historyWrite = historyWrite
    .then(() => saveHistory(HISTORY_FILE, [...jobs.values()]))
    .catch((error) => {
      process.stderr.write(`내역을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}
`);
    });
}

/** 목록은 자주 읽으므로 큰 전체 결과(미디어 URL·파일 목록·미리보기)는 빼고 요약만 보낸다. 전체 결과는 단건 조회로 받는다. */
function listJobs(): Job[] {
  return trimHistory([...jobs.values()]).map(({ result: _result, ...job }) => job);
}

/** 브라우저 프로필을 쓰는 일을 다운로드 대기열에 끼워 하나씩 실행한다 (로그인 창과 동시에 열리면 프로필이 잠긴다). */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isFinished(job: Job): boolean {
  return job.status === 'done' || job.status === 'error' || job.status === 'cancelled';
}

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
  persistHistory();
  const attempt = (attempts.get(job.id) ?? 0) + 1;
  attempts.set(job.id, attempt);
  queue = queue
    .then(() => (attempts.get(job.id) === attempt ? runJob(job) : undefined))
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
    job.transfer = progress.transfer;
  };

  try {
    const target = getSession();
    onProgress({ ratio: 0.05, message: 'Threads 페이지를 여는 중…' });
    const archive: ThreadArchive = await target.extract(job.url);
    job.post = postSummary(archive);
    persistHistory();
    onProgress({ ratio: 0.3, message: '게시물을 읽었습니다. 저장을 시작합니다…' });

    const outputDir = await resolveArchiveDir(job.baseDir ?? defaultBaseDir(), archive);
    // resolveArchiveDir는 같은 게시물의 post.json이 있을 때만 기존 폴더를 돌려준다.
    job.alreadySaved = await stat(path.join(outputDir, 'post.json')).then(
      () => true,
      () => false,
    );

    const result = await saveArchive(target, archive, {
      outputDir,
      onProgress,
      signal: controller.signal,
    });

    job.result = result;
    job.saved = savedSummary(result);
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
    job.transfer = undefined;
    job.finishedAt = Date.now();
    persistHistory();
  }
}

/** 끝난 작업을 같은 항목으로 다시 받는다. 목록에서 맨 위로 올라온다. */
function retry(job: Job): void {
  job.progress = 0;
  job.createdAt = Date.now();
  delete job.finishedAt;
  delete job.result;
  delete job.error;
  delete job.alreadySaved;
  enqueue(job);
}

/**
 * Threads 로그인 창을 띄우고, 사용자가 창을 닫을 때까지 기다린다.
 * 같은 프로필 폴더를 두 브라우저가 동시에 쓸 수 없으므로 다운로드 대기열에 끼워 차례로 실행하고,
 * 그동안 백그라운드 세션은 닫았다가 다음 작업에서 로그인된 프로필로 다시 연다.
 */
function login(): Promise<void> {
  return serialize(async () => {
    await session?.close();
    session = null;

    const loginSession = new ThreadsSession({ profileDir: PROFILE_DIR, headed: true });
    try {
      const page = await loginSession.openPage(LOGIN_URL);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, LOGIN_TIMEOUT_MS);
        page.context().once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      await loginSession.close();
    }
  });
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
    sendJson(response, 200, { ok: true, version: '0.4.0' });
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
    const archive = await serialize(() => getSession().extract(link));
    const folderName = defaultFolderName(archive);
    sendJson(response, 200, {
      archive,
      folderName,
      suggestedDir: path.join(defaultBaseDir(), folderName),
    });
    return;
  }

  if (url.pathname === '/api/jobs' && request.method === 'GET') {
    sendJson(response, 200, { jobs: listJobs() });
    return;
  }

  if (url.pathname === '/api/login' && request.method === 'POST') {
    await login();
    sendJson(response, 200, { ok: true });
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

  const jobMatch = /^\/api\/jobs\/([a-f0-9]+)(\/cancel|\/retry)?$/.exec(url.pathname);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]!);
    if (!job) {
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '작업을 찾지 못했습니다.' } });
      return;
    }
    if (jobMatch[2] === '/retry' && request.method === 'POST') {
      if (!isFinished(job)) {
        sendJson(response, 409, { error: { code: 'JOB_ACTIVE', message: '아직 진행 중인 작업입니다.' } });
        return;
      }
      retry(job);
      sendJson(response, 200, { job });
      return;
    }
    if (jobMatch[2] === '/cancel' && request.method === 'POST') {
      abortControllers.get(job.id)?.abort();
      if (job.status === 'queued') {
        job.status = 'cancelled';
        job.message = '취소되었습니다.';
        job.finishedAt = Date.now();
        persistHistory();
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

for (const job of await loadHistory(HISTORY_FILE)) jobs.set(job.id, job);

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
