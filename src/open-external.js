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

/**
 * The account this process runs as, spelled so `icacls` cannot misresolve it.
 *
 * A bare account name is ambiguous: `icacls <file> /grant:r <USERNAME>:F` is
 * resolved against both the account database and the computer account, and when
 * the two differ only in case the computer account wins. The ACE then names
 * `S-1-5-21-<machine>` — a SID no user token carries — while `inheritance:r` in
 * the same call has already removed the inherited ACEs. The file is left with a
 * DACL nothing can satisfy, so the writer's own `renameSync` fails EPERM and the
 * file becomes unreadable, unwritable and undeletable (issue #738).
 *
 * `whoami /user` reports the SID of the current token and a SID has nothing to
 * resolve. Its output is ASCII, so the OEM code page problem that kept the
 * account name out of `whoami` in the first place (issue #456, PR #637) cannot
 * reach it: a SID carries no localizable text. The qualified name stays as the
 * fallback for a missing or failing `whoami`, and is still strictly safer than
 * the bare name because it names the account domain instead of letting icacls
 * choose between two candidates.
 *
 * Memoized: a token's SID cannot change while the process runs, and the stores
 * this serves flush on a timer, so one `whoami` per process is enough.
 */
let granteeCache
function currentUserGrantee(system32) {
  if (granteeCache !== undefined) return granteeCache
  try {
    const out = execFileSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'latin1', windowsHide: true, shell: false })
    const sid = /"(S-1-[0-9-]+)"/.exec(out)?.[1]
    if (sid !== undefined) {
      granteeCache = `*${sid}`
      return granteeCache
    }
  } catch { /* fall through to the qualified name */ }
  const user = process.env.USERNAME ?? ''
  const domain = process.env.USERDOMAIN ?? ''
  granteeCache = domain === '' ? user : `${domain}\\${user}`
  return granteeCache
}

export function restrictPermissions(file, directory = false) {
  if (process.platform !== 'win32') return fs.chmodSync(file, directory ? 0o700 : 0o600)
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  // The `*` prefix marks the grantee as a SID, not a name icacls should look up.
  const grantee = currentUserGrantee(system32)
  execFileSync(path.join(system32, 'icacls.exe'),
    [file, '/inheritance:r', '/grant:r', `${grantee}:${directory ? '(OI)(CI)F' : 'F'}`],
    { stdio: 'ignore', windowsHide: true, shell: false })
}
