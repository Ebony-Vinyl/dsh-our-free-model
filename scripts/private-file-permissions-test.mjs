/**
 * The private-file permission promise behind issue #456: every store that
 * documents 0600 must actually land 0600.
 *
 * Node ignores the permission bits of `mode` on Windows, so the checks assert
 * what the filesystem really says — icacls output on Windows (the ASCII ACE
 * markers `(I)`/`(F)` survive the OEM code page, the localized names do not and
 * are not asserted on), stat bits everywhere else. Two consumers are exercised
 * end to end so a restriction that broke the writer's own read-back cannot
 * slip through.
 *
 * Run: node scripts/private-file-permissions-test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { restrictPermissions } from '../src/open-external.js'
import { JsonStore } from '../src/store.js'
import { writeEacUser, readEacUser } from '../src/eac-user.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const win32 = process.platform === 'win32'
const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
/** icacls speaks the OEM code page; latin1 keeps the bytes so the ASCII ACE
 *  markers stay assertable on any locale. */
function rawAcl(file) {
  return execFileSync(path.join(system32, 'icacls.exe'), [file], { encoding: 'buffer' }).toString('latin1')
}
/** The SIDs the DACL actually names. `icacls` renders a SID as an account name
 *  in its display form but always as a SID in the saved SDDL, which is the only
 *  form a machine without that account can still compare exactly. */
function aclSids(file) {
  const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-sddl-')), 'acl.sddl')
  try {
    execFileSync(path.join(system32, 'icacls.exe'), [file, '/save', saved], { stdio: 'ignore', windowsHide: true })
    const text = fs.readFileSync(saved).toString('utf16le').replace(/^\uFEFF/, '')
    return text.match(/S-1-[0-9-]+/g) ?? []
  } finally {
    fs.rmSync(path.dirname(saved), { recursive: true, force: true })
  }
}
/** The SID of the account running the suite, straight from the token. */
function currentUserSid() {
  const out = execFileSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'latin1', windowsHide: true })
  return /"(S-1-[0-9-]+)"/.exec(out)?.[1]
}
/** Remove a fixture tree even when a failed assertion left a DACL nothing can
 *  reach it through — that is exactly the failure this suite is about. */
function discard(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {
    try { execFileSync(path.join(system32, 'icacls.exe'), [dir, '/reset', '/T'], { stdio: 'ignore' }) } catch { /* best effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* leave it to the OS temp cleaner */ }
  }
}
/** The restriction itself must hold, and the writer must still read its file. */
function assertPrivateFile(file) {
  if (win32) {
    const acl = rawAcl(file)
    assert.ok(/\(F\)/.test(acl), `expected a full-control ACE, got: ${acl}`)
    assert.ok(!acl.includes('(I)'), `inherited ACEs survived: ${acl}`)
    // The ACE must name the user running this process. A name that resolves to
    // the computer account instead (issue #738) leaves a DACL no user token
    // satisfies, and every later read, write and rename of the file fails.
    const sid = currentUserSid()
    if (sid !== undefined) {
      assert.ok(aclSids(file).includes(sid), `the DACL does not name ${sid}: ${acl}`)
    }
  } else {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  }
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-private-file-'))

check('restrictPermissions drops inheritance and keeps only the current user', () => {
  const dir = temp()
  const file = path.join(dir, 'secret.json')
  fs.writeFileSync(file, '{"secret":true}', { mode: 0o600 })
  restrictPermissions(file)
  assertPrivateFile(file)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"secret":true}')
  discard(dir)
})

check('a restricted directory still lets the owner create and read files inside', () => {
  const dir = temp()
  restrictPermissions(dir, true)
  if (win32) {
    const acl = rawAcl(dir)
    assert.ok(/\(OI\)\(CI\)\(F\)/.test(acl), `expected inheritable full control, got: ${acl}`)
    assert.ok(!acl.includes('(I)'), `inherited ACEs survived: ${acl}`)
    const sid = currentUserSid()
    if (sid !== undefined) {
      assert.ok(aclSids(dir).includes(sid), `the DACL does not name ${sid}: ${acl}`)
    }
  } else {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  }
  const file = path.join(dir, 'inside.json')
  fs.writeFileSync(file, 'ok')
  assert.equal(fs.readFileSync(file, 'utf8'), 'ok')
  discard(dir)
})

check('JsonStore flush lands with private permissions and reloads unchanged', () => {
  const file = path.join(temp(), 'settings.json')
  const store = new JsonStore(file, { key: 'old' })
  store.update({ key: 'new' })
  store.flush()
  assertPrivateFile(file)
  assert.deepEqual(new JsonStore(file, {}).get(), { key: 'new' })
  discard(path.dirname(file))
})

check('writeEacUser persists the token privately and readEacUser sees it', () => {
  const file = path.join(temp(), 'eac-user.json')
  const saved = writeEacUser({ token: 't0k3n', login: 'octo' }, file)
  assert.notEqual(saved, null, 'the write must not fail on a writable home')
  assertPrivateFile(file)
  assert.equal(readEacUser(file)?.token, 't0k3n')
  discard(path.dirname(file))
})

/**
 * Issue #738: on a machine whose computer name differs from the account name
 * only in case, `icacls /grant:r <bare USERNAME>:F` resolves the computer
 * account and writes an ACE no user token matches, so the DACL it leaves
 * behind rejects the writer itself. `restrictPermissions` is called from the
 * temp-file-then-rename path of every private store, so the fixture here is the
 * regression, end to end: grant, then rename over the live file, then reload.
 */
check('a USERNAME that collides with the computer name still yields a DACL the owner can use', () => {
  if (!win32) return
  const dir = temp()
  const file = path.join(dir, 'upgrade-state.json')
  fs.writeFileSync(file, '{"phase":"installing"}')
  const real = { USERNAME: process.env.USERNAME, USERDOMAIN: process.env.USERDOMAIN, COMPUTERNAME: process.env.COMPUTERNAME }
  // The collision itself is what the restriction must survive; every process
  // that reads these variables is this one.
  process.env.USERNAME = real.COMPUTERNAME ?? real.USERNAME
  process.env.USERDOMAIN = real.COMPUTERNAME ?? real.USERDOMAIN
  try {
    const pending = `${file}.tmp`
    fs.writeFileSync(pending, '{"phase":"complete"}')
    restrictPermissions(pending)
    fs.renameSync(pending, file)
  } finally {
    process.env.USERNAME = real.USERNAME
    process.env.USERDOMAIN = real.USERDOMAIN
  }
  assertPrivateFile(file)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"phase":"complete"}')
  discard(dir)
})

if (failures > 0) {
  console.error(`${failures} private-file check(s) failed`)
  process.exitCode = 1
} else {
  console.log('5/5 private-file checks passed')
}
