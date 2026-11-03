import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveResult, ThreadArchive, TransferProgress } from './types.js';

/**
 * 엔진 작업과 다운로드 내역.
 *
 * 작업은 메모리에서 진행하고, 앱을 다시 켜도 내역을 볼 수 있게 요약만 history.json에 남긴다.
 * (미디어 URL·파일 목록이 든 전체 결과는 크고 만료되므로 저장하지 않는다.)
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface EngineJob {
  id: string;
  status: JobStatus;
  url: string;
  /** 상위 저장 폴더. 게시물별 하위 폴더는 엔진이 정한다. */
  baseDir?: string;
  progress: number;
  message: string;
  /** 미디어를 받는 중일 때만 있음 */
  transfer?: TransferProgress;
  createdAt: number;
  finishedAt?: number;
  /** 게시물을 읽은 뒤 채워지는 작성자·본문 요약 (목록 표시용) */
  post?: { owner: string; text: string };
  /** 저장을 마친 뒤 채워지는 저장 위치 요약 (목록 표시용, 내역에도 남는다) */
  saved?: { outputDir: string; manifestPath: string; mediaCount: number };
  /** 이번 실행에서 받은 작업만 있는 전체 결과 */
  result?: ArchiveResult;
  /** 같은 게시물을 이미 저장한 폴더가 있어 그 폴더에 다시 저장했는지 */
  alreadySaved?: boolean;
  error?: { code: string; message: string; hint?: string };
}

export const HISTORY_LIMIT = 200;

const POST_TEXT_LIMIT = 80;

export function postSummary(archive: ThreadArchive): { owner: string; text: string } {
  const text = (archive.posts[0]?.text ?? '').replace(/\s+/g, ' ').trim();
  return {
    owner: archive.owner,
    text: text.length > POST_TEXT_LIMIT ? `${text.slice(0, POST_TEXT_LIMIT)}…` : text,
  };
}

export function savedSummary(result: ArchiveResult): NonNullable<EngineJob['saved']> {
  return {
    outputDir: result.outputDir,
    manifestPath: result.manifestPath,
    mediaCount: result.files.filter((file) => file.kind !== 'metadata').length,
  };
}

/** 내역 파일에 남길 형태. 진행 중 정보와 전체 결과는 뺀다. */
export function toRecord(job: EngineJob): EngineJob {
  const { transfer: _transfer, result: _result, ...record } = job;
  return record;
}

/** 최근 작업이 앞에 오도록 정렬하고, 오래된 끝난 작업부터 잘라 낸다. 진행 중인 작업은 자르지 않는다. */
export function trimHistory(jobs: EngineJob[], limit = HISTORY_LIMIT): EngineJob[] {
  const sorted = [...jobs].sort((a, b) => b.createdAt - a.createdAt);
  let finished = 0;
  return sorted.filter((job) => {
    if (job.status === 'queued' || job.status === 'running') return true;
    finished += 1;
    return finished <= limit;
  });
}

/** 내역 비우기에서 지울 작업: 끝난 것(완료·실패·취소)만. 받는 중·대기 중인 작업은 남긴다. */
export function finishedIds(jobs: Iterable<EngineJob>): string[] {
  return [...jobs].filter((job) => job.status !== 'queued' && job.status !== 'running').map((job) => job.id);
}

/**
 * 내역 파일을 읽는다. 없거나 깨졌으면 빈 내역으로 시작한다.
 * 앱이 꺼질 때 대기·진행 중이던 작업은 중단된 것으로 바꿔 다시 받을 수 있게 한다.
 */
export async function loadHistory(file: string): Promise<EngineJob[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(isRecord).map((job) => {
    if (job.status !== 'queued' && job.status !== 'running') return job;
    return {
      ...job,
      status: 'error',
      message: '앱이 종료되어 다운로드가 중단됐습니다.',
      error: { code: 'INTERRUPTED', message: '앱이 종료되어 다운로드가 중단됐습니다.', hint: '다시 받기를 눌러 주세요.' },
      finishedAt: job.finishedAt ?? job.createdAt,
    };
  });
}

/** 임시 파일에 쓴 뒤 바꿔 끼워, 쓰는 도중 꺼져도 내역 파일이 깨지지 않게 한다. */
export async function saveHistory(file: string, jobs: EngineJob[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(trimHistory(jobs).map(toRecord), null, 2), 'utf8');
  await rename(temp, file);
}

function isRecord(value: unknown): value is EngineJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<EngineJob>;
  return typeof job.id === 'string' && typeof job.url === 'string' && typeof job.status === 'string' && typeof job.createdAt === 'number';
}
