import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { EngineClient, EngineError, waitForEngine, type Job } from './api';

/**
 * 클립보드에서 Threads 링크를 감지했을 때 우측 하단에 뜨는 작은 창.
 * [다운로드]를 누르면 바로 기본 저장 폴더에 받고, 같은 창에서 진행·완료를 보여 준다.
 */

type ToastState =
  | { kind: 'detected' }
  | { kind: 'downloading'; job: Job }
  | { kind: 'done'; job: Job }
  | { kind: 'error'; message: string };

const DETECTED_HIDE_MS = 15_000;
const DONE_HIDE_MS = 10_000;

export default function Toast() {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<ToastState>({ kind: 'detected' });
  const [hovered, setHovered] = useState(false);
  const client = useRef<EngineClient | null>(null);
  const runId = useRef(0);

  useEffect(() => {
    document.body.classList.add('toast-body');
    void invoke<string | null>('current_toast_url').then((current) => {
      if (current) setUrl(current);
    });
    const unlisten = listen<string>('toast-url', (event) => {
      runId.current += 1; // 진행 중이던 이전 링크의 결과는 버린다.
      setUrl(event.payload);
      setState({ kind: 'detected' });
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

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
    if (!url) return;
    const run = ++runId.current;
    const update = (next: ToastState) => {
      if (run === runId.current) setState(next);
    };

    try {
      client.current ??= new EngineClient(await waitForEngine());
      const engine = client.current;
      // 저장 위치는 엔진 기본값(다운로드\Threads Archiver) 아래 게시물별 폴더.
      const { jobId } = await engine.startArchive(url, '');
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
    }
  }, [url]);

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
      <button type="button" className="toast-close" aria-label="닫기" onClick={hide}>
        ×
      </button>

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

      {state.kind === 'downloading' ? (
        <>
          <div className="toast-title">{state.job.message}</div>
          <div className="toast-url mono">{shortUrl(url)}</div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.max(4, state.job.progress * 100)}%` }} />
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
