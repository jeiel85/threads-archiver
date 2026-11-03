import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { ThreadArchive } from '@threads-archiver/core';
import {
  EngineClient,
  EngineError,
  isActive,
  percentText,
  reportDownloadStatus,
  transferText,
  waitForEngine,
  type AppSettings,
  type EngineInfo,
  type Job,
  type LoginStatus,
} from './api';

type Phase = 'boot' | 'idle' | 'extracting' | 'preview' | 'downloading' | 'done';

/** 메인 창의 탭. 알림 창에서 'show-tab' 이벤트로 바꿀 수도 있다. */
export type Tab = 'download' | 'history' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'download', label: '다운로드' },
  { id: 'history', label: '내역' },
  { id: 'settings', label: '설정' },
];

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
  const [tab, setTab] = useState<Tab>('download');
  /** 내역 탭 배지: 받는 중·대기 중인 작업 수 */
  const [activeCount, setActiveCount] = useState(0);
  const jobId = useRef<string | null>(null);

  useEffect(() => {
    const unlisten = listen<Tab>('show-tab', (event) => setTab(event.payload));
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

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

  // 창을 트레이로 내려도 진행을 볼 수 있게 트레이 툴팁에 알린다.
  const downloadingJob = phase === 'downloading' ? job : null;
  useEffect(() => {
    reportDownloadStatus(downloadingJob);
  }, [downloadingJob]);

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

      <nav className="tabs" role="tablist" aria-label="화면">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`tab${tab === item.id ? ' active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'history' && activeCount ? <span className="tab-badge">{activeCount}</span> : null}
          </button>
        ))}
      </nav>

      {error ? (
        <div className="error-card" role="alert">
          <div className="error-code">{error.code}</div>
          <p className="error-message">{error.message}</p>
          {error.hint ? <p className="error-hint">{error.hint}</p> : null}
        </div>
      ) : null}

      {/* 탭을 옮겨도 미리보기·진행 상태가 남도록 숨기기만 한다. */}
      <div className="tab-panel" role="tabpanel" hidden={tab !== 'download'}>
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
        </section>

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
              <span>{[transferText(job), percentText(job)].filter(Boolean).join(' · ')}</span>
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
      </div>

      <div className="tab-panel" role="tabpanel" hidden={tab !== 'history'}>
        {client ? (
          <HistoryPanel client={client} onOpen={openArchiveItem} onError={setError} onActiveCount={setActiveCount} />
        ) : null}
      </div>

      <div className="tab-panel" role="tabpanel" hidden={tab !== 'settings'}>
        <section className="settings-card">
          <SettingsPanel client={client} onError={setError} />
        </section>
      </div>

      <footer className="footer">
        <span>개인 백업용 도구입니다. 저작권과 Threads 이용약관을 존중해 주세요.</span>
        <UpdateStatus busy={phase === 'downloading'} />
      </footer>
    </div>
  );
}

const HISTORY_ACTIVE_POLL_MS = 700;
const HISTORY_IDLE_POLL_MS = 3000;
/** '내역 비우기'를 한 번 누른 뒤 확인을 기다리는 시간 */
const CLEAR_CONFIRM_MS = 4000;

/**
 * 다운로드 내역. 메인 창·알림 창에서 받은 작업과 지난 실행의 내역을 최근 순으로 보여 주고,
 * 끝난 항목은 같은 링크로 다시 받을 수 있다.
 */
function HistoryPanel({
  client,
  onOpen,
  onError,
  onActiveCount,
}: {
  client: EngineClient;
  onOpen: (path: string) => Promise<void>;
  onError: (error: UiError) => void;
  onActiveCount: (count: number) => void;
}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  /** 비우기를 한 번 눌러 확인을 기다리는 중인지 */
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), CLEAR_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      let delay = HISTORY_IDLE_POLL_MS;
      try {
        const list = await client.jobs();
        if (stopped) return;
        setJobs(list);
        const active = list.filter(isActive).length;
        onActiveCount(active);
        if (active) delay = HISTORY_ACTIVE_POLL_MS;
      } catch {
        // 엔진이 잠시 응답하지 않아도 다음 주기에 다시 읽는다.
      }
      if (!stopped) timer = window.setTimeout(poll, delay);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [client, refresh, onActiveCount]);

  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        setRefresh((value) => value + 1);
      } catch (cause) {
        onError(toUiError(cause));
      }
    },
    [onError],
  );

  if (!jobs) return null;

  const finishedCount = jobs.filter((job) => !isActive(job)).length;

  const clear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    void act(() => client.clearHistory());
  };

  return (
    <section className="history">
      <div className="history-head">
        <strong>다운로드 내역</strong>
        <span className="history-head-side">
          {jobs.length ? `${jobs.length}건` : ''}
          {finishedCount ? (
            <button
              type="button"
              className={`link history-clear${confirmClear ? ' confirm' : ''}`}
              title="끝난 항목을 내역에서 모두 지웁니다. 저장된 파일은 그대로 남습니다."
              onClick={clear}
            >
              {confirmClear ? `한 번 더 누르면 ${finishedCount}건을 지워요` : '내역 비우기'}
            </button>
          ) : null}
        </span>
      </div>
      {jobs.length === 0 ? (
        <p className="history-empty">아직 받은 게시물이 없어요. 여기서나 클립보드 알림에서 받은 내역이 모입니다.</p>
      ) : (
        <ul className="history-list">
          {jobs.map((job) => (
            <li key={job.id} className={`history-item ${job.status}`}>
              <span className="history-dot" aria-hidden="true" />
              <div className="history-body">
                <div className="history-title" title={job.url}>
                  {job.post ? (
                    <>
                      <strong>@{job.post.owner}</strong> {job.post.text}
                    </>
                  ) : (
                    <span className="mono">{shortLink(job.url ?? '')}</span>
                  )}
                </div>
                <div className="history-sub" title={job.error?.hint ?? job.saved?.outputDir}>
                  {historyStatus(job)}
                </div>
                {job.status === 'running' ? (
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${Math.max(4, job.progress * 100)}%` }} />
                  </div>
                ) : null}
              </div>
              <div className="history-actions">
                {isActive(job) ? (
                  <button type="button" className="ghost" onClick={() => void act(() => client.cancel(job.id))}>
                    취소
                  </button>
                ) : (
                  <>
                    {job.status === 'done' && job.saved ? (
                      <button type="button" className="ghost" onClick={() => void onOpen(job.saved!.outputDir)}>
                        폴더 열기
                      </button>
                    ) : null}
                    <button type="button" className="secondary" onClick={() => void act(() => client.retry(job.id))}>
                      다시 받기
                    </button>
                    <button
                      type="button"
                      className="ghost history-delete"
                      aria-label="내역에서 지우기"
                      title="내역에서 지우기 (저장된 파일은 그대로)"
                      onClick={() => void act(() => client.deleteJob(job.id))}
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function historyStatus(job: Job): string {
  const when = job.finishedAt ?? job.createdAt;
  const time = when
    ? new Date(when).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  switch (job.status) {
    case 'queued':
      return '대기 중';
    case 'running':
      return [job.message, transferText(job), percentText(job)].filter(Boolean).join(' · ');
    case 'done':
      return [time, '저장 완료', job.saved ? `미디어 ${job.saved.mediaCount}개` : ''].filter(Boolean).join(' · ');
    case 'cancelled':
      return [time, '취소됨'].filter(Boolean).join(' · ');
    default:
      return [time, job.error?.message ?? job.message].filter(Boolean).join(' · ');
  }
}

function shortLink(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\?.*$/, '');
}

const LOGIN_ACTIVE_POLL_MS = 1000;
const LOGIN_IDLE_POLL_MS = 10_000;

function SettingsPanel({ client, onError }: { client: EngineClient | null; onError: (error: UiError) => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loginStatus, setLoginStatus] = useState<LoginStatus | null>(null);
  const loginBusy = loginStatus?.state === 'waiting' || loginStatus?.state === 'open';

  // 로그인 창이 열려 있는 동안만 자주 확인하고, 평소에는 다운로드 뒤 바뀐 상태를 가끔 반영한다.
  useEffect(() => {
    if (!client) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await client.loginStatus();
        if (stopped) return;
        setLoginStatus(status);
        timer = window.setTimeout(poll, status.state === 'idle' ? LOGIN_IDLE_POLL_MS : LOGIN_ACTIVE_POLL_MS);
      } catch {
        if (!stopped) timer = window.setTimeout(poll, LOGIN_IDLE_POLL_MS);
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [client, loginBusy]);

  const login = useCallback(async () => {
    if (!client) return;
    try {
      setLoginStatus(await client.login());
    } catch (cause) {
      onError(toUiError(cause));
    }
  }, [client, onError]);

  useEffect(() => {
    void invoke<AppSettings>('get_settings').then(setSettings);
    // 트레이 메뉴에서 바꾼 값도 화면에 반영한다.
    const unlisten = listen<AppSettings>('settings-changed', (event) => setSettings(event.payload));
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const change = useCallback(
    async (command: 'set_clipboard_watch' | 'set_auto_download' | 'set_autostart', enabled: boolean) => {
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
      <label className={`setting nested${settings.clipboardWatch ? '' : ' disabled'}`}>
        <input
          type="checkbox"
          checked={settings.autoDownload}
          disabled={!settings.clipboardWatch}
          onChange={(event) => void change('set_auto_download', event.target.checked)}
        />
        <span className="setting-title">자동 다운로드</span>
        <span className="setting-desc">
          링크를 감지하면 알림에서 5초 뒤 자동으로 받습니다. 그 전에 '다운로드 하지 않기'를 누르면 취소되고, 알림에
          마우스를 올려 두면 카운트다운이 멈춥니다.
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
      <div className="setting login-setting">
        <div className="login-row">
          <button type="button" className="secondary" disabled={!client || loginBusy} onClick={() => void login()}>
            {loginStatus?.state === 'waiting'
              ? '다운로드가 끝나면 로그인 창이 열려요…'
              : loginStatus?.state === 'open'
                ? '로그인 창에서 로그인해 주세요…'
                : loginStatus?.loggedIn
                  ? '다시 로그인'
                  : 'Threads 로그인'}
          </button>
          {loginStatus && loginStatus.loggedIn !== null && !loginBusy ? (
            <span className={`login-state ${loginStatus.loggedIn ? 'on' : 'off'}`}>
              {loginStatus.loggedIn ? '● 로그인됨' : '○ 로그인 안 됨'}
            </span>
          ) : null}
        </div>
        <span className="setting-desc">
          로그인해야 보이는 게시물(일부 사용자에게만 공개된 글 등)을 받으려면 한 번 로그인해 두세요. 열린 브라우저에서
          로그인하면 창이 저절로 닫히고, 세션은 이 PC에만 저장됩니다. 로그인 창이 열려 있는 동안 다운로드는 잠시 기다립니다.
        </span>
        {loginStatus?.error && !loginBusy ? (
          <span className="setting-desc login-error" role="alert">
            {loginStatus.error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes?: string | null;
}

type UpdateState =
  | { kind: 'idle' | 'checking' | 'latest' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'installing'; info: UpdateInfo; received: number; total?: number | null }
  | { kind: 'error'; message: string };

/**
 * 시작할 때 GitHub 최신 릴리스를 한 번 확인하고, 새 버전이 있으면 업데이트 버튼을 보여 준다.
 * 자동 확인 실패(오프라인 등)는 조용히 넘기고, 직접 누른 확인의 실패만 표시한다.
 */
function UpdateStatus({ busy: mainBusy }: { busy: boolean }) {
  const [version, setVersion] = useState('');
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  // 알림 창에서 시작한 다운로드도 포함한 앱 전체의 다운로드 여부
  const [downloading, setDownloading] = useState(false);
  const busy = mainBusy || downloading;

  const check = useCallback(async (manual: boolean) => {
    setState({ kind: 'checking' });
    try {
      const info = await invoke<UpdateInfo | null>('check_update');
      setState(info ? { kind: 'available', info } : { kind: manual ? 'latest' : 'idle' });
    } catch (cause) {
      setState(manual ? { kind: 'error', message: String(cause) } : { kind: 'idle' });
    }
  }, []);

  useEffect(() => {
    void getVersion().then(setVersion);
    void check(false);
    const unlisten = listen<{ received: number; total?: number | null }>('update-progress', (event) =>
      setState((current) =>
        current.kind === 'installing' ? { ...current, ...event.payload } : current,
      ),
    );
    const unlistenDownloads = listen<boolean>('downloads-active', (event) => setDownloading(event.payload));
    return () => {
      void unlisten.then((stop) => stop());
      void unlistenDownloads.then((stop) => stop());
    };
  }, [check]);

  const install = useCallback(async (info: UpdateInfo) => {
    setState({ kind: 'installing', info, received: 0 });
    try {
      // 성공하면 설치 프로그램이 뜨고 앱이 종료된다.
      await invoke('install_update');
    } catch (cause) {
      setState({ kind: 'error', message: String(cause) });
    }
  }, []);

  const current = <span className="mono">{version ? `v${version}` : ''}</span>;

  switch (state.kind) {
    case 'available':
      return (
        <span className="update">
          {current}
          <span className="update-new">새 버전 v{state.info.version}</span>
          <button
            type="button"
            className="link update-action"
            disabled={busy}
            title={busy ? '다운로드가 끝난 뒤에 업데이트할 수 있습니다.' : undefined}
            onClick={() => void install(state.info)}
          >
            업데이트
          </button>
        </span>
      );
    case 'installing': {
      const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
      const amount = state.total ? `${mb(state.received)} / ${mb(state.total)}MB` : `${mb(state.received)}MB`;
      return (
        <span className="update">
          {current}
          <span className="update-new">v{state.info.version} 받는 중 {amount}</span>
        </span>
      );
    }
    default:
      return (
        <span className="update">
          {state.kind === 'error' ? <span className="update-error" title={state.message}>{state.message}</span> : null}
          {state.kind === 'latest' ? <span>최신 버전입니다</span> : null}
          {current}
          <button
            type="button"
            className="link update-action"
            disabled={state.kind === 'checking'}
            onClick={() => void check(true)}
          >
            {state.kind === 'checking' ? '확인 중…' : '업데이트 확인'}
          </button>
        </span>
      );
  }
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
