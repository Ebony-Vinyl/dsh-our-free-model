use tauri::Url;

pub fn open_external(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return Err("仅支持打开 HTTP 或 HTTPS 链接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(window: *mut std::ffi::c_void, operation: *const u16, file: *const u16, parameters: *const u16, directory: *const u16, show: i32) -> isize;
        }
        let verb: Vec<u16> = std::ffi::OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let address: Vec<u16> = std::ffi::OsStr::new(url.as_str()).encode_wide().chain(Some(0)).collect();
        let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), address.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
        if result <= 32 { return Err("无法打开系统浏览器，请复制链接后手动打开".into()); }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let launcher = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(launcher).arg(url.as_str()).spawn().map(|_| ()).map_err(|_| "无法打开系统浏览器".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_non_web_schemes_and_credentials() {
        for value in ["file:///C:/Windows/notepad.exe", "javascript:alert(1)", "data:text/html,a", "https://user:secret@example.com/"] {
            assert!(open_external(&Url::parse(value).unwrap()).is_err());
        }
    }
}
