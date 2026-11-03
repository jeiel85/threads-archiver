//! 클립보드 감시와 우측 하단 팝업(toast 창).
//!
//! Windows 클립보드 변경 번호(GetClipboardSequenceNumber)만 주기적으로 비교하고,
//! 번호가 바뀌었을 때만 내용을 읽는다. 내용은 Threads 링크인지 검사하는 데만 쓰고 저장·전송하지 않는다.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub const TOAST_LABEL: &str = "toast";
const TOAST_WIDTH: f64 = 380.0;
const TOAST_HEIGHT: f64 = 148.0;
const TOAST_MARGIN: f64 = 16.0;
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 팝업에 넘기는 감지 결과. 자동 다운로드 여부는 감지한 순간의 설정을 따른다.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastLink {
    pub url: String,
    pub auto_download: bool,
}

#[derive(Default)]
pub struct WatchState {
    pub enabled: AtomicBool,
    pub auto_download: AtomicBool,
    /// 이번 실행에서 이미 알린 링크들. A → B → A 순서로 복사해도 A를 다시 띄우지 않는다.
    notified: Mutex<HashSet<String>>,
    /// 팝업 창이 처음 뜰 때 가져갈 링크 (이벤트보다 창 로딩이 늦을 수 있어서 따로 보관)
    pub current_link: Mutex<Option<ToastLink>>,
}

impl WatchState {
    /// 처음 보는 링크면 기록하고 true, 이번 실행에서 이미 알린 링크면 false.
    fn mark_notified(&self, url: &str) -> bool {
        self.notified.lock().unwrap_or_else(|poison| poison.into_inner()).insert(url.to_string())
    }
}

/// 클립보드 텍스트에서 Threads 게시물·공유 링크를 찾는다.
/// 링크만 복사한 경우와 "글 + 링크"를 복사한 경우를 모두 받되, 너무 긴 텍스트는 무시한다.
pub fn detect_threads_url(text: &str) -> Option<String> {
    if text.len() > 4096 {
        return None;
    }
    text.split_whitespace().find_map(|token| {
        // 따옴표·괄호로 감싼 링크와, 문장 끝 문장부호가 붙은 링크("…/post/abc.")도 받는다.
        let token = token
            .trim_start_matches(|c: char| matches!(c, '"' | '\'' | '<' | '(' | '['))
            .trim_end_matches(|c: char| matches!(c, '"' | '\'' | '>' | ')' | ']' | '.' | ',' | '!' | '?' | ';' | ':'));
        let lower = token.to_ascii_lowercase();
        let rest = lower
            .strip_prefix("https://")
            .or_else(|| lower.strip_prefix("http://"))
            .unwrap_or(&lower);
        let rest = rest.strip_prefix("www.").unwrap_or(rest);
        let path = rest.strip_prefix("threads.com/").or_else(|| rest.strip_prefix("threads.net/"))?;

        let is_post = path.starts_with('@') && path.contains("/post/");
        let is_share = path.starts_with("share/") && path.len() > "share/".len();
        if !(is_post || is_share) {
            return None;
        }
        Some(if lower.starts_with("http") { token.to_string() } else { format!("https://{token}") })
    })
}

