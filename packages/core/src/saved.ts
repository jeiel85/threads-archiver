import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ArchiveError, type ThreadArchive } from './types.js';

/**
 * 이미 저장한 게시물 폴더를 다시 읽는다 (내역 미리보기용).
 *
 * post.json의 미디어 URL·미리보기 URL은 만료된 CDN 주소라 쓰지 않고,
 * 같은 폴더에 저장된 파일(fileName)을 엔진이 직접 내보낸다.
 */

/** saveArchive가 붙이는 미디어 파일 이름: `01.jpg`, `12.mp4` */
const MEDIA_FILE = /^\d{2,}\.[a-z0-9]{2,5}$/i;

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4v: 'video/mp4',
};

export async function readSavedArchive(outputDir: string): Promise<ThreadArchive> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(outputDir, 'post.json'), 'utf8'));
  } catch {
    throw new ArchiveError(
      'POST_NOT_FOUND',
      '저장된 게시물을 찾지 못했습니다.',
      '폴더를 옮겼거나 지웠다면 다시 받기를 눌러 주세요.',
    );
  }
  const archive = parsed as Partial<ThreadArchive> | null;
  if (!archive || typeof archive.owner !== 'string' || !Array.isArray(archive.posts)) {
    throw new ArchiveError('EXTRACTION_FAILED', '저장된 게시물 정보(post.json)를 해석하지 못했습니다.');
  }
  return archive as ThreadArchive;
}

/**
 * 게시물 폴더 안의 미디어 파일 경로. 저장할 때 붙인 이름 형식이 아니면(경로 이동 포함) undefined.
 */
export function savedMediaPath(outputDir: string, fileName: string): string | undefined {
  if (!MEDIA_FILE.test(fileName)) return undefined;
  return path.join(outputDir, fileName);
}

export function mediaContentType(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * `Range: bytes=start-end` 헤더를 해석한다. 영상 태그가 앞부분·끝부분만 읽을 수 있게 한다.
 * 헤더가 없거나 형식이 다르면 null(전체 전송), 범위를 벗어나면 'invalid'(416).
 */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let start: number;
  let end: number;
  if (!match[1]) {
    // bytes=-N: 끝에서 N바이트
    const suffix = Number(match[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}
