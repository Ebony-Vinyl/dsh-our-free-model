/**
 * Offline tests for the 2026-11-14 free-lane 429 fixes (9router issue #65).
 *
 * Three upstream checks reuse the same `429 FreeUsageLimitError` wording as a
 * spent quota, so the lane looked out of quota while every request was actually
 * refused on shape. Each section pins one fix:
 * 1. the `<env>` block must ride in the system prompt, complete and idempotent,
 *    across all three wire shapes (chat / claude / responses);
 * 2. session ids must carry a *current* minting clock — digest-derived clocks
 *    and stale reuses draw the same 429 (A/B measured 200 3/3 vs 429 3/3);
 * 3. the transport hop: the sidecar script parses, and `laneFetch` falls back
 *    to the direct stack when Bun is unusable.
 *
 * Run: node scripts/opencode-429-fix-test.mjs
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolate the session store and pin the upstream to a dead local port before
// importing anything — `UPSTREAM_BASE` is captured at import time, and the
// transport flag is read per call, so both must be set here.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-429fix-'))
process.env.DSH_HOME = scratch
process.env.OUR_FREE_MODEL_BASE = 'http://127.0.0.1:1'
process.env.OPENCODE_TRANSPORT = 'off'

const up = await import('../src/upstream.js')
const { laneFetch } = await import('../src/transport.js')

let failures = 0
function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected)
    console.log(`ok  ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${label}\n    ${error.message.split('\n').join('\n    ')}`)
  }
}

// ── 1. The `<env>` block ────────────────────────────────────────────────────
{
  const body = { messages: [{ role: 'user', content: 'hi' }] }
  up.applyEnvBlock(body, false)
  check('chat: a system message is prepended', body.messages[0].role, 'system')
  check('chat: the block is complete', up.hasCompleteEnvBlock(body.messages[0].content), true)
  check('chat: both lines are present', /Working directory: \/workspace[\s\S]*Workspace root folder: \/workspace/.test(body.messages[0].content), true)

  const before = body.messages[0].content
  up.applyEnvBlock(body, false)
  check('chat: idempotent, no stacking', body.messages[0].content, before)

  const existing = { messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }] }
  up.applyEnvBlock(existing, false)
  check('chat: existing system message is completed in place', existing.messages[0].content.startsWith('You are helpful.'), true)
  check('chat: still one system message', existing.messages.length, 2)

  const blocks = { messages: [{ role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] }] }
  up.applyEnvBlock(blocks, false)
  check('chat: block content gains the env text', up.hasCompleteEnvBlock(blocks.messages[0].content.map(b => b.text).join('\n')), true)

  const claude = {}
  up.applyFingerprint(claude, 'claude')
  check('claude: fingerprint leaves a complete env block', up.hasCompleteEnvBlock(String(claude.system)), true)
  const claudeAgain = { ...claude, system: claude.system }
  up.applyEnvBlock(claudeAgain, 'claude')
  check('claude: idempotent', claudeAgain.system, claude.system)

  const claudeBlocks = { system: [{ type: 'text', text: 'You are helpful.' }] }
  up.applyEnvBlock(claudeBlocks, 'claude')
  check('claude: block array gains the env text', up.hasCompleteEnvBlock(claudeBlocks.system.map(b => b.text).join('\n')), true)

  const flat = {}
  up.applyFingerprint(flat, true)
  check('responses: fingerprint leaves a complete env block', up.hasCompleteEnvBlock(String(flat.instructions)), true)

  // A one-line partial (the variant decolua#5128 measured failing later) still
  // ends up with a complete block in the body.
  const partial = { messages: [{ role: 'system', content: '<env>\n  Working directory: /workspace\n</env>' }] }
  up.applyEnvBlock(partial, false)
  check('chat: a partial block ends up complete', up.hasCompleteEnvBlock(partial.messages[0].content), true)
}

// ── 2. Session clocks ──────────────────────────────────────────────────────
{
  const id = up.canonicalizeSession('clock:test')
  check('canonicalize mints a canonical id', up.isCanonicalSession(id), true)
  const clock = up.sessionClockMs(id)
  check('the embedded phase sits inside the wrap window', clock >= 0 && clock < up.SESSION_WRAP_MS, true)
  check('the embedded clock decodes to the current phase', up.isUsableSession(id), true)
  check('stable random half per seed', up.canonicalizeSession('clock:test').slice(16), id.slice(16))

  const stale = 'ses_ffffffffffffABCDEFGHIJKLMN' // epoch 1970
  check('a stale id is not usable', up.isUsableSession(stale), false)
  const nonsense = 'ses_123456789abcABCDEFGHIJKLMN' // ascending layout
  check('an ascending id is not usable', up.isUsableSession(nonsense), false)

  const first = up.sessionForConversation('ttl:seed')
  check('one conversation, one session', up.sessionForConversation('ttl:seed'), first)
  check('the remembered session is fresh', up.isUsableSession(first), true)

  // A remembered id minted 3 h ago (the pre-fix map holds many like it) is
  // replaced, not reused: past the 2 h TTL the same seed re-mints on the
  // current clock. Crafted via the timestamp argument so the phase is
  // deterministic regardless of where `now` sits in the 18.25 h frame.
  const staleEra = up.canonicalizeSession('ttl:old', Date.now() - 3 * 60 * 60 * 1000)
  check('a 3 h-old id is not usable', up.isUsableSession(staleEra), false)
  const reminted = up.sessionForConversation(staleEra)
  check('a stale id is not forwarded', reminted !== staleEra, true)
  check('the replacement is usable', up.isUsableSession(reminted), true)
}

// ── 3. The transport hop ───────────────────────────────────────────────────
{
  const source = fs.readFileSync(new URL('../scripts/opencode-transport.mjs', import.meta.url), 'utf8')
  check('the sidecar refuses to run without a token', /missing per-process token/.test(source), true)
  check('the sidecar strips its own hop headers', /'x-ofm-token', 'x-ofm-url', 'host', 'content-length'/.test(source), true)

  // With OPENCODE_TRANSPORT=off the hop is a plain passthrough to egressFetch
  // (flag read per call, so this works even though the module loaded earlier).
  // The upstream base is a dead local port, so the fetch must reject with a
  // transport error, not hang or fabricate a response.
  const { postStreamed } = await import('../src/http.js')
  let outcome = 'no-throw'
  try {
    await postStreamed({ path: '/zen/v1/chat/completions', body: { model: 'x', messages: [] }, session: up.mintSessionId(), onData: () => {} })
  } catch (error) {
    outcome = error?.code ?? error?.message
  }
  check('with the hop off, a dead upstream surfaces as a transport error', outcome, 'TRANSPORT')

  // laneFetch itself, hop enabled: the sidecar forwards to the dead port, the
  // 502 falls back to the direct stack, which also fails — a failure object,
  // never a hang.
  process.env.OPENCODE_TRANSPORT = ''
  const response = await laneFetch('http://127.0.0.1:1/health', { method: 'GET' }).catch(error => ({ failed: error?.code ?? error?.message }))
  check('laneFetch reaches the direct stack (dead port → failure object)', Boolean(response.failed ?? response.status), true)
}

fs.rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nsemua lolos' : `\n${failures} gagal`)
process.exit(failures === 0 ? 0 : 1)
