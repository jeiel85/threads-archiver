import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { ArchiveError, type ThreadArchive, type ThreadsPost } from '../types.js';
import { extractThreadsDom, type RawDomResult } from '../dom/extractPage.js';
import { carouselKindsByCode, fillVideosFromPageData, alignCarouselMedia, postsMissingVideos, resolveBlobVideos, videoUrlsByCode } from '../dom/pageData.js';
import { parseThreadsUrl, isShortShareLink, type ParsedThreadsUrl } from '../urls.js';

const DEFAULT_TIMEOUT_MS = 45_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Playwright용 Chromium이 설치돼 있으면 그것을, 없으면 시스템 브라우저 채널을 쓴다.
 * 설치본은 Chromium(약 150MB)을 동봉하지 않으므로 Windows에 기본 탑재된 Edge로 동작한다.
 * `THREADS_ARCHIVER_BROWSER_CHANNEL`(msedge, chrome 등)로 강제할 수 있다.
 */
export function resolveBrowserChannel(): string | undefined {
  const forced = process.env.THREADS_ARCHIVER_BROWSER_CHANNEL?.trim();
  if (forced) return forced;
  if (existsSync(chromium.executablePath())) return undefined;
  return process.platform === 'win32' ? 'msedge' : 'chrome';
}

function launchFailed(error: unknown, channel: string | undefined): never {
  const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
  const hint = channel
    ? `${channel === 'msedge' ? 'Microsoft Edge' : channel} 브라우저가 설치돼 있는지 확인하세요. 소스에서 실행 중이면 \`npm run setup:browser\`로 Chromium을 설치해도 됩니다.`
    : '`npm run setup:browser`로 Chromium을 다시 설치하세요.';
  throw new ArchiveError('EXTRACTION_FAILED', `브라우저를 실행하지 못했습니다: ${detail}`, hint);
}

export interface SessionOptions {
  /** 쿠키/로그인 세션을 보관할 디렉터리 (지정 시 재사용) */
  profileDir?: string;
  /** 브라우저 창 표시 여부 */
  headed?: boolean;
  locale?: string;
  viewport?: { width: number; height: number };
}

/**
 * Playwright 브라우저 하나를 감싸 재사용하는 세션.
 *
 * Threads 웹은 로그인 없이도 공개 게시물을 렌더링하지만, 로그인 세션이 있으면
 * 연령 제한·비공개 게시물 등에서 성공률이 올라간다. profileDir를 주면 세션이 유지된다.
 */
export class ThreadsSession {
  private readonly options: SessionOptions;
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;

  constructor(options: SessionOptions = {}) {
    this.options = options;
  }

  async open(): Promise<void> {
    if (this.context) return;

    const headless = !this.options.headed;
    const contextOptions = {
      locale: this.options.locale ?? 'en-US',
      userAgent: USER_AGENT,
      viewport: this.options.viewport ?? { width: 1280, height: 1600 },
      deviceScaleFactor: 1,
    };

    const channel = resolveBrowserChannel();

    try {
      if (this.options.profileDir) {
        this.context = await chromium.launchPersistentContext(this.options.profileDir, {
          ...contextOptions,
          headless,
          channel,
        });
        return;
      }

      this.browser = await chromium.launch({ headless, channel });
    } catch (error) {
      launchFailed(error, channel);
    }
    this.context = await this.browser.newContext(contextOptions);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
  }

  /** Threads 로그인 세션 쿠키 값. 로그인하지 않았으면 undefined. */
  async loginCookie(): Promise<string | undefined> {
    return sessionCookie(this.requireContext());
  }

  /** 로그인·디버깅용으로 페이지를 직접 연다. */
  async openPage(url: string): Promise<Page> {
    await this.open();
    const page = await this.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return page;
  }

  private requireContext(): BrowserContext {
    if (!this.context) {
      throw new ArchiveError('EXTRACTION_FAILED', '브라우저 세션이 열려 있지 않습니다.');
    }
    return this.context;
  }

