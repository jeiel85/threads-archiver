import { describe, expect, it } from 'vitest';
import { defaultFolderName, renderMarkdown } from '../src/download.js';
import type { ThreadArchive } from '../src/types.js';

const archive: ThreadArchive = {
  sourceUrl: 'https://www.threads.com/@zuck/post/DeZtp-TkQHh',
  owner: 'zuck',
  extractedAt: '2026-10-29T00:00:00.000Z',
  extractor: { name: 'threads-dom', version: '1' },
  posts: [
    {
      shortcode: 'DeZtp-TkQHh',
      permalink: 'https://www.threads.com/@zuck/post/DeZtp-TkQHh',
      author: { username: 'zuck', verified: true },
      text: '첫 번째 글',
      postedAt: '2026-10-13T01:56:29.000Z',
      media: [
        {
          kind: 'image',
          url: 'https://cdn.example/a.jpg',
          width: 1080,
          height: 1350,
          fileName: '01.jpg',
          bytes: 1024,
        },
      ],
    },
    {
      shortcode: 'DeZtrvAEfEr',
      permalink: 'https://www.threads.com/@zuck/post/DeZtrvAEfEr',
      author: { username: 'zuck' },
      text: '이어 쓴 글',
      postedAt: '2026-10-13T01:57:09.000Z',
      media: [
        {
          kind: 'video',
          url: 'https://cdn.example/b.mp4',
          fileName: '02.mp4',
          bytes: 2048,
        },
      ],
    },
  ],
};

describe('renderMarkdown', () => {
  it('타래의 모든 게시물과 미디어 링크를 담는다', () => {
    const markdown = renderMarkdown(archive);
    expect(markdown).toContain('# @zuck — Threads 아카이브');
    expect(markdown).toContain(archive.sourceUrl);
    expect(markdown).toContain('첫 번째 글');
    expect(markdown).toContain('이어 쓴 글');
    expect(markdown).toContain('[01.jpg](01.jpg)');
    expect(markdown).toContain('[02.mp4](02.mp4)');
  });
});

describe('defaultFolderName', () => {
  it('작성자와 게시물 ID로 폴더명을 만든다', () => {
    expect(defaultFolderName(archive)).toBe('zuck_DeZtp-TkQHh');
  });

  it('파일명에 쓸 수 없는 문자를 치환한다', () => {
    const risky: ThreadArchive = { ...archive, owner: 'a:b/c\\d*e?f"g<h>i|j' };
    expect(defaultFolderName(risky)).toBe('a_b_c_d_e_f_g_h_i_j_DeZtp-TkQHh');
  });
});
