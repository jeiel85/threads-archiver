import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { EngineClient, EngineError, percentText, reportDownloadStatus, transferText, waitForEngine, type Job } from './api';

/**
 * 클립보드에서 Threads 링크를 감지했을 때 우측 하단에 뜨는 작은 창.
 * [다운로드]를 누르면 바로 기본 저장 폴더에 받고, 같은 창에서 진행·완료를 보여 준다.
 * 자동 다운로드가 켜져 있으면 잠시 카운트다운한 뒤 스스로 받고, 그 사이 [다운로드 하지 않기]로 취소할 수 있다.
 */

type ToastState =
  | { kind: 'detected' }
  | { kind: 'countdown'; remaining: number }
  | { kind: 'downloading'; job: Job }
  | { kind: 'done'; job: Job }
  | { kind: 'error'; message: string };

const DETECTED_HIDE_MS = 15_000;
const DONE_HIDE_MS = 10_000;
const AUTO_DOWNLOAD_SECONDS = 5;

interface ToastLink {
  url: string;
  autoDownload: boolean;
}

function initialState(link: ToastLink): ToastState {
  return link.autoDownload ? { kind: 'countdown', remaining: AUTO_DOWNLOAD_SECONDS } : { kind: 'detected' };
}

export default function Toast() {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<ToastState>({ kind: 'detected' });
  const [hovered, setHovered] = useState(false);
  const client = useRef<EngineClient | null>(null);
  const runId = useRef(0);
  /** 작업 요청을 보내는 동안 true. 같은 링크로 작업이 두 번 제출되지 않게 막는다. */
  const submitting = useRef(false);

  useEffect(() => {
    document.body.classList.add('toast-body');
    void invoke<ToastLink | null>('current_toast_link').then((current) => {
      if (!current) return;
      setUrl(current.url);
      setState(initialState(current));
    });
    const unlisten = listen<ToastLink>('toast-link', (event) => {
      runId.current += 1; // 진행 중이던 이전 링크의 결과는 버린다.
      submitting.current = false;
      // 마우스를 올린 채 버튼을 눌러 창이 숨겨지면 mouseleave가 오지 않으므로, 새 링크에서는 hover를 풀어 둔다.
      setHovered(false);
      setUrl(event.payload.url);
      setState(initialState(event.payload));
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  // 알림 창을 닫아도 트레이 툴팁에서 진행을 보고, 트레이 아이콘 클릭으로 이 창을 다시 띄울 수 있게 알린다.
  const downloadingJob = state.kind === 'downloading' ? state.job : null;
  useEffect(() => {
    reportDownloadStatus(downloadingJob);
  }, [downloadingJob]);

  const hide = useCallback(() => {
    void invoke('hide_toast');
  }, []);

  // 감지 알림과 완료 알림은 잠시 뒤 스스로 사라진다. 마우스를 올려 두면 기다린다.
  useEffect(() => {
    if (!url || hovered) return;
    const delay = state.kind === 'detected' ? DETECTED_HIDE_MS : state.kind === 'done' ? DONE_HIDE_MS : 0;
    if (!delay) return;
    const timer = window.setTimeout(hide, delay);
    return () => window.clearTimeout(timer);
  }, [url, state.kind, hovered, hide]);

  const download = useCallback(async () => {
    if (!url || submitting.current) return;
    submitting.current = true;
    const run = ++runId.current;
    const update = (next: ToastState) => {
      if (run === runId.current) setState(next);
    };
    // 엔진 시작·요청 전송이 느려도 버튼이 사라지고 자동 닫힘이 멈추도록 먼저 진행 상태로 바꾼다.
    update({ kind: 'downloading', job: { id: '', status: 'queued', progress: 0, message: '요청 보내는 중…' } });

    try {
      client.current ??= new EngineClient(await waitForEngine());
      const engine = client.current;
      // 저장 위치는 엔진 기본값(다운로드\Threads Archiver) 아래 게시물별 폴더.
      const { jobId } = await engine.startArchive(url, '');
      submitting.current = false;
      let job: Job = { id: jobId, status: 'queued', progress: 0, message: '대기 중…' };
      update({ kind: 'downloading', job });

      while (job.status === 'queued' || job.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (run !== runId.current) return;
        job = await engine.job(jobId);
        update({ kind: 'downloading', job });
      }

      if (job.status === 'done') update({ kind: 'done', job });
      else update({ kind: 'error', message: job.error?.message ?? job.message });
    } catch (cause) {
      update({ kind: 'error', message: cause instanceof EngineError || cause instanceof Error ? cause.message : String(cause) });
    } finally {
      submitting.current = false;
    }
  }, [url]);

  // 자동 다운로드 카운트다운. 마우스를 올려 두면 멈춰서 버튼을 누를 여유를 준다.
  const remaining = state.kind === 'countdown' ? state.remaining : null;
  useEffect(() => {
    if (remaining === null || hovered) return;
    if (remaining <= 0) {
      void download();
      return;
    }
    const timer = window.setTimeout(() => {
      setState((current) => (current.kind === 'countdown' ? { kind: 'countdown', remaining: current.remaining - 1 } : current));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [remaining, hovered, download]);

  // 숨긴 창에서 카운트다운이 이어지지 않도록 상태부터 바꾼 뒤 숨긴다.
  const cancelAutoDownload = useCallback(() => {
    setState({ kind: 'detected' });
    hide();
  }, [hide]);

  const openFolder = useCallback(async (path: string) => {
    try {
      await invoke('open_archive_item', { path });
      hide();
    } catch (cause) {
      setState({ kind: 'error', message: String(cause) });
    }
  }, [hide]);

  if (!url) return null;

  return (
    <div
      className={`toast-card ${state.kind}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {state.kind === 'downloading' ? (
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
        <button
          type="button"
          className="toast-close"
          aria-label="닫기"
          onClick={state.kind === 'countdown' ? cancelAutoDownload : hide}
        >
          ×
        </button>
      )}

      {state.kind === 'detected' ? (
        <>
          <div className="toast-title">Threads 링크를 복사했어요</div>
          <div className="toast-url mono">{shortUrl(url)}</div>
          <div className="toast-actions">
            <button type="button" className="primary" onClick={() => void download()}>
              다운로드
            </button>
            <button type="button" className="ghost" onClick={hide}>
              무시
            </button>
          </div>
        </>
      ) : null}

      {state.kind === 'countdown' ? (
        <>
          <div className="toast-title">
            {hovered ? '자동 다운로드를 잠시 멈췄어요' : `${state.remaining}초 뒤 자동으로 다운로드해요`}
          </div>
          <div className="toast-url mono">{shortUrl(url)}</div>
          <div className="progress-track">
            <div className="progress-fill countdown" style={{ width: `${(state.remaining / AUTO_DOWNLOAD_SECONDS) * 100}%` }} />
          </div>
          <div className="toast-actions">
            <button type="button" className="primary" onClick={() => void download()}>
              지금 다운로드
            </button>
            <button type="button" className="ghost" onClick={cancelAutoDownload}>
              다운로드 하지 않기
            </button>
          </div>
        </>
      ) : null}

      {state.kind === 'downloading' ? (
        <>
          <div className="toast-title">{state.job.message}</div>
          <div className="toast-url mono">{shortUrl(url)}</div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.max(4, state.job.progress * 100)}%` }} />
          </div>
          <div className="toast-meta mono">
            <span>{transferText(state.job) || '숨겨도 다운로드는 계속돼요'}</span>
            <span>{percentText(state.job)}</span>
          </div>
        </>
      ) : null}

      {state.kind === 'done' && state.job.result ? (
        <>
          <div className="toast-title">
            <span className="toast-check">✓</span>
            {state.job.alreadySaved ? '이미 저장된 게시물이라 같은 폴더에 다시 저장했어요' : '저장 완료'}
          </div>
          <div className="toast-url mono" title={state.job.result.outputDir}>
            {folderName(state.job.result.outputDir)}
          </div>
          <div className="toast-actions">
            <button type="button" className="secondary" onClick={() => void openFolder(state.job.result!.outputDir)}>
              폴더 열기
            </button>
            <button type="button" className="ghost" onClick={() => void invoke('show_main_window').then(hide)}>
              앱 열기
            </button>
          </div>
        </>
      ) : null}

      {state.kind === 'error' ? (
        <>
          <div className="toast-title danger">다운로드하지 못했어요</div>
          <div className="toast-url">{state.message}</div>
          <div className="toast-actions">
            <button type="button" className="secondary" onClick={() => void download()}>
              다시 시도
            </button>
            <button type="button" className="ghost" onClick={hide}>
              닫기
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\?.*$/, '');
}

function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}
