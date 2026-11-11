mod external;
mod service;
mod update;

use service::ServiceProcess;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[derive(Default)]
struct ServiceState {
    process: Mutex<Option<ServiceProcess>>,
    stopping: AtomicBool,
    updating: AtomicBool,
}

#[tauri::command]
async fn install_desktop_update(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if !cfg!(windows) { return Err("当前仅支持 Windows 桌面安装更新".into()); }
    let data_dir = {
        let state = app.state::<ServiceState>();
        let guard = state.process.lock().map_err(|_| "服务状态不可用")?;
        let process = guard.as_ref().ok_or("桌面服务未启动")?;
        let expected: tauri::Url = process.management_url.parse().map_err(|_| "管理地址无效")?;
        let actual = window.url().map_err(|_| "无法确认调用窗口")?;
        if window.label() != "main" || actual.origin() != expected.origin() { return Err("仅允许当前桌面管理窗口安装更新".into()); }
        process.data_dir().to_owned()
    };
    if app.state::<ServiceState>().updating.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err("安装交接已在进行".into()); }
    let owned = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let verified = update::prepare(&data_dir, env!("CARGO_PKG_VERSION"))?;
        stop_service(&owned);
        if let Err(error) = update::handoff(verified) {
            if let Ok(address) = start_service(&owned) {
                if let Some(window) = owned.get_webview_window("main") {
                    if let Ok(url) = address.parse() { let _ = window.navigate(url); }
                }
            }
            return Err(error);
        }
        owned.exit(0);
        Ok(())
    }).await.unwrap_or_else(|_| Err("安装交接任务未完成".to_string()));
    if result.is_err() { app.state::<ServiceState>().updating.store(false, Ordering::SeqCst); }
    result
}

fn titlebar_script(origin: &str) -> String {
    let css = include_str!("../../ui/titlebar.css");
    let js = include_str!("../../ui/titlebar.js");
    format!(
        "if(location.origin === {}) {{ const mount = () => {{ const style=document.createElement('style'); style.textContent={}; document.head.appendChild(style); {} }}; if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount,{{once:true}}); else mount(); }}",
        serde_json::to_string(origin).unwrap(),
        serde_json::to_string(css).unwrap(),
        js,
    )
}

