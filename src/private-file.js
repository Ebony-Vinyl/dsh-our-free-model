/**
 * Private-file permissions shared by every credential-bearing store.
 *
 * Node ignores the permission bits of `mode` on Windows, so the documented
 * 0600 promise needs icacls: drop inherited ACEs and keep only the current
 * user. Other platforms keep using chmod. A failed icacls throws and the
 * caller abandons the write — a file that cannot meet the promise must not
 * land on disk.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export function restrictPermissions(file, directory = false) {
  if (process.platform !== 'win32') return fs.chmodSync(file, directory ? 0o700 : 0o600)
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  // whoami prints the account in the OEM code page, which corrupts non-ASCII
  // machine names once decoded as UTF-8; Node reads env vars through the
  // UTF-16 APIs, so USERNAME is always a correct Unicode string.
  const user = process.env.USERNAME ?? ''
  execFileSync(path.join(system32, 'icacls.exe'),
    [file, '/inheritance:r', '/grant:r', `${user}:${directory ? '(OI)(CI)F' : 'F'}`],
    { stdio: 'ignore', windowsHide: true, shell: false })
}
