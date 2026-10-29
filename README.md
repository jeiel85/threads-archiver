# Threads Archiver

Threads 게시물 링크 하나로 사진·영상·글(작성자가 이어 쓴 연속 게시물 포함)을 내 컴퓨터에 저장하는 개인 백업용 데스크톱 앱입니다.

![미리보기와 저장 완료 화면](docs/screenshot-done.png)

## 구성

| 경로 | 내용 |
| --- | --- |
| `packages/core` | 추출·다운로드 엔진. Playwright(Chromium)로 게시물 페이지를 열어 글과 미디어를 수집합니다. CLI와 로컬 HTTP 엔진 서버를 함께 제공합니다. |
| `apps/desktop` | Tauri 2 + React 데스크톱 앱. 실행 시 `node`로 엔진 서버(`packages/core/dist/server.js`)를 띄우고, 무작위 토큰을 붙여 `127.0.0.1`로만 통신합니다. |
| `scripts/install-browser.mjs` | Playwright용 Chromium 설치(최초 1회, 약 150MB) |
| `scripts/smoke.mjs` | 실제 게시물로 엔진 → 미리보기 → 다운로드 전 과정을 확인하는 스모크 테스트 |

## 요구 사항

- Node.js 20.11 이상 (데스크톱 앱도 PATH의 `node`로 엔진을 실행합니다)
- 데스크톱 앱 빌드 시 Rust 툴체인과 [Tauri 2 사전 요구 사항](https://tauri.app/start/prerequisites/)

## 시작하기

```bash
npm install
npm run setup:browser
```

### 데스크톱 앱 (개발 모드)

```bash
npm run tauri -w @threads-archiver/desktop -- dev
```

링크를 붙여 넣고 **미리보기**로 글과 미디어 썸네일을 확인한 뒤 **다운로드**를 누르면 됩니다. 저장 폴더(기본 `<홈>\Downloads\Threads Archiver`) 아래에 게시물마다 하위 폴더를 만들어 저장합니다.

```
Threads Archiver/
  2026-10-14 @nasa - Spotted views of a space jellyfish…/
  2026-10-13 @zuck - Introducing Muse Wonder, our new family…/
```

폴더 이름은 `<작성일> @<작성자> - <본문 첫 줄 요약>`이라 이름순 정렬이 곧 시간순입니다. 본문이 없으면 게시물 ID를 쓰고, 같은 이름의 다른 게시물이 있으면 ` (2)`처럼 번호를 붙입니다. 같은 게시물을 다시 받으면 기존 폴더를 덮어씁니다.

### 클립보드 감시 · 트레이

- **클립보드 감시**(기본 꺼짐): Threads 게시물·공유 링크를 복사하면 화면 우측 하단에 알림이 뜨고, **다운로드**를 누르면 기본 저장 폴더(`Downloads\Threads Archiver`) 아래 게시물 폴더에 바로 저장합니다. 이미 받은 게시물이면 같은 폴더에 다시 저장했다고 알려 줍니다.
  - 클립보드 변경 번호만 0.5초마다 비교하고, 바뀌었을 때만 텍스트를 읽어 Threads 링크인지 확인합니다. 내용은 저장하거나 보내지 않습니다.
  - 감시를 켜기 전에 이미 복사돼 있던 링크와, 이번 실행에서 이미 알린 링크에는 다시 반응하지 않습니다.
  - 갤럭시 폰은 **Windows와 연결(Link to Windows)** 앱에서 클립보드 동기화를 켜면 폰에서 복사한 링크도 감지됩니다. 아이폰은 Windows와 클립보드를 동기화하는 공식 방법이 없어 지원하지 않습니다.
- **진행률**: 알림 창과 메인 창에 받은 용량(`5.6 / 8.1MB`)과 %가 표시됩니다. 받는 중 알림 창의 `–`(숨기기)를 눌러도 다운로드는 계속되며, 트레이 아이콘에 마우스를 올리면 진행률이 보이고 클릭하면 진행 창이 다시 뜹니다.
- **트레이**: 창을 닫으면 트레이로 내려가 계속 실행됩니다. 트레이 메뉴에서 열기 · 클립보드 감시 켜기/끄기 · 종료를 할 수 있습니다. 이미 실행 중일 때 다시 실행하면 기존 창이 열립니다.
- **Windows 시작 시 트레이로 실행**(기본 꺼짐): 켜면 `HKCU\…\Run`에 `--minimized` 인자로 등록되어 로그인 시 창 없이 트레이에서 시작합니다.

### CLI

```bash
npm run build -w @threads-archiver/core
node packages/core/dist/cli.js "https://www.threads.com/@nasa/post/Decc755lYhC"
```

주요 옵션은 `-o <상위 폴더>`, `--no-media`, `--no-markdown`, `--json`, `--headed`, `--login`입니다. 전체 목록은 `--help`로 확인하세요.
로그인이 필요한 게시물은 `--login`으로 브라우저를 열어 로그인해 두면, 세션이 `%LOCALAPPDATA%\Threads Archiver\browser-profile`에 저장되어 이후 실행에 쓰입니다.

## 저장 결과

```
<저장 폴더>/<작성일> @<작성자> - <요약>/
  01.jpg, 02.mp4, …   # 미디어 (게시물 순서대로 번호)
  post.json           # 작성자·게시물·미디어 메타데이터 전체
  post.md             # 사람이 읽기 좋은 Markdown 요약
```

## 개발

```bash
npm test            # core 단위 테스트 (vitest)
npm run typecheck   # 전체 워크스페이스 타입 검사
node scripts/smoke.mjs [threads-url] [baseDir]  # 네트워크·Chromium 필요
```

미리보기 썸네일은 원본을 받지 않습니다. 이미지는 CDN이 제공하는 320px급 축소본을 쓰고, 영상은 추출에 쓴 브라우저에서 약 1초 지점 한 장면을 360px JPEG(수~수십 KB)로 찍습니다. 썸네일을 만들지 못한 미디어는 종류·해상도만 표시합니다. 영상 캡처는 `post.json`에 저장하지 않습니다.

## 현재 한계

- 릴리스 설치본은 아직 없습니다. 엔진이 시스템 `node`와 Playwright Chromium에 의존하므로, 배포하려면 Node 런타임·엔진·브라우저를 함께 번들링하는 방식을 먼저 정해야 합니다.
- Threads 페이지 구조가 바뀌면 추출이 깨질 수 있습니다. `scripts/smoke.mjs`로 주기적으로 확인하세요.

## 주의

개인 백업용 도구입니다. 저작권과 Threads 이용약관을 존중해 주세요.
