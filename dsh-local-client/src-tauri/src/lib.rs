// DeepSeek Harness Local — Tauri shell wiring.
//
// Design (own wiring, no Electron-style custom protocol):
//  1. The Node host sidecar (bundled node + the deployed dsh runtime) is
//     spawned as a plain child process; DSH_HOME points at the app-data dir.
//  2. The host is itself an HTTP server (dsh --profile web): it serves the
//     official web frontend and injects the boot manifest. The shell only
//     needs to learn the listening port and open a WebView on it.
//  3. Tray, single-instance, window-state and graceful host shutdown are
//     owned by the Rust process.

use std::sync::Mutex;
use tauri::Manager;

mod host;

/// The running host sidecar (taken on exit for graceful shutdown).
pub struct HostState(pub Mutex<Option<host::HostChild>>);

/// The port the host bound, once learned from its stdout URL line.
pub struct HostPort(pub Mutex<Option<u16>>);

/// The full (token) URL of the running host; kept even when the window was
/// not auto-opened, so the tray "显示" can create it on demand.
pub struct HostUrl(pub Mutex<Option<String>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: surface the existing window, or open one from the
            // stored host URL when the app runs tray-only (auto-open off).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                host::open_window_from_state(app);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(HostState(Mutex::new(None)))
        .manage(HostPort(Mutex::new(None)))
        .manage(HostUrl(Mutex::new(None)))
        .setup(|app| {
            eprintln!("[shell] setup enter");
            host::install_tray(app)?;
            eprintln!("[shell] tray installed");
            // Boot the sidecar and open the window on a worker thread; the
            // main thread stays free for the event loop.
            host::spawn_and_open(app.handle().clone());
            eprintln!("[shell] spawn_and_open dispatched");
            // Test hook: auto-quit N ms after boot (verifies the shutdown chain).
            if let Ok(ms) = std::env::var("DSH_TEST_AUTO_QUIT_MS") {
                if let Ok(ms) = ms.parse::<u64>() {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                        eprintln!("[shell] test hook: auto quit");
                        handle.exit(0);
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the DeepSeek Harness Local client")
        .run(|app, event| {
            // Dock icon click on macOS with no visible window (tray mode):
            // open the host window instead of doing nothing.
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows && app.get_webview_window("main").is_none() {
                    host::open_window_from_state(app);
                }
            }
            // Graceful host shutdown on exit: TERM, wait briefly, then KILL.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<HostState>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        child.stop();
                    }
                }
            }
        });
}