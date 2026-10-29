import { ArchiveError } from './types.js';

export interface ParsedThreadsUrl {
  /** 원본 입력 문자열 */
  input: string;
  /** 정규화된 게시물 주소 */
  url: string;
  username: string;
  shortcode: string;
}

const HOSTS = new Set([
  'threads.com',
  'www.threads.com',
  'threads.net',
  'www.threads.net',
]);

const POST_PATH = /^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)(?:\/.*)?$/;

/**
 * 공유 텍스트, 단축 링크, 추적 파라미터가 섞인 입력에서 게시물 주소만 뽑아낸다.
 *
 * 지원 입력 예:
 *  - https://www.threads.com/@zuck/post/DeZtp-TkQHh
 *  - https://www.threads.net/@zuck/post/DeZtp-TkQHh/media?xmt=AQG...
 *  - "이 글 봐 https://www.threads.com/@zuck/post/DeZtp-TkQHh 정말 좋다"
 *  - threads.com/@zuck/post/DeZtp-TkQHh  (스킴 없는 입력)
 */
export function parseThreadsUrl(input: string): ParsedThreadsUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ArchiveError('INVALID_URL', '링크가 비어 있습니다.', 'Threads 게시물 공유 링크를 붙여넣어 주세요.');
  }

  for (const candidate of candidateUrls(trimmed)) {
    const parsed = tryParse(candidate, trimmed);
    if (parsed) return parsed;
  }

  throw new ArchiveError(
    'INVALID_URL',
    'Threads 게시물 링크를 찾지 못했습니다.',
    '예: https://www.threads.com/@username/post/XXXXXXXXXXX',
  );
}

function* candidateUrls(input: string): Generator<string> {
  if (/^https?:\/\//i.test(input)) {
    yield input;
    return;
  }
  // 텍스트에 섞여 있는 링크를 먼저 찾는다.
  const embedded = input.match(/https?:\/\/[^\s"'<>]+/gi);
  if (embedded) {
    for (const url of embedded) yield url;
    return;
  }
  if (/^(www\.)?threads\.(com|net)\//i.test(input)) {
    yield `https://${input}`;
  }
}

function tryParse(raw: string, original: string): ParsedThreadsUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  // 단축 링크(threads.com/share/...)는 서버 리다이렉트가 필요하므로 추출 단계에서 처리한다.
  const match = POST_PATH.exec(url.pathname);
  if (!match) return null;

  const username = match[1]!;
  const shortcode = match[2]!;

  return {
    input: original,
    url: `https://www.threads.com/@${username}/post/${shortcode}`,
    username,
    shortcode,
  };
}

/** 리다이렉트가 필요한 공유 단축 링크인지 확인한다. */
export function isShortShareLink(input: string): boolean {
  return /threads\.(com|net)\/share\//i.test(input);
}
