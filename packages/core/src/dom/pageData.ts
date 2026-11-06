import type { RawDomMedia, RawDomResult } from './extractPage.js';

/**
 * 로그인하면 Threads가 영상을 스트리밍(MSE)으로 재생해 <video>에는 `blob:` 주소만 남는다.
 * 페이지에 함께 내려오는 JSON(script[type="application/json"])의 `video_versions`에는
 * 원본 mp4 주소가 있으므로, 게시물 코드(shortcode)별로 영상 주소를 모아 blob 주소를 바꿔 끼운다.
 */

/** 게시물 코드 → 영상 주소 목록 (여러 장짜리 게시물은 영상이 나오는 순서대로). */
export function videoUrlsByCode(jsonTexts: string[]): Map<string, string[]> {
  return collectByCode(jsonTexts, (node) => {
    const urls = mediaVideoUrls(node);
    return urls.length ? urls : undefined;
  });
}

export type CarouselItemKind = 'image' | 'video';

/**
 * 영상이 든 여러 장짜리 게시물의 장별 종류 (화면에 나오는 순서대로).
 * 영상 플레이어가 그려지지 않았을 때 화면의 이미지 중 무엇이 진짜 사진이고 무엇이 영상 썸네일인지 가른다.
 */
export function carouselKindsByCode(jsonTexts: string[]): Map<string, CarouselItemKind[]> {
  return collectByCode(jsonTexts, (node) => {
    if (!Array.isArray(node.carousel_media)) return undefined;
    const kinds = node.carousel_media.map((item): CarouselItemKind =>
      item && typeof item === 'object' && firstVideoUrl(item as Record<string, unknown>) ? 'video' : 'image',
    );
    return kinds.includes('video') ? kinds : undefined;
  });
}

/** 페이지 JSON을 훑어 게시물 코드마다 처음 값을 돌려주는 노드에서 값을 모은다. */
function collectByCode<T>(jsonTexts: string[], pick: (node: Record<string, unknown>) => T | undefined): Map<string, T> {
  const result = new Map<string, T>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;

    if (typeof node.code === 'string' && !result.has(node.code)) {
      const picked = pick(node);
      if (picked !== undefined) result.set(node.code, picked);
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
 *
 * 화면의 이미지에는 영상 썸네일과 진짜 사진이 섞여 있을 수 있다. 여러 장짜리 게시물은 JSON의 장별 종류와
 * 화면 이미지 수가 같으면 순서대로 짝지어, 영상 자리는 그 썸네일을 미리보기로 쓰는 영상으로 바꾸고 사진은 그대로 둔다.
 * 단일 영상이거나 수가 맞지 않으면(짝을 확신할 수 없음) 영상만 남기고 첫 이미지를 미리보기로 쓴다.
 */
export function fillVideosFromPageData(
  raw: RawDomResult,
  urlsByCode: Map<string, string[]>,
  codes: Iterable<string>,
  carouselKinds: Map<string, CarouselItemKind[]> = new Map(),
): void {
  const targets = new Set(codes);
  for (const post of raw.posts) {
    if (!post.shortcode || !targets.has(post.shortcode)) continue;
    const urls = urlsByCode.get(post.shortcode) ?? [];
    if (urls.length === 0) continue;
    const images = post.media.filter((media) => media.kind === 'image');
    const preview = (image: RawDomMedia | undefined) => (image ? image.previewUrl ?? image.url : undefined);

    const kinds = carouselKinds.get(post.shortcode);
    if (kinds && kinds.length === images.length && kinds.filter((kind) => kind === 'video').length === urls.length) {
      let videoIndex = 0;
      post.media = kinds.map((kind, index) =>
        kind === 'video' ? { kind: 'video', url: urls[videoIndex++]!, previewUrl: preview(images[index]) } : images[index]!,
      );
      continue;
    }

    const previewUrl = preview(images[0]);
    post.media = urls.map((url) => ({ kind: 'video', url, previewUrl }));
  }
}

/**
 * 영상이 보이는 게시물의 미디어를 페이지 JSON의 장별 구성에 맞춘다.
 *
 * DOM은 영상 썸네일을 뺀 미디어를 화면 순서대로 내보낸다. 여러 장짜리에서 그 수가 JSON의 장 수와 같으면
 * 장별로 짝지어, 사진 자리는 사진으로, 영상 자리는 그려진 영상 그대로 두거나(로그인 상태에서 화면 밖 장은
 * <video> 없이 썸네일만 있다) 썸네일 자리를 JSON 영상 주소로 바꾸고 썸네일을 미리보기로 쓴다.
 * 그 밖(단일 영상, 수나 종류가 맞지 않음)에는 남은 이미지가 썸네일일 수 있으므로 예전처럼 영상만 남긴다.
 */
export function alignCarouselMedia(
  raw: RawDomResult,
  urlsByCode: Map<string, string[]>,
  carouselKinds: Map<string, CarouselItemKind[]>,
): void {
  for (const post of raw.posts) {
    const videos = post.media.filter((media) => media.kind === 'video');
    if (videos.length === 0) continue;

    const kinds = post.shortcode ? carouselKinds.get(post.shortcode) : undefined;
    const urls = post.shortcode ? urlsByCode.get(post.shortcode) ?? [] : [];
    const aligned = kinds && kinds.length === post.media.length ? alignByKinds(post.media, kinds, urls) : undefined;
    post.media = aligned ?? videos;
  }
}

function alignByKinds(media: RawDomMedia[], kinds: CarouselItemKind[], urls: string[]): RawDomMedia[] | undefined {
  const result: RawDomMedia[] = [];
  let videoIndex = 0;
  for (let i = 0; i < kinds.length; i += 1) {
    const item = media[i]!;
    if (kinds[i] === 'image') {
      if (item.kind !== 'image') return undefined;
      result.push(item);
      continue;
    }
    const url = urls[videoIndex++];
    if (item.kind === 'video') result.push(item);
    else if (url) result.push({ kind: 'video', url, previewUrl: item.previewUrl ?? item.url });
    else return undefined;
  }
  return result;
}
