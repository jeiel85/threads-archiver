/**
 * 페이지 안에서 실행되는 DOM 추출기.
 *
 * 이 파일의 함수는 브라우저(또는 WebView) 컨텍스트에서 그대로 실행된다.
 * 따라서 Node API·import·TypeScript 런타임 헬퍼에 의존하면 안 된다.
 * Playwright에서는 page.evaluate(extractThreadsDom, url) 형태로 주입한다.
 */

export interface RawDomMedia {
  kind: 'image' | 'video';
  url: string;
  width?: number;
  height?: number;
  durationSec?: number;
  previewUrl?: string;
}

export interface RawDomStats {
  likes?: number;
  replies?: number;
  reposts?: number;
  shares?: number;
}

export interface RawDomPost {
  username: string;
  displayName?: string;
  verified?: boolean;
  avatarUrl?: string;
  shortcode?: string;
  permalink?: string;
  postedAt?: string;
  text: string;
  media: RawDomMedia[];
  stats?: RawDomStats;
}

export interface RawDomResult {
  posts: RawDomPost[];
  page: {
    url: string;
    title: string;
    bodyTextHead: string;
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function extractThreadsDom(): RawDomResult {
  const doc: any = typeof document !== 'undefined' ? document : null;
  if (!doc) {
    return { posts: [], page: { url: '', title: '', bodyTextHead: '' } };
  }

  const allContainers: any[] = Array.from(doc.querySelectorAll('[data-pressable-container]'));

  // 인용 게시물 등 중첩된 컨테이너는 별도 게시물로 취급하지 않는다.
  const containers = allContainers.filter((el) => {
    const parent = el.parentElement;
    return !(parent && parent.closest('[data-pressable-container]'));
  });

  const clean = (value: string | null | undefined): string =>
    (value ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();

  const parseCount = (value: string | null | undefined): number | undefined => {
    const text = clean(value);
    if (!text) return undefined;
    const match = text.match(/([0-9][0-9.,]*)\s*([KMB])?/i);
    if (!match) return undefined;
    const base = Number(match[1]!.replace(/,/g, ''));
    if (!Number.isFinite(base)) return undefined;
    const suffix = (match[2] ?? '').toUpperCase();
    const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
    return Math.round(base * multiplier);
  };

  const pickLargestFromSrcset = (srcset: string | null): string | undefined => {
    if (!srcset) return undefined;
    const entries = srcset
      .split(/,\s*(?=https?:)/)
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        const url = parts[0];
        const descriptor = parts[1] ?? '';
        const width = descriptor.endsWith('w') ? Number(descriptor.slice(0, -1)) : 0;
        return { url, width };
      })
      .filter((entry) => !!entry.url);

    if (entries.length === 0) return undefined;
    entries.sort((a, b) => b.width - a.width);
    return entries[0]!.url;
  };

  /** 미리보기용: 320px 이상 중 가장 작은 후보 (없으면 가장 큰 것). */
  const pickPreviewFromSrcset = (srcset: string | null): string | undefined => {
    if (!srcset) return undefined;
    const entries = srcset
      .split(/,\s*(?=https?:)/)
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        const descriptor = parts[1] ?? '';
        return { url: parts[0], width: descriptor.endsWith('w') ? Number(descriptor.slice(0, -1)) : 0 };
      })
      .filter((entry) => !!entry.url && entry.width > 0);

