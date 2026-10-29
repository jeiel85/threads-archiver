#!/usr/bin/env node
// 엔진 → 미리보기 → 다운로드 전체 경로를 실제 Threads 게시물로 확인하는 스모크 테스트.
//
//   node scripts/smoke.mjs                          # 기본 예시 게시물
//   node scripts/smoke.mjs <threads-url> [baseDir]  # 직접 지정 (baseDir 아래 게시물별 폴더에 저장)
//
// 네트워크와 Playwright 브라우저(Chromium)가 필요합니다.

import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(root, 'packages', 'core', 'dist', 'server.js');
const url = process.argv[2] ?? 'https://www.threads.com/@nasa/post/Decc755lYhC';
const outDir = path.resolve(process.argv[3] ?? path.join(root, '.tmp', 'smoke-out'));
const token = 'smoke-test-token';

const server = spawn(process.execPath, [serverScript], {
  cwd: root,
  env: { ...process.env, THREADS_ARCHIVER_TOKEN: token, THREADS_ARCHIVER_PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const fail = (message) => {
  console.error(`\nSMOKE FAILED: ${message}`);
  server.kill();
  process.exit(1);
};

const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('engine did not start within 30s')), 30_000);
  let buffer = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    buffer += chunk;
    const line = buffer.split('\n').find((entry) => entry.startsWith('ENGINE_READY '));
    if (!line) return;
    clearTimeout(timer);
    resolve(JSON.parse(line.slice('ENGINE_READY '.length)).port);
  });
  server.on('exit', (code) => reject(new Error(`engine exited early (code ${code})`)));
}).catch((error) => fail(error.message));

const call = async (pathname, init = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-engine-token': token, ...(init.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname} -> ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
};

const started = Date.now();
try {
  const health = await call('/api/health');
  console.log(`engine ready on 127.0.0.1:${port} (v${health.version})`);

  const { defaultOutputDir } = await call('/api/config');
  console.log(`default output: ${defaultOutputDir}`);

  console.log(`extracting: ${url}`);
  const preview = await call('/api/extract', { method: 'POST', body: JSON.stringify({ url }) });
  const archive = preview.archive;
  const media = archive.posts.flatMap((post) => post.media);
  const images = media.filter((item) => item.kind === 'image').length;
  const videos = media.filter((item) => item.kind === 'video').length;
  console.log(
    `  @${archive.owner} · ${archive.posts.length} post(s) · ${images} image(s) · ${videos} video(s)`,
  );
  console.log(`  suggested folder: ${preview.suggestedDir}`);

  await mkdir(outDir, { recursive: true });
  const { jobId } = await call('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ url, baseDir: outDir }),
  });

  let job;
  let lastMessage = '';
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    ({ job } = await call(`/api/jobs/${jobId}`));
    if (job.message !== lastMessage) {
      lastMessage = job.message;
      console.log(`  ${Math.round(job.progress * 100)}% ${job.message}`);
    }
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') break;
  }

  if (job.status !== 'done') {
    throw new Error(`job ${job.status}: ${job.error?.code ?? ''} ${job.error?.message ?? job.message}`);
  }

  const files = await readdir(job.result.outputDir);
  console.log(`\nSMOKE OK in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  output: ${job.result.outputDir}`);
  console.log(`  files : ${files.join(', ')}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

server.kill();
process.exit(0);
