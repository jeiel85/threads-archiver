import { describe, expect, it } from 'vitest';
import type { RawDomResult } from '../src/dom/extractPage.js';
import { fillVideosFromPageData, postsMissingVideos, resolveBlobVideos, videoUrlsByCode } from '../src/dom/pageData.js';

const pageJson = JSON.stringify({
  require: [
    [
      'ScheduledServerJS',
      {
        data: {
          posts: [
            { code: 'SINGLE', video_versions: [{ type: 101, url: 'https://cdn/single-hd.mp4' }, { type: 102, url: 'https://cdn/single-sd.mp4' }] },
            {
              code: 'CAROUSEL',
              video_versions: null,
              carousel_media: [
                { image_versions2: {}, video_versions: null },
                { video_versions: [{ url: 'https://cdn/c-1.mp4' }] },
                { video_versions: [{ url: 'https://cdn/c-2.mp4' }] },
              ],
            },
            { code: 'IMAGE_ONLY', video_versions: null },
            {
              // 릴스를 붙인 글: 영상은 붙인 미디어에 있다. 인용한 게시물의 영상은 쓰지 않는다.
              code: 'LINKED',
              media_type: 19,
              video_versions: null,
              text_post_app_info: {
                linked_inline_media: { code: 'REEL', media_type: 2, video_versions: [{ url: 'https://cdn/reel.mp4' }] },
                share_info: { quoted_post: { code: 'QUOTED', video_versions: [{ url: 'https://cdn/quoted.mp4' }] } },
              },
            },
            {
              code: 'QUOTING',
              video_versions: null,
              text_post_app_info: { share_info: { quoted_post: { code: 'QUOTED2', video_versions: [{ url: 'https://cdn/q2.mp4' }] } } },
            },
            // 같은 게시물이 다시 나와도 먼저 찾은 주소를 쓴다.
            { code: 'SINGLE', video_versions: [{ url: 'https://cdn/duplicate.mp4' }] },
          ],
        },
      },
    ],
  ],
});

function raw(posts: Array<{ shortcode: string; videos: string[] }>): RawDomResult {
  return {
    posts: posts.map(({ shortcode, videos }) => ({
      username: 'a',
      shortcode,
      text: '',
      media: [{ kind: 'image', url: 'https://cdn/thumb.jpg' }, ...videos.map((url) => ({ kind: 'video' as const, url }))],
    })),
    page: {},
  } as unknown as RawDomResult;
}

describe('스트리밍 영상 원본 주소 찾기', () => {
  it('게시물 코드별로 가장 높은 화질 주소를, 여러 장짜리는 영상 순서대로 모은다', () => {
    const map = videoUrlsByCode(['not json', pageJson]);
    expect(map.get('SINGLE')).toEqual(['https://cdn/single-hd.mp4']);
    expect(map.get('CAROUSEL')).toEqual(['https://cdn/c-1.mp4', 'https://cdn/c-2.mp4']);
    expect(map.has('IMAGE_ONLY')).toBe(false);
    expect(map.get('LINKED')).toEqual(['https://cdn/reel.mp4']);
    expect(map.has('QUOTING')).toBe(false);
  });

  it('blob 영상만 원본 주소로 바꾸고, 못 바꾼 수를 돌려준다', () => {
    const result = raw([
      { shortcode: 'CAROUSEL', videos: ['blob:https://www.threads.com/1', 'blob:https://www.threads.com/2'] },
      { shortcode: 'SINGLE', videos: ['https://cdn/already-real.mp4'] },
      { shortcode: 'MISSING', videos: ['blob:https://www.threads.com/3'] },
    ]);
    expect(resolveBlobVideos(result, videoUrlsByCode([pageJson]))).toBe(1);
    expect(result.posts.map((post) => post.media.filter((m) => m.kind === 'video').map((m) => m.url))).toEqual([
      ['https://cdn/c-1.mp4', 'https://cdn/c-2.mp4'],
      ['https://cdn/already-real.mp4'],
      ['blob:https://www.threads.com/3'],
    ]);
  });

  it('JSON엔 영상이 있는데 화면에 <video>가 없는 아카이브 게시물만 누락으로 본다', () => {
    const map = videoUrlsByCode([pageJson]);
    const result = raw([
      { shortcode: 'SINGLE', videos: [] }, // 플레이어가 아직 안 그려져 썸네일만 보임
      { shortcode: 'CAROUSEL', videos: ['blob:https://www.threads.com/1'] }, // 이미 보이는 영상이 있음
      { shortcode: 'IMAGE_ONLY', videos: [] }, // JSON에도 영상이 없음
      { shortcode: 'LINKED', videos: [] }, // 아카이브에 들어가지 않는 다른 사람 답글
    ]);
    expect(postsMissingVideos(result, map, ['SINGLE', 'CAROUSEL', 'IMAGE_ONLY'])).toEqual(['SINGLE']);
  });

  it('끝내 그려지지 않은 영상은 썸네일 이미지 대신 JSON 영상 주소로 채운다', () => {
    const result = raw([
      { shortcode: 'CAROUSEL', videos: [] },
      { shortcode: 'IMAGE_ONLY', videos: [] },
    ]);
    fillVideosFromPageData(result, videoUrlsByCode([pageJson]), ['CAROUSEL']);
    expect(result.posts[0]!.media).toEqual([
      { kind: 'video', url: 'https://cdn/c-1.mp4', previewUrl: 'https://cdn/thumb.jpg' },
      { kind: 'video', url: 'https://cdn/c-2.mp4', previewUrl: 'https://cdn/thumb.jpg' },
    ]);
    expect(result.posts[1]!.media).toEqual([{ kind: 'image', url: 'https://cdn/thumb.jpg' }]);
  });
});