    if (entries.length === 0) return undefined;
    entries.sort((a, b) => a.width - b.width);
    return (entries.find((entry) => entry.width >= 320) ?? entries[entries.length - 1]!).url;
  };

  const toNumber = (value: string | null): number | undefined => {
    if (!value) return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const timestampLike = /^(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}|\d+\s*(s|m|h|d|w|mo|y)|\d{1,2}월\s*\d{1,2}일|\d+시간|\d+일|\d+주|\d+개월)$/i;
  const ignoredTexts = new Set([
    'author',
    '작성자',
    '·',
    '•',
    'edited',
    '수정됨',
    'see translation',
    '번역 보기',
    // 로그인하면 게시물 아래에 나오는 안내
    'no replies yet',
    '아직 답글이 없습니다',
  ]);

  const isInsideNestedPost = (element: any, container: any): boolean => {
    const nested = element.parentElement ? element.parentElement.closest('[data-pressable-container]') : null;
    return !!nested && nested !== container;
  };

  const isAuthorAnchor = (anchor: any): boolean => /^\/@[^/]+\/?$/.test(String(anchor.getAttribute('href') ?? ''));

  /**
   * 로그인하면 게시물 안에 답글 입력창이 생기고, 그 안내 문구("Reply to …")도 span[dir=auto]로 들어 있다.
   * 입력 요소를 품은 조상 중 글자가 이 문구뿐인 곳이 있으면 입력창의 안내 문구로 본다.
   */
  const isComposerPlaceholder = (span: any, container: any, text: string): boolean => {
    for (let el = span.parentElement; el && el !== container; el = el.parentElement) {
      if (clean(el.innerText ?? '') !== text) return false;
      if (el.querySelector('[contenteditable="true"],[role="textbox"],textarea,input')) return true;
    }
    return false;
  };

  const pageCounter = /^\d+\s*\/\s*\d+$/;

  /**
   * span의 본문 글자. 로그인하면 본문 span 안에 버튼("Translate")과 타래 순번("1 / 3")이 함께 들어오므로,
   * 그 요소들의 글자 줄을 본문에서 뺀다.
   */
  const spanBodyText = (span: any): string => {
    const noise: any[] = Array.from(span.querySelectorAll('button,[role="button"],div')).filter(
      (el: any) => el.matches('button,[role="button"]') || pageCounter.test(clean(el.innerText ?? '').replace(/\s+/g, ' ')),
    );
    const lines = String(span.innerText ?? span.textContent ?? '').split('\n');
    for (const el of noise) {
      const run = String(el.innerText ?? '')
        .split('\n')
        .map((line) => clean(line))
        .filter(Boolean);
      if (run.length === 0) continue;
      // 같은 줄들이 연달아 나오는 마지막 자리를 찾아 뺀다.
      for (let start = lines.length - run.length; start >= 0; start -= 1) {
        if (run.every((line, offset) => clean(lines[start + offset]) === line)) {
          lines.splice(start, run.length);
          break;
        }
      }
    }
    return clean(lines.join('\n'));
  };

  const collectText = (container: any): string => {
    const likeButton = Array.from(container.querySelectorAll('[role="button"]')).find((button: any) =>
      /^(like|좋아요)\b/i.test(clean(button.getAttribute('aria-label') ?? '')),
    ) as any;

    const spans: any[] = Array.from(container.querySelectorAll('span[dir="auto"]'));
    const chunks: string[] = [];

    for (const span of spans) {
      if (span.closest('a[href]')) continue;
      if (span.closest('button,[role="button"]')) continue;
      if (span.closest('time,abbr')) continue;
      if (isInsideNestedPost(span, container)) continue;
      if (span.querySelector('span[dir="auto"]')) continue; // 중첩된 내부 span은 중복이므로 제외
      if (likeButton && likeButton.parentElement && likeButton.contains(span)) continue;

      const text = spanBodyText(span);
      if (!text) continue;
      if (isComposerPlaceholder(span, container, text)) continue;
      if (timestampLike.test(text)) continue;
      if (ignoredTexts.has(text.toLowerCase())) continue;
      if (chunks[chunks.length - 1] === text) continue;
      chunks.push(text);
    }

    return chunks.join('\n').trim();
  };

  const collectMedia = (container: any): RawDomMedia[] => {
    const media: RawDomMedia[] = [];

    const videos: any[] = Array.from(container.querySelectorAll('video')).filter(
      (video: any) => !isInsideNestedPost(video, container),
    );
    // 영상의 대표 이미지: poster 속성, 없으면 같은 게시물 안의 썸네일 <picture>.
    const posterImages: any[] = Array.from(container.querySelectorAll('picture img')).filter((img: any) => {
      if (isInsideNestedPost(img, container)) return false;
      if (/profile picture|프로필 사진/i.test(String(img.getAttribute('alt') ?? ''))) return false;
      const anchor = img.closest('a[href]');
      return !(anchor && isAuthorAnchor(anchor));
    });
    let posterIndex = 0;

    for (const video of videos) {
      const src: string = video.currentSrc || video.src || video.querySelector('source')?.src || '';
      if (!src) continue;
      const posterImg = posterImages[posterIndex++];
      const poster: string | undefined =
        video.poster ||
        (posterImg
          ? pickPreviewFromSrcset(posterImg.getAttribute('srcset')) ?? posterImg.currentSrc ?? posterImg.src
          : undefined) ||
        undefined;
      media.push({
        previewUrl: poster,
        kind: 'video',
        url: src,
        width: toNumber(String(video.videoWidth || video.getAttribute('width') || '')),
        height: toNumber(String(video.videoHeight || video.getAttribute('height') || '')),
        durationSec:
          typeof video.duration === 'number' && Number.isFinite(video.duration) && video.duration > 0
            ? Math.round(video.duration * 1000) / 1000
            : undefined,
      });
    }

    // 영상 게시물의 썸네일(picture)은 별도 미디어로 저장하지 않는다.
    if (media.length === 0) {
      const images: any[] = Array.from(container.querySelectorAll('picture img, img')).filter(
        (img: any) => !isInsideNestedPost(img, container),
      );
      const seen = new Set<string>();
      for (const img of images) {
        const alt = String(img.getAttribute('alt') ?? '');
        if (/profile picture|프로필 사진/i.test(alt)) continue;
        const anchor = img.closest('a[href]');
        if (anchor && isAuthorAnchor(anchor)) continue;

        const width = toNumber(img.getAttribute('width'));
        const height = toNumber(img.getAttribute('height'));
        if (width !== undefined && width < 100) continue;

        const url = pickLargestFromSrcset(img.getAttribute('srcset')) ?? img.currentSrc ?? img.src;
        if (!url || seen.has(url)) continue;
        seen.add(url);

        media.push({
          kind: 'image',
          url,
          width,
          height,
          previewUrl: pickPreviewFromSrcset(img.getAttribute('srcset')) ?? url,
        });
      }
    }

    return media;
  };

  const collectStats = (container: any): RawDomStats | undefined => {
    const buttons: any[] = Array.from(container.querySelectorAll('[role="button"]'));
    const stats: RawDomStats = {};

    for (const button of buttons) {
      const label = clean(button.getAttribute('aria-label') ?? '');
      if (!label) continue;
      const match = label.match(/^(like|comment|reply|repost|share|좋아요|댓글|답글|재게시|공유)\b/i);
      if (!match) continue;
      const key = match[1]!.toLowerCase();
      const value = parseCount(label.slice(match[0].length)) ?? parseCount(clean(button.innerText));
      if (value === undefined) continue;
      if (key === 'like' || key === '좋아요') stats.likes = value;
      else if (key === 'comment' || key === 'reply' || key === '댓글' || key === '답글') stats.replies = value;
      else if (key === 'repost' || key === '재게시') stats.reposts = value;
      else if (key === 'share' || key === '공유') stats.shares = value;
    }

    return Object.keys(stats).length > 0 ? stats : undefined;
  };

  const posts: RawDomPost[] = [];

  for (const container of containers) {
    const authorLink: any = Array.from(container.querySelectorAll('a[href]')).find((a: any) => isAuthorAnchor(a));
    if (!authorLink) continue;

    const authorHref = String(authorLink.getAttribute('href') ?? '');
    const username = authorHref.replace(/^\/@/, '').replace(/\/$/, '').split('/')[0] ?? '';
    if (!username) continue;

    const postLink: any = container.querySelector('a[href*="/post/"]');
    const permalinkPath = postLink ? String(postLink.getAttribute('href') ?? '') : '';
    const shortcodeMatch = permalinkPath.match(/\/post\/([A-Za-z0-9_-]+)/);
    const shortcode = shortcodeMatch ? shortcodeMatch[1] : undefined;
    const permalink = shortcode ? `https://www.threads.com/@${username}/post/${shortcode}` : undefined;

    const timeEl: any = container.querySelector('time');
    const postedAt = timeEl ? String(timeEl.getAttribute('datetime') ?? '') || undefined : undefined;

    const avatarImg: any = container.querySelector('img[alt*="profile picture"], img[alt*="프로필"]');
    const avatarUrl = avatarImg ? String(avatarImg.getAttribute('src') ?? '') || undefined : undefined;

    let displayName: string | undefined;
    const authorTexts: string[] = Array.from(container.querySelectorAll(`a[href="/@${username}"]`)).map((a: any) =>
      clean(a.innerText ?? a.textContent ?? ''),
    );
    for (const text of authorTexts) {
      if (text && text !== username && !timestampLike.test(text)) {
        displayName = text;
        break;
      }
    }

    const verifiedTitles: any[] = Array.from(container.querySelectorAll('svg title'));
    const verified = verifiedTitles.some((t) => /^(verified|인증됨?)$/i.test(clean(t.textContent ?? '')));

    posts.push({
      username,
      displayName,
      verified: verified || undefined,
      avatarUrl,
      shortcode,
      permalink,
      postedAt,
      text: collectText(container),
      media: collectMedia(container),
      stats: collectStats(container),
    });
  }

  const bodyText = doc.body ? String((doc.body as any).innerText ?? '') : '';

  return {
    posts,
    page: {
      url: typeof location !== 'undefined' ? location.href : '',
      title: typeof document !== 'undefined' ? document.title : '',
      bodyTextHead: bodyText.slice(0, 600),
    },
  };
}
