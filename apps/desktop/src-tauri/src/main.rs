// Windows 릴리스 빌드에서 콘솔 창이 뜨지 않도록 하는 진입점
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    threads_archiver_lib::run()
}
