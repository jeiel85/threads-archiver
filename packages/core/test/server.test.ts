import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 엔진 HTTP 라우트 통합 테스트. 실제 server.ts를 띄우고(127.0.0.1, 임의 포트) 저장을 마친 내역을 미리 넣어 둔다.
 * 브라우저(Playwright)는 다운로드·로그인 라우트에서만 열리므로 여기서는 열리지 않는다.
 */

const TOKEN = 'a'.repeat(48);
const DONE = 'aa00000000000001';
const OTHER_DONE = 'aa00000000000002';
const FAILED = 'bb00000000000001';
const IMAGE = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const BIG = 4 * 1024 * 1024;

let root: string;
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'threads-archiver-server-'));
  const outputDir = path.join(root, 'saved', 'post');
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, 'post.json'),
    JSON.stringify({ owner: 'someone', sourceUrl: 'https://www.threads.com/@someone/post/x', posts: [] }),
  );
  await writeFile(path.join(outputDir, '01.jpg'), IMAGE);
  await writeFile(path.join(outputDir, '02.mp4'), Buffer.alloc(BIG, 1));
  await writeFile(path.join(outputDir, 'secret.txt'), 'not media');

  const saved = { outputDir, manifestPath: path.join(outputDir, 'post.json'), mediaCount: 2 };
  const job = (id: string, extra: object) => ({ id, url: 'https://www.threads.com/@someone/post/x', progress: 1, message: '', createdAt: 1, ...extra });
  await writeFile(
    path.join(root, 'history.json'),
    JSON.stringify([
      job(DONE, { status: 'done', saved, finishedAt: 2 }),
      job(OTHER_DONE, { status: 'done', saved, finishedAt: 2 }),
      job(FAILED, { status: 'error', message: '실패', finishedAt: 2 }),
    ]),
  );

  process.env.THREADS_ARCHIVER_TOKEN = TOKEN;
  process.env.THREADS_ARCHIVER_PORT = '0';
  process.env.THREADS_ARCHIVER_PROFILE = path.join(root, 'profile');
  process.env.THREADS_ARCHIVER_HISTORY = path.join(root, 'history.json');

  const { server } = await import('../src/server.js');
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close?.();
  await rm(root, { recursive: true, force: true });
});

const auth = { 'x-engine-token': TOKEN };

async function mediaKey(id: string): Promise<string> {
  const response = await fetch(`${base}/api/jobs/${id}/archive`, { headers: auth });
  expect(response.status).toBe(200);
  return ((await response.json()) as { mediaKey: string }).mediaKey;
}

describe('엔진 토큰', () => {
  it('토큰이 없거나 틀리면 401', async () => {
    expect((await fetch(`${base}/api/jobs`)).status).toBe(401);
    expect((await fetch(`${base}/api/jobs`, { headers: { 'x-engine-token': 'wrong' } })).status).toBe(401);
    // 길이가 같아도 값이 다르면 거절
    expect((await fetch(`${base}/api/jobs`, { headers: { 'x-engine-token': 'b'.repeat(48) } })).status).toBe(401);
    expect((await fetch(`${base}/api/jobs`, { headers: auth })).status).toBe(200);
  });

  it('쿼리 인증은 media 라우트에서만, 그 작업 전용 키로만 통한다', async () => {
    const key = await mediaKey(DONE);
    // 엔진 토큰을 쿼리로 보내는 옛 방식은 어디서도 통하지 않는다.
    expect((await fetch(`${base}/api/jobs/${DONE}/media/01.jpg?token=${TOKEN}`)).status).toBe(401);
    expect((await fetch(`${base}/api/jobs?token=${TOKEN}`)).status).toBe(401);
    // 미디어 키는 다른 라우트·다른 작업에 쓸 수 없다.
    expect((await fetch(`${base}/api/jobs/${DONE}/archive?key=${key}`)).status).toBe(401);
    expect((await fetch(`${base}/api/jobs?key=${key}`)).status).toBe(401);
    expect((await fetch(`${base}/api/jobs/${OTHER_DONE}/media/01.jpg?key=${key}`)).status).toBe(401);
    expect((await fetch(`${base}/api/jobs/${DONE}/media/01.jpg?key=${'0'.repeat(64)}`)).status).toBe(401);
    expect((await fetch(`${base}/api/jobs/${DONE}/media/01.jpg?key=${key}`)).status).toBe(200);
  });
});

