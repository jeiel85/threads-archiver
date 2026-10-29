/**
 * Threads 공유 링크에서 추출한 데이터의 공통 타입.
 *
 * 이 타입들은 "추출 결과"를 표현하며, 파일 저장 여부와는 독립적이다.
 * 다운로드 단계에서 파일명·바이트 수가 추가된다.
 */

export type MediaKind = 'image' | 'video';

export interface MediaAsset {
  kind: MediaKind;
  /** CDN 원본 URL (만료되는 서명 URL이므로 즉시 내려받아야 한다) */
  url: string;
  width?: number;
  height?: number;
  durationSec?: number;
  /** 미리보기용 작은 이미지 URL (영상은 대표 썸네일). url과 마찬가지로 만료된다. */
  previewUrl?: string;
  /** 다운로드 후 채워지는 저장 파일명 */
  fileName?: string;
  /** 다운로드 후 채워지는 바이트 수 */
  bytes?: number;
}

export interface PostAuthor {
  username: string;
  displayName?: string;
  verified?: boolean;
  avatarUrl?: string;
}

export interface PostStats {
  likes?: number;
  replies?: number;
  reposts?: number;
  shares?: number;
}

export interface ThreadsPost {
  shortcode: string;
  /** 정규화된 게시물 주소 (https://www.threads.com/@user/post/CODE) */
  permalink: string;
  author: PostAuthor;
  text: string;
  /** ISO 8601 */
  postedAt?: string;
  media: MediaAsset[];
  stats?: PostStats;
}

/** 연속 게시물(타래)까지 포함한 하나의 아카이브 단위 */
export interface ThreadArchive {
  sourceUrl: string;
  /** 타래를 시작한 작성자 */
  owner: string;
  /** index 0 = 공유된 게시물, 이후 = 같은 작성자가 이어 쓴 글 */
  posts: ThreadsPost[];
  extractedAt: string;
  extractor: {
    name: string;
    version: string;
  };
}

export type ArchiveErrorCode =
  | 'INVALID_URL'
  | 'POST_NOT_FOUND'
  | 'POST_RESTRICTED'
  | 'TIMEOUT'
  | 'EXTRACTION_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'CANCELLED';

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  readonly hint?: string;

  constructor(code: ArchiveErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    if (hint) this.hint = hint;
  }
}

export interface ExtractOptions {
  /** 로그인 세션을 유지할 프로필 디렉터리. 지정하면 쿠키가 저장된다. */
  profileDir?: string;
  /** true면 브라우저 창을 띄운다 (로그인·디버깅용) */
  headed?: boolean;
  timeoutMs?: number;
  /** 이미 열려 있는 브라우저 세션을 재사용할 때 전달 */
  session?: ExtractionSession;
}

export interface ExtractionSession {
  /** 주입된 DOM 추출 스크립트를 실행할 페이지 팩토리 */
  readonly kind: 'playwright';
}

export interface DownloadProgress {
  /** 0 ~ 1 */
  ratio: number;
  message: string;
  file?: string;
  /** 미디어를 받는 동안의 세부 진행 (몇 번째 파일, 받은/전체 바이트) */
  transfer?: TransferProgress;
}

export interface TransferProgress {
  /** 1부터 */
  fileIndex: number;
  fileCount: number;
  received: number;
  /** 서버가 크기를 알려 주지 않으면 없음 */
  total?: number;
}

export interface DownloadOptions {
  outputDir: string;
  /** 미디어 파일 저장 여부 (false면 글/메타데이터만) */
  includeMedia?: boolean;
  /** 글을 Markdown으로 저장 */
  includeMarkdown?: boolean;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
}

export interface DownloadedFile {
  postShortcode: string;
  kind: MediaKind | 'metadata';
  path: string;
  bytes: number;
}

export interface ArchiveResult {
  archive: ThreadArchive;
  /** 실제 저장된 디렉터리 (절대 경로) */
  outputDir: string;
  files: DownloadedFile[];
  manifestPath: string;
  markdownPath?: string;
}
