// Host sidecar lifecycle: spawn the bundled Node + dsh runtime, learn the
// listening port from the host's stdout URL line, open the WebView, and
// provide graceful shutdown.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{HostPort, HostState};

/// Handle on the host process for graceful shutdown. The pid lets us send
/// signals without owning the Child (the spawn thread keeps that for wait()).
pub struct HostChild {
    pid: u32,
    stop: Arc<AtomicBool>,
}

impl HostChild {
    /// Graceful shutdown: SIGTERM, poll liveness up to ~3 s, then SIGKILL.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let pid = self.pid;
        let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
        for _ in 0..30 {
            // kill -0 probes whether the process still exists.
            let alive = Command::new("kill").arg("-0").arg(pid.to_string()).status();
            if !matches!(alive, Ok(status) if status.success()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = Command::new("kill").arg("-KILL").arg(pid.to_string()).status();
    }
}

/// Absolute path of the bundled runtime: <resources>/runtime.
fn runtime_dir(app: &AppHandle) -> PathBuf {
    match app.path().resource_dir() {
        Ok(dir) => dir.join("runtime"),
        Err(_) => {
            // Development fallback: the checked-in resources tree.
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtime")
        }
    }
}

/// Parse the host's stdout URL line, e.g.
///   "dsh web: http://127.0.0.1:33123/?token=abc..."
/// Newer runtimes require the browser-session token: return the FULL URL so the
/// webview can follow the 303 -> cookie exchange. Returns (url, port).
fn parse_url_line(line: &str) -> Option<(String, u16)> {
    let idx = line.find("http://127.0.0.1:")?;
    let rest = &line[idx..];
    let url: String = rest
        .split_whitespace()
        .next()?
        .trim_end_matches(['.', ',', ')', ']'])
        .to_string();
    let after_port = &url["http://127.0.0.1:".len()..];
    let digits: String = after_port.chars().take_while(|c| c.is_ascii_digit()).collect();
    let port: u16 = digits.parse().ok()?;
    Some((url, port))
}

/// Spawn the host and, once the port is known, open the main window.
pub fn spawn_and_open(app: AppHandle) {
    std::thread::spawn(move || {
        eprintln!("[shell] host thread start");
        let runtime = runtime_dir(&app);
        eprintln!("[shell] runtime dir: {}", runtime.display());
        let node = runtime.join("node/bin/node");
        let wrapper = runtime.join("host-wrapper.sh");
        let bin = runtime.join("app/node_modules/@deepseek-ai/dsh/lib/bin.js");
        let patch = runtime.join("desktop.patch.yml");
        let data_dir = match app.path().app_data_dir() {
            Ok(dir) => dir,
            Err(err) => {
                eprintln!("dsh-local-client: no app data dir: {err}");
                return;
            }
        };
        // DSH_HOME: env override (power users / tests), else the app-data dir.
        let dsh_home = std::env::var("DSH_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("dsh-home"));
        let logs_dir = data_dir.join("logs");
        let _ = std::fs::create_dir_all(&dsh_home);
        let _ = std::fs::create_dir_all(&logs_dir);
        let log_path = logs_dir.join("host.log");

        if !node.exists() || !bin.exists() {
            let msg = format!(
                "dsh-local-client: bundled runtime incomplete (node={} bin={})",
                node.display(),
                bin.display()
            );
            eprintln!("{msg}");
            let _ = std::fs::write(log_path, format!("{msg}\n"));
            return;
        }

        let stop = Arc::new(AtomicBool::new(false));
        // Spawn via the watchdog wrapper: stdin stays piped and open for the
        // wrapper's lifetime, so an EOF (shell died) terminates the host; the
        // wrapper also forwards TERM/INT to the host on graceful shutdown.
        let host_bin = if wrapper.exists() { wrapper.as_path() } else { node.as_path() };
        let mut child = match Command::new(host_bin)
            .arg(&node)
            .arg(&bin)
            .arg("web")
            .arg("--patch")
            .arg(&patch)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg("0")
            .env("DSH_HOME", &dsh_home)
            .env("DSH_TELEMETRY_DISABLED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                let msg = format!("dsh-local-client: failed to spawn host: {err}");
                eprintln!("{msg}");
                let _ = std::fs::write(log_path, format!("{msg}\n"));
                return;
            }
        };

        // Keep the watchdog stdin write-end alive: Child::wait() closes the
        // child's stdin before waiting, which would EOF the wrapper and kill
        // the host instantly. Holding the write end here keeps the pipe open
        // for the shell process's whole lifetime; the OS closes it when the
        // shell dies (crash/kill), triggering the wrapper's watchdog TERM.
        let _stdin_holder = child.stdin.take();

        // Hand the shutdown handle to the state; the pipes stay here.
        if let Some(state) = app.try_state::<HostState>() {
            *state.0.lock().unwrap() = Some(HostChild {
                pid: child.id(),
                stop: stop.clone(),
            });
        }

        // stderr -> logs/host.log (a bounded stream keeps memory flat).
        if let Some(stderr) = child.stderr.take() {
            let log_path = log_path.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut last = String::new();
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    if last.len() + line.len() + 1 > 2 * 1024 * 1024 {
                        last.clear();
                    }
                    last.push_str(&line);
                    last.push('\n');
                    let _ = std::fs::write(&log_path, &last);
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                }
            });
        }

