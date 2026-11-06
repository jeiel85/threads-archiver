import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ThreadsSession, waitForLogin } from './extract/session.js';
import { saveArchive, defaultBaseDir, defaultFolderName, resolveArchiveDir } from './download.js';
import { finishedIds, loadHistory, postSummary, savedSummary, saveHistory, trimHistory, type EngineJob } from './history.js';
import { defaultProfileDir } from './paths.js';
import { mediaContentType, parseByteRange, readSavedArchive, savedMediaPath } from './saved.js';
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
const LOGIN_FILE = path.join(path.dirname(PROFILE_DIR), 'login.json');
/** 로그인 창을 닫지 않고 둬도 다운로드가 영영 막히지 않게 하는 상한 */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** 로그인 쿠키가 생긴 뒤 Threads가 첫 화면으로 넘어갈 시간을 주고 창을 닫는다. */
const LOGIN_SETTLE_MS = 1500;

/**
 * 로그인 상태. state는 로그인 창의 진행(대기열에서 기다림 → 창 열림 → 끝),
 * loggedIn은 마지막으로 확인한 세션 쿠키 유무(확인한 적 없으면 null). 앱을 다시 켜도 알 수 있게 파일에 남긴다.
 */
const loginStatus: {
  state: 'idle' | 'waiting' | 'open';
  loggedIn: boolean | null;
  checkedAt?: number;
  /** 마지막 로그인 시도가 실패했을 때의 이유. 다시 시도하면 지운다. */
  error?: string;
} = {
  state: 'idle',
  loggedIn: null,
};

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

async function loadLoginStatus(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(LOGIN_FILE, 'utf8')) as { loggedIn?: unknown; checkedAt?: unknown };
    if (typeof saved.loggedIn === 'boolean') loginStatus.loggedIn = saved.loggedIn;
    if (typeof saved.checkedAt === 'number') loginStatus.checkedAt = saved.checkedAt;
  } catch {
    // 아직 확인한 적 없음
  }
}

function setLoggedIn(loggedIn: boolean): void {
  if (loginStatus.loggedIn === loggedIn) return;
  loginStatus.loggedIn = loggedIn;
  loginStatus.checkedAt = Date.now();
  void writeFile(LOGIN_FILE, JSON.stringify({ loggedIn, checkedAt: loginStatus.checkedAt }), 'utf8').catch(() => undefined);
}

/** 길이가 다르면 바로 거절하고, 같으면 상수 시간으로 비교한다. */
function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 작업 하나의 저장된 미디어만 읽을 수 있는 키. <img>·<video>는 헤더를 붙일 수 없어 쿼리로 넘기는데,
 * 엔진 토큰 대신 이 키를 실어 URL이 로그·개발자 도구에 남아도 그 작업의 미디어 읽기 말고는 할 수 없게 한다.
 * 엔진 토큰에서 파생하므로 엔진을 다시 켜면(토큰이 바뀌면) 함께 무효가 된다.
 */
function mediaKey(jobId: string): string {
  return createHmac('sha256', TOKEN).update(`media:${jobId}`).digest('hex');
}

