use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;

mod settings;
mod watcher;

use watcher::{ToastLink, WatchState};

#[derive(Clone, Serialize)]
struct EngineInfo {
    status: String,
    port: Option<u16>,
    token: Option<String>,
    message: String,
}

struct EngineState {
    info: Mutex<EngineInfo>,
    child: Mutex<Option<Child>>,
}

#[derive(Deserialize)]
struct ReadyLine {
    port: u16,
    token: String,
}

#[tauri::command]
fn engine_info(state: State<'_, Arc<EngineState>>) -> EngineInfo {
    state
        .info
        .lock()
        .map(|info| info.clone())
        .unwrap_or(EngineInfo {
            status: "error".into(),
            port: None,
            token: None,
            message: "엔진 상태를 읽지 못했습니다.".into(),
        })
}

/// 저장 결과(아카이브 폴더, post.json, post.md)만 기본 앱으로 연다.
/// 프런트엔드에 opener 경로 권한을 통째로 열어 주지 않기 위해 여기서 대상을 검사한다.
#[tauri::command]
fn open_archive_item(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let target = PathBuf::from(&path);
    let allowed = if target.is_dir() {
        target.join("post.json").is_file()
    } else {
        target.is_file()
            && matches!(
                target.file_name().and_then(|name| name.to_str()),
                Some("post.json") | Some("post.md")
            )
    };

    if !allowed {
        return Err(format!("아카이브 폴더나 파일이 아니라서 열 수 없습니다: {path}"));
    }

    app.opener()
        .open_path(path.clone(), None::<&str>)
        .map_err(|error| format!("열지 못했습니다: {path} ({error})"))
}

fn set_info(state: &Arc<EngineState>, info: EngineInfo) {
    if let Ok(mut guard) = state.info.lock() {
        *guard = info;
    }
}

/// canonicalize()와 resource_dir()은 Windows에서 `\\?\` 접두사가 붙은 경로를 돌려준다.
/// Node.js는 이 형식을 스크립트 경로로 해석하지 못하므로 일반 경로로 되돌린다.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    match text.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => path,
    }
}

/// 엔진 스크립트 위치: 패키지에 동봉된 리소스 → 개발용 저장소 경로 순으로 찾는다.
fn resolve_engine_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("engine").join("server.js");
        if bundled.exists() {
            return Ok(strip_verbatim(bundled));
        }
    }

    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("core")
        .join("dist")
        .join("server.js");

    if dev_path.exists() {
        return Ok(strip_verbatim(dev_path.canonicalize().unwrap_or(dev_path)));
    }

    Err(format!(
        "엔진을 찾지 못했습니다: {} (먼저 `npm run build`를 실행하세요)",
        dev_path.display()
    ))
}

/// Node 실행 파일: 설치본에 동봉된 `node/node.exe` → PATH의 `node` 순으로 쓴다.
fn resolve_node(app: &tauri::AppHandle) -> PathBuf {
    let file = if cfg!(windows) { "node.exe" } else { "node" };
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("node").join(file);
        if bundled.exists() {
            return strip_verbatim(bundled);
        }
    }
    PathBuf::from("node")
}

