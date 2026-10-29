import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** 기본 저장 위치: <홈>/Downloads/Threads Archiver */
export function defaultBaseDir(): string {
  return path.join(os.homedir(), 'Downloads', 'Threads Archiver');
}

/** 로그인 세션(쿠키) 보관 위치 */
export function defaultProfileDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Threads Archiver', 'browser-profile');
}