fn start_service(app: &tauri::AppHandle) -> Result<String, String> {
    let resources = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
    } else {
        app.path().resource_dir().map_err(|_| "无法定位安装资源")?
    };
    let node = if cfg!(target_os = "windows") {
        resources.join("runtime/node.exe")
    } else {
        resources.join("runtime/node")
    };
    let host = resources.join("service/packages/desktop/service-host.mjs");
    if !node.is_file() || !host.is_file() {
        return Err("安装资源不完整，请重新安装桌面程序".into());
    }
    let data_dir = std::env::var_os("OFM_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".our-free-model")))
        .ok_or("无法确定服务数据目录")?;
    let state = app.state::<ServiceState>();
    // 与退出共用锁：退出必须等正在启动的子进程完成交接后再清理。
    let mut guard = state.process.lock().map_err(|_| "服务状态不可用")?;
    if state.stopping.load(Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    let process = ServiceProcess::start(&node, &host, &data_dir)?;
    if state.stopping.load(Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    let address = process.management_url.clone();
    *guard = Some(process);
    Ok(address)
}

fn stop_service(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ServiceState>() {
        if let Ok(mut guard) = state.process.lock() {
            if let Some(mut process) = guard.take() {
                process.stop();
            }
        }
    }
}

/// Fit the main window into the monitor's work area at the current scale.
///
/// The builder's sizes are logical pixels, while `work_area` is physical. At
/// 150–200% scaling a 1280×800 window can be taller than a 1920×1200 screen
/// once the taskbar is removed; `center()` then places the bottom under the
/// taskbar and the sidebar footer is cut off (issue #766). Clamp both the
/// initial size and the minimum to the logical work area so the window can
/// always fit.
fn fit_window_to_work_area(
    work: (u32, u32),
    scale: f64,
    desired: (f64, f64),
    minimum: (f64, f64),
) -> ((f64, f64), (f64, f64)) {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let work_width = (work.0 as f64 / scale).max(1.0);
    let work_height = (work.1 as f64 / scale).max(1.0);
    let min_width = minimum.0.min(work_width);
    let min_height = minimum.1.min(work_height);
    let width = desired.0.min(work_width).max(min_width);
    let height = desired.1.min(work_height).max(min_height);
    ((width, height), (min_width, min_height))
}

/// Hide or show the WebView2 child together with the window.
///
/// `WebviewWindow::hide()` only hides the native window; the WebView2
/// controller keeps `IsVisible(true)` and keeps compositing the page's
/// infinite CSS animations (issue #804). `Webview::hide()` reaches
/// `ICoreWebView2Controller::SetIsVisible(false)` through wry, so the GPU
/// process can go idle while the app stays in the tray.
fn set_main_webview_visible(app: &tauri::AppHandle, visible: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let webview = window.as_ref();
        let _ = if visible { webview.show() } else { webview.hide() };
    }
}

fn show_main(app: &tauri::AppHandle, address: &str) -> tauri::Result<()> {
    let url: tauri::Url = address.parse().expect("服务握手已校验 URL");
    let origin = url.origin().ascii_serialization();
    let mut capability = CapabilityBuilder::new("desktop-service-window")
        .window("main")
        .local(false)
        .remote(format!("{origin}/*"));
    for permission in [
        "core:window:allow-minimize",
        "core:window:allow-maximize",
        "core:window:allow-unmaximize",
        "core:window:allow-is-maximized",
        "core:window:allow-hide",
        "core:window:allow-close",
        "core:window:allow-start-dragging",
        "allow-install-desktop-update",
    ] {
        capability = capability.permission(permission);
    }
    app.add_capability(capability)?;
    let ((width, height), (min_width, min_height)) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            let work = monitor.work_area().size;
            fit_window_to_work_area(
                (work.width, work.height),
                monitor.scale_factor(),
                (1280.0, 800.0),
                (960.0, 560.0),
            )
        })
        .unwrap_or(((1280.0, 800.0), (960.0, 560.0)));
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Our Free Model")
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .prevent_overflow()
        .center()
        .decorations(false)
        .initialization_script(titlebar_script(&origin))
        .on_navigation(move |url| {
            if url.origin().ascii_serialization() == origin { return true; }
            if let Err(message) = external::open_external(url) { eprintln!("{message}"); }
            false
        })
        .on_new_window(|url, _| {
            if let Err(message) = external::open_external(&url) { eprintln!("{message}"); }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

fn show_existing(app: &tauri::AppHandle) {
    if let Some(window) = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("splash"))
    {
        let _ = window.unminimize();
        let _ = window.show();
        set_main_webview_visible(app, true);
        let _ = window.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![install_desktop_update])
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_existing(app)))
        .setup(|app| {
            app.manage(ServiceState::default());
            WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
                .title("Our Free Model").inner_size(400.0, 300.0).center()
                .resizable(false).decorations(false).always_on_top(true).skip_taskbar(true)
                .build()?;
            let show = MenuItem::with_id(app, "show", "打开面板", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("已配置应用图标").clone())
                .menu(&menu).tooltip("Our Free Model")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_existing(app), "quit" => app.exit(0), _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                set_main_webview_visible(tray.app_handle(), false);
                                let _ = window.hide();
                            }
                            else { show_existing(tray.app_handle()); }
                        }
                    }
                }).build(app)?;
            // 后端握手放在后台，让启动窗口能继续绘制。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let result = start_service(&handle);
                let window_handle = handle.clone();
                // 在主线程串行处理窗口创建和退出，防止退出后重新创建窗口。
                let _ = handle.run_on_main_thread(move || {
                let handle = window_handle;
                if handle.state::<ServiceState>().stopping.load(Ordering::SeqCst) { return; }
                let result = result.and_then(|address| show_main(&handle, &address).map_err(|_| "无法打开管理窗口".into()));
                if let Err(message) = result {
                    stop_service(&handle);
                    let message = serde_json::to_string(&message).unwrap();
                    let _ = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("error.html".into()))
                        .title("Our Free Model — 启动失败").inner_size(620.0, 300.0).center()
                        .initialization_script(format!("document.addEventListener('DOMContentLoaded',()=>{{document.getElementById('reason').textContent={message};}})"))
                        .build();
                }
                if let Some(splash) = handle.get_webview_window("splash") { let _ = splash.close(); }
                });
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    set_main_webview_visible(window.app_handle(), false);
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!()).expect("无法构建桌面应用")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                app.state::<ServiceState>().stopping.store(true, Ordering::SeqCst);
                stop_service(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::fit_window_to_work_area;

    fn close(actual: (f64, f64), expected: (f64, f64)) {
        assert!((actual.0 - expected.0).abs() < 0.001, "{actual:?} != {expected:?}");
        assert!((actual.1 - expected.1).abs() < 0.001, "{actual:?} != {expected:?}");
    }

    #[test]
    fn a_1920x1200_screen_at_200_percent_fits_above_the_taskbar() {
        let (inner, minimum) = fit_window_to_work_area(
            (1920, 1152), 2.0, (1280.0, 800.0), (960.0, 560.0),
        );
        close(inner, (960.0, 576.0));
        close(minimum, (960.0, 560.0));
    }

    #[test]
    fn a_1920x1200_screen_at_150_percent_uses_the_full_width() {
        let (inner, minimum) = fit_window_to_work_area(
            (1920, 1152), 1.5, (1280.0, 800.0), (960.0, 560.0),
        );
        close(inner, (1280.0, 768.0));
        close(minimum, (960.0, 560.0));
    }

    #[test]
    fn a_small_screen_shrinks_both_the_window_and_the_minimum() {
        let (inner, minimum) = fit_window_to_work_area(
            (1024, 560), 1.0, (1280.0, 800.0), (960.0, 560.0),
        );
        close(inner, (1024.0, 560.0));
        close(minimum, (960.0, 560.0));
        let (inner, minimum) = fit_window_to_work_area(
            (800, 560), 1.0, (1280.0, 800.0), (960.0, 560.0),
        );
        close(inner, (800.0, 560.0));
        close(minimum, (800.0, 560.0));
    }

    #[test]
    fn an_invalid_scale_falls_back_to_one() {
        let (inner, _) = fit_window_to_work_area(
            (1366, 728), 0.0, (1280.0, 800.0), (960.0, 560.0),
        );
        close(inner, (1280.0, 728.0));
    }
}
