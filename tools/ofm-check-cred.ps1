$target = 'zed:url=http://127.0.0.1:18900/v1'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredCheck {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
}
"@

$ptr = [IntPtr]::Zero
$ok = [CredCheck]::CredRead($target, 1, 0, [ref]$ptr)
if (-not $ok) { Write-Host "NOT FOUND: $target"; exit 1 }
$c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredCheck+CREDENTIAL])
$bytes = New-Object byte[] $c.CredentialBlobSize
[System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
Write-Host "Target : $($c.TargetName)"
Write-Host "User   : $($c.UserName)"
Write-Host "Persist: $($c.Persist)"
$lw = [System.DateTime]::FromFileTime($c.LastWritten)
Write-Host "Written: $lw"
Write-Host "Size   : $($c.CredentialBlobSize)"
$hasNull = ($bytes -contains 0)
Write-Host "HasNull: $hasNull"
if (-not $hasNull) {
  $utf8 = [System.Text.Encoding]::UTF8.GetString($bytes)
  Write-Host "UTF8   : $utf8"
} else {
  $u16 = [System.Text.Encoding]::Unicode.GetString($bytes)
  Write-Host "UTF16  : $u16  <-- BAD (null bytes present)"
}
[CredCheck]::CredFree($ptr)
