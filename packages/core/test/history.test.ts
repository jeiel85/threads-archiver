import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishedIds, loadHistory, saveHistory, trimHistory, type EngineJob } from '../src/history.js';

function job(id: string, createdAt: number, status: EngineJob['status'] = 'done'): EngineJob {
  return { id, url: `https://www.threads.com/@a/post/${id}`, status, progress: 1, message: '', createdAt };
}

describe('다운로드 내역', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'history-'));
    file = path.join(dir, 'sub', 'history.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('최근 작업이 앞에 오고, 한도를 넘는 오래된 끝난 작업만 잘라 낸다', () => {
    const jobs = [job('a', 1), job('b', 2), job('c', 3, 'running'), job('d', 0, 'queued')];
    expect(trimHistory(jobs, 1).map((item) => item.id)).toEqual(['c', 'b', 'd']);
  });

  it('진행 정보와 전체 결과는 빼고 저장한 뒤 다시 읽는다', async () => {
    const saved: EngineJob = {
      ...job('a', 1),
      transfer: { fileIndex: 1, fileCount: 1, received: 1 },
      saved: { outputDir: 'D:\\out', manifestPath: 'D:\\out\\post.json', mediaCount: 2 },
      result: { outputDir: 'D:\\out' } as EngineJob['result'],
    };
    await saveHistory(file, [saved]);

    const raw = JSON.parse(await readFile(file, 'utf8')) as EngineJob[];
    expect(raw[0]).not.toHaveProperty('transfer');
    expect(raw[0]).not.toHaveProperty('result');
    expect(await loadHistory(file)).toEqual([{ ...job('a', 1), saved: saved.saved }]);
  });

  it('앱이 꺼질 때 대기·진행 중이던 작업은 중단됨으로 바꿔 다시 받을 수 있게 한다', async () => {
    await saveHistory(file, [job('a', 5, 'running'), job('b', 4, 'queued')]);
    const loaded = await loadHistory(file);
    expect(loaded.map((item) => [item.status, item.error?.code])).toEqual([
      ['error', 'INTERRUPTED'],
      ['error', 'INTERRUPTED'],
    ]);
  });

  it('내역 비우기는 끝난 작업만 고르고 받는 중·대기 중인 작업은 남긴다', () => {
    const jobs = [job('a', 1), job('b', 2, 'running'), job('c', 3, 'error'), job('d', 4, 'queued'), job('e', 5, 'cancelled')];
    expect(finishedIds(jobs)).toEqual(['a', 'c', 'e']);
  });

  it('내역 파일이 없거나 깨졌으면 빈 내역으로 시작한다', async () => {
    expect(await loadHistory(file)).toEqual([]);
    await writeFile(path.join(dir, 'broken.json'), '{not json');
    expect(await loadHistory(path.join(dir, 'broken.json'))).toEqual([]);
    await writeFile(path.join(dir, 'odd.json'), JSON.stringify([{ id: 1 }, job('ok', 1)]));
    expect((await loadHistory(path.join(dir, 'odd.json'))).map((item) => item.id)).toEqual(['ok']);
  });
});