/** 잘못된 퍼센트 인코딩(`%E0%A4%A`)이면 undefined. */
function decodePathPart(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
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
    let archive: ThreadArchive;
    try {
      archive = await target.extract(job.url);
    } finally {
      // 받을 때마다 로그인이 살아 있는지 함께 확인한다 (세션 만료·로그아웃 반영).
      await target.loginCookie().then((cookie) => setLoggedIn(Boolean(cookie)), () => undefined);
    }
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
 * Threads 로그인 창을 띄운다. 요청은 바로 돌려주고, 진행은 loginStatus로 알린다.
 * 새 세션 쿠키가 생기면 로그인된 것으로 보고 창을 스스로 닫는다. 그 전에 사용자가 창을 닫으면
 * 그때까지 확인한 쿠키로 판단한다(이미 로그인돼 있던 경우 포함).
 * 같은 프로필 폴더를 두 브라우저가 동시에 쓸 수 없으므로 다운로드 대기열에 끼워 차례로 실행하고,
 * 그동안 백그라운드 세션은 닫았다가 다음 작업에서 로그인된 프로필로 다시 연다.
 */
function startLogin(): void {
  if (loginStatus.state !== 'idle') return;
  loginStatus.state = 'waiting';
  delete loginStatus.error;
  void serialize(async () => {
    loginStatus.state = 'open';
    await session?.close();
    session = null;

    const loginSession = new ThreadsSession({ profileDir: PROFILE_DIR, headed: true });
    try {
      const page = await loginSession.openPage(LOGIN_URL);
      const loggedIn = await waitForLogin(page.context(), LOGIN_TIMEOUT_MS);
      setLoggedIn(loggedIn);
      if (loggedIn) await page.waitForTimeout(LOGIN_SETTLE_MS).catch(() => undefined);
    } finally {
      await loginSession.close();
    }
  })
    .catch((error) => {
      // 요청은 이미 돌려줬으므로 실패는 상태에 남겨 설정 화면에서 보여 준다.
      loginStatus.error = `로그인 창을 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    })
    .finally(() => {
      loginStatus.state = 'idle';
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

  // <img>·<video>는 헤더를 붙일 수 없으므로 저장된 미디어 파일만 쿼리로 그 작업 전용 키(mediaKey)를 받는다.
  const mediaMatch = /^\/api\/jobs\/([a-f0-9]+)\/media\/([^/]+)$/.exec(url.pathname);
  const authorized =
    sameSecret(request.headers['x-engine-token'], TOKEN) ||
    (mediaMatch !== null && sameSecret(url.searchParams.get('key'), mediaKey(mediaMatch[1]!)));
  if (!authorized) {
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

  if (url.pathname === '/api/login' && request.method === 'GET') {
    sendJson(response, 200, loginStatus);
    return;
  }

  if (url.pathname === '/api/login' && request.method === 'POST') {
    startLogin();
    sendJson(response, 202, loginStatus);
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

  // 내역 비우기: 끝난 작업만 지운다. 받는 중·대기 중인 작업은 남긴다. 저장된 파일은 건드리지 않는다.
  if (url.pathname === '/api/jobs/clear' && request.method === 'POST') {
    const removed = finishedIds(jobs.values());
    for (const id of removed) {
      jobs.delete(id);
      attempts.delete(id);
    }
    persistHistory();
    sendJson(response, 200, { removed: removed.length });
    return;
  }

  if (mediaMatch && request.method === 'GET') {
    const fileName = decodePathPart(mediaMatch[2]!);
    if (fileName === undefined) {
      sendJson(response, 400, { error: { code: 'BAD_REQUEST', message: '파일 이름을 해석하지 못했습니다.' } });
      return;
    }
    await sendSavedMedia(request, response, jobs.get(mediaMatch[1]!), fileName);
    return;
  }

  const jobMatch = /^\/api\/jobs\/([a-f0-9]+)(\/cancel|\/retry|\/delete|\/archive)?$/.exec(url.pathname);
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
    // 내역 미리보기: 저장한 폴더의 post.json을 다시 읽는다. 미디어는 /media/<파일 이름>으로 받는다.
    if (jobMatch[2] === '/archive' && request.method === 'GET') {
      if (job.status !== 'done' || !job.saved) {
        sendJson(response, 409, { error: { code: 'NOT_SAVED', message: '저장을 마친 항목만 미리 볼 수 있습니다.' } });
        return;
      }
      const archive = await readSavedArchive(job.saved.outputDir);
      sendJson(response, 200, { archive, outputDir: job.saved.outputDir, mediaKey: mediaKey(job.id) });
      return;
    }
    if (jobMatch[2] === '/delete' && request.method === 'POST') {
      if (!isFinished(job)) {
        sendJson(response, 409, { error: { code: 'JOB_ACTIVE', message: '받는 중인 항목은 취소한 뒤 지울 수 있습니다.' } });
        return;
      }
      jobs.delete(job.id);
      attempts.delete(job.id);
      persistHistory();
      sendJson(response, 200, { removed: 1 });
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

/** 저장을 마친 작업 폴더의 미디어 파일 하나를 보낸다. Range 요청을 받아 영상도 앞부분만 읽을 수 있다. */
async function sendSavedMedia(
  request: IncomingMessage,
  response: ServerResponse,
  job: Job | undefined,
  fileName: string,
): Promise<void> {
  const file = job?.status === 'done' && job.saved ? savedMediaPath(job.saved.outputDir, fileName) : undefined;
  const info = file ? await stat(file).catch(() => undefined) : undefined;
  if (!file || !info?.isFile()) {
    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '저장된 파일을 찾지 못했습니다.' } });
    return;
  }

  const headers = {
    'content-type': mediaContentType(fileName),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  const range = parseByteRange(request.headers.range, info.size);
  if (range === 'invalid') {
    response.writeHead(416, { ...headers, 'content-range': `bytes */${info.size}` });
    response.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: info.size - 1 };
  response.writeHead(range ? 206 : 200, {
    ...headers,
    'content-length': String(Math.max(0, end - start + 1)),
    ...(range ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}),
  });
  if (info.size === 0) {
    response.end();
    return;
  }
  // pipeline은 응답이 중간에 닫히면(미리보기 전환·영상 메타데이터만 읽고 중단) 파일 스트림도 닫는다.
  pipeline(createReadStream(file, { start, end }), response, () => undefined);
}

/** 통합 테스트가 포트를 알아내고 닫을 수 있게 내보낸다. */
export const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    try {
      sendError(response, error instanceof ArchiveError ? 400 : 500, error);
    } catch {
      response.destroy();
    }
  });
});

for (const job of await loadHistory(HISTORY_FILE)) jobs.set(job.id, job);
await loadLoginStatus();

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
