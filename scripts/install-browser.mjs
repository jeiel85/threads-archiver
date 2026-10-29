#!/usr/bin/env node
// Playwright가 사용하는 Chromium을 내려받습니다. (최초 1회, 약 150MB)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', 'playwright', 'cli.js');

console.log('Installing Chromium for Playwright…');
const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  cwd: root,
  stdio: 'inherit',
});

if (result.status !== 0) {
  console.error('Chromium install failed. Run `npx playwright install chromium` manually.');
  process.exit(result.status ?? 1);
}

console.log('Done.');
