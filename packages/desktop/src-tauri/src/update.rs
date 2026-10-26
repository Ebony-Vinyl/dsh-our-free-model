use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema_version: u32,
    version: String,
    size: u64,
    sha256: String,
}

#[derive(Debug)]
pub struct VerifiedUpdate {
    installer: PathBuf,
    sha256: String,
    directory: PathBuf,
}

pub fn prepare(data_dir: &Path, current: &str) -> Result<VerifiedUpdate, String> {
    let directory = data_dir.join("desktop-updates");
    if fs::symlink_metadata(&directory)
        .map_err(|_| "尚未下载更新")?
        .file_type()
        .is_symlink()
    {
        return Err("更新缓存不能是符号链接".into());
    }
    let ready = directory.join("ready.json");
    if !fs::symlink_metadata(&ready)
        .map_err(|_| "请先下载并校验更新")?
        .is_file()
    {
        return Err("更新记录不是普通文件".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(&ready)
        .map_err(|_| "无法读取更新记录")?
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取更新记录")?;
    if bytes.len() > 16384 {
        return Err("更新记录过大".into());
    }
    let record: Receipt = serde_json::from_slice(&bytes).map_err(|_| "更新记录格式无效")?;
    let version = semver::Version::parse(&record.version).map_err(|_| "更新版本格式无效")?;
    let current = semver::Version::parse(current).map_err(|_| "当前版本格式无效")?;
    if record.schema_version != 1
        || version <= current
        || !version.pre.is_empty()
        || !version.build.is_empty()
        || record.size == 0
        || record.size > 256 * 1024 * 1024
        || record.sha256.len() != 64
        || !record
            .sha256
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("更新记录不符合安装条件".into());
    }
    let installer = directory.join(format!("installer-{}.exe", record.sha256));
    let metadata = fs::symlink_metadata(&installer).map_err(|_| "安装包不存在，请重新下载")?;
    if !metadata.is_file() || metadata.len() != record.size {
        return Err("安装包大小不匹配，请重新下载".into());
    }
    let canonical_directory = directory.canonicalize().map_err(|_| "更新目录无效")?;
    let canonical_data = data_dir.canonicalize().map_err(|_| "数据目录无效")?;
    if canonical_directory.parent() != Some(canonical_data.as_path()) {
        return Err("更新目录越界".into());
    }
    let installer = installer.canonicalize().map_err(|_| "安装包路径无效")?;
    if installer.parent() != Some(canonical_directory.as_path()) {
        return Err("安装包路径越界".into());
    }
    let mut file = fs::File::open(&installer).map_err(|_| "无法读取安装包")?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| "无法校验安装包")?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if format!("{:x}", digest.finalize()) != record.sha256 {
        return Err("安装包校验失败，当前应用未被修改".into());
    }
    Ok(VerifiedUpdate {
        installer,
        sha256: record.sha256,
        directory: canonical_directory,
    })
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_path(value: &Path) -> String {
    let raw = value.to_string_lossy();
    // canonicalize 的 Windows 扩展前缀不能直接交给 ShellExecute/Start-Process。
    let friendly = if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        raw.into_owned()
    };
    quote(&friendly)
}

fn helper_script(update: &VerifiedUpdate, current_exe: &Path, pid: u32, ack: &Path) -> String {
    format!(
        r#"$ErrorActionPreference='Stop'
Set-Content -LiteralPath {ack} -Value 'ready' -Encoding UTF8
try {{
  Wait-Process -Id {pid} -Timeout 60 -ErrorAction SilentlyContinue
  if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ throw 'application did not stop' }}
  if ((Get-FileHash -LiteralPath {installer} -Algorithm SHA256).Hash -ne '{sha}') {{ throw 'checksum mismatch' }}
  Set-Content -LiteralPath {result} -Value '{{"ok":true}}' -Encoding UTF8
  $installed=Start-Process -FilePath {installer} -ArgumentList @('/S','/R','/UPDATE') -WindowStyle Hidden -Wait -PassThru
  if ($installed.ExitCode -ne 0 -and $installed.ExitCode -ne 3010) {{ throw 'installer failed' }}
}} catch {{
  Set-Content -LiteralPath {result} -Value '{{"ok":false,"error":"更新安装未完成，已尝试重新打开原应用，请重新检查更新。"}}' -Encoding UTF8
  if (Test-Path -LiteralPath {current_exe}) {{ Start-Process -FilePath {current_exe} -WindowStyle Normal }}
}}
"#,
        ack = quote_path(ack),
        pid = pid,
        installer = quote_path(&update.installer),
        sha = update.sha256,
        result = quote_path(&update.directory.join("last-install.json")),
        current_exe = quote_path(current_exe)
    )
}

