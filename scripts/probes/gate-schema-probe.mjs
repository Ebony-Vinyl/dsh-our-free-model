/**
 * Does the free-tier gate accept a fingerprint stub with an empty schema?
 *
 * `docs/free-lane-wire.md` (measured 2026-10-14) says both `bash` and `read`
 * must be declared **and** each parameter schema must carry at least one
 * property: `properties: {}` is recorded there as a 403. `src/upstream.js`
 * meanwhile ships empty stubs on the assumption that the legacy `/zen/v1` gate
 * only checks names. Both cannot be true, and the difference decides whether a
 * caller's turn is locked out.
 *
 * This probe sends the same minimal turn three ways against the live lane:
 *
 *   1. no tools at all            (control — expected to be refused)
 *   2. the five stubs, `properties: {}`   (what the adapter ships today)
 *   3. the five stubs, one property each  (the shape the measurement recorded)
 *
 * A 403 means the gate refused; 200/429 means the gate passed (429 is only the
 * per-IP quota). Run: node scripts/probes/gate-schema-probe.mjs [model]
 */
import { applyFingerprint, gatewayHeaders, sessionForConversation } from '../../src/upstream.js'

const BASE = process.env.OUR_FREE_MODEL_BASE ?? 'https://opencode.ai'
const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash-free'
const SESSION = sessionForConversation(`gate-schema-probe:${MODEL}`)

const STUB_NAMES = ['bash', 'edit', 'glob', 'grep', 'read']

/** The smallest schema the recorded measurement calls sufficient. */
const SCHEMA = {
  bash: { command: { type: 'string' } },
  edit: { path: { type: 'string' } },
  glob: { pattern: { type: 'string' } },
  grep: { pattern: { type: 'string' } },
  read: { path: { type: 'string' } },
}

const chatTool = (name, properties) => ({
  type: 'function',
  function: { name, description: `Agent tool ${name}`, parameters: { type: 'object', properties } },
})

const VARIANTS = [
  ['no tools', () => []],
  ['stubs with empty properties (current adapter)', () => STUB_NAMES.map(name => chatTool(name, {}))],
  ['stubs with one property each', () => STUB_NAMES.map(name => chatTool(name, SCHEMA[name]))],
]

async function send(label, tools) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: PROBE-OK' }],
    max_tokens: 24,
    stream: true,
  }
  if (tools.length > 0) body.tools = tools
  const res = await fetch(`${BASE}/zen/v1/chat/completions`, {
    method: 'POST',
    headers: gatewayHeaders({ session: SESSION, stream: true }),
    body: JSON.stringify(body),
    redirect: 'error',
  })
  const text = await res.text()
  const gate = /FreeTierError|LANE_LOCKED/.test(text)
  const verdict = res.status === 403 ? 'REFUSED' : res.status === 429 ? 'PASSED (quota)' : res.status === 200 ? 'PASSED' : `HTTP ${res.status}`
  console.log(`${label}\n  → ${res.status} ${verdict}${gate ? ' [FreeTierError]' : ''}`)
  console.log(`  ${text.slice(0, 220).replace(/\s+/g, ' ')}`)
  return { status: res.status, gate }
}

console.log(`model ${MODEL} · lane ${BASE}/zen/v1/chat/completions\n`)
const results = []
for (const [label, tools] of VARIANTS) {
  results.push(await send(label, tools()))
  console.log('')
}

// The point of the probe: is the empty schema itself the refusal?
const empty = results[1]
const schema = results[2]
if (empty.status === 403 && schema.status !== 403) {
  console.log('CONCLUSION: the empty schema is what the gate refuses — ship properties.')
} else if (empty.status !== 403 && schema.status !== 403) {
  console.log('CONCLUSION: both shapes pass on this lane; the refusal is elsewhere.')
} else {
  console.log('CONCLUSION: inconclusive — see statuses above.')
}

// Keep the fingerprint import honest: the adapter path is exercised too.
const body = { messages: [{ role: 'user', content: 'x' }] }
applyFingerprint(body, false)
console.log(`adapter injects: ${body.tools.map(tool => tool.function.name).join(', ')} (properties: ${JSON.stringify(body.tools[0].function.parameters)})`)
