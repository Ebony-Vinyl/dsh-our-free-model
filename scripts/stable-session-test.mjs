import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-stable-session-'))
const previous = process.env.DSH_HOME
process.env.DSH_HOME = scratch
try {
  const up = await import('../src/upstream.js?stable-session-test=first')
  const legacy = up.canonicalizeSession('legacy')
  const real = up.mintSessionId(Date.now() - 1000)
  fs.mkdirSync(path.join(scratch, 'our-free-model'), { recursive: true })
  const file = path.join(scratch, 'our-free-model/session-map.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: { legacy, real } }))
  const before = Date.now()
  const upgraded = up.sessionForConversation('legacy')
  const after = Date.now()
  assert.notEqual(upgraded, legacy)
  assert.ok(up.isCanonicalSession(upgraded))
  const decoded = (~BigInt('0x' + upgraded.slice(4, 16)) & 0xffffffffffffn) >> 12n
  assert.ok(decoded >= (BigInt(before) & 0xfffffffffn) && decoded <= (BigInt(after) & 0xfffffffffn))
  assert.equal(up.sessionForConversation('legacy'), upgraded)
  assert.equal(up.sessionForConversation('real'), real)
  const caller = up.mintSessionId()
  assert.equal(up.sessionForConversation(caller), caller)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.sessions.legacy, upgraded)
  assert.equal(saved.sessions.real, real)
  const reloaded = await import('../src/upstream.js?stable-session-test=second')
  assert.equal(reloaded.sessionForConversation('legacy'), upgraded)
  assert.equal(reloaded.sessionForConversation('real'), real)
  const newConversation = reloaded.sessionForConversation('new-conversation')
  assert.notEqual(newConversation, upgraded)
  assert.equal(reloaded.sessionForConversation('new-conversation'), newConversation)
  console.log('PASS stable sessions: one-time legacy migration, real timestamp, no retry rotation, persisted reload, caller ID preservation')
} finally {
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  fs.rmSync(scratch, { recursive: true, force: true })
}
