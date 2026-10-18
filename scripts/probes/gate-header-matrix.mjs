/**
 * Which identity headers does the free-tier gate actually accept?
 *
 * `src/upstream.js` was restored to a v1.3.7 shape on 2026-10-18: it sends
 * `x-opencode-request` and a canonical `prj_<24hex>` project id. The
 * `opencode2api` reference implementation (internal/identity/request.go,
 * fetched 2026-10-18) says the opposite for the current gate:
 *
 *   - "it 403s requests that still carry the legacy x-opencode-request header"
 *   - "the upstream free tier 403s canonical prj_* project ids while accepting
 *     the literal \"global\" every official client sends"
 *
 * Both statements are cheap to test and they are mutually exclusive with the
 * current header set, so this probe walks a small matrix instead of guessing.
 * Every refusal is a 403 raised before inference, so a refused probe does not
 * spend quota.
 *
 * Run: node scripts/probes/gate-header-matrix.mjs [model]
 */
import { gatewayHeaders, sessionForConversation } from '../../src/upstream.js'

const BASE = process.env.OUR_FREE_MODEL_BASE ?? 'https://opencode.ai'
const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash-free'
const SESSION = sessionForConversation(`gate-header-matrix:${MODEL}`)

/** Gate tools in the shape docs/free-lane-wire.md records as sufficient. */
const TOOLS = [
  { name: 'bash', props: { command: { type: 'string' } } },
  { name: 'edit', props: { path: { type: 'string' } } },
  { name: 'glob', props: { pattern: { type: 'string' } } },
  { name: 'grep', props: { pattern: { type: 'string' } } },
  { name: 'read', props: { path: { type: 'string' } } },
].map(({ name, props }) => ({
  type: 'function',
  function: { name, description: `Agent tool ${name}`, parameters: { type: 'object', properties: props } },
}))

const OS_UA = `opencode/1.18.31 (${process.platform === 'win32' ? 'windows' : process.platform} ${process.arch === 'x64' ? 'amd64' : process.arch}; go1.25.0)`

const VARIANTS = [
  { label: 'zen · current headers', path: '/zen/v1/chat/completions', drop: [], patch: {} },
  { label: 'zen · drop x-opencode-request', path: '/zen/v1/chat/completions', drop: ['x-opencode-request'], patch: {} },
  { label: 'zen · project global', path: '/zen/v1/chat/completions', drop: [], patch: { 'x-opencode-project': 'global' } },
  { label: 'zen · drop request + project global', path: '/zen/v1/chat/completions', drop: ['x-opencode-request'], patch: { 'x-opencode-project': 'global' } },
  { label: 'inference · current headers', path: '/inference/v1/chat/completions', drop: [], patch: {} },
  { label: 'inference · drop request + project global', path: '/inference/v1/chat/completions', drop: ['x-opencode-request'], patch: { 'x-opencode-project': 'global' } },
  { label: 'inference · same + session-id header', path: '/inference/v1/chat/completions', drop: ['x-opencode-request'], patch: { 'x-opencode-project': 'global', 'x-opencode-session-id': SESSION } },
  { label: 'inference · same + short UA', path: '/inference/v1/chat/completions', drop: ['x-opencode-request'], patch: { 'x-opencode-project': 'global', 'x-opencode-session-id': SESSION, 'user-agent': 'opencode/1.18.31' } },
  { label: 'inference · same + os/arch UA', path: '/inference/v1/chat/completions', drop: ['x-opencode-request'], patch: { 'x-opencode-project': 'global', 'x-opencode-session-id': SESSION, 'user-agent': OS_UA } },
  { label: 'inference · same + client desktop', path: '/inference/v1/chat/completions', drop: ['x-opencode-request'], patch: { 'x-opencode-project': 'global', 'x-opencode-session-id': SESSION, 'x-opencode-client': 'desktop' } },
]

async function send(variant) {
  const headers = { ...gatewayHeaders({ session: SESSION, stream: true }) }
  for (const key of variant.drop) delete headers[key]
  Object.assign(headers, variant.patch)
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: PROBE-OK' }],
    max_tokens: 24,
    stream: true,
    tools: TOOLS,
  }
  let res
  try {
    res = await fetch(`${BASE}${variant.path}`, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
    })
  } catch (error) {
    console.log(`${variant.label}\n  → transport error: ${error.message}\n`)
    return { status: 0 }
  }
  const text = await res.text()
  const gate = /FreeTierError/.test(text)
  const verdict = res.status === 403 ? 'REFUSED' : res.status === 429 ? 'PASSED (quota)' : res.status === 200 ? 'PASSED' : `HTTP ${res.status}`
  console.log(`${variant.label}\n  → ${res.status} ${verdict}${gate ? ' [FreeTierError]' : ''}`)
  console.log(`  ${text.slice(0, 200).replace(/\s+/g, ' ')}\n`)
  return { status: res.status, gate }
}

console.log(`model ${MODEL} · session ${SESSION}\n`)
const results = []
for (const variant of VARIANTS) results.push({ variant, ...(await send(variant)) })

const passed = results.filter(r => r.status === 200 || r.status === 429)
console.log(passed.length > 0
  ? `CONCLUSION: ${passed.map(r => r.variant.label).join(' | ')}`
  : 'CONCLUSION: every variant refused — the gate wants something not in this matrix.')