#[cfg(windows)]
fn clipboard_sequence() -> u32 {
    // SAFETY: 인자가 없고 현재 클립보드 변경 번호만 돌려주는 Win32 함수다.
    unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

#[cfg(not(windows))]
fn clipboard_sequence() -> u32 {
    0
}

pub fn spawn(app: AppHandle, state: Arc<WatchState>) {
    thread::spawn(move || {
        let mut last_seen = clipboard_sequence();
        let mut was_enabled = state.enabled.load(Ordering::Relaxed);

        loop {
            thread::sleep(POLL_INTERVAL);
            let enabled = state.enabled.load(Ordering::Relaxed);
            let sequence = clipboard_sequence();

            // 감시를 켜는 순간 이미 클립보드에 있던 링크에는 반응하지 않는다.
            if !enabled || !was_enabled {
                last_seen = sequence;
                was_enabled = enabled;
                continue;
            }
            if sequence == last_seen {
                continue;
            }
            last_seen = sequence;

            let Ok(text) = app.clipboard().read_text() else {
                continue; // 텍스트가 아닌 복사(이미지·파일)는 무시한다.
            };
            let Some(url) = detect_threads_url(&text) else {
                continue;
            };

            if !state.mark_notified(&url) {
                continue;
            }

            show_toast(&app, &state, url);
        }
    });
}

fn show_toast(app: &AppHandle, state: &WatchState, url: String) {
    let link = ToastLink { url, auto_download: state.auto_download.load(Ordering::Relaxed) };
    *state.current_link.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(link.clone());

    let window = match app.get_webview_window(TOAST_LABEL) {
        Some(window) => window,
        None => match create_toast(app) {
            Ok(window) => window,
            Err(error) => {
                eprintln!("알림 창을 만들지 못했습니다: {error}");
                return;
            }
        },
    };

    place_bottom_right(&window);
    let _ = window.emit("toast-link", link);
    let _ = window.show();
}

fn create_toast(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    WebviewWindowBuilder::new(app, TOAST_LABEL, WebviewUrl::App("index.html?view=toast".into()))
        .title("Threads Archiver 알림")
        .inner_size(TOAST_WIDTH, TOAST_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
}

fn place_bottom_right(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width = (TOAST_WIDTH * scale) as i32;
    let height = (TOAST_HEIGHT * scale) as i32;
    let margin = (TOAST_MARGIN * scale) as i32;
    let x = area.position.x + area.size.width as i32 - width - margin;
    let y = area.position.y + area.size.height as i32 - height - margin;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[cfg(test)]
mod tests {
    use super::{detect_threads_url, WatchState};

    #[test]
    fn 이미_알린_링크는_다른_링크를_거쳐도_다시_알리지_않는다() {
        let state = WatchState::default();
        assert!(state.mark_notified("https://www.threads.com/@a/post/A"));
        assert!(state.mark_notified("https://www.threads.com/@b/post/B"));
        assert!(!state.mark_notified("https://www.threads.com/@a/post/A"));
    }

    #[test]
    fn 게시물_링크를_찾는다() {
        assert_eq!(
            detect_threads_url("https://www.threads.com/@zuck/post/DeZtp-TkQHh?xmt=abc").as_deref(),
            Some("https://www.threads.com/@zuck/post/DeZtp-TkQHh?xmt=abc")
        );
        assert_eq!(
            detect_threads_url("https://www.threads.net/@nasa/post/Decc755lYhC").as_deref(),
            Some("https://www.threads.net/@nasa/post/Decc755lYhC")
        );
    }

    #[test]
    fn 공유_단축_링크와_글_속_링크를_찾는다() {
        assert_eq!(
            detect_threads_url("이거 봐 https://www.threads.com/share/FT-8R3j6Q/ 웃김").as_deref(),
            Some("https://www.threads.com/share/FT-8R3j6Q/")
        );
        assert_eq!(
            detect_threads_url("threads.com/@zuck/post/DeZtp-TkQHh").as_deref(),
            Some("https://threads.com/@zuck/post/DeZtp-TkQHh")
        );
    }

    #[test]
    fn 링크_끝의_문장부호와_괄호를_떼어낸다() {
        assert_eq!(
            detect_threads_url("이 글 좋다 https://www.threads.com/@zuck/post/DeZtp-TkQHh.").as_deref(),
            Some("https://www.threads.com/@zuck/post/DeZtp-TkQHh")
        );
        assert_eq!(
            detect_threads_url("(https://www.threads.com/share/FT-8R3j6Q/),").as_deref(),
            Some("https://www.threads.com/share/FT-8R3j6Q/")
        );
    }

    #[test]
    fn 게시물이_아닌_링크와_일반_텍스트는_무시한다() {
        assert_eq!(detect_threads_url("https://www.threads.com/@zuck"), None);
        assert_eq!(detect_threads_url("https://www.threads.com/"), None);
        assert_eq!(detect_threads_url("https://www.threads.com/share/"), None);
        assert_eq!(detect_threads_url("https://example.com/@zuck/post/abc"), None);
        assert_eq!(detect_threads_url("그냥 메모"), None);
        assert_eq!(detect_threads_url(&"a".repeat(5000)), None);
    }
}