        // stdout -> parse the URL line, then open the window on the main thread.
        // IMPORTANT: keep reading stdout for the host's whole lifetime. The pipe's
        // read end must stay open: if this thread ends, the host's later stdout
        // writes (plugin logs, e.g. the forge injector) hit EPIPE and crash it.
        if let Some(stdout) = child.stdout.take() {
            let app = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                let mut opened = false;
                for line in reader.lines().map_while(Result::ok) {
                    if !opened {
                        eprintln!("[host] {line}");
                        if let Some((url, port)) = parse_url_line(&line) {
                            if let Some(state) = app.try_state::<HostPort>() {
                                *state.0.lock().unwrap() = Some(port);
                            }
                            let app_for_window = app.clone();
                            let _ = app.run_on_main_thread(move || open_main_window(&app_for_window, url));
                            opened = true;
                        }
                    }
                    // subsequent lines: discard silently (host/plugin logs)
                }
            });
        }

        // If the host dies before a window exists (boot failure), surface the
        // log path and exit the shell process.
        let status = child.wait();
        eprintln!("dsh-local-client: host exited: {status:?}");
        let no_port = app
            .try_state::<HostPort>()
            .map(|s| s.0.lock().unwrap().is_none())
            .unwrap_or(true);
        if no_port {
            std::process::exit(1);
        }
    });
}

/// Bundled dsh runtime version from resources/runtime/version.json (assemble writes it).
fn bundled_dsh_version(runtime: &std::path::Path) -> Option<String> {
    let file = runtime.join("version.json");
    let text = std::fs::read_to_string(file).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("dsh")?.as_str().map(|s| s.to_string())
}

/// Create the main window pointing at the host's (token) URL.
fn open_main_window(app: &AppHandle, url_string: String) {
    let dsh_version = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("runtime"))
        .and_then(|runtime| bundled_dsh_version(&runtime));
    use tauri_plugin_window_state::{StateFlags, WindowExt};
    let url = match url_string.parse() {
        Ok(url) => url,
        Err(err) => {
            eprintln!("dsh-local-client: bad URL {url_string}: {err}");
            return;
        }
    };
    let title = match &dsh_version {
            Some(v) => format!("DeepSeek Harness Local · dsh {v}"),
            None => "DeepSeek Harness Local".to_string(),
        };
        let window = match WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
            .title(&title)
        .inner_size(1280.0, 860.0)
        .min_inner_size(720.0, 520.0)
        .build()
    {
        Ok(window) => window,
        Err(err) => {
            eprintln!("dsh-local-client: window creation failed: {err}");
            return;
        }
    };
    let _ = window.restore_state(StateFlags::all());
}

/// Tray icon: show/hide toggle and quit. Skipped when no window icon exists
/// (dev shell without a bundle icon; packaged apps always have one).
pub fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let Some(icon) = app.default_window_icon() else {
        return Ok(());
    };
    let toggle = MenuItem::with_id(app, "toggle", "显示/隐藏", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;
    TrayIconBuilder::new()
        .icon(icon.clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => {
                if let Some(window) = app.get_webview_window("main") {
                    let visible = window.is_visible().unwrap_or(true);
                    if visible {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}