#[cfg(windows)]
pub fn handoff(update: VerifiedUpdate) -> Result<(), String> {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    let executable = std::env::current_exe().map_err(|_| "无法定位当前程序")?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时钟无效")?
        .as_nanos();
    let ack = update.directory.join(format!("handoff-{nonce}.txt"));
    let script = helper_script(&update, &executable, std::process::id(), &ack);
    let powershell =
        PathBuf::from(std::env::var_os("SystemRoot").ok_or("无法定位系统 PowerShell")?)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut helper = Command::new(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000008)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "无法启动安装交接进程")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let ready = loop {
        if fs::read_to_string(&ack)
            .map(|v| v.trim_start_matches('\u{feff}').trim() == "ready")
            .unwrap_or(false)
        {
            break true;
        }
        if helper
            .try_wait()
            .map_err(|_| "无法确认安装交接进程")?
            .is_some()
            || Instant::now() >= deadline
        {
            break false;
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    let _ = fs::remove_file(&ack);
    if !ready {
        let _ = helper.kill();
        let _ = helper.wait();
        return Err("安装交接未就绪，应用保持运行".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn handoff(_: VerifiedUpdate) -> Result<(), String> {
    Err("当前仅支持 Windows 桌面安装更新".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_fixed_cache_and_refuses_tamper_or_downgrade() {
        let dir = std::env::temp_dir().join(format!(
            "ofm-native-update-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache = dir.join("desktop-updates");
        fs::create_dir_all(&cache).unwrap();
        let bytes = b"only a test fixture, never executed";
        let sha = format!("{:x}", Sha256::digest(bytes));
        let installer = cache.join(format!("installer-{sha}.exe"));
        fs::write(&installer, bytes).unwrap();
        let receipt = serde_json::json!({"schemaVersion":1,"version":"2.7.3","size":bytes.len(),"sha256":sha});
        fs::write(cache.join("ready.json"), receipt.to_string()).unwrap();
        assert!(prepare(&dir, "2.7.1").is_ok());
        assert!(prepare(&dir, "2.7.3").is_err());
        fs::write(&installer, vec![0; bytes.len()]).unwrap();
        assert!(prepare(&dir, "2.7.1").unwrap_err().contains("校验失败"));
        let mut injected = receipt;
        injected["path"] = serde_json::json!("C:/outside.exe");
        fs::write(cache.join("ready.json"), injected.to_string()).unwrap();
        assert!(prepare(&dir, "2.7.1").is_err());
        assert!(dir.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn helper_quotes_paths_and_waits_before_installing() {
        let update = VerifiedUpdate {
            installer: PathBuf::from("C:/user's folder/installer.exe"),
            sha256: "a".repeat(64),
            directory: PathBuf::from("C:/cache"),
        };
        let script = helper_script(
            &update,
            Path::new("C:/app/main.exe"),
            1234,
            Path::new("C:/cache/ack"),
        );
        assert!(script.contains("'C:/user''s folder/installer.exe'"));
        assert!(script.find("Wait-Process").unwrap() < script.find("Get-FileHash").unwrap());
        assert!(
            script.find("Get-FileHash").unwrap() < script.find("$installed=Start-Process").unwrap()
        );
        assert!(script.contains("@('/S','/R','/UPDATE')"));
        assert!(!script.contains("Stop-Process"));
        assert_eq!(
            quote_path(Path::new(r"\\?\C:\缓存\setup.exe")),
            "'C:\\缓存\\setup.exe'"
        );
    }
}
