import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import {
  EngineClient,
  EngineError,
  isActive,
  percentText,
  reportDownloadStatus,
  transferText,
  waitForEngine,
  type Job,
} from './api';

/**
 * 클립보드에서 Threads 링크를 감지했을 때 우측 하단에 뜨는 작은 창.
 * [다운로드]를 누르면 바로 기본 저장 폴더에 받고, 같은 창에서 진행·완료를 보여 준다.
 * 자동 다운로드가 켜져 있으면 잠시 카운트다운한 뒤 스스로 받고, 그 사이 [다운로드 하지 않기]로 취소할 수 있다.
 *
 * 받는 중에 다른 링크를 복사해도 앞의 다운로드는 끊기지 않는다. 엔진이 차례로 받고,
 * 이 창은 새 링크를 먼저 묻고 나서 이어서 전체 진행을 보여 준다.
 */

/** 아직 받을지 정하지 않은 가장 최근 링크 */
interface Pending {
  url: string;
  mode: 'detected' | 'countdown';
  remaining: number;
}

interface ToastLink {
  url: string;
  autoDownload: boolean;
}

const DETECTED_HIDE_MS = 15_000;
const DONE_HIDE_MS = 10_000;
const AUTO_DOWNLOAD_SECONDS = 5;
const POLL_MS = 500;

function toPending(link: ToastLink): Pending {
  return { url: link.url, mode: link.autoDownload ? 'countdown' : 'detected', remaining: AUTO_DOWNLOAD_SECONDS };
}