describe('/api/jobs/:id/archive', () => {
  it('저장을 마친 작업은 post.json과 미디어 키를 돌려준다', async () => {
    const response = await fetch(`${base}/api/jobs/${DONE}/archive`, { headers: auth });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { archive: { owner: string }; outputDir: string; mediaKey: string };
    expect(body.archive.owner).toBe('someone');
    expect(body.outputDir).toContain('post');
    expect(body.mediaKey).toMatch(/^[a-f0-9]{64}$/);
    expect(body.mediaKey).not.toBe(await mediaKey(OTHER_DONE));
  });

  it('저장하지 못한 작업은 409, 없는 작업은 404', async () => {
    const failed = await fetch(`${base}/api/jobs/${FAILED}/archive`, { headers: auth });
    expect(failed.status).toBe(409);
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe('NOT_SAVED');
    expect((await fetch(`${base}/api/jobs/cc00000000000001/archive`, { headers: auth })).status).toBe(404);
  });
});

describe('/api/jobs/:id/media/<파일>', () => {
  it('전체 파일을 200으로 보낸다', async () => {
    const response = await fetch(`${base}/api/jobs/${DONE}/media/01.jpg?key=${await mediaKey(DONE)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await response.arrayBuffer()).equals(IMAGE)).toBe(true);
  });

  it('엔진 토큰 헤더로도 받을 수 있다', async () => {
    expect((await fetch(`${base}/api/jobs/${DONE}/media/01.jpg`, { headers: auth })).status).toBe(200);
  });

  it('Range 요청은 206과 그 구간만', async () => {
    const response = await fetch(`${base}/api/jobs/${DONE}/media/01.jpg`, { headers: { ...auth, range: 'bytes=10-19' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 10-19/${IMAGE.length}`);
    expect(response.headers.get('content-length')).toBe('10');
    expect(Buffer.from(await response.arrayBuffer()).equals(IMAGE.subarray(10, 20))).toBe(true);
  });

  it('범위를 벗어나면 416', async () => {
    const response = await fetch(`${base}/api/jobs/${DONE}/media/01.jpg`, { headers: { ...auth, range: 'bytes=5000-' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${IMAGE.length}`);
  });

  it('저장 형식이 아닌 파일 이름·경로 이동·없는 파일·저장 안 한 작업은 404', async () => {
    const key = await mediaKey(DONE);
    for (const name of ['secret.txt', 'post.json', '..%2Fpost%2Fpost.json', '..%5C..%5Chistory.json', '03.jpg']) {
      expect((await fetch(`${base}/api/jobs/${DONE}/media/${name}?key=${key}`)).status, name).toBe(404);
    }
    expect((await fetch(`${base}/api/jobs/${FAILED}/media/01.jpg`, { headers: auth })).status).toBe(404);
  });

  it('잘못된 퍼센트 인코딩은 500이 아니라 400', async () => {
    const response = await fetch(`${base}/api/jobs/${DONE}/media/%E0%A4%A.jpg`, { headers: auth });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('받는 도중 끊어도 엔진은 계속 응답한다', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${base}/api/jobs/${DONE}/media/02.mp4`, { headers: auth }, (response) => {
        expect(response.statusCode).toBe(200);
        response.once('data', () => {
          request.destroy();
          resolve();
        });
      });
      request.on('error', (error) => (request.destroyed ? undefined : reject(error)));
      request.end();
    });
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/jobs/${DONE}/media/01.jpg`, { headers: auth })).status).toBe(200);
  });
});