  private async newPage(): Promise<Page> {
    const context = this.requireContext();
    const page = await context.newPage();

    // 폰트는 추출에 불필요하므로 차단해 속도를 높인다.
    // 주의: media 요청을 막으면 Threads가 <video> 자체를 렌더링하지 않아 영상 URL을 얻을 수 없다.
    await page.route('**/*', (route) => {
      if (route.request().resourceType() === 'font') {
        void route.abort();
        return;
      }
      void route.continue();
    });

    return page;
  }

  /** 공유 링크 하나를 추출해 아카이브 구조로 돌려준다. */
  async extract(input: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ThreadArchive> {
    await this.open();

    let parsed: ParsedThreadsUrl | null = null;
    let targetUrl: string;
    try {
      parsed = parseThreadsUrl(input);
      targetUrl = parsed.url;
    } catch (error) {
      if (!isShortShareLink(input)) throw error;
      // 단축 공유 링크는 브라우저가 리다이렉트한 뒤 주소를 다시 해석한다.
      targetUrl = input.trim();
    }

    const page = await this.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      if (!parsed) {
        parsed = parseThreadsUrl(page.url());
        if (!parsed) {
          throw new ArchiveError('INVALID_URL', '공유 링크가 게시물 주소로 연결되지 않았습니다.', page.url());
        }
      }

      await this.waitForPost(page, timeoutMs);

      const raw = await readPostWithVideos(page, parsed);
      const archive = buildArchive(raw, parsed);
      // 아카이브에 들어가는 게시물만 따진다 (같은 화면의 다른 사람 답글 영상은 상관없음).
      if (archive.posts.some((post) => post.media.some((media) => media.url.startsWith('blob:')))) {
        throw new ArchiveError(
          'EXTRACTION_FAILED',
          '영상의 원본 주소를 찾지 못했습니다.',
          '로그인 상태에서는 영상이 스트리밍으로 재생돼 페이지 데이터에서 주소를 찾습니다. 잠시 뒤 다시 받아 보세요.',
        );
      }
      await captureVideoPreviews(this.requireContext(), archive);
      return archive;
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      if (error instanceof Error && /Timeout/i.test(error.message)) {
        throw new ArchiveError(
          'TIMEOUT',
          '페이지가 제한 시간 안에 준비되지 않았습니다.',
          '네트워크 상태를 확인하거나 --headed 옵션으로 페이지를 직접 열어 보세요.',
        );
      }
      throw new ArchiveError(
        'EXTRACTION_FAILED',
        `게시물을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async waitForPost(page: Page, timeoutMs: number): Promise<void> {
    // 일부 사용자에게만 공개된 게시물은 본문 대신 안내 화면만 나오므로, 그 화면이면 바로 멈춘다.
    await page
      .waitForFunction(
        (pattern) =>
          document.querySelector('[data-pressable-container] time') !== null ||
          new RegExp(pattern, 'i').test(document.body ? document.body.innerText : ''),
        RESTRICTED_PATTERN.source,
        { timeout: timeoutMs },
      )
      .catch(() => undefined);

    // 미디어의 srcset과 본문이 모두 렌더링될 시간을 준다.
    await page.waitForTimeout(400);

    const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    const hasPost = await page.locator('[data-pressable-container] time').count();
    if (!hasPost && RESTRICTED_PATTERN.test(bodyText)) {
      throw new ArchiveError(
        'POST_RESTRICTED',
        '로그인해야 볼 수 있는 게시물입니다.',
        `Threads가 일부 사용자에게 공개하지 않는 게시물입니다. ${LOGIN_HINT}`,
      );
    }
    if (looksLikeLoginWall(bodyText)) {
      throw new ArchiveError('POST_RESTRICTED', 'Threads가 로그인을 요구했습니다.', LOGIN_HINT);
    }
  }

  /**
   * CDN 미디어를 내려받는다. 만료되는 서명 URL이므로 추출 직후 호출해야 한다.
   * 진행률을 알리기 위해 Playwright 요청(본문을 한 번에만 돌려줌) 대신 Node fetch로 스트리밍하고,
   * 브라우저 세션과 같은 쿠키·User-Agent를 붙인다.
   */
  async downloadBuffer(url: string, options: MediaDownloadOptions = {}): Promise<{ body: Buffer; contentType: string | null }> {
    const context = this.requireContext();
    const cookies = await context.cookies(url);
    return fetchStreaming(url, {
      ...options,
      cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    });
  }
}

export interface MediaDownloadOptions {
  referer?: string;
  /** 받은 바이트 수와 전체 크기(Content-Length가 없으면 undefined) */
  onBytes?: (received: number, total: number | undefined) => void;
  signal?: AbortSignal;
}

const MEDIA_TIMEOUT_MS = 120_000;

const PREVIEW_SEEK_SEC = 1;
const PREVIEW_WIDTH = 360;

/**
 * 포스터가 없는 영상은 앞부분 한 장면(약 1초, 짧은 영상은 10% 지점)을 작은 JPEG로 찍어
 * previewUrl(data URL)에 넣는다. Threads 페이지에서 바로 찍으면 로그인 팝업·어두운 배경이 겹치므로
 * 같은 브라우저 세션의 빈 페이지에 영상만 띄워 찍는다.
 * 미리보기 썸네일은 부가 정보라서, 한 영상이 실패해도 추출 자체는 실패시키지 않고 그 영상만 건너뛴다.
 */
async function captureVideoPreviews(context: BrowserContext, archive: ThreadArchive): Promise<void> {
  const targets = archive.posts.flatMap((post) => post.media).filter((m) => m.kind === 'video' && !m.previewUrl);
  if (targets.length === 0) return;

  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: PREVIEW_WIDTH, height: 1200 });
    for (const asset of targets) {
      try {
        await page.setContent(
          `<body style="margin:0;background:#000"><video muted playsinline preload="auto" style="display:block;width:${PREVIEW_WIDTH}px"></video></body>`,
        );
        const ready = await page.evaluate(
          ({ src, seekSec }) =>
            new Promise<boolean>((resolve) => {
              const video = document.querySelector('video')!;
              const timer = setTimeout(() => resolve(false), 8_000);
              const finish = (ok: boolean) => {
                clearTimeout(timer);
                resolve(ok);
              };
              video.addEventListener('error', () => finish(false), { once: true });
              video.addEventListener(
                'loadeddata',
                () => {
                  const target =
                    Number.isFinite(video.duration) && video.duration > 0 ? Math.min(seekSec, video.duration * 0.1) : 0;
                  video.addEventListener('seeked', () => finish(true), { once: true });
                  video.currentTime = target;
                },
                { once: true },
              );
              video.src = src;
            }),
          { src: asset.url, seekSec: PREVIEW_SEEK_SEC },
        );
        if (!ready) continue;

        const shot = await page.locator('video').screenshot({ type: 'jpeg', quality: 70, timeout: 5_000 });
        asset.previewUrl = `data:image/jpeg;base64,${shot.toString('base64')}`;
      } catch {
        // 위 주석대로 이 영상은 미리보기 없이 진행한다. UI는 썸네일 대신 종류 표시만 보여 준다.
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function fetchStreaming(
  url: string,
  options: MediaDownloadOptions & { cookie: string },
): Promise<{ body: Buffer; contentType: string | null }> {
  const timeout = AbortSignal.timeout(MEDIA_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = {
    referer: options.referer ?? 'https://www.threads.com/',
    accept: '*/*',
    'user-agent': USER_AGENT,
  };
  if (options.cookie) headers.cookie = options.cookie;

  let response: Response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (error) {
    throw downloadError(error, signal);
  }

  if (!response.ok || !response.body) {
    throw new ArchiveError(
      'DOWNLOAD_FAILED',
      `미디어를 내려받지 못했습니다 (HTTP ${response.status}).`,
      'CDN 주소는 몇 시간 뒤 만료됩니다. 링크를 다시 추출해 주세요.',
    );
  }

  const length = Number(response.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  const chunks: Uint8Array[] = [];
  let received = 0;
  options.onBytes?.(0, total);

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      options.onBytes?.(received, total);
    }
  } catch (error) {
    throw downloadError(error, signal);
  }

  return { body: Buffer.concat(chunks), contentType: response.headers.get('content-type') };
}

function downloadError(error: unknown, signal: AbortSignal): ArchiveError {
  if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
    return new ArchiveError('DOWNLOAD_FAILED', '미디어를 내려받는 시간이 너무 오래 걸려 중단했습니다.', '네트워크 상태를 확인하고 다시 시도해 주세요.');
  }
  if (signal.aborted) return new ArchiveError('CANCELLED', '다운로드를 취소했습니다.');
  return new ArchiveError(
    'DOWNLOAD_FAILED',
    `미디어를 내려받지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    '네트워크 상태를 확인하고 다시 시도해 주세요.',
  );
}

/** 영상 플레이어가 늦게 그려질 때 다시 읽으며 기다리는 최대 시간과 간격 */
const VIDEO_RENDER_WAIT_MS = 8_000;
const VIDEO_RENDER_POLL_MS = 500;

/**
 * 게시물 화면을 읽고 영상 주소를 원본으로 맞춘다.
 *
 * - 페이지 JSON에는 영상이 있는데 화면에 <video>가 아직 없으면(첫 실행처럼 느릴 때) 잠시 다시 읽으며 기다린다.
 *   끝내 그려지지 않으면 썸네일을 이미지로 저장하는 대신 JSON의 영상 주소로 채운다.
 * - 영상이 든 여러 장짜리는 JSON의 장별 구성에 맞춰 섞인 사진을 남기고, 로그인 상태에서 아직 그려지지 않은
 *   장의 영상도 JSON 주소로 채운다(구성이 맞지 않으면 보이는 영상만).
 * - 로그인 상태에서 blob: 으로만 보이는 영상은 JSON의 원본 mp4 주소로 바꾼다. 못 바꾼 것은 그대로 둔다.
 */
async function readPostWithVideos(page: Page, parsed: ParsedThreadsUrl): Promise<RawDomResult> {
  let raw = (await page.evaluate(extractThreadsDom)) as RawDomResult;
  const jsonTexts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script[type="application/json"]'))
      .map((script) => script.textContent ?? '')
      .filter((text) => text.includes('video_versions')),
  );
  const urlsByCode = videoUrlsByCode(jsonTexts);
  // 아카이브에 들어가는 게시물만 따진다 (같은 화면의 다른 사람 답글 영상은 상관없음).
  const missing = () => postsMissingVideos(raw, urlsByCode, archiveCodes(raw, parsed));

  const deadline = Date.now() + VIDEO_RENDER_WAIT_MS;
  while (missing().length > 0 && Date.now() < deadline) {
    await page.waitForTimeout(VIDEO_RENDER_POLL_MS);
    raw = (await page.evaluate(extractThreadsDom)) as RawDomResult;
  }
  const carouselKinds = carouselKindsByCode(jsonTexts);
  fillVideosFromPageData(raw, urlsByCode, missing(), carouselKinds);
  alignCarouselMedia(raw, urlsByCode, carouselKinds);

  resolveBlobVideos(raw, urlsByCode);
  return raw;
}

/** 아카이브에 들어갈 게시물 코드. 게시물을 못 찾는 화면이면 비워 두고, 그 오류는 buildArchive가 낸다. */
function archiveCodes(raw: RawDomResult, parsed: ParsedThreadsUrl): string[] {
  try {
    return buildArchive(raw, parsed).posts.map((post) => post.shortcode);
  } catch {
    return [];
  }
}

/** 로그인하면 threads.com에 생기는 세션 쿠키 값 */
export async function sessionCookie(context: BrowserContext): Promise<string | undefined> {
  const cookies = await context.cookies('https://www.threads.com');
  return cookies.find((cookie) => cookie.name === 'sessionid' && cookie.value)?.value;
}

/**
 * 로그인 창에서 로그인이 끝나기를 기다린다.
 * 창을 연 뒤 새 세션 쿠키가 생기면 true. 그 전에 창이 닫히거나 시간이 다 되면
 * 그때까지 확인한 쿠키 유무를 돌려준다(이미 로그인돼 있던 경우 true).
 */
export async function waitForLogin(context: BrowserContext, timeoutMs: number, pollMs = 1000): Promise<boolean> {
  const before = await sessionCookie(context);
  let latest = before;
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(timeout);
      resolve(value);
    };
    const poll = setInterval(() => {
      sessionCookie(context).then(
        (cookie) => {
          latest = cookie;
          if (cookie && cookie !== before) finish(true);
        },
        () => undefined,
      );
    }, pollMs);
    const timeout = setTimeout(() => finish(Boolean(latest)), timeoutMs);
    context.once('close', () => finish(Boolean(latest)));
  });
}

