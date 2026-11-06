import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSavedArchive, mediaContentType, parseByteRange, readSavedArchive, savedMediaPath } from '../src/saved.js';

describe('저장된 게시물 다시 읽기', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'saved-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('post.json을 읽어 아카이브를 돌려준다', async () => {
    const archive = { sourceUrl: 'https://www.threads.com/@a/post/X', owner: 'a', posts: [], extractedAt: '', extractor: {} };
    await writeFile(path.join(dir, 'post.json'), JSON.stringify(archive), 'utf8');
    await expect(readSavedArchive(dir)).resolves.toMatchObject({ owner: 'a', posts: [] });
  });

  it('post.json이 없으면 다시 받기를 안내한다', async () => {
    await expect(readSavedArchive(dir)).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
  });

  it('형식이 다른 post.json은 해석 실패로 알린다', async () => {
    await writeFile(path.join(dir, 'post.json'), '{"hello":1}', 'utf8');
    await expect(readSavedArchive(dir)).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' });
  });

  it('저장할 때 붙인 이름 형식의 파일만 내보낸다', () => {
    expect(savedMediaPath(dir, '01.jpg')).toBe(path.join(dir, '01.jpg'));
    expect(savedMediaPath(dir, '12.mp4')).toBe(path.join(dir, '12.mp4'));
    expect(savedMediaPath(dir, 'post.json')).toBeUndefined();
    expect(savedMediaPath(dir, '..\\01.jpg')).toBeUndefined();
    expect(savedMediaPath(dir, '../01.jpg')).toBeUndefined();
    expect(savedMediaPath(dir, '01.jpg/..')).toBeUndefined();
  });

  it('확장자로 content-type을 정한다', () => {
    expect(mediaContentType('01.JPG')).toBe('image/jpeg');
    expect(mediaContentType('02.mp4')).toBe('video/mp4');
    expect(mediaContentType('03.xyz')).toBe('application/octet-stream');
  });
});

describe('Range 헤더', () => {
  it('없거나 형식이 다르면 전체를 보낸다', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('items=0-1', 100)).toBeNull();
    expect(parseByteRange('bytes=-', 100)).toBeNull();
  });

  it('시작·끝·끝에서부터 범위를 해석한다', () => {
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 });
    expect(parseByteRange('bytes=-300', 100)).toEqual({ start: 0, end: 99 });
  });

  it('파일 밖을 가리키면 416으로 거절한다', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('invalid');
    expect(parseByteRange('bytes=20-10', 100)).toBe('invalid');
    expect(parseByteRange('bytes=-0', 100)).toBe('invalid');
  });
});

describe('이미 저장한 게시물 빨리 찾기', () => {
  let base: string;
  const link = 'https://www.threads.com/@a/post/ABC123?xmt=tracking';

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'saved-base-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function savePost(folder: string, shortcode: string, media: Array<{ kind: string; fileName?: string }>, files = media) {
    const dir = path.join(base, folder);
    await mkdir(dir, { recursive: true });
    const archive = {
      sourceUrl: `https://www.threads.com/@a/post/${shortcode}`,
      owner: 'a',
      posts: [{ shortcode, text: '본문', media: media.map((m) => ({ url: 'https://cdn/x', ...m })) }],
      extractedAt: '',
      extractor: {},
    };
    await writeFile(path.join(dir, 'post.json'), JSON.stringify(archive), 'utf8');
    for (const file of files) if (file.fileName) await writeFile(path.join(dir, file.fileName), 'data', 'utf8');
    return dir;
  }

  it('같은 게시물 코드의 폴더를 찾아 저장 결과로 돌려준다', async () => {
    await savePost('2026-01-01 @a - 다른 글', 'OTHER', []);
    const dir = await savePost('2026-01-02 @a - 본문 (2)', 'ABC123', [
      { kind: 'image', fileName: '01.jpg' },
      { kind: 'video', fileName: '02.mp4' },
    ]);
    await writeFile(path.join(dir, 'post.md'), '# a', 'utf8');

    const result = await findSavedArchive(base, link);
    expect(result?.outputDir).toBe(path.resolve(dir));
    expect(result?.markdownPath).toBe(path.join(path.resolve(dir), 'post.md'));
    expect(result?.files.filter((file) => file.kind !== 'metadata').map((file) => path.basename(file.path))).toEqual(['01.jpg', '02.mp4']);
    expect(result?.files.find((file) => file.kind === 'image')?.bytes).toBe(4);
  });

  it('미디어 파일이 하나라도 없으면 다 받지 않은 것으로 본다', async () => {
    await savePost('글', 'ABC123', [{ kind: 'image', fileName: '01.jpg' }, { kind: 'image', fileName: '02.jpg' }], [
      { kind: 'image', fileName: '01.jpg' },
    ]);
    await expect(findSavedArchive(base, link)).resolves.toBeUndefined();
  });

  it('미디어 없이 저장한 폴더는 다 받지 않은 것으로 본다', async () => {
    await savePost('글', 'ABC123', [{ kind: 'image' }]);
    await expect(findSavedArchive(base, link)).resolves.toBeUndefined();
  });

  it('저장 폴더가 없거나 코드를 바로 알 수 없는 링크면 찾지 않는다', async () => {
    await expect(findSavedArchive(path.join(base, '없음'), link)).resolves.toBeUndefined();
    await savePost('글', 'ABC123', []);
    await expect(findSavedArchive(base, 'https://www.threads.com/share/xyz')).resolves.toBeUndefined();
    await expect(findSavedArchive(base, link)).resolves.toBeDefined();
  });
});
