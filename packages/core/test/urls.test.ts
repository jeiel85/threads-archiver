import { describe, expect, it } from 'vitest';
import { isShortShareLink, parseThreadsUrl } from '../src/urls.js';
import { ArchiveError } from '../src/types.js';

describe('parseThreadsUrl', () => {
  it('일반 게시물 링크를 정규화한다', () => {
    const parsed = parseThreadsUrl('https://www.threads.com/@zuck/post/DeZtp-TkQHh');
    expect(parsed).toMatchObject({
      username: 'zuck',
      shortcode: 'DeZtp-TkQHh',
      url: 'https://www.threads.com/@zuck/post/DeZtp-TkQHh',
    });
  });

  it('threads.net, /media, 추적 파라미터를 처리한다', () => {
    const parsed = parseThreadsUrl('https://www.threads.net/@nasa/post/Decc755lYhC/media?xmt=AQG123&hl=ko');
    expect(parsed.username).toBe('nasa');
    expect(parsed.shortcode).toBe('Decc755lYhC');
    expect(parsed.url).toBe('https://www.threads.com/@nasa/post/Decc755lYhC');
  });

  it('공유 문구에 섞인 링크를 뽑아낸다', () => {
    const parsed = parseThreadsUrl('이 글 봐 https://www.threads.com/@zuck/post/DeZtp-TkQHh 진짜 좋다');
    expect(parsed.shortcode).toBe('DeZtp-TkQHh');
  });

  it('스킴이 없는 입력도 받아들인다', () => {
    expect(parseThreadsUrl('threads.com/@zuck/post/DeZtp-TkQHh').shortcode).toBe('DeZtp-TkQHh');
  });

  it('게시물 주소가 아니면 INVALID_URL로 실패한다', () => {
    expect(() => parseThreadsUrl('https://www.threads.com/@zuck')).toThrowError(ArchiveError);
    try {
      parseThreadsUrl('https://example.com/@zuck/post/abc');
    } catch (error) {
      expect((error as ArchiveError).code).toBe('INVALID_URL');
    }
  });

  it('빈 입력을 거부한다', () => {
    expect(() => parseThreadsUrl('   ')).toThrowError(ArchiveError);
  });
});

describe('isShortShareLink', () => {
  it('share 단축 링크를 구분한다', () => {
    expect(isShortShareLink('https://www.threads.com/share/BAH123abc')).toBe(true);
    expect(isShortShareLink('https://www.threads.com/@zuck/post/DeZtp-TkQHh')).toBe(false);
  });
});
