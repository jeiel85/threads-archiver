#!/usr/bin/env node
// 릴리스에 올릴 파일을 release-assets/ 에 모읍니다. (.github/workflows/release.yml에서 실행)
//
//   node scripts/release-assets.mjs <tag> [owner/repo]
//
//   Threads-Archiver_<버전>_x64-setup.exe   설치본 (GitHub가 공백을 바꾸지 않도록 이름을 정리)
//   latest.json                            자동 업데이트 매니페스트 (tauri-plugin-updater 형식)
//
// 설치본은 `npm run bundle -- --config src-tauri/tauri.updater.json`으로 서명(.sig)까지 만든 상태여야 합니다.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tag, repo = process.env.GITHUB_REPOSITORY ?? 'jeiel85/threads-archiver'] = process.argv.slice(2);
if (!tag) {
  console.error('사용법: node scripts/release-assets.mjs <tag> [owner/repo]');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
if (tag.replace(/^v/, '') !== version) {
  console.error(`태그(${tag})와 앱 버전(${version})이 다릅니다.`);
  process.exit(1);
}

const nsisDir = path.join(root, 'apps/desktop/src-tauri/target/release/bundle/nsis');
const setup = readdirSync(nsisDir).find((name) => name.includes(`_${version}_`) && name.endsWith('-setup.exe'));
if (!setup) {
  console.error(`${nsisDir}에 ${version} 설치본이 없습니다.`);
  process.exit(1);
}
const signature = readFileSync(path.join(nsisDir, `${setup}.sig`), 'utf8').trim();

const outDir = path.join(root, 'release-assets');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir);

const assetName = `Threads-Archiver_${version}_x64-setup.exe`;
copyFileSync(path.join(nsisDir, setup), path.join(outDir, assetName));

const manifest = {
  version,
  notes: `https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${assetName}`,
    },
  },
};
writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`release-assets/: ${assetName}, latest.json`);
