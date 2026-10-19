Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredEnum {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredEnumerate(string filter, int flags, out int count, out IntPtr credentials);
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

$count = 0
$ptr = [IntPtr]::Zero
$ok = [CredEnum]::CredEnumerate("zed:*", 0, [ref]$count, [ref]$ptr)
if (-not $ok) { Write-Host "No zed: credentials found"; exit 0 }
Write-Host "Found $count zed: credential(s)"
Write-Host "========================================"
$stride = [IntPtr]::Size
for ($i = 0; $i -lt $count; $i++) {
  $slot = [IntPtr]::Add($ptr, $i * $stride)
  $credPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($slot)
  if ($credPtr -eq [IntPtr]::Zero) { continue }
  $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [type][CredEnum+CREDENTIAL])
  $bytes = New-Object byte[] $c.CredentialBlobSize
  if ($c.CredentialBlobSize -gt 0) {
    [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
  }
  $hasNull = ($bytes -contains 0)
  Write-Host "Target : $($c.TargetName)"
  Write-Host "User   : $($c.UserName)"
  Write-Host "Persist: $($c.Persist)  Size: $($c.CredentialBlobSize)  HasNull: $hasNull"
  if ($hasNull) {
    Write-Host "Value  : (UTF16) $([System.Text.Encoding]::Unicode.GetString($bytes))"
  } else {
    Write-Host "Value  : (UTF8)  $([System.Text.Encoding]::UTF8.GetString($bytes))"
  }
  Write-Host "----------------------------------------"
}
[CredEnum]::CredFree($ptr)
