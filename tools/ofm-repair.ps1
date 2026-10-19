$ErrorActionPreference = 'Continue'

$target = "zed:url=http://127.0.0.1:18900/v1"
$secret = "ofm-X3NQCZ1UGsYzYI959kp00DOnvDSpvn-r"
$repo   = "D:\Aset\dsh-ofm"
$vbs    = Join-Path $repo "ofm-standalone-hidden.vbs"

$sig = @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type;
  [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
  [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
  public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
  public uint Persist; public uint AttributeCount; public IntPtr Attributes;
  [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
  [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
}
public class CA {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL c, uint f);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string t, uint ty, uint f, out IntPtr p);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string t, uint ty, uint f);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);
}
"@
Add-Type -TypeDefinition $sig

Write-Output "===== 1. CREDENTIAL ====="
[void][CA]::CredDelete($target, 1, 0)
Start-Sleep -Milliseconds 250
$bytes = [Text.Encoding]::UTF8.GetBytes($secret)
$blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
$c = New-Object CREDENTIAL
$c.Flags = 0; $c.Type = 1; $c.TargetName = $target; $c.Comment = $null
$c.LastWritten = 0; $c.CredentialBlobSize = $bytes.Length; $c.CredentialBlob = $blob
$c.Persist = 2; $c.AttributeCount = 0; $c.Attributes = [IntPtr]::Zero
$c.TargetAlias = $null; $c.UserName = 'Bearer'
$ok = [CA]::CredWrite([ref]$c, 0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
Write-Output "CredWrite ok=$ok"
$p = [IntPtr]::Zero
if ([CA]::CredRead($target, 1, 0, [ref]$p)) {
  $rc = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][CREDENTIAL])
  $b = New-Object byte[] $rc.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($rc.CredentialBlob, $b, 0, $rc.CredentialBlobSize)
  Write-Output ("READBACK size={0} persist={1} value={2}" -f $rc.CredentialBlobSize, $rc.Persist, [Text.Encoding]::UTF8.GetString($b))
  [CA]::CredFree($p)
} else { Write-Output "READBACK FAILED" }

Write-Output "===== 2. STALE LOCK ====="
$lock = Join-Path $env:USERPROFILE ".our-free-model\service.lock"
if (Test-Path $lock) {
  $oldpid = (Get-Content $lock -Raw | ConvertFrom-Json).pid
  if (-not (Get-Process -Id $oldpid -ErrorAction SilentlyContinue)) {
    Remove-Item $lock -Force
    Write-Output "removed stale lock (dead pid $oldpid)"
  } else { Write-Output "lock held by LIVE pid $oldpid" }
} else { Write-Output "no lock file" }

Write-Output "===== 3. START SERVICE (hidden) ====="
if (-not (Test-Path $vbs)) { Write-Output "VBS MISSING: $vbs" }
else {
  Start-Process wscript.exe -ArgumentList "`"$vbs`""
  Start-Sleep -Seconds 8
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:18900/health" -TimeoutSec 10
    Write-Output ("health ok={0} version={1}" -f $h.ok, $h.version)
  } catch { Write-Output "health FAILED: $($_.Exception.Message)" }
}

Write-Output "===== 4. AUTOSTART SHORTCUT ====="
$sh = New-Object -ComObject WScript.Shell
$startup = $sh.SpecialFolders('Startup')
$lnkPath = Join-Path $startup 'OFM-Standalone.lnk'
$lnk = $sh.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$lnk.Arguments = "`"$vbs`""
$lnk.WorkingDirectory = $repo
$lnk.Description = 'Our-Free-Model Standalone (hidden)'
$lnk.Save()
Write-Output ("saved: {0} exists={1}" -f $lnkPath, (Test-Path $lnkPath))