fn start_engine(app: tauri::AppHandle, state: Arc<EngineState>) {
    let script = match resolve_engine_script(&app) {
        Ok(path) => path,
        Err(message) => {
            set_info(
                &state,
                EngineInfo {
                    status: "error".into(),
                    port: None,
                    token: None,
                    message,
                },
            );
            return;
        }
    };

    let token = format!("{:x}", rand_token());
    let mut command = Command::new(resolve_node(&app));
    command
        .arg(&script)
        .env("THREADS_ARCHIVER_TOKEN", &token)
        .env("THREADS_ARCHIVER_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            set_info(
                &state,
                EngineInfo {
                    status: "error".into(),
                    port: None,
                    token: None,
                    message: format!(
                        "Node.js 실행 파일을 찾지 못했습니다 ({error}). Node.js 20 이상을 설치해 주세요."
                    ),
                },
            );
            return;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child_state = state.clone();
    let log_state = state.clone();

    if let Some(stderr) = stderr {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                #[cfg(debug_assertions)]
                eprintln!("[engine:stderr] {trimmed}");
                if let Ok(mut guard) = log_state.info.lock() {
                    if guard.status != "ready" {
                        guard.message = trimmed.chars().take(400).collect();
                    }
                }
            }
        });
    }

    thread::spawn(move || {
        let Some(stdout) = stdout else {
            return;
        };
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let trimmed = line.trim();
            let Some(payload) = trimmed.strip_prefix("ENGINE_READY ") else {
                #[cfg(debug_assertions)]
                if !trimmed.is_empty() {
                    eprintln!("[engine:stdout] {trimmed}");
                }
                continue;
            };
            match serde_json::from_str::<ReadyLine>(payload) {
                Ok(ready) => {
                    set_info(
                        &child_state,
                        EngineInfo {
                            status: "ready".into(),
                            port: Some(ready.port),
                            token: Some(ready.token),
                            message: "엔진 준비 완료".into(),
                        },
                    );
                }
                Err(error) => {
                    set_info(
                        &child_state,
                        EngineInfo {
                            status: "error".into(),
                            port: None,
                            token: None,
                            message: format!("엔진 응답을 해석하지 못했습니다: {error}"),
                        },
                    );
                }
            }
        }
    });

    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }
}

/// 외부 크레이트 없이 만드는 간단한 난수 토큰.
fn rand_token() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    nanos.wrapping_mul(6364136223846793005).wrapping_add(pid << 32)
}

fn stop_engine(state: &EngineState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
struct UpdateProgress {
    received: u64,
    total: Option<u64>,
}

/// GitHub 최신 릴리스의 latest.json을 확인한다. 새 버전이 없으면 None.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;

    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| format!("업데이트를 확인하지 못했습니다: {error}"))?;

    Ok(update.map(|update| UpdateInfo {
        version: update.version,
        current_version: update.current_version,
        notes: update.body,
    }))
}

/// 새 버전을 받아 서명을 검증한 뒤 설치한다. Windows에서는 설치 프로그램을 띄우고 앱이 종료되며,
/// 설치가 끝나면 설치 프로그램이 앱을 다시 실행한다.
#[tauri::command]
async fn install_update(app: tauri::AppHandle, state: State<'_, Arc<EngineState>>) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    if downloads_active(&app) {
        return Err("다운로드가 진행 중입니다. 끝난 뒤에 업데이트해 주세요.".into());
    }

    // 설치 프로그램이 동봉 node.exe를 덮어써야 하므로 앱이 종료되기 직전에 엔진을 먼저 끈다.
    let engine = Arc::clone(&state);
    let update = app
        .updater_builder()
        .on_before_exit(move || stop_engine(&engine))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| format!("업데이트를 확인하지 못했습니다: {error}"))?
        .ok_or_else(|| "이미 최신 버전입니다.".to_string())?;

    let mut received: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let _ = app.emit("update-progress", UpdateProgress { received, total });
            },
            || {},
        )
        .await
        .map_err(|error| format!("업데이트를 내려받지 못했습니다: {error}"))?;

    // 받는 동안 알림 창에서 새 다운로드가 시작됐으면 끊지 않도록 설치를 미룬다.
    if downloads_active(&app) {
        return Err("업데이트를 받는 동안 다운로드가 시작돼 설치를 미뤘습니다. 다운로드가 끝난 뒤 다시 눌러 주세요.".into());
    }

    update
        .install(bytes)
        .map_err(|error| format!("업데이트를 설치하지 못했습니다: {error}"))
}

const MINIMIZED_ARG: &str = "--minimized";
const MENU_OPEN: &str = "open";
const MENU_WATCH: &str = "watch";
const MENU_QUIT: &str = "quit";

