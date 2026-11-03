import { EventEmitter } from 'node:events';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { waitForLogin } from '../src/extract/session.js';

/** 쿠키 목록과 close 이벤트만 흉내 낸 브라우저 컨텍스트 */
function fakeContext(initial?: string) {
  const emitter = new EventEmitter();
  const state = { session: initial };
  const context = Object.assign(emitter, {
    cookies: async () => (state.session ? [{ name: 'sessionid', value: state.session }] : []),
  }) as unknown as BrowserContext;
  return { context, state, close: () => emitter.emit('close') };
}

describe('로그인 완료 감지', () => {
  it('창을 연 뒤 새 세션 쿠키가 생기면 창을 닫지 않아도 로그인으로 끝난다', async () => {
    const { context, state } = fakeContext();
    const result = waitForLogin(context, 5_000, 10);
    setTimeout(() => (state.session = 'new'), 30);
    await expect(result).resolves.toBe(true);
  });

  it('로그인하지 않고 창을 닫으면 로그인 안 됨', async () => {
    const { context, close } = fakeContext();
    const result = waitForLogin(context, 5_000, 10);
    setTimeout(close, 30);
    await expect(result).resolves.toBe(false);
  });

  it('이미 로그인돼 있던 창은 저절로 닫히지 않고, 사용자가 닫으면 로그인됨으로 끝난다', async () => {
    const { context, close } = fakeContext('existing');
    let settled = false;
    const result = waitForLogin(context, 5_000, 10).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    close();
    await expect(result).resolves.toBe(true);
  });

  it('제한 시간이 지나면 그때까지 확인한 쿠키로 끝난다', async () => {
    const { context } = fakeContext();
    await expect(waitForLogin(context, 50, 10)).resolves.toBe(false);
  });
});
