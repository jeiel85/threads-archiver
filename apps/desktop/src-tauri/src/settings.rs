//! 앱 설정 (앱 설정 폴더의 settings.json).
//!
//! 자동 실행 여부는 레지스트리(autostart 플러그인)가 기준이라 여기에 저장하지 않는다.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub clipboard_watch: bool,
    /// 감지한 링크를 팝업에서 잠시 기다린 뒤 자동으로 받는다(팝업에서 취소 가능).
    pub auto_download: bool,
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

/// 설정 파일이 없거나 깨졌으면 기본값(클립보드 감시 꺼짐)으로 시작한다.
pub fn load(app: &tauri::AppHandle) -> Settings {
    settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("설정 폴더를 찾지 못했습니다.")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("설정 폴더를 만들지 못했습니다: {error}"))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(&path, text).map_err(|error| format!("설정을 저장하지 못했습니다: {error}"))
}
