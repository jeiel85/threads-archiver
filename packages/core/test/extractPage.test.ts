import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractThreadsDom, type RawDomResult } from '../src/dom/extractPage.js';
import { resolveBrowserChannel } from '../src/extract/session.js';

/**
 * extractThreadsDom은 페이지 안에서 실행되는 함수라 실제 브라우저(Chromium 또는 Windows의 Edge)로 확인한다.
 * 마크업은 Threads 게시물 화면 구조를 필요한 만큼만 줄인 것이다.
 */
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, channel: resolveBrowserChannel() });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function extract(body: string): Promise<RawDomResult> {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
    return (await page.evaluate(extractThreadsDom)) as RawDomResult;
  } finally {
    await page.close();
  }
}

const post = (inner: string) => `
  <div data-pressable-container>
    <a href="/@nookvale">nookvale</a>
    <a href="/@nookvale/post/DfYaOBMCOCv"><time datetime="2026-11-05T10:00:00.000Z">1d</time></a>
    <span dir="auto">A little sunrise drive</span>
    ${inner}
  </div>`;

describe('게시물 DOM 추출', () => {
  it('게시물에 붙인 음악 플레이어의 숨은 video는 영상으로 세지 않는다', async () => {
    // 실제 화면: "Play music" 버튼 안에 display:none인 <video>(blob, 소리만)가 본 영상보다 먼저 나온다.
    const raw = await extract(
      post(`
        <div role="button" aria-label="Play music"><div><video playsinline src="blob:https://www.threads.com/music" style="display: none"></video></div></div>
        <div><video playsinline src="blob:https://www.threads.com/main" style="width: 320px; height: 180px"></video></div>
      `),
    );

    expect(raw.posts).toHaveLength(1);
    expect(raw.posts[0]!.media.map((media) => [media.kind, media.url])).toEqual([
      ['video', 'blob:https://www.threads.com/main'],
    ]);
  });

  it('음악만 붙인 글에서도 이미지는 그대로 모은다', async () => {
    const raw = await extract(
      post(`
        <div role="button" aria-label="Play music"><video src="blob:https://www.threads.com/music" style="display: none"></video></div>
        <picture><img src="https://cdn.example/photo.jpg" alt="photo" width="640" height="480"></picture>
      `),
    );

    expect(raw.posts[0]!.media.map((media) => [media.kind, media.url])).toEqual([
      ['image', 'https://cdn.example/photo.jpg'],
    ]);
  });

  it('영상과 같은 장의 이미지는 썸네일(미리보기)로 쓰고, 다른 장의 사진은 이미지로 모은다', async () => {
    // 실제 화면(@mosseri/post/DdjvqxNAdWd): 첫 장 사진은 <picture>, 영상 장은 썸네일 <img>와 <video>가 한 칸에 겹친다.
    const raw = await extract(
      post(`
        <div class="row">
          <div><picture><img src="https://cdn.example/photo.jpg" width="640" height="853"></picture></div>
          <div><img src="https://cdn.example/thumb-1.jpg"><video src="https://cdn.example/v1.mp4"></video></div>
          <div><img src="https://cdn.example/thumb-2.jpg"><video src="https://cdn.example/v2.mp4"></video></div>
        </div>
      `),
    );

    expect(raw.posts[0]!.media.map((media) => [media.kind, media.url, media.previewUrl])).toEqual([
      ['image', 'https://cdn.example/photo.jpg', 'https://cdn.example/photo.jpg'],
      ['video', 'https://cdn.example/v1.mp4', 'https://cdn.example/thumb-1.jpg'],
      ['video', 'https://cdn.example/v2.mp4', 'https://cdn.example/thumb-2.jpg'],
    ]);
  });

  it('로그인 상태에서 아직 <video>가 그려지지 않은 장의 썸네일도 화면 순서대로 내보낸다', async () => {
    const raw = await extract(
      post(`
        <div class="row">
          <div><picture><img src="https://cdn.example/photo.jpg"></picture></div>
          <div><img src="https://cdn.example/thumb-1.jpg"><video src="blob:https://www.threads.com/1"></video></div>
          <div><img src="https://cdn.example/thumb-2.jpg"></div>
        </div>
      `),
    );

    expect(raw.posts[0]!.media.map((media) => [media.kind, media.url])).toEqual([
      ['image', 'https://cdn.example/photo.jpg'],
      ['video', 'blob:https://www.threads.com/1'],
      ['image', 'https://cdn.example/thumb-2.jpg'],
    ]);
  });

  it('단일 영상 게시물의 썸네일은 이미지로 저장하지 않는다', async () => {
    const raw = await extract(
      post(`<div><div><picture><img src="https://cdn.example/thumb.jpg"></picture></div><video src="https://cdn.example/v.mp4"></video></div>`),
    );

    expect(raw.posts[0]!.media.map((media) => [media.kind, media.url, media.previewUrl])).toEqual([
      ['video', 'https://cdn.example/v.mp4', 'https://cdn.example/thumb.jpg'],
    ]);
  });

  it('아직 주소가 없는 영상의 썸네일은 지우지 않고 이미지로 남긴다', async () => {
    const raw = await extract(
      post(`
        <div class="row">
          <div><picture><img src="https://cdn.example/photo.jpg"></picture></div>
          <div><img src="https://cdn.example/thumb-1.jpg"><video></video></div>
        </div>
      `),
    );

    expect(raw.posts[0]!.media.map((media) => [media.kind, media.url])).toEqual([
      ['image', 'https://cdn.example/photo.jpg'],
      ['image', 'https://cdn.example/thumb-1.jpg'],
    ]);
  });
});
