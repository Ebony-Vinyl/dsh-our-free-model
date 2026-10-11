#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Our Free Model 桌面壳。
//!
//! 职责只有四件事：
//! 1. 以子进程方式启动仓库自带的独立本地服务（packages/standalone，Node 运行时随应用分发）；
//! 2. 轮询 /health 等它就绪，然后打开管理面板窗口（URL 自带一次性登录令牌，页面自动兑换）；
//! 3. 提供托盘：打开面板、重启服务、打开数据目录、退出；
//! 4. 关窗最小化到托盘，退出时确保服务子进程被回收。
//!
//! 服务本体零改动：所有运维策略（端口选择、数据目录、锁文件、密钥）
//! 仍由独立服务自己决定，壳只负责生命周期与展示。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW：node.exe 是控制台程序，避免每次启动闪黑框。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct ServiceState {
    child: Option<Child>,
    port: u16,
    management_url: String,
    data_dir: PathBuf,
    log_path: PathBuf,
    ready: bool,
}

impl Drop for ServiceState {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn service_dir() -> PathBuf {
    // 打包后：<exe>/resources/app/packages/standalone（镜像仓库根布局）；
    // 开发态回退到仓库内真实路径。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let packaged = dir.join("resources").join("app").join("packages").join("standalone");
            if packaged.join("cli.mjs").is_file() {
                return packaged;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("packages").join("standalone")
}

fn node_exe(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let packaged = dir.join("resources").join("runtime").join(if cfg!(windows) { "node.exe" } else { "bin/node" });
        if packaged.is_file() {
            return packaged;
        }
    }
    // 开发态：直接用系统 PATH 里的 node。
    PathBuf::from("node")
}

fn data_dir() -> PathBuf {
    if let Ok(home) = std::env::var("OFM_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }
    dirs_home().join(".our-free-model")
}

fn dirs_home() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("C:\\"))
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/tmp"))
    }
}

fn spawn_service(app: &AppHandle) -> Result<ServiceState, String> {
    let data = data_dir();
    std::fs::create_dir_all(&data).map_err(|e| format!("无法创建数据目录 {}: {e}", data.display()))?;
    let log_path = data.join("desktop-service.log");
    let log_file = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&log_path)
        .map_err(|e| format!("无法打开日志文件: {e}"))?;
    let mut log_err = log_file.try_clone().map_err(|e| format!("无法复制日志句柄: {e}"))?;

    let dir = service_dir();
    let node = node_exe(app);
    let mut cmd = Command::new(&node);
    cmd.arg("cli.mjs").current_dir(&dir).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("无法启动服务进程 ({}): {e}", node.display()))?;
    let mut stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // stderr 全量进日志；stdout 既进日志又抽取出管理地址。
    std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut buf = [0u8; 4096];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => { let _ = log_err.write_all(&buf[..n]); let _ = log_err.flush(); }
            }
        }
    });

    let mut management_url = String::new();
    let deadline = Instant::now() + Duration::from_secs(25);
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while management_url.is_empty() && Instant::now() < deadline {
        match stdout.read(&mut byte) {
            Ok(0) => {
                let status = child.try_wait().map_err(|e| e.to_string())?;
                return Err(match status {
                    Some(s) => format!("服务进程提前退出（{s}），日志：{}", log_path.display()),
                    None => "服务进程输出已关闭但未退出".into(),
                });
            }
            Ok(_) => {
                if byte[0] == b'\n' {
                    let text = String::from_utf8_lossy(&line).to_string();
                    if let Some(start) = text.find("http://") {
                        let url = text[start..].trim().to_string();
                        if url.contains("/#login=") || url.contains("#login=") {
                            management_url = url;
                        }
                    }
                    line.clear();
                } else {
                    line.push(byte[0]);
                }
            }
            Err(e) => return Err(format!("读取服务输出失败: {e}")),
        }
    }
    if management_url.is_empty() {
        let _ = child.kill();
        return Err("等待服务打印管理地址超时（25 秒），日志：".to_string() + &log_path.display().to_string());
    }

    let port: u16 = management_url.split("://").nth(1)
        .and_then(|rest| rest.split('/').next())
        .and_then(|authority| authority.rsplit(':').next())
        .and_then(|p| p.parse().ok())
        .ok_or_else(|| format!("无法从管理地址解析端口: {management_url}"))?;

    // 后台线程继续把 stdout 写入日志（避免管道写满阻塞服务）。
    let mut log_app = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).ok();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => if let Some(f) = log_app.as_mut() { let _ = f.write_all(&buf[..n]); },
            }
        }
    });

    Ok(ServiceState { child: Some(child), port, management_url, data_dir: data, log_path, ready: false })
}

