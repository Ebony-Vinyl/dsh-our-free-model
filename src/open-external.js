import childProcess, { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

export const MAX_EXTERNAL_URL_LENGTH = 2048

export function externalUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_EXTERNAL_URL_LENGTH) return null
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
        url.href.length > MAX_EXTERNAL_URL_LENGTH) return null
    return url.href
  } catch { return null }
}

/** Await the launcher so a missing browser or process failure remains recoverable. */
export async function openExternal(value, {
  platform = process.platform, exec, systemRoot = process.env.SystemRoot ?? 'C:\\Windows',
} = {}) {
  const url = externalUrl(value)
  if (url === null) return false
  // Resolved at call time, not import time: the offline suites replace
  // `childProcess.execFile` and re-export the builtin, and a promisified copy
  // captured at import would ignore that stub.
  const runFile = exec ?? promisify(childProcess.execFile)
  try {
    if (platform === 'win32') {
      const script = `Start-Process -FilePath '${url.replaceAll("'", "''")}' -ErrorAction Stop`
      await runFile(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10000 })
    } else {
      await runFile(platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], { timeout: 10000 })
    }
    return true
  } catch { return false }
}

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
