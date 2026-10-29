import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { archiveThread, extractThread } from './archive.js';
import { defaultBaseDir, summarize } from './download.js';
import { ThreadsSession } from './extract/session.js';
import { defaultProfileDir } from './paths.js';
import { ArchiveError } from './types.js';

const HELP = `
threads-archiver — Threads 게시물 아카이버

사용법
  threads-archiver <threads-게시물-링크> [옵션]

옵션
  -o, --out <폴더>    상위 저장 폴더. 그 아래 '<작성일> @<작성자> - <요약>' 폴더에 저장
                      (기본: ${defaultBaseDir()})
      --no-media      미디어 없이 글만 저장
      --no-markdown   Markdown 파일을 만들지 않음
      --json          결과를 JSON으로 출력
      --headed        브라우저 창을 띄워 실행 (문제 확인용)
      --profile <폴더> 로그인 세션 폴더
      --login         로그인용 브라우저를 열고, 로그인 후 Enter를 누르면 저장
  -h, --help          도움말

예시
  threads-archiver "https://www.threads.com/@zuck/post/DeZtp-TkQHh"
  threads-archiver https://www.threads.net/@nasa/post/Decc755lYhC -o D:\\Archive\\nasa
  threads-archiver --login
`.trim();

interface CliOptions {
  url?: string;
  outputDir?: string;
  includeMedia: boolean;
  includeMarkdown: boolean;
  json: boolean;
  headed: boolean;
  profileDir: string;
  login: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    includeMedia: true,
    includeMarkdown: true,
    json: false,
    headed: false,
    profileDir: defaultProfileDir(),
    login: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      case '-o':
      case '--out':
        options.outputDir = argv[++i];
        break;
      case '--no-media':
        options.includeMedia = false;
        break;
      case '--no-markdown':
        options.includeMarkdown = false;
        break;
      case '--json':
        options.json = true;
        break;
      case '--headed':
        options.headed = true;
        break;
      case '--profile':
        options.profileDir = argv[++i] ?? options.profileDir;
        break;
      case '--login':
        options.login = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`알 수 없는 옵션: ${arg}`);
          process.exit(2);
        }
        options.url ??= arg;
    }
  }

  return options;
}

async function login(profileDir: string): Promise<void> {
  const session = new ThreadsSession({ profileDir, headed: true });
  await session.open();
  console.log('브라우저에서 Threads에 로그인하세요. 끝나면 이 터미널에서 Enter를 누르세요.');
  await session.openPage('https://www.threads.com/');
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
  await session.close();
  console.log(`로그인 세션을 저장했습니다: ${profileDir}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.login) {
    await login(options.profileDir);
    return;
  }

  if (!options.url) {
    console.log(HELP);
    process.exit(2);
  }

  const sessionOptions = { profileDir: options.profileDir, headed: options.headed };
  const isTty = process.stdout.isTTY && !options.json;

  if (!options.includeMedia) {
    const { archive } = await extractThread(options.url, sessionOptions);
    console.log(summarize(archive));
    console.log(options.json ? JSON.stringify(archive, null, 2) : renderPreview(archive));
    return;
  }

  const result = await archiveThread(options.url, {
    ...sessionOptions,
    baseDir: options.outputDir,
    includeMedia: options.includeMedia,
    includeMarkdown: options.includeMarkdown,
    onProgress: isTty
      ? (progress) => {
          process.stdout.write(`\r${(progress.ratio * 100).toFixed(0).padStart(3)}%  ${progress.message.padEnd(60).slice(0, 60)}`);
        }
      : undefined,
  });

  if (isTty) process.stdout.write('\n');

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(summarize(result.archive));
  console.log(`저장 위치: ${result.outputDir}`);
  console.log(`파일 ${result.files.filter((file) => file.kind !== 'metadata').length}개 · 메타데이터 ${result.manifestPath}`);
}

function renderPreview(archive: { posts: Array<{ text: string; media: unknown[] }> }): string {
  return archive.posts
    .map((post, index) => {
      const preview = post.text.length > 200 ? `${post.text.slice(0, 200)}…` : post.text;
      return `\n[${index + 1}] ${preview}\n    미디어 ${post.media.length}개`;
    })
    .join('\n');
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    if (error instanceof ArchiveError) {
      console.error(`\n✖ ${error.message}`);
      if (error.hint) console.error(`  → ${error.hint}`);
      process.exit(error.code === 'CANCELLED' ? 130 : 1);
    }
    console.error('\n✖ 예기치 못한 오류:', error);
    process.exit(1);
  });
}
