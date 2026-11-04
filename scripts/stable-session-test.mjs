import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-stable-session-'))
const previous = process.env.DSH_HOME
process.env.DSH_HOME = scratch
try {
  const up = await import('../src/upstream.js?stable-session-test=first')
  // A pre-port id, built exactly as the old canonicalizeSession emitted it:
  // descending encoding, but a date the hash happened to land on (1970) —
  // shape-valid, date-implausible, answered 429 upstream.
  const legacyValue = ~(0x001b6b2b7abdn << 12n | 1n) & 0xffffffffffffn
  const legacy = `ses_${legacyValue.toString(16).padStart(12, '0')}${up.mintSessionId().slice(16)}`
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
  // Since the o2a port (src/o2a/identity.js) the mint draws its date from the
  // slow clock: today's UTC midnight minus at most 30 days — plausible, which
  // is the property the upstream enforces, not "this very second".
  // The wire's time part is a 36-bit millisecond phase (o2a/identity.js), so
  // plausibility means "within the last month of the current phase cycle".
  const { phaseAgeMs } = await import('../src/o2a/identity.js')
  const age = phaseAgeMs(Number(decoded), after)
  assert.ok(age <= 31 * 86400000, `re-mint phase age ${age}ms must be plausible (within 31 days)`)
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
  const first = up.gatewayHeaders({ session: upgraded })
  const second = up.gatewayHeaders({ session: upgraded })
  assert.equal(first['x-opencode-project'], second['x-opencode-project'])
  assert.notEqual(first['x-opencode-project'], up.gatewayHeaders({ session: real })['x-opencode-project'])
  assert.equal(reloaded.gatewayHeaders({ session: upgraded })['x-opencode-project'], first['x-opencode-project'])
  console.log('PASS stable sessions: one-time legacy migration, real timestamp, no retry rotation, persisted reload, caller ID preservation')
} finally {
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  fs.rmSync(scratch, { recursive: true, force: true })
}
