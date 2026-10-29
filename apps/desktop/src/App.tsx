import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { ThreadArchive } from '@threads-archiver/core';
import { EngineClient, EngineError, waitForEngine, type AppSettings, type EngineInfo, type Job } from './api';

type Phase = 'boot' | 'idle' | 'extracting' | 'preview' | 'downloading' | 'done';

interface PreviewState {
  archive: ThreadArchive;
  folderName: string;
  suggestedDir: string;
}

interface UiError {
  code: string;
  message: string;
  hint?: string;
}

const SAMPLE = 'https://www.threads.com/@zuck/post/DeZtp-TkQHh';

export default function App() {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [client, setClient] = useState<EngineClient | null>(null);
  const [phase, setPhase] = useState<Phase>('boot');
  const [url, setUrl] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const jobId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const info = await waitForEngine();
        if (cancelled) return;
        const engineClient = new EngineClient(info);
        setEngine(info);
        setClient(engineClient);
        setPhase('idle');

        const config = await engineClient.config();
        if (!cancelled) setOutputDir((current) => current || config.defaultOutputDir);
      } catch (cause) {
        if (cancelled) return;
        setPhase('idle');
        setError(toUiError(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!client) return;
    const id = jobId.current;
    if (!id) return;

    let timer: number | undefined;
    let stopped = false;

    const poll = async () => {
      try {
        const current = await client.job(id);
        if (stopped) return;
        setJob(current);
        if (current.status === 'done' || current.status === 'error' || current.status === 'cancelled') {
          if (current.status === 'done') setPhase('done');
          else {
            setPhase('preview');
            if (current.error) setError(current.error);
          }
          return;
        }
      } catch (cause) {
        if (!stopped) {
          setPhase('preview');
          setError(toUiError(cause));
        }
        return;
      }
      timer = window.setTimeout(poll, 400);
    };

    void poll();

    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [client, job?.id]);

  const handleExtract = useCallback(async () => {
    if (!client) return;
    const link = url.trim();
    if (!link) {
      setError({ code: 'INVALID_URL', message: 'Threads 게시물 링크를 먼저 붙여넣어 주세요.' });
      return;
    }

    setError(null);
    setJob(null);
    jobId.current = null;
    setPhase('extracting');

    try {
      const result = await client.extract(link);
      setPreview(result);
      setPhase('preview');
    } catch (cause) {
      setPhase('idle');
      setError(toUiError(cause));
    }
  }, [client, url]);

  const handleDownload = useCallback(async () => {
    if (!client || !preview) return;
    setError(null);
    setPhase('downloading');

    try {
      const { jobId: id } = await client.startArchive(preview.archive.sourceUrl, outputDir);
      jobId.current = id;
      setJob({ id, status: 'queued', progress: 0, message: '대기 중…' });
    } catch (cause) {
      setPhase('preview');
      setError(toUiError(cause));
    }
  }, [client, outputDir, preview]);

  const handlePickFolder = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: '저장 폴더 선택' });
    if (typeof selected === 'string') setOutputDir(selected);
  }, []);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch {
      setError({
        code: 'CLIPBOARD_DENIED',
        message: '클립보드 내용을 읽지 못했습니다.',
        hint: 'Ctrl+V로 직접 붙여넣어 주세요.',
      });
    }
  }, []);

  const openArchiveItem = useCallback(async (path: string) => {
    try {
      await invoke('open_archive_item', { path });
    } catch (cause) {
      setError({ code: 'OPEN_FAILED', message: String(cause) });
    }
  }, []);

  const reset = useCallback(() => {
    setPreview(null);
    setJob(null);
    setError(null);
    jobId.current = null;
    setPhase('idle');
  }, []);

  const busy = phase === 'extracting' || phase === 'downloading' || phase === 'boot';
  const result = job?.status === 'done' ? job.result : undefined;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3v12" strokeLinecap="round" />
              <path d="M7.5 10.5 12 15l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 19h16" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <h1>Threads Archiver</h1>
            <p className="tagline">링크 하나로 사진·영상·글을 내 컴퓨터에</p>
          </div>
        </div>
        <EngineBadge engine={engine} phase={phase} />
      </header>

      <section className="composer">
        <label className="field">
          <span className="field-label">Threads 공유 링크</span>
          <div className={`input-row ${phase === 'extracting' ? 'is-busy' : ''}`}>
            <input
              type="url"
              value={url}
              placeholder={SAMPLE}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !busy) void handleExtract();
              }}
              disabled={busy}
            />
            <button type="button" className="ghost" onClick={handlePaste} disabled={busy}>
              붙여넣기
            </button>
          </div>
        </label>

        <label className="field">
          <span className="field-label">저장 폴더</span>
          <div className="input-row">
            <input
              type="text"
              value={outputDir}
              placeholder="비워 두면 다운로드\Threads Archiver 아래에 저장됩니다"
              spellCheck={false}
              onChange={(event) => setOutputDir(event.target.value)}
              disabled={busy}
            />
            <button type="button" className="ghost" onClick={() => void handlePickFolder()} disabled={busy}>
              찾아보기
            </button>
          </div>
        </label>

        <div className="actions">
          <button type="button" className="primary" onClick={() => void handleExtract()} disabled={busy || !url.trim()}>
            {phase === 'extracting' ? '읽는 중…' : '미리보기'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void handleDownload()}
            disabled={!preview || busy}
          >
            {phase === 'downloading' ? '내려받는 중…' : '다운로드'}
          </button>
          {(preview || error) && !busy ? (
            <button type="button" className="link" onClick={reset}>
              초기화
            </button>
          ) : null}
        </div>

        <SettingsPanel onError={setError} />
      </section>

      {error ? (
        <div className="error-card" role="alert">
          <div className="error-code">{error.code}</div>
          <p className="error-message">{error.message}</p>
          {error.hint ? <p className="error-hint">{error.hint}</p> : null}
        </div>
      ) : null}

      {phase === 'extracting' ? (
        <div className="skeleton-card">
          <span className="spinner" aria-hidden="true" />
          <div>
            <strong>게시물을 읽고 있어요</strong>
            <p>브라우저를 백그라운드로 열어 글과 미디어를 확인합니다. 처음 실행은 조금 더 걸릴 수 있어요.</p>
          </div>
        </div>
      ) : null}

      {preview ? <ArchivePreview preview={preview} outputDir={outputDir} /> : null}

      {phase === 'downloading' && job ? (
        <div className="progress-card">
          <div className="progress-head">
            <strong>{job.message}</strong>
            <span>{Math.round((job.progress ?? 0) * 100)}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.max(4, (job.progress ?? 0) * 100)}%` }} />
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="result-card">
          <div className="result-head">
            <span className="check" aria-hidden="true">✓</span>
            <div>
              <strong>저장 완료</strong>
              <p className="mono path">{result.outputDir}</p>
            </div>
          </div>
          <div className="result-meta">
            <span>미디어 {result.files.filter((file) => file.kind !== 'metadata').length}개</span>
            <span>메타데이터 post.json</span>
            <span>Markdown post.md</span>
          </div>
          <div className="result-actions">
            <button type="button" className="secondary" onClick={() => void openArchiveItem(result.outputDir)}>
              폴더 열기
            </button>
            <button type="button" className="ghost" onClick={() => void openArchiveItem(result.manifestPath)}>
              post.json 열기
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'idle' && !preview && !error ? <EmptyState onPick={setUrl} /> : null}

      <footer className="footer">
        <span>개인 백업용 도구입니다. 저작권과 Threads 이용약관을 존중해 주세요.</span>
        <span className="mono">v0.3.1</span>
      </footer>
    </div>
  );
}

function SettingsPanel({ onError }: { onError: (error: UiError) => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    void invoke<AppSettings>('get_settings').then(setSettings);
    // 트레이 메뉴에서 바꾼 값도 화면에 반영한다.
    const unlisten = listen<AppSettings>('settings-changed', (event) => setSettings(event.payload));
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const change = useCallback(
    async (command: 'set_clipboard_watch' | 'set_autostart', enabled: boolean) => {
      try {
        setSettings(await invoke<AppSettings>(command, { enabled }));
      } catch (cause) {
        onError({ code: 'SETTINGS_FAILED', message: String(cause) });
      }
    },
    [onError],
  );

  if (!settings) return null;

  return (
    <div className="settings">
      <label className="setting">
        <input
          type="checkbox"
          checked={settings.clipboardWatch}
          onChange={(event) => void change('set_clipboard_watch', event.target.checked)}
        />
        <span className="setting-title">클립보드 감시</span>
        <span className="setting-desc">
          Threads 링크를 복사하면 우측 하단 알림에서 바로 다운로드합니다. 갤럭시는 'Windows와 연결'의 클립보드
          동기화를 켜면 폰에서 복사한 링크도 감지합니다. 클립보드 내용은 링크 여부만 확인하고 저장하지 않습니다.
        </span>
      </label>
      <label className="setting">
        <input
          type="checkbox"
          checked={settings.autostart}
          onChange={(event) => void change('set_autostart', event.target.checked)}
        />
        <span className="setting-title">Windows 시작 시 트레이로 실행</span>
        <span className="setting-desc">창을 닫아도 트레이에서 계속 실행됩니다. 완전히 끄려면 트레이 메뉴의 '종료'를 누르세요.</span>
      </label>
    </div>
  );
}

function EngineBadge({ engine, phase }: { engine: EngineInfo | null; phase: Phase }) {
  const state = phase === 'boot' ? 'starting' : engine?.status === 'ready' ? 'ready' : 'error';
  const label =
    state === 'ready' ? '엔진 준비됨' : state === 'starting' ? '엔진 시작 중' : '엔진 오류';

  return (
    <div className={`engine-badge ${state}`}>
      <span className="dot" aria-hidden="true" />
      {label}
    </div>
  );
}

function ArchivePreview({ preview, outputDir }: { preview: PreviewState; outputDir: string }) {
  const { archive } = preview;
  const root = archive.posts[0];
  const images = archive.posts.reduce(
    (sum, post) => sum + post.media.filter((media) => media.kind === 'image').length,
    0,
  );
  const videos = archive.posts.reduce(
    (sum, post) => sum + post.media.filter((media) => media.kind === 'video').length,
    0,
  );

  return (
    <section className="preview-card">
      <div className="preview-head">
        <div className="author">
          <span className="avatar" aria-hidden="true">
            {archive.owner.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <div className="author-name">
              @{archive.owner}
              {root?.author.verified ? <span className="verified" title="인증 계정">✓</span> : null}
            </div>
            <div className="author-meta">
              게시물 {archive.posts.length}개 · 이미지 {images}개 · 영상 {videos}개
            </div>
          </div>
        </div>
        <a className="source" href={archive.sourceUrl} target="_blank" rel="noreferrer">
          원본 보기 ↗
        </a>
      </div>

      <ol className="thread-list">
        {archive.posts.map((post, index) => (
          <li key={`${post.shortcode}-${index}`} className="thread-item">
            <div className="thread-index">{String(index + 1).padStart(2, '0')}</div>
            <div className="thread-body">
              <div className="thread-meta">{formatDate(post.postedAt)}</div>
              {post.text ? <p className="thread-text">{post.text}</p> : <p className="thread-text muted">본문 없음</p>}
              {post.media.length > 0 ? (
                <div className="thumbs">
                  {post.media.map((media, mediaIndex) => (
                    <MediaThumb key={`${media.url.slice(-24)}-${mediaIndex}`} media={media} />
                  ))}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <p className="preview-note mono">저장 위치: {archiveDir(outputDir, preview)}</p>
    </section>
  );
}

type Media = ThreadArchive['posts'][number]['media'][number];

/** 미리보기 썸네일. 미리보기 URL이 없거나 불러오지 못하면 종류·해상도 칩으로 대신한다. */
function MediaThumb({ media }: { media: Media }) {
  const [failed, setFailed] = useState(false);
  const label = media.kind === 'video' ? '영상' : '이미지';
  const detail =
    media.kind === 'video' && media.durationSec
      ? formatDuration(media.durationSec)
      : media.width && media.height
        ? `${media.width}×${media.height}`
        : '';

  if (!media.previewUrl || failed) {
    return (
      <span className={`chip ${media.kind}`}>
        {label}
        {detail ? ` · ${detail}` : ''}
      </span>
    );
  }

  const ratio = media.width && media.height ? media.width / media.height : 1;
  return (
    <figure className={`thumb ${media.kind}`} style={{ aspectRatio: String(Math.min(Math.max(ratio, 0.56), 1.78)) }}>
      <img src={media.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      <figcaption>
        {media.kind === 'video' ? '▶ ' : ''}
        {detail || label}
      </figcaption>
    </figure>
  );
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 상위 폴더 + 게시물별 하위 폴더. 같은 이름의 다른 게시물이 있으면 엔진이 번호를 붙인다. */
function archiveDir(baseDir: string, preview: PreviewState): string {
  const base = baseDir.trim().replace(/[\\/]+$/, '');
  return base ? `${base}\\${preview.folderName}` : preview.suggestedDir;
}

function EmptyState({ onPick }: { onPick: (url: string) => void }) {
  return (
    <div className="empty">
      <p className="empty-title">이렇게 쓰면 됩니다</p>
      <ol className="steps">
        <li>
          <span>1</span> Threads 앱에서 <b>공유 → 링크 복사</b>를 누릅니다.
        </li>
        <li>
          <span>2</span> 위 입력창에 붙여넣고 <b>미리보기</b>를 누릅니다.
        </li>
        <li>
          <span>3</span> 사진·영상·글, 이어 쓴 타래까지 한 폴더에 저장됩니다.
        </li>
      </ol>
      <button type="button" className="link" onClick={() => onPick(SAMPLE)}>
        예시 링크로 채워 보기
      </button>
    </div>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return '작성 시각 미상';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toUiError(cause: unknown): UiError {
  if (cause instanceof EngineError) {
    return { code: cause.code, message: cause.message, hint: cause.hint };
  }
  if (cause instanceof Error) {
    return { code: 'UNEXPECTED', message: cause.message };
  }
  return { code: 'UNEXPECTED', message: String(cause) };
}
