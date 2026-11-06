import type { RawDomResult } from './extractPage.js';

/**
 * 로그인하면 Threads가 영상을 스트리밍(MSE)으로 재생해 <video>에는 `blob:` 주소만 남는다.
 * 페이지에 함께 내려오는 JSON(script[type="application/json"])의 `video_versions`에는
 * 원본 mp4 주소가 있으므로, 게시물 코드(shortcode)별로 영상 주소를 모아 blob 주소를 바꿔 끼운다.
 */

/** 게시물 코드 → 영상 주소 목록 (여러 장짜리 게시물은 영상이 나오는 순서대로). */
export function videoUrlsByCode(jsonTexts: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;

    if (typeof node.code === 'string' && !result.has(node.code)) {
      const urls = mediaVideoUrls(node);
      if (urls.length) result.set(node.code, urls);
    }
    for (const child of Object.values(node)) visit(child);
  };

  for (const text of jsonTexts) {
    try {
      visit(JSON.parse(text));
    } catch {
      // 영상 정보가 아닌 스크립트는 건너뛴다.
    }
  }
  return result;
}

function mediaVideoUrls(node: Record<string, unknown>): string[] {
  if (Array.isArray(node.carousel_media)) {
    return node.carousel_media
      .map((item) => (item && typeof item === 'object' ? firstVideoUrl(item as Record<string, unknown>) : undefined))
      .filter((url): url is string => Boolean(url));
  }
  const url = firstVideoUrl(node);
  if (url) return [url];

  // 인스타그램 릴스 등을 붙인 글은 게시물 자체엔 영상이 없고, 붙인 미디어(별도 코드)에 영상이 있다.
  // (인용한 다른 게시물 share_info.quoted_post는 화면에서도 따로 빠지므로 포함하지 않는다.)
  const appInfo = node.text_post_app_info;
  const linked = appInfo && typeof appInfo === 'object' ? (appInfo as Record<string, unknown>).linked_inline_media : undefined;
  return linked && typeof linked === 'object' ? mediaVideoUrls(linked as Record<string, unknown>) : [];
}

/** video_versions의 첫 항목이 가장 높은 화질이다. */
function firstVideoUrl(node: Record<string, unknown>): string | undefined {
  if (!Array.isArray(node.video_versions)) return undefined;
  const first = node.video_versions.find(
    (version) => version && typeof version === 'object' && typeof (version as { url?: unknown }).url === 'string',
  ) as { url: string } | undefined;
  return first?.url;
}

/**
 * blob 주소인 영상을 페이지 JSON의 원본 주소로 바꾼다. 게시물마다 영상이 나온 순서로 맞춘다.
 * @returns 바꾸지 못한 blob 영상 수
 */
export function resolveBlobVideos(raw: RawDomResult, urlsByCode: Map<string, string[]>): number {
  let unresolved = 0;
  for (const post of raw.posts) {
    const urls = post.shortcode ? urlsByCode.get(post.shortcode) ?? [] : [];
    let index = 0;
    for (const media of post.media) {
      if (media.kind !== 'video') continue;
      const candidate = urls[index++];
      if (!media.url.startsWith('blob:')) continue;
      if (candidate) media.url = candidate;
      else unresolved += 1;
    }
  }
  return unresolved;
}

/**
 * 페이지 JSON에는 영상이 있는데 화면(DOM)에서는 <video>를 하나도 못 찾은 게시물 코드.
 * 로그인 상태로 브라우저를 막 띄운 직후처럼 느릴 때, 본문은 떴지만 영상 플레이어가 아직 그려지지 않아
 * 썸네일 <picture>만 보이는 경우다. 그대로 두면 영상 대신 썸네일이 이미지로 저장된다.
 * @param codes 아카이브에 들어가는 게시물 코드만 본다(같은 화면의 다른 사람 답글은 상관없음).
 */
export function postsMissingVideos(raw: RawDomResult, urlsByCode: Map<string, string[]>, codes: Iterable<string>): string[] {
  const wanted = new Set(codes);
  return raw.posts
    .filter(
      (post) =>
        post.shortcode !== undefined &&
        wanted.has(post.shortcode) &&
        (urlsByCode.get(post.shortcode)?.length ?? 0) > 0 &&
        !post.media.some((media) => media.kind === 'video'),
    )
    .map((post) => post.shortcode!);
}

/**
 * 끝내 <video>가 그려지지 않은 게시물의 미디어를 페이지 JSON의 영상 주소로 채운다.
 * 화면에 보이던 이미지는 영상의 썸네일이므로, 첫 이미지를 영상들의 미리보기로 쓴다.
 */
export function fillVideosFromPageData(raw: RawDomResult, urlsByCode: Map<string, string[]>, codes: Iterable<string>): void {
  const targets = new Set(codes);
  for (const post of raw.posts) {
    if (!post.shortcode || !targets.has(post.shortcode)) continue;
    const urls = urlsByCode.get(post.shortcode) ?? [];
    if (urls.length === 0) continue;
    const thumbnail = post.media.find((media) => media.kind === 'image');
    const previewUrl = thumbnail ? thumbnail.previewUrl ?? thumbnail.url : undefined;
    post.media = urls.map((url) => ({ kind: 'video', url, previewUrl }));
  }
}