export default function Toast() {
  const [pending, setPending] = useState<Pending | null>(null);
  /** 이 창에서 시작한 작업 (요청한 순서) */
  const [tracked, setTracked] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  /** 엔진에 요청조차 보내지 못한 링크 */
  const [submitError, setSubmitError] = useState<{ url: string; message: string } | null>(null);
  const [hovered, setHovered] = useState(false);
  const client = useRef<EngineClient | null>(null);
  /** 요청을 보내는 중인 링크. 같은 링크가 두 번 제출되지 않게 막는다. */
  const submitting = useRef(new Set<string>());
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  /** 작업을 추적하기 시작한 시각. 그 전에 보낸 목록 요청에 없다고 지워진 것으로 보지 않게 한다. */
  const trackedAt = useRef(new Map<string, number>());

  const trackedJobs = tracked.map((id) => jobs[id]).filter((job): job is Job => Boolean(job));
  const activeJobs = trackedJobs.filter(isActive);
  const current = activeJobs.find((job) => job.status === 'running') ?? activeJobs[0] ?? null;
  const waiting = current ? activeJobs.length - 1 : 0;

  useEffect(() => {
    document.body.classList.add('toast-body');
    void invoke<ToastLink | null>('current_toast_link').then((link) => {
      if (link) setPending(toPending(link));
    });
    const unlisten = listen<ToastLink>('toast-link', (event) => {
      // 마우스를 올린 채 버튼을 눌러 창이 숨겨지면 mouseleave가 오지 않으므로, 새 링크에서는 hover를 풀어 둔다.
      setHovered(false);
      setSubmitError(null);
      setPending(toPending(event.payload));
      // 받는 중인 작업이 있으면 이어지는 한 묶음으로 보고(끝나면 함께 요약), 모두 끝났으면 새로 시작한다.
      setTracked((ids) => (ids.some((id) => !jobsRef.current[id] || isActive(jobsRef.current[id])) ? ids : []));
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const engine = useCallback(async () => {
    client.current ??= new EngineClient(await waitForEngine());
    return client.current;
  }, []);

  // 받는 중인 작업이 있으면 엔진의 작업 목록을 주기적으로 읽어 온다.
  const polling = tracked.some((id) => !jobs[id] || isActive(jobs[id]));
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const requestedAt = Date.now();
        const list = await (await engine()).jobs();
        if (stopped) return;
        setJobs((all) => {
          const next = { ...all };
          for (const job of list) next[job.id] = job;
          return next;
        });
        // 내역에서 지운 작업(끝난 것만 지울 수 있다)은 목록에서 빠지므로 추적에서도 뺀다.
        const listed = new Set(list.map((job) => job.id));
        setTracked((ids) => {
          const kept = ids.filter((id) => listed.has(id) || (trackedAt.current.get(id) ?? 0) >= requestedAt);
          return kept.length === ids.length ? ids : kept;
        });
      } catch {
        // 엔진이 잠시 응답하지 않아도 다음 주기에 다시 읽는다.
      }
      if (!stopped) timer = window.setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [polling, engine]);

  // 알림 창을 닫아도 트레이 툴팁에서 진행을 보고, 트레이 아이콘 클릭으로 이 창을 다시 띄울 수 있게 알린다.
  useEffect(() => {
    reportDownloadStatus(current, waiting);
  }, [current, waiting]);

  const hide = useCallback(() => {
    void invoke('hide_toast');
  }, []);

  const download = useCallback(
    async (url: string) => {
      if (submitting.current.has(url)) return;
      submitting.current.add(url);
      setSubmitError(null);
      setPending((now) => (now?.url === url ? null : now));
      try {
        // 저장 위치는 엔진 기본값(다운로드\Threads Archiver) 아래 게시물별 폴더.
        const { jobId } = await (await engine()).startArchive(url, '');
        setJobs((all) => ({ ...all, [jobId]: { id: jobId, url, status: 'queued', progress: 0, message: '대기 중…' } }));
        trackedAt.current.set(jobId, Date.now());
        setTracked((ids) => [...ids, jobId]);
      } catch (cause) {
        setSubmitError({ url, message: errorMessage(cause) });
      } finally {
        submitting.current.delete(url);
      }
    },
    [engine],
  );

  const retry = useCallback(
    async (job: Job) => {
      try {
        const next = await (await engine()).retry(job.id);
        setJobs((all) => ({ ...all, [job.id]: next }));
      } catch (cause) {
        setJobs((all) => ({ ...all, [job.id]: { ...job, status: 'error', error: { code: 'RETRY_FAILED', message: errorMessage(cause) } } }));
      }
    },
    [engine],
  );

  /** 새 링크를 받지 않기로 했을 때: 받는 중인 다운로드가 있으면 그 진행으로 돌아가고, 없으면 창을 숨긴다. */
  const dismissPending = useCallback(() => {
    setPending(null);
    if (activeJobs.length === 0) hide();
  }, [activeJobs.length, hide]);

  // 자동 다운로드 카운트다운. 마우스를 올려 두면 멈춰서 버튼을 누를 여유를 준다.
  const countdown = pending?.mode === 'countdown' ? pending : null;
  useEffect(() => {
    if (!countdown || hovered) return;
    if (countdown.remaining <= 0) {
      void download(countdown.url);
      return;
    }
    const timer = window.setTimeout(() => {
      setPending((now) => (now && now.mode === 'countdown' ? { ...now, remaining: now.remaining - 1 } : now));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, hovered, download]);

  // 감지 알림과 완료 알림은 잠시 뒤 스스로 사라진다. 마우스를 올려 두면 기다린다.
  const pendingUrl = pending?.url;
  const view = pending ? pending.mode : submitError ? 'submit-error' : current ? 'progress' : trackedJobs.length ? 'finished' : null;
  useEffect(() => {
    if (hovered) return;
    if (view === 'detected') {
      const timer = window.setTimeout(() => {
        setPending(null);
        hide();
      }, DETECTED_HIDE_MS);
      return () => window.clearTimeout(timer);
    }
    if (view === 'finished') {
      const timer = window.setTimeout(hide, DONE_HIDE_MS);
      return () => window.clearTimeout(timer);
    }
    // 새 링크가 오면(pendingUrl) 그 링크에도 처음부터 같은 시간을 준다.
  }, [view, pendingUrl, hovered, hide]);

  const openFolder = useCallback(
    async (path: string) => {
      try {
        await invoke('open_archive_item', { path });
        hide();
      } catch (cause) {
        setSubmitError({ url: path, message: String(cause) });
      }
    },
    [hide],
  );

  /** 메인 창을 열고 원하는 탭(내역·설정 등)으로 바꾼다. */
  const openApp = useCallback(
    (tab: 'download' | 'history' | 'settings' = 'history') => {
      void emit('show-tab', tab)
        .then(() => invoke('show_main_window'))
        .then(hide);
    },
    [hide],
  );

  if (!view) return null;

  const finished = trackedJobs.filter((job) => !isActive(job));
  const lastDone = [...finished].reverse().find((job) => job.status === 'done');
  const single = trackedJobs.length === 1 ? trackedJobs[0]! : null;
  const cardKind = view === 'finished' ? (finished.every((job) => job.status === 'done') ? 'done' : 'error') : view;

  return (
    <div className={`toast-card ${cardKind}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {view === 'progress' ? (
        // 받는 중에는 닫기(×) 대신 숨기기: 다운로드가 끊기지 않는다는 것을 모양으로도 알린다.
        <button
          type="button"
          className="toast-close"
          aria-label="숨기기"
          title="숨기기 — 다운로드는 계속되고, 트레이 아이콘을 누르면 다시 보여요"
          onClick={hide}
        >
          –
        </button>
      ) : (
        <button type="button" className="toast-close" aria-label="닫기" onClick={pending ? dismissPending : hide}>
          ×
        </button>
      )}

      {pending ? (
        <>
          <div className="toast-title">
            {pending.mode === 'detected'
              ? 'Threads 링크를 복사했어요'
              : hovered
                ? '자동 다운로드를 잠시 멈췄어요'
                : `${pending.remaining}초 뒤 자동으로 다운로드해요`}
          </div>
          <div className="toast-url mono">{shortUrl(pending.url)}</div>
          {pending.mode === 'countdown' ? (
            <div className="progress-track">
              <div
                className="progress-fill countdown"
                style={{ width: `${(pending.remaining / AUTO_DOWNLOAD_SECONDS) * 100}%` }}
              />
            </div>
          ) : null}
          {activeJobs.length ? <div className="toast-meta">앞의 다운로드 {activeJobs.length}건은 계속 받고 있어요</div> : null}
          <div className="toast-actions">
            <button type="button" className="primary" onClick={() => void download(pending.url)}>
              {pending.mode === 'countdown' ? '지금 다운로드' : '다운로드'}
            </button>
            <button type="button" className="ghost" onClick={dismissPending}>
              {pending.mode === 'countdown' ? '다운로드 하지 않기' : '무시'}
            </button>
          </div>
        </>
      ) : null}

      {view === 'submit-error' && submitError ? (
        <>
          <div className="toast-title danger">다운로드를 시작하지 못했어요</div>
          <div className="toast-url">{submitError.message}</div>
          <div className="toast-actions">
            <button type="button" className="secondary" onClick={() => void download(submitError.url)}>
              다시 시도
            </button>
            <button type="button" className="ghost" onClick={hide}>
              닫기
            </button>
          </div>
        </>
      ) : null}

      {view === 'progress' && current ? (
        <>
          <div className="toast-title">{current.message}</div>
          <div className="toast-url mono">{jobLabel(current)}</div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.max(4, current.progress * 100)}%` }} />
          </div>
          <div className="toast-meta mono">
            <span>{transferText(current) || '숨겨도 다운로드는 계속돼요'}</span>
            <span>{percentText(current)}</span>
          </div>
          {waiting ? <div className="toast-meta">이어서 {waiting}건 더 받을 예정이에요</div> : null}
        </>
      ) : null}

      {view === 'finished' && single ? <SingleResult job={single} onRetry={retry} onOpenFolder={openFolder} onOpenApp={openApp} onClose={hide} /> : null}

      {view === 'finished' && !single ? (
        <>
          <div className="toast-title">
            {cardKind === 'done' ? <span className="toast-check">✓</span> : null}
            {summaryText(finished)}
          </div>
          <div className="toast-url mono">{lastDone ? folderName(lastDone.saved?.outputDir ?? '') : '실패한 항목은 앱에서 다시 받을 수 있어요'}</div>
          <div className="toast-actions">
            <button type="button" className="secondary" onClick={() => openApp('history')}>
              내역 보기
            </button>
            {lastDone?.saved ? (
              <button type="button" className="ghost" onClick={() => void openFolder(lastDone.saved!.outputDir)}>
                마지막 폴더 열기
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function SingleResult({
  job,
  onRetry,
  onOpenFolder,
  onOpenApp,
  onClose,
}: {
  job: Job;
  onRetry: (job: Job) => Promise<void>;
  onOpenFolder: (path: string) => Promise<void>;
  onOpenApp: (tab?: 'download' | 'history' | 'settings') => void;
  onClose: () => void;
}) {
  if (job.status === 'done' && job.saved) {
    const outputDir = job.saved.outputDir;
    return (
      <>
        <div className="toast-title">
          <span className="toast-check">✓</span>
          {job.alreadySaved ? '이미 저장된 게시물이라 같은 폴더에 다시 저장했어요' : '저장 완료'}
        </div>
        <div className="toast-url mono" title={outputDir}>
          {folderName(outputDir)}
        </div>
        <div className="toast-actions">
          <button type="button" className="secondary" onClick={() => void onOpenFolder(outputDir)}>
            폴더 열기
          </button>
          <button type="button" className="ghost" onClick={() => onOpenApp('history')}>
            앱 열기
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="toast-title danger">{job.status === 'cancelled' ? '다운로드를 취소했어요' : '다운로드하지 못했어요'}</div>
      <div className="toast-url" title={job.error?.hint}>
        {job.error?.message ?? job.message}
      </div>
      <div className="toast-actions">
        <button type="button" className="secondary" onClick={() => void onRetry(job)}>
          다시 받기
        </button>
        <button
          type="button"
          className="ghost"
          onClick={job.error?.code === 'POST_RESTRICTED' ? () => onOpenApp('settings') : onClose}
        >
          {job.error?.code === 'POST_RESTRICTED' ? '앱에서 로그인' : '닫기'}
        </button>
      </div>
    </>
  );
}

function summaryText(finished: Job[]): string {
  const done = finished.filter((job) => job.status === 'done').length;
  const failed = finished.length - done;
  return failed ? `${done}건 저장 · ${failed}건 실패` : `${done}건 모두 저장 완료`;
}

function jobLabel(job: Job): string {
  if (job.post) return `@${job.post.owner}${job.post.text ? ` · ${job.post.text}` : ''}`;
  return job.url ? shortUrl(job.url) : '';
}

function errorMessage(cause: unknown): string {
  return cause instanceof EngineError || cause instanceof Error ? cause.message : String(cause);
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\?.*$/, '');
}

function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}
