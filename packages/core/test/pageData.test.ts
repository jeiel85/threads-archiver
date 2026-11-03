import { describe, expect, it } from 'vitest';
import type { RawDomResult } from '../src/dom/extractPage.js';
import { resolveBlobVideos, videoUrlsByCode } from '../src/dom/pageData.js';

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
});
