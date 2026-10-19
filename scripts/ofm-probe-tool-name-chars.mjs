/**
 * Which tool-name characters does the free lane's gate accept?
 *
 * `tools-colon` in ofm-probe-upstream-raw.mjs answers HTTP 400 with an empty
 * body, while 128-character names pass — so the gate validates the name itself.
 * This probe sends one candidate name per request (alongside the mandatory
 * fingerprint stubs) and prints the status, so the sanitiser's allow-list is
 * measured rather than guessed.
 *
 * Usage: node scripts/ofm-probe-tool-name-chars.mjs [model]
 */
import { applyFingerprint, endpointFor, gatewayHeaders, sessionForConversation, UPSTREAM_BASE } from '../src/upstream.js'

const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash-free'
const URL = `${UPSTREAM_BASE}${endpointFor(MODEL)}`
const session = sessionForConversation(`probe-name-chars-${MODEL}`)

const candidates = [
  'a.b',
  'a/b',
  'a b',
  'a:b',
  'a-b',
  'a_b',
  'A1',
  'a$b',
  'a+b',
  'a@b',
  'a#b',
  'a%b',
  'a~b',
  'a(b)',
  'naïve',
  'a\u0000b'.replace('\u0000', ''),
  'mcp_rea_read_file',
  'a'.repeat(128),
  'a'.repeat(129),
  'a'.repeat(200),
]

const base = {
  model: MODEL,
  messages: [{ role: 'user', content: 'Halo' }],
  stream: true,
  max_tokens: 512,
}

for (const name of candidates) {
  const body = JSON.parse(JSON.stringify(base))
  body.tools = [{ type: 'function', function: { name, description: 'Probe tool.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }]
  body.tool_choice = 'auto'
  applyFingerprint(body, false)
  const started = Date.now()
  let status = 0
  let text = ''
  try {
    const response = await fetch(URL, { method: 'POST', headers: gatewayHeaders({ session, stream: true }), body: JSON.stringify(body), redirect: 'error' })
    status = response.status
    text = await response.text()
  } catch (error) {
    text = `fetch error: ${error?.message ?? error}`
  }
  const label = JSON.stringify(name.length > 40 ? `${name.slice(0, 12)}…(${name.length})` : name)
  console.log(`${status === 200 ? 'OK  ' : 'FAIL'} ${String(status).padEnd(3)} len=${String(name.length).padEnd(3)} ${label}${status === 200 ? '' : ` ${text.slice(0, 200).replace(/\n/g, ' ')}`} ${Date.now() - started}ms`)
  await new Promise(r => setTimeout(r, 1200))
}