const TRAY_ID: &str = "main";
const TRAY_TOOLTIP: &str = "Threads Archiver";

/// 진행 중인 다운로드의 한 줄 요약. 창 이름("main"·"toast")별로 하나씩, 트레이 툴팁에 함께 보여 준다.
#[derive(Default)]
struct DownloadStatus(Mutex<BTreeMap<String, String>>);

/// 트레이 메뉴의 "클립보드 감시" 체크 항목. 화면에서 바꿔도 메뉴 체크가 따라가게 보관한다.
struct TrayWatchItem(CheckMenuItem<tauri::Wry>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    clipboard_watch: bool,
    auto_download: bool,
    autostart: bool,
}

fn settings_view(app: &tauri::AppHandle, watch: &WatchState) -> SettingsView {
    SettingsView {
        clipboard_watch: watch.enabled.load(Ordering::Relaxed),
        auto_download: watch.auto_download.load(Ordering::Relaxed),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle, watch: State<'_, Arc<WatchState>>) -> SettingsView {
    settings_view(&app, &watch)
}

#[tauri::command]
fn set_clipboard_watch(
    app: tauri::AppHandle,
    watch: State<'_, Arc<WatchState>>,
    enabled: bool,
) -> Result<SettingsView, String> {
    apply_clipboard_watch(&app, &watch, enabled)?;
    Ok(settings_view(&app, &watch))
}

#[tauri::command]
fn set_auto_download(
    app: tauri::AppHandle,
    watch: State<'_, Arc<WatchState>>,
    enabled: bool,
) -> Result<SettingsView, String> {
    let mut current = settings::load(&app);
    current.auto_download = enabled;
    settings::save(&app, &current)?;
    watch.auto_download.store(enabled, Ordering::Relaxed);
    Ok(settings_view(&app, &watch))
}

#[tauri::command]
fn set_autostart(
    app: tauri::AppHandle,
    watch: State<'_, Arc<WatchState>>,
    enabled: bool,
) -> Result<SettingsView, String> {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    result.map_err(|error| format!("자동 실행 설정을 바꾸지 못했습니다: {error}"))?;
    Ok(settings_view(&app, &watch))
}

/// 팝업 창이 처음 뜰 때 보여 줄 링크
#[tauri::command]
fn current_toast_link(watch: State<'_, Arc<WatchState>>) -> Option<ToastLink> {
    watch.current_link.lock().ok().and_then(|link| link.clone())
}

#[tauri::command]
fn hide_toast(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(watcher::TOAST_LABEL) {
        let _ = window.hide();
    }
}

/// 창이 다운로드 진행을 알린다(`status`가 None이면 끝남). 트레이 툴팁에 반영한다.
#[tauri::command]
fn set_download_status(
    window: tauri::WebviewWindow,
    downloads: State<'_, DownloadStatus>,
    status: Option<String>,
) {
    let (tooltip, active) = {
        let mut map = downloads.0.lock().unwrap_or_else(|poison| poison.into_inner());
        match status {
            Some(text) => map.insert(window.label().to_string(), text),
            None => map.remove(window.label()),
        };
        let tooltip = std::iter::once(TRAY_TOOLTIP.to_string()).chain(map.values().cloned()).collect::<Vec<_>>().join("
");
        (tooltip, !map.is_empty())
    };
    if let Some(tray) = window.app_handle().tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip));
    }
    // 어느 창에서든 받는 중이면 메인 창의 업데이트 버튼을 막는다.
    let _ = window.app_handle().emit("downloads-active", active);
}

/// 메인 창·알림 창 중 하나라도 다운로드 중인지. 업데이트 설치는 엔진을 끄므로 이때는 막는다.
fn downloads_active(app: &tauri::AppHandle) -> bool {
    app.try_state::<DownloadStatus>()
        .is_some_and(|downloads| downloads.0.lock().is_ok_and(|map| !map.is_empty()))
}

