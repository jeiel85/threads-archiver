import path from 'node:path';
import { ThreadsSession, type SessionOptions } from './extract/session.js';
import { defaultBaseDir, defaultFolderName, saveArchive } from './download.js';
import {
  ArchiveError,
  type ArchiveResult,
  type DownloadProgress,
  type ThreadArchive,
} from './types.js';

export interface ArchiveThreadOptions extends SessionOptions {
  /** 저장 폴더. 생략하면 <Downloads>/Threads Archiver/<작성자>_<게시물ID> */
  outputDir?: string;
  includeMedia?: boolean;
  includeMarkdown?: boolean;
  timeoutMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export interface ExtractedThread {
  archive: ThreadArchive;
  /** 기본 저장 폴더 (아직 생성되지 않음) */
  suggestedDir: string;
}

/** 링크에서 게시물(과 이어진 타래)을 읽기만 하고 파일은 저장하지 않는다. */
export async function extractThread(input: string, options: ArchiveThreadOptions = {}): Promise<ExtractedThread> {
  const session = new ThreadsSession(options);
  try {
    const archive = await session.extract(input, options.timeoutMs);
    return {
      archive,
      suggestedDir: path.join(options.outputDir ?? defaultBaseDir(), defaultFolderName(archive)),
    };
  } finally {
    await session.close();
  }
}

/** 링크를 추출하고 미디어·글을 저장한다. */
export async function archiveThread(input: string, options: ArchiveThreadOptions = {}): Promise<ArchiveResult> {
  const session = new ThreadsSession(options);
  try {
    options.onProgress?.({ ratio: 0.05, message: 'Threads 페이지를 여는 중…' });
    const archive = await session.extract(input, options.timeoutMs);
    options.onProgress?.({ ratio: 0.3, message: '게시물을 읽었습니다. 저장을 시작합니다…' });

    const outputDir =
      options.outputDir ?? path.join(defaultBaseDir(), defaultFolderName(archive));

    return await saveArchive(session, archive, {
      outputDir,
      includeMedia: options.includeMedia ?? true,
      includeMarkdown: options.includeMarkdown ?? true,
      onProgress: options.onProgress,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(
      'EXTRACTION_FAILED',
      `아카이브에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await session.close();
  }
}
