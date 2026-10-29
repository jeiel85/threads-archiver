use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{Manager, RunEvent, State};

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

fn set_info(state: &Arc<EngineState>, info: EngineInfo) {
    if let Ok(mut guard) = state.info.lock() {
        *guard = info;
    }
}

/// 엔진 스크립트 위치: 패키지에 동봉된 리소스 → 개발용 저장소 경로 순으로 찾는다.
fn resolve_engine_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("engine").join("server.js");
        if bundled.exists() {
            return Ok(bundled);
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
        let resolved = dev_path.canonicalize().unwrap_or(dev_path);
        // canonicalize()는 Windows에서 `\\?\` 접두사가 붙은 경로를 돌려준다.
        // Node.js는 이 형식을 스크립트 경로로 해석하지 못하므로 일반 경로로 되돌린다.
        let text = resolved.to_string_lossy().to_string();
        return Ok(match text.strip_prefix(r"\\?\") {
            Some(stripped) => PathBuf::from(stripped),
            None => resolved,
        });
    }

    Err(format!(
        "엔진을 찾지 못했습니다: {} (먼저 `npm run build`를 실행하세요)",
        dev_path.display()
    ))
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
    let mut command = Command::new("node");
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

    let setup_state = Arc::clone(&state);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![engine_info])
        .setup(move |app| {
            let handle = app.handle().clone();
            let engine_state = Arc::clone(&setup_state);
            thread::spawn(move || start_engine(handle, engine_state));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 앱을 초기화하지 못했습니다");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            if let Ok(mut guard) = state.child.lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
            }
        }
    });
}