/// 트레이 아이콘 클릭: 알림 창에서 받는 중이면 그 진행 창을 다시 띄우고, 아니면 메인 창을 연다.
fn on_tray_click(app: &tauri::AppHandle) {
    let toast_downloading = app
        .try_state::<DownloadStatus>()
        .is_some_and(|downloads| downloads.0.lock().is_ok_and(|map| map.contains_key(watcher::TOAST_LABEL)));
    match app.get_webview_window(watcher::TOAST_LABEL) {
        Some(toast) if toast_downloading => {
            let _ = toast.show();
        }
        _ => show_main(app),
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    show_main(&app);
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn apply_clipboard_watch(app: &tauri::AppHandle, watch: &WatchState, enabled: bool) -> Result<(), String> {
    let mut current = settings::load(app);
    current.clipboard_watch = enabled;
    settings::save(app, &current)?;
    watch.enabled.store(enabled, Ordering::Relaxed);

    if let Some(item) = app.try_state::<TrayWatchItem>() {
        let _ = item.0.set_checked(enabled);
    }
    let _ = app.emit("settings-changed", settings_view(app, watch));
    Ok(())
}

fn build_tray(app: &tauri::App, watch_enabled: bool) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, "열기", true, None::<&str>)?;
    let watch = CheckMenuItem::with_id(app, MENU_WATCH, "클립보드 감시", true, watch_enabled, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "종료", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &watch, &separator, &quit])?;
    app.manage(TrayWatchItem(watch));

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(TRAY_TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main(app),
            MENU_WATCH => {
                if let Some(watch) = app.try_state::<Arc<WatchState>>() {
                    let next = !watch.enabled.load(Ordering::Relaxed);
                    if let Err(error) = apply_clipboard_watch(app, &watch, next) {
                        eprintln!("{error}");
                    }
                }
            }
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                on_tray_click(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(EngineState {
        info: Mutex::new(EngineInfo {
            status: "starting".into(),
            port: None,
            token: None,
            message: "엔진을 시작하는 중…".into(),
        }),
        child: Mutex::new(None),
    });
    let watch_state = Arc::new(WatchState::default());

    let setup_state = Arc::clone(&state);
    let setup_watch = Arc::clone(&watch_state);

    let app = tauri::Builder::default()
        // 이미 떠 있으면(트레이 포함) 두 번째 실행 대신 기존 창을 연다. 엔진·클립보드 감시가 중복되지 않게 한다.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::Builder::new().args([MINIMIZED_ARG]).build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state.clone())
        .manage(watch_state.clone())
        .manage(DownloadStatus::default())
        .invoke_handler(tauri::generate_handler![
            engine_info,
            open_archive_item,
            get_settings,
            set_clipboard_watch,
            set_auto_download,
            set_autostart,
            current_toast_link,
            hide_toast,
            set_download_status,
            show_main_window,
            check_update,
            install_update
        ])
        .on_window_event(|window, event| {
            // 메인 창의 닫기(X)는 종료가 아니라 트레이로 숨기기. 종료는 트레이 메뉴에서 한다.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let engine_state = Arc::clone(&setup_state);
            thread::spawn(move || start_engine(handle, engine_state));

            let saved = settings::load(app.handle());
            setup_watch.enabled.store(saved.clipboard_watch, Ordering::Relaxed);
            setup_watch.auto_download.store(saved.auto_download, Ordering::Relaxed);
            build_tray(app, saved.clipboard_watch)?;
            watcher::spawn(app.handle().clone(), Arc::clone(&setup_watch));

            // 자동 실행(--minimized)일 때는 트레이에만 둔다.
            if !std::env::args().any(|arg| arg == MINIMIZED_ARG) {
                show_main(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 앱을 초기화하지 못했습니다");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            stop_engine(&state);
        }
    });
}
