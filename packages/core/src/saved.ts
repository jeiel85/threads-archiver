import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseThreadsUrl } from './urls.js';
import { ArchiveError, type ArchiveResult, type DownloadedFile, type ThreadArchive } from './types.js';

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

/** 한 번에 열어 볼 post.json 수. 폴더가 많아도 파일 핸들을 한꺼번에 다 쓰지 않게 한다. */
const SCAN_BATCH = 32;

/**
 * 링크의 게시물을 `baseDir` 아래에 이미 다 저장해 두었으면 그 결과를 돌려준다. 브라우저를 열지 않는다.
 *
 * 게시물 폴더 이름은 본문·작성일로 정해져 링크만으로는 알 수 없으므로, 하위 폴더의 post.json을 읽어
 * 첫 게시물 코드가 같은 것을 찾는다(resolveArchiveDir가 같은 폴더를 재사용하는 기준과 같다).
 * 미디어 파일이 하나라도 없거나 미디어 없이 저장한 폴더는 다 받지 않은 것으로 보고 undefined.
 * 단축 공유 링크처럼 게시물 코드를 바로 알 수 없는 링크도 undefined (평소처럼 페이지를 읽는다).
 */
export async function findSavedArchive(baseDir: string, input: string): Promise<ArchiveResult | undefined> {
  let shortcode: string;
  try {
    shortcode = parseThreadsUrl(input).shortcode;
  } catch {
    return undefined;
  }

  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.resolve(baseDir, entry.name));

  for (let start = 0; start < dirs.length; start += SCAN_BATCH) {
    const batch = dirs.slice(start, start + SCAN_BATCH);
    const found = await Promise.all(batch.map((dir) => completeArchive(dir, shortcode)));
    const hit = found.find((result) => result !== undefined);
    if (hit) return hit;
  }
  return undefined;
}

async function completeArchive(outputDir: string, shortcode: string): Promise<ArchiveResult | undefined> {
  const manifestPath = path.join(outputDir, 'post.json');
  let archive: ThreadArchive;
  try {
    archive = JSON.parse(await readFile(manifestPath, 'utf8')) as ThreadArchive;
  } catch {
    return undefined;
  }
  if (!Array.isArray(archive?.posts) || archive.posts[0]?.shortcode !== shortcode) return undefined;

  const files: DownloadedFile[] = [];
  for (const post of archive.posts) {
    for (const asset of post.media ?? []) {
      const file = asset.fileName ? savedMediaPath(outputDir, asset.fileName) : undefined;
      const info = file ? await stat(file).catch(() => undefined) : undefined;
      if (!file || !info?.isFile()) return undefined;
      files.push({ postShortcode: post.shortcode, kind: asset.kind, path: file, bytes: info.size });
    }
  }

  const markdown = path.join(outputDir, 'post.md');
  const markdownPath = (await stat(markdown).catch(() => undefined))?.isFile() ? markdown : undefined;
  if (markdownPath) files.push({ postShortcode: shortcode, kind: 'metadata', path: markdownPath, bytes: 0 });
  files.push({ postShortcode: shortcode, kind: 'metadata', path: manifestPath, bytes: 0 });

  return { archive, outputDir, files, manifestPath, markdownPath };
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