/// 对本机 /health 做一次极简 HTTP/1.0 探测，不需要任何 HTTP 依赖。
fn health_ok(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.write_all(format!("GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes());
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let head = String::from_utf8_lossy(&buf);
    head.starts_with("HTTP/1.") && head.contains(" 200")
}

fn wait_ready(state: &mut ServiceState, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if state.child.as_mut().and_then(|c| c.try_wait().ok()).flatten().is_some() {
            return false;
        }
        if health_ok(state.port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn show_error_window(app: &AppHandle, message: String) {
    let body = format!(
        "<div style=\"max-width:560px;padding:24px\"><h2 style=\"font-weight:600;margin:0 0 12px\">本地服务启动失败</h2>\
         <p style=\"white-space:pre-wrap;line-height:1.6;opacity:.85\">{}</p></div>",
        html_escape(&message),
    );
    let script = format!("document.body.innerHTML={};", serde_json::Value::String(body));
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Our Free Model — 启动失败")
        .inner_size(680.0, 420.0)
        .build();
    if let Ok(window) = window {
        let _ = window.eval(&script);
    } else {
        eprintln!("{message}");
    }
}

fn html_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn open_management(app: &AppHandle) {
    let Some(state) = app.try_state::<Mutex<ServiceState>>() else { return };
    let url = { state.lock().expect("service state poisoned").management_url.clone() };
    if url.is_empty() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let parsed: tauri::Url = url.parse().expect("management url");
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("Our Free Model")
        .inner_size(1180.0, 800.0)
        .min_inner_size(920.0, 620.0)
        .build();
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开管理面板", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启本地服务", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
    let log = MenuItem::with_id(app, "log", "查看服务日志", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &restart, &data, &log, &quit])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("app icon").clone())
        .tooltip("Our Free Model")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_management(app),
            "restart" => { let _ = restart_service(app); }
            "data" => {
                let dir = app.try_state::<Mutex<ServiceState>>()
                    .map(|s| s.lock().expect("service state poisoned").data_dir.clone());
                if let Some(dir) = dir { let _ = tauri_plugin_opener::open_path(dir, None::<&str>); }
            }
            "log" => {
                let path = app.try_state::<Mutex<ServiceState>>()
                    .map(|s| s.lock().expect("service state poisoned").log_path.clone());
                if let Some(path) = path { let _ = tauri_plugin_opener::reveal_item_in_dir(path); }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                open_management(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn restart_service(app: &AppHandle) -> Result<(), String> {
    let mut fresh = {
        let state = app.try_state::<Mutex<ServiceState>>().ok_or("服务状态未初始化")?;
        let mut guard = state.lock().expect("service state poisoned");
        if let Some(child) = guard.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        guard.child = None;
        guard.ready = false;
        spawn_service(app)?
    };
    if !wait_ready(&mut fresh, Duration::from_secs(25)) {
        // 保留这个实例：失败信息里带了日志路径，进程由后续 restart 或退出回收。
        let message = format!("服务重启后未在预期时间内就绪，日志：{}", fresh.log_path.display());
        {
            let shared = app.state::<Mutex<ServiceState>>();
            let mut guard = shared.lock().expect("service state poisoned");
            guard.data_dir = fresh.data_dir.clone();
            guard.log_path = fresh.log_path.clone();
        }
        show_error_window(app, message.clone());
        return Err(message);
    }
    {
        let shared = app.state::<Mutex<ServiceState>>();
        let mut guard = shared.lock().expect("service state poisoned");
        guard.child = fresh.child.take();
        guard.port = fresh.port;
        guard.ready = true;
        guard.management_url = fresh.management_url.clone();
    }
    // 关掉旧窗口再重开：新地址自带新的一次性登录令牌。
    // destroy 绕过“关窗即隐藏”的事件拦截。
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.destroy();
    }
    open_management(app);
    let _ = app.emit("service-restarted", ());
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_management(app);
        }))
        .invoke_handler(tauri::generate_handler![get_status, restart_service_cmd, open_management_cmd])
        .setup(|app| {
            let handle = app.handle().clone();
            let service = spawn_service(&handle);
            match service {
                Ok(mut state) => {
                    let ready = wait_ready(&mut state, Duration::from_secs(25));
                    let management_url = state.management_url.clone();
                    let port = state.port;
                    app.manage(Mutex::new(ServiceState {
                        child: state.child.take(),
                        port: state.port,
                        management_url: management_url.clone(),
                        data_dir: state.data_dir.clone(),
                        log_path: state.log_path.clone(),
                        ready,
                    }));
                    if ready {
                        let parsed: tauri::Url = management_url.parse().expect("management url");
                        WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(parsed))
                            .title("Our Free Model")
                            .inner_size(1180.0, 800.0)
                            .min_inner_size(920.0, 620.0)
                            .visible(true)
                            .build()?;
                        let _ = handle.emit("service-ready", serde_json::json!({ "port": port }));
                    } else {
                        show_error_window(&handle, format!(
                            "本地服务未在预期时间内就绪（端口 {port} 无响应）。\n可在托盘菜单中重试，或查看数据目录里的 desktop-service.log。"
                        ));
                    }
                }
                Err(message) => {
                    app.manage(Mutex::new(ServiceState {
                        child: None, port: 0, management_url: String::new(),
                        data_dir: data_dir(), log_path: data_dir().join("desktop-service.log"), ready: false,
                    }));
                    show_error_window(&handle, message);
                }
            }
            build_tray(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗即隐藏到托盘；真正的退出走托盘菜单。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Mutex<ServiceState>>() {
                    let mut guard = state.lock().expect("service state poisoned");
                    if let Some(child) = guard.child.as_mut() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}

#[tauri::command]
fn get_status(state: tauri::State<'_, Mutex<ServiceState>>) -> serde_json::Value {
    let mut guard = state.lock().expect("service state poisoned");
    serde_json::json!({
        "ready": guard.ready,
        "port": guard.port,
        "running": guard.child.as_mut().and_then(|c| c.try_wait().ok()).flatten().is_none(),
        "managementUrl": guard.management_url,
        "dataDir": guard.data_dir.display().to_string(),
        "logPath": guard.log_path.display().to_string(),
    })
}

#[tauri::command]
fn restart_service_cmd(app: AppHandle) -> Result<bool, String> {
    restart_service(&app)?;
    Ok(true)
}

#[tauri::command]
fn open_management_cmd(app: AppHandle) {
    open_management(&app);
}
