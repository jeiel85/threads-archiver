import { mkdir, writeFile } from 'node:fs/promises';
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

export function defaultFolderName(archive: ThreadArchive): string {
  const root = archive.posts[0];
  const code = root?.shortcode || 'thread';
  return `${sanitize(archive.owner)}_${code}`;
}

function sanitize(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'threads';
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
  await writeFile(manifestPath, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');

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
