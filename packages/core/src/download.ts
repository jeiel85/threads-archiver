import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultBaseDir } from './paths.js';
import {
  ArchiveError,
  type ArchiveResult,
  type DownloadOptions,
  type DownloadedFile,
  type MediaAsset,
  type ThreadArchive,
  type ThreadsPost,
} from './types.js';
import type { ThreadsSession } from './extract/session.js';

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

const VIDEO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** 기본 저장 위치: <홈>/Downloads/Threads Archiver */
export { defaultBaseDir };

const SUMMARY_MAX = 40;

/**
 * 저장 폴더 이름: `<작성일> @<작성자> - <본문 요약>`.
 * 날짜를 앞에 두어 탐색기에서 이름순 정렬이 곧 시간순이 되게 한다.
 * 본문이 없으면 요약 대신 게시물 ID를 쓴다.
 */
export function defaultFolderName(archive: ThreadArchive): string {
  const root = archive.posts[0];
  const date = localDate(root?.postedAt ?? archive.extractedAt);
  const summary = summarizeText(root?.text ?? '') || root?.shortcode || 'thread';
  const name = [date, `@${archive.owner} - ${summary}`].filter(Boolean).join(' ');
  return sanitize(name);
}

/**
 * `baseDir` 아래에 이 아카이브를 저장할 하위 폴더를 정한다.
 * 같은 이름의 폴더가 이미 있으면, 같은 게시물을 다시 받은 경우에만 그 폴더를 재사용하고
 * 다른 게시물이면 ` (2)`, ` (3)`… 을 붙인다.
 */
export async function resolveArchiveDir(baseDir: string, archive: ThreadArchive): Promise<string> {
  const name = defaultFolderName(archive);
  const rootCode = archive.posts[0]?.shortcode;

  for (let index = 1; ; index += 1) {
    const candidate = path.resolve(baseDir, index === 1 ? name : `${name} (${index})`);
    const existing = await stat(candidate).catch(() => null);
    if (!existing) return candidate;
    if (existing.isDirectory() && rootCode && (await archivedShortcode(candidate)) === rootCode) {
      return candidate;
    }
  }
}

async function archivedShortcode(dir: string): Promise<string | undefined> {
  try {
    const saved = JSON.parse(await readFile(path.join(dir, 'post.json'), 'utf8')) as ThreadArchive;
    return saved.posts?.[0]?.shortcode;
  } catch {
    // post.json이 없거나 깨진 폴더는 다른 게시물의 폴더로 본다.
    return undefined;
  }
}

function localDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 본문 첫 줄에서 링크를 빼고 단어 경계에 맞춰 짧게 자른다. */
export function summarizeText(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim())
      .find((line) => line.length > 0) ?? '';

  const chars = Array.from(firstLine);
  if (chars.length <= SUMMARY_MAX) return firstLine;

  const cut = chars.slice(0, SUMMARY_MAX).join('');
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace >= SUMMARY_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Windows 폴더명에 쓸 수 없는 문자 처리: 구분자 성격(/ \ |)은 공백으로, 나머지는 지운다. */
function sanitize(value: string): string {
  const cleaned = value
    .replace(/[/\\|]/g, ' ')
    .replace(/[<>:"?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, 80).join('').replace(/[. ]+$/g, '') || 'threads';
}

function extensionFor(asset: MediaAsset, contentType: string | null): string {
  const table = asset.kind === 'video' ? VIDEO_EXT : IMAGE_EXT;
  if (contentType) {
    const normalized = contentType.split(';')[0]!.trim().toLowerCase();
    if (table[normalized]) return table[normalized]!;
  }
  const fromUrl = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(asset.url);
  if (fromUrl) {
    const ext = fromUrl[1]!.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'mp4', 'webm', 'mov'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  }
  return asset.kind === 'video' ? 'mp4' : 'jpg';
}

export interface SaveOptions extends DownloadOptions {
  /** 파일명 접두사 (기본: 순번) */
  prefix?: string;
}

/**
 * 추출된 아카이브의 미디어와 글을 디스크에 저장한다.
 *
 * CDN URL은 서명되어 수 시간 뒤 만료되므로 추출 직후에 호출해야 한다.
 */
export async function saveArchive(
  session: ThreadsSession,
  archive: ThreadArchive,
  options: SaveOptions,
): Promise<ArchiveResult> {
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });

  const includeMedia = options.includeMedia ?? true;
  const includeMarkdown = options.includeMarkdown ?? true;
  const files: DownloadedFile[] = [];
  const total = includeMedia ? archive.posts.reduce((sum, post) => sum + post.media.length, 0) : 0;
  let done = 0;
  let counter = 0;

  const report = (message: string, file?: string) => {
    const ratio = total === 0 ? 0.5 : done / (total + 1);
    options.onProgress?.({ ratio: Math.min(ratio, 0.95), message, file });
  };

  report('미디어를 내려받는 중…');

  for (const post of archive.posts) {
    for (const asset of post.media) {
      if (options.signal?.aborted) {
        throw new ArchiveError('CANCELLED', '다운로드를 취소했습니다.');
      }

      counter += 1;
      const response = await session.downloadBuffer(asset.url);
      const ext = extensionFor(asset, response.contentType);
      const fileName = `${String(counter).padStart(2, '0')}.${ext}`;
      const target = path.join(outputDir, fileName);

      await writeFile(target, response.body);
      asset.fileName = fileName;
      asset.bytes = response.body.byteLength;

      files.push({ postShortcode: post.shortcode, kind: asset.kind, path: target, bytes: asset.bytes });
      done += 1;
      report(`${fileName} 저장 완료`, target);
    }
  }

  const manifestPath = path.join(outputDir, 'post.json');
  // 영상 미리보기(data URL 캡처)는 화면 표시용이라 manifest에는 남기지 않는다.
  const manifest = JSON.stringify(
    archive,
    (key, value: unknown) => (key === 'previewUrl' && typeof value === 'string' && value.startsWith('data:') ? undefined : value),
    2,
  );
  await writeFile(manifestPath, `${manifest}\n`, 'utf8');

  let markdownPath: string | undefined;
  if (includeMarkdown) {
    markdownPath = path.join(outputDir, 'post.md');
    await writeFile(markdownPath, renderMarkdown(archive), 'utf8');
    files.push({ postShortcode: archive.posts[0]?.shortcode ?? '', kind: 'metadata', path: markdownPath, bytes: 0 });
  }

  files.push({ postShortcode: archive.posts[0]?.shortcode ?? '', kind: 'metadata', path: manifestPath, bytes: 0 });
  options.onProgress?.({ ratio: 1, message: `저장 완료: ${outputDir}` });

  return { archive, outputDir, files, manifestPath, markdownPath };
}

export function renderMarkdown(archive: ThreadArchive): string {
  const lines: string[] = [];
  const root = archive.posts[0];
  const owner = root?.author.displayName
    ? `${root.author.displayName} (@${archive.owner})`
    : `@${archive.owner}`;

  lines.push(`# ${owner} — Threads 아카이브`);
  lines.push('');
  lines.push(`- 원본: ${archive.sourceUrl}`);
  lines.push(`- 추출: ${archive.extractedAt}`);
  lines.push(`- 게시물 수: ${archive.posts.length}`);
  lines.push('');

  archive.posts.forEach((post, index) => {
    lines.push(`## ${index + 1}. ${post.postedAt ?? '작성 시각 미상'}`);
    lines.push('');
    if (post.permalink) {
      lines.push(`> ${post.permalink}`);
      lines.push('');
    }
    if (post.text) {
      lines.push(post.text);
      lines.push('');
    }
    for (const asset of post.media) {
      if (!asset.fileName) continue;
      lines.push(asset.kind === 'video' ? `- 🎬 [${asset.fileName}](${asset.fileName})` : `- 🖼️ [${asset.fileName}](${asset.fileName})`);
    }
    if (post.media.length > 0) lines.push('');
  });

  return `${lines.join('\n').trim()}\n`;
}

export function summarize(archive: ThreadArchive): string {
  const mediaCount = archive.posts.reduce((sum, post) => sum + post.media.length, 0);
  const images = archive.posts.reduce((sum, post) => sum + post.media.filter((m) => m.kind === 'image').length, 0);
  const videos = mediaCount - images;
  return `@${archive.owner} · 게시물 ${archive.posts.length}개 · 이미지 ${images}개 · 영상 ${videos}개`;
}

export type { ThreadsPost };
