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
/** The restriction itself must hold, and the writer must still read its file. */
function assertPrivateFile(file) {
  if (win32) {
    const acl = rawAcl(file)
    assert.ok(/\(F\)/.test(acl), `expected a full-control ACE, got: ${acl}`)
    assert.ok(!acl.includes('(I)'), `inherited ACEs survived: ${acl}`)
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
})

check('a restricted directory still lets the owner create and read files inside', () => {
  const dir = temp()
  restrictPermissions(dir, true)
  if (win32) {
    const acl = rawAcl(dir)
    assert.ok(/\(OI\)\(CI\)\(F\)/.test(acl), `expected inheritable full control, got: ${acl}`)
    assert.ok(!acl.includes('(I)'), `inherited ACEs survived: ${acl}`)
  } else {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  }
  const file = path.join(dir, 'inside.json')
  fs.writeFileSync(file, 'ok')
  assert.equal(fs.readFileSync(file, 'utf8'), 'ok')
})

check('JsonStore flush lands with private permissions and reloads unchanged', () => {
  const file = path.join(temp(), 'settings.json')
  const store = new JsonStore(file, { key: 'old' })
  store.update({ key: 'new' })
  store.flush()
  assertPrivateFile(file)
  assert.deepEqual(new JsonStore(file, {}).get(), { key: 'new' })
})

check('writeEacUser persists the token privately and readEacUser sees it', () => {
  const file = path.join(temp(), 'eac-user.json')
  const saved = writeEacUser({ token: 't0k3n', login: 'octo' }, file)
  assert.notEqual(saved, null, 'the write must not fail on a writable home')
  assertPrivateFile(file)
  assert.equal(readEacUser(file)?.token, 't0k3n')
})

if (failures > 0) {
  console.error(`${failures} private-file check(s) failed`)
  process.exitCode = 1
} else {
  console.log('4/4 private-file checks passed')
}
