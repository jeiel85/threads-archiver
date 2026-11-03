#!/usr/bin/env node
// 설치본에 넣을 엔진·Node 런타임을 apps/desktop/src-tauri/bundle-resources/ 에 모읍니다.
// `npm run bundle`(tauri.bundle.json의 beforeBuildCommand)에서 실행됩니다.
//
//   engine/server.js …          packages/core/dist 의 .js
//   engine/node_modules/…       playwright, playwright-core (Chromium은 넣지 않음 → 시스템 Edge 사용)
//   node/node.exe               이 스크립트를 실행한 Node 실행 파일
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(root, 'packages', 'core');
const coreDist = path.join(coreDir, 'dist');
const outDir = path.join(root, 'apps', 'desktop', 'src-tauri', 'bundle-resources');
const engineDir = path.join(outDir, 'engine');
const nodeDir = path.join(outDir, 'node');

if (!existsSync(path.join(coreDist, 'server.js'))) {
  console.error(`엔진 빌드 결과가 없습니다: ${coreDist} (먼저 npm run build -w @threads-archiver/core)`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(engineDir, { recursive: true });
mkdirSync(nodeDir, { recursive: true });

cpSync(coreDist, engineDir, {
  recursive: true,
  filter: (src) => !/\.(d\.ts|map)$/.test(src),
});
writeFileSync(path.join(engineDir, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2));

// core → playwright → playwright-core 가 실제로 해석하는 위치에서 복사해 버전이 어긋나지 않게 한다.
let resolver = createRequire(path.join(coreDir, 'package.json'));
for (const name of ['playwright', 'playwright-core']) {
  const pkgJson = resolver.resolve(`${name}/package.json`);
  // 타입 선언과 CLI용 스킬 문서는 런타임에 쓰지 않는다. 스킬 문서는 경로가 깊어
  // 설치 경로가 길면 MAX_PATH(260자)를 넘겨 설치가 멈추므로 반드시 뺀다.
  cpSync(path.dirname(pkgJson), path.join(engineDir, 'node_modules', name), {
    recursive: true,
    dereference: true,
    filter: (src) => !/\.d\.ts$/.test(src) && !/[\\/]lib[\\/]tools[\\/]skills([\\/]|$)/.test(src),
  });
  resolver = createRequire(pkgJson);
}

const nodeFile = process.platform === 'win32' ? 'node.exe' : 'node';
cpSync(process.execPath, path.join(nodeDir, nodeFile));

console.log(`Staged engine and Node ${process.version} → ${path.relative(root, outDir)}`);
