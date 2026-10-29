import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultFolderName, renderMarkdown, resolveArchiveDir, summarizeText } from '../src/download.js';
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
      // 정오(UTC)라서 UTC-11 ~ UTC+11 어느 시간대에서 돌려도 날짜가 같다.
      postedAt: '2026-10-13T12:00:00.000Z',
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
      postedAt: '2026-10-13T12:01:00.000Z',
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

function withRoot(patch: Partial<ThreadArchive['posts'][number]>, owner = archive.owner): ThreadArchive {
  return { ...archive, owner, posts: [{ ...archive.posts[0]!, ...patch }, ...archive.posts.slice(1)] };
}

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
  it('작성일·작성자·본문 요약으로 폴더명을 만든다', () => {
    expect(defaultFolderName(archive)).toBe('2026-10-13 @zuck - 첫 번째 글');
  });

  it('본문이 없으면 게시물 ID를 쓴다', () => {
    expect(defaultFolderName(withRoot({ text: '' }))).toBe('2026-10-13 @zuck - DeZtp-TkQHh');
  });

  it('폴더명에 쓸 수 없는 문자는 지우거나 공백으로 바꾸고 끝의 마침표를 지운다', () => {
    const risky = withRoot({ text: 'a:b/c\\d*e?f"g<h>i|j.' }, 'x:y');
    expect(defaultFolderName(risky)).toBe('2026-10-13 @xy - ab c defghi j');
  });

  it('따옴표·콜론이 든 실제 본문도 읽기 좋게 남긴다', () => {
    const quoted = withRoot({ text: 'Spotted: views of a "space jellyfish" following today\'s launch' });
    expect(defaultFolderName(quoted)).toBe('2026-10-13 @zuck - Spotted views of a space jellyfish…');
  });
});

describe('summarizeText', () => {
  it('첫 줄만 쓰고 링크와 연속 공백을 지운다', () => {
    expect(summarizeText('\n  오늘   발표합니다 https://example.com/x \n둘째 줄')).toBe('오늘 발표합니다');
  });

  it('긴 본문은 단어 경계에서 자르고 말줄임표를 붙인다', () => {
    const summary = summarizeText(
      'Spotted: views of a "space jellyfish" following today\'s launch of NASA\'s SpaceX mission',
    );
    expect(summary).toBe('Spotted: views of a "space jellyfish"…');
    expect(Array.from(summary).length).toBeLessThanOrEqual(41);
  });
});

describe('resolveArchiveDir', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'threads-archiver-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('상위 폴더 아래 게시물 폴더 경로를 돌려준다', async () => {
    expect(await resolveArchiveDir(base, archive)).toBe(path.join(base, '2026-10-13 @zuck - 첫 번째 글'));
  });

  it('같은 게시물을 다시 받으면 기존 폴더를 재사용한다', async () => {
    const first = await resolveArchiveDir(base, archive);
    await mkdir(first);
    await writeFile(path.join(first, 'post.json'), JSON.stringify(archive));
    expect(await resolveArchiveDir(base, archive)).toBe(first);
  });

  it('이름이 같은 다른 게시물이면 번호를 붙인다', async () => {
    const first = await resolveArchiveDir(base, archive);
    await mkdir(first);
    await writeFile(path.join(first, 'post.json'), JSON.stringify(withRoot({ shortcode: 'OTHER' })));
    expect(await resolveArchiveDir(base, archive)).toBe(`${first} (2)`);
  });
});