/** 로그아웃 상태에서 민감·연령 제한 게시물을 열면 나오는 안내 ("This content isn't available to everyone") */
const RESTRICTED_PATTERN = /isn['’]t available to everyone|can['’]t be seen by certain audiences/i;

const LOGIN_HINT =
  "앱에서는 설정의 'Threads 로그인', CLI에서는 `--login`으로 한 번 로그인하면 세션이 저장되어 다음부터 자동으로 사용됩니다.";

function looksLikeLoginWall(text: string): boolean {
  const normalized = text.toLowerCase();
  const signals = ['log in to see', '로그인하여', '로그인이 필요', 'sign in to see'];
  return signals.some((signal) => normalized.includes(signal.toLowerCase())) && !normalized.includes('views');
}

function buildArchive(raw: RawDomResult, parsed: ParsedThreadsUrl): ThreadArchive {
  if (raw.posts.length === 0) {
    throw new ArchiveError(
      'POST_NOT_FOUND',
      '게시물을 찾지 못했습니다.',
      `페이지 제목: ${raw.page.title || '(없음)'}`,
    );
  }

  const index = raw.posts.findIndex((post) => post.shortcode === parsed.shortcode);
  const rootIndex = index >= 0 ? index : 0;

  if (index < 0 && raw.posts[0]!.username.toLowerCase() !== parsed.username.toLowerCase()) {
    throw new ArchiveError(
      'POST_NOT_FOUND',
      '요청한 게시물이 페이지에서 확인되지 않았습니다.',
      '게시물이 삭제되었거나 비공개로 전환되었을 수 있습니다.',
    );
  }

  const root = raw.posts[rootIndex]!;
  const owner = root.username;

  const chain = [root];
  for (let i = rootIndex + 1; i < raw.posts.length; i += 1) {
    const next = raw.posts[i]!;
    if (next.username.toLowerCase() !== owner.toLowerCase()) break;
    chain.push(next);
  }

  const posts: ThreadsPost[] = chain.map((post) => normalizePost(post, owner));

  return {
    sourceUrl: parsed.url,
    owner,
    posts,
    extractedAt: new Date().toISOString(),
    extractor: { name: 'threads-dom', version: '1' },
  };
}

function normalizePost(raw: RawDomResult['posts'][number], owner: string): ThreadsPost {
  const seen = new Set<string>();
  const media = raw.media.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });

  const shortcode = raw.shortcode ?? '';
  return {
    shortcode,
    permalink: raw.permalink ?? (shortcode ? `https://www.threads.com/@${owner}/post/${shortcode}` : ''),
    author: {
      username: raw.username,
      displayName: raw.displayName,
      verified: raw.verified,
      avatarUrl: raw.avatarUrl,
    },
    text: raw.text,
    postedAt: raw.postedAt,
    media: media.map((item) => ({
      kind: item.kind,
      url: item.url,
      width: item.width,
      height: item.height,
      durationSec: item.durationSec,
      previewUrl: item.previewUrl,
    })),
    stats: raw.stats,
  };
}
