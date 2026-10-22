/**
 * The 白嫖 channel lane (`chan:`), end to end through the real host wiring.
 *
 * The routing feature ("a chain may include channel models") has three promises
 * that only an end-to-end run can pin, because each one lives across a seam:
 *
 * 1. **The lane syncs from the gateway.** The host boots against a fake
 *    channel gateway (port + key through the `DSH_OPENAI_GATEWAY_*` env seams
 *    `src/chan-relay.js` already defines), and the gateway's listing rows land
 *    in `state().catalog` tagged `channel: 'chan'`. The listing intentionally
 *    carries rows the lane must NOT advertise: a foreign plugin's provider
 *    (`deepseek-official/…`), our own lane (`our-free-model/…`) and a malformed
 *    row — only allowlisted pack providers may leak through, or a chain could
 *    loop back into this plugin's own route.
 * 2. **The lane is routing-only.** Chan rows stay out of `listModels` and the
 *    summary's `route` field — the pack already serves them under its own
 *    routes — while still being visible to the chain editor, rendered
 *    available (never probed) and never spent against the free lane's probe.
 * 3. **A chain can dial one.** A combo whose first link is a free model that
 *    hits a quota wall must advance into the chan member: the fake gateway
 *    receives `POST /v1/chat/completions` with `Bearer <key>` and the raw
 *    `<provider>/<model>` wire id (never the `chan:` catalog id), the caller's
 *    tools arrive as declared (no decoy fingerprint), the chosen
 *    `reasoning_effort` rides as chosen, and the streamed answer reaches the
 *    caller as one successful turn attributed to the chain.
 *
 * Everything is loopback: a stub free lane, a stub channel gateway, a temp
 * DSH_HOME. No network, no quota, nothing installed into the user's ~/.dsh.
 *
 * Run: node scripts/channel-lane-test.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { callRoute, chatFrames, fakeContext, stubUpstream, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const checkThat = (name, condition, detail = '') => {
  if (!condition) failures++
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${condition ? '' : ` — ${detail}`}`)
}

const TASK = 'CHANNEL_LANE_TASK_SENTINEL: answer the original question'
const FREE_ID = 'deepseek-v4-flash-free'
const COMBO_ID = 'combo:chan-failover'
const PROVIDER = 'trae'
const MODEL = 'chan-answer-model'
const CHAN_ID = `chan:${PROVIDER}/${MODEL}`
const CHAN_ANSWER = 'ANSWERED_BY_THE_CHANNEL_LANE'
const CHAN_JSON_ANSWER = 'ANSWERED_BY_THE_CHANNEL_LANE_AS_ONE_JSON_DOCUMENT'
const CHAN_KEY = 'chan-gateway-test-key'
/** Rows the fake gateway lists that must never become catalog entries. */
const FOREIGN_ID = 'deepseek-official/leaked-foreign-model'
const SELF_LANE_ID = `our-free-model/${FREE_ID}`

// ── the stubs ────────────────────────────────────────────────────────────────
// The free lane: it names one model and hits a quota wall on the task turn
// (probe pings stay healthy, so only the chain's own attempt fails).
const freeLane = await stubUpstream({
  listing: [FREE_ID],
  answer: (id, body) => JSON.stringify(body).includes(TASK)
    ? { status: 429, body: JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }) }
    : { body: chatFrames('probe ok') },
})
process.env.OUR_FREE_MODEL_BASE = freeLane.base

// The fake channel gateway: the pack's loopback OpenAI surface, including the
// rows the lane must filter out.
const gatewayRequests = []
let gatewayListCalls = 0
let gatewayAuthFailures = 0
// The gateway answers `stream:true` with one JSON document while this is set:
// a provider that ignores the flag, which the poster must still fold into the
// delta frames the chat decoder consumes.
let gatewayJsonAnswer = false
const chanGateway = http.createServer((req, res) => {
  const url = String(req.url ?? '')
  const authorized = req.headers.authorization === `Bearer ${CHAN_KEY}`
  if (req.method === 'GET' && url === '/v1/models') {
    gatewayListCalls += 1
    if (!authorized) {
      gatewayAuthFailures += 1
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"missing or invalid gateway key"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: `${PROVIDER}/${MODEL}`, object: 'model', created: 0, owned_by: PROVIDER, name: 'Trae Chan Answer Model', context_window: 131072, max_tokens: 16384, input: ['text'], reasoning: { efforts: [{ id: 'low', name: 'Low', canonical: 'low' }, { id: 'high', name: 'High', canonical: 'high' }], default: 'high', openai_efforts: ['low', 'high'] } },
        { id: FOREIGN_ID, object: 'model', created: 0, owned_by: 'deepseek-official', name: 'Foreign Plugin Model' },
        { id: SELF_LANE_ID, object: 'model', created: 0, owned_by: 'our-free-model', name: 'Our own lane, listed back at us' },
        { object: 'model', created: 0, owned_by: PROVIDER, name: 'a row with no id at all' },
        { id: `${PROVIDER}/${MODEL}`, object: 'model', created: 0, owned_by: PROVIDER, name: 'Trae Chan Answer Model (duplicate)' },
      ],
    }))
    return
  }
  if (req.method === 'POST' && url === '/v1/chat/completions') {
    const pieces = []
    req.on('data', piece => pieces.push(piece))
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(pieces).toString('utf8') || '{}') } catch { /* recorded as-is below */ }
      gatewayRequests.push({ url, authorized, body })
      if (!authorized) {
        gatewayAuthFailures += 1
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"missing or invalid gateway key"}}')
        return
      }
      if (gatewayJsonAnswer) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          id: 'chatcmpl-chan-json',
          object: 'chat.completion',
          created: 0,
          model: `${PROVIDER}/${MODEL}`,
          choices: [{ index: 0, message: { role: 'assistant', content: CHAN_JSON_ANSWER }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.end(chatFrames(CHAN_ANSWER))
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(`{"error":{"message":"no route for ${req.method} ${url}"}}`)
})
await new Promise(resolve => chanGateway.listen(0, '127.0.0.1', resolve))
chanGateway.unref()
process.env.DSH_OPENAI_GATEWAY_PORT = String(chanGateway.address().port)
process.env.DSH_OPENAI_GATEWAY_API_KEY = CHAN_KEY

// ── 3. boot the host against the stubs ──────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-channel-lane-'))
process.env.DSH_HOME = home
const dataDir = path.join(home, 'our-free-model')
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  enabled: true,
  probeIntervalMinutes: 15,
  defaultMaxTokens: 32768,
  // The chain under test: the free link fails, the chan link must answer.
  combos: [{
    id: COMBO_ID,
    name: 'Chan Failover',
    models: [FREE_ID, CHAN_ID],
    strategy: 'fallback',
    stickyLimit: 1,
    enabled: true,
  }],
}))

// ── 2. the module contract ───────────────────────────────────────────────────
// Imported only now, on purpose: src/chan-lane.js pulls in src/http.js ->
// src/upstream.js, which freezes OUR_FREE_MODEL_BASE at its own import time.
// Setting that env var after this import would leave the free lane dialing a
// closed port and the whole turn scenario would silently test nothing.
const { CHANNEL_LANE, CHANNEL_PREFIX, CHANNEL_PACK_PROVIDERS, channelCatalogId, parseChannelCatalogId, buildChannelCatalog } =
  await import('../src/chan-lane.js')
{
  check('the lane names itself', [CHANNEL_LANE, CHANNEL_PREFIX], ['chan', 'chan:'])
  check('a catalog id is provider/model under the chan prefix', channelCatalogId(PROVIDER, MODEL), CHAN_ID)
  check('the id parses back apart', parseChannelCatalogId(CHAN_ID), { providerId: PROVIDER, modelId: MODEL })
  check('only a chan-prefixed provider/model id parses', [parseChannelCatalogId(FREE_ID), parseChannelCatalogId('chan:'), parseChannelCatalogId(null)], [null, null, null])
  check('the model half keeps its own slashes', parseChannelCatalogId('chan:a/b/c'), { providerId: 'a', modelId: 'b/c' })
  const packProviders = Array.isArray(CHANNEL_PACK_PROVIDERS) ? CHANNEL_PACK_PROVIDERS : []
  checkThat('the pack allowlist names the vendored providers', packProviders.includes(PROVIDER) && !packProviders.includes('opencode'), JSON.stringify(CHANNEL_PACK_PROVIDERS))

  const rows = [
    { id: `${PROVIDER}/${MODEL}`, name: 'Trae Chan Answer Model', context_window: 131072, max_tokens: 16384, input: ['text'], reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], default: 'high', openai_efforts: ['low', 'high'] } },
    { id: FOREIGN_ID, name: 'Foreign Plugin Model' },
    { id: SELF_LANE_ID, name: 'Our own lane, listed back at us' },
    { id: `${PROVIDER}/${MODEL}`, name: 'Trae Chan Answer Model (duplicate)' },
    { name: 'a row with no id at all' },
    null,
  ]
  const entries = buildChannelCatalog(rows)
  check('only the pack provider row survives, deduped', entries.map(entry => entry.id), [CHAN_ID])
  const entry = entries[0]
  check('the entry carries its lane, provider and wire id', [entry.channel, entry.providerId, entry.modelId, entry.wire], [CHANNEL_LANE, PROVIDER, MODEL, 'chat'])
  check('…and the gateway-declared capacities', [entry.contextWindow, entry.maxOutput, entry.vision], [131072, 16384, false])
}

const { apply, inject } = await import('../index.js')
const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'timer', 'connection', 'attachments'], onRegister: route => routes.push(route) })
apply(ctx, {})
const api = () => routes.find(route => route.kind === 'prefix')?.handler
await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
const adapter = ctx.__captured.adapters[0]?.adapter
const summary = () => callRoute(api(), 'GET', '/api/our-free-model/summary')
const post = (url, body) => callRoute(api(), 'POST', `/api/our-free-model${url}`, body)

let summaryJson = null
// The host swallows a failed lane fetch into a log line, so a timeout reports
// the recent logs beside the condition — the difference between "the row never
// came" and "the listing was refused" has to be visible in the failure.
await until(async () => {
  const response = await summary()
  summaryJson = response.json ?? null
  return (summaryJson?.catalog ?? []).some(entry => entry.id === CHAN_ID)
}, { what: `the ${CHAN_ID} row to join the catalog (host logs: ${ctx.__logs.slice(-4).join(' | ') || 'none'})`, timeoutMs: 20000 })

const byId = new Map((summaryJson.catalog ?? []).map(entry => [entry.id, entry]))
const chanRow = byId.get(CHAN_ID)
checkThat('the channel lane row joined the catalog', chanRow !== undefined, [...byId.keys()].join(', '))
check('the row is tagged with its lane', chanRow?.channel, 'chan')
check('with the provider and model kept separate', [chanRow?.providerId, chanRow?.modelId], [PROVIDER, MODEL])
check('the listing is filtered to the pack providers — foreign plugins never leak', [byId.has(FOREIGN_ID), byId.has(SELF_LANE_ID)], [false, false])
check('duplicate and malformed rows widened nothing', (summaryJson.catalog ?? []).filter(entry => entry.channel === 'chan').map(entry => entry.id), [CHAN_ID])
check('a listed row is not claimed as tested', [chanRow?.availability, chanRow?.availabilitySource, chanRow?.probedAt], ['unknown', 'listing', 0])
check('the row is routing-only — no standalone route', chanRow?.route, null)
check('the key reached the gateway — no unauthorized call', gatewayAuthFailures, 0)

// The harness picker must not advertise chan models standalone.
const listed = await adapter.listModels('our-free-model')
checkThat('listModels never advertises a chan row standalone', !listed.some(row => row.id === CHAN_ID), listed.map(row => row.id).join(', '))

// The chain editor's own list does see it — that is how a chain references it.
const combos = await callRoute(api(), 'GET', '/api/our-free-model/combos')
checkThat('the chain editor offers the chan model to chains', (combos.json?.models ?? []).some(row => row.id === CHAN_ID && row.channel === 'chan'), JSON.stringify((combos.json?.models ?? []).map(row => row.id)))
const comboRow = byId.get(COMBO_ID)
checkThat('the combo resolved with both links', comboRow !== undefined, [...byId.keys()].join(', '))
check('the chain kept the chan link', comboRow?.combo, [FREE_ID, CHAN_ID])

// ── 4. the turn: the free link hits a wall, the chan link answers ────────────
const TURN_TOOL = { type: 'function', function: { name: 'our_lane_probe_tool', description: 'a caller tool that must ride as declared', parameters: { type: 'object', properties: {} } } }
const controller = new AbortController()
const chunks = []
try {
  for await (const chunk of adapter.stream({
    provider: 'our-free-model',
    model: COMBO_ID,
    maxTokens: 4096,
    reasoningEffort: 'high',
    sessionId: 'channel-lane-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    tools: [TURN_TOOL],
    signal: controller.signal,
  })) chunks.push(chunk)
} finally {
  controller.abort()
}
const answer = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const finish = chunks.find(chunk => chunk.type === 'finish')?.reason

checkThat('the free link was tried and refused', freeLane.requests.filter(row => JSON.stringify(row.body).includes(TASK)).length === 1, JSON.stringify(freeLane.requests.map(row => row.path)))
check('the channel gateway received exactly one turn', gatewayRequests.length, 1)
checkThat('the gateway saw the bearer key', gatewayRequests[0]?.authorized === true, JSON.stringify(gatewayRequests[0]?.authorized))
check('the wire id is provider/model, never the chan: catalog id', gatewayRequests[0]?.body?.model, `${PROVIDER}/${MODEL}`)
checkThat('the answer streamed back to the caller', answer.includes(CHAN_ANSWER), answer)
check('the turn finishes cleanly', finish?.kind, 'stop')
check('exactly one finish reached the caller', chunks.filter(chunk => chunk.type === 'finish').length, 1)
checkThat('the caller tools rode as declared, with no decoy quartet added', JSON.stringify(gatewayRequests[0]?.body?.tools) === JSON.stringify([TURN_TOOL]) && !/bash|glob|grep|read/.test(JSON.stringify(gatewayRequests[0]?.body?.tools)), JSON.stringify(gatewayRequests[0]?.body?.tools))
check('the chosen reasoning effort rode through as chosen', gatewayRequests[0]?.body?.reasoning_effort, 'high')

const stats = (await callRoute(api(), 'GET', '/api/our-free-model/stats')).json
const comboStats = stats.models.find(row => row.model === COMBO_ID)
checkThat('the logical turn is attributed to the chain', comboStats !== undefined, JSON.stringify(stats.models.map(row => row.model)))
check('recorded as one turn', comboStats?.turns, 1)
check('not a failed turn', comboStats?.failedTurns, 0)

// ── 4b. a non-stream JSON answer still reaches the caller ───────────────────
// The poster forces `stream:true`, but a gateway that ignores it answers with
// one `chat.completion` document. Handing that document to the chat decoder
// yields no text (`choices[0].message` is not `choices[0].delta`), so the
// poster must synthesise the delta frames itself.
gatewayJsonAnswer = true
const jsonChunks = []
try {
  for await (const chunk of adapter.stream({
    provider: 'our-free-model',
    model: COMBO_ID,
    maxTokens: 4096,
    sessionId: 'channel-lane-json-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    signal: new AbortController().signal,
  })) jsonChunks.push(chunk)
} finally {
  gatewayJsonAnswer = false
}
const jsonAnswer = jsonChunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const jsonFinish = jsonChunks.find(chunk => chunk.type === 'finish')?.reason
checkThat('the non-stream gateway answer is folded into deltas', jsonAnswer.includes(CHAN_JSON_ANSWER), jsonAnswer)
check('the non-stream turn finishes cleanly', jsonFinish?.kind, 'stop')

// ── 5. the refresh round re-syncs the lane and never probes it ───────────────
const listCallsBefore = gatewayListCalls
const refresh = await post('/refresh')
check('the manual refresh answers', refresh.status, 200)
checkThat('the refresh round re-reads the channel gateway listing', gatewayListCalls > listCallsBefore, `${listCallsBefore} -> ${gatewayListCalls}`)
checkThat('no probe was ever spent on a chan row against the free lane', !freeLane.requests.some(row => row.body?.model === CHAN_ID || row.body?.model === `${PROVIDER}/${MODEL}`), JSON.stringify(freeLane.requests.map(row => row.body?.model)))

// ── teardown ────────────────────────────────────────────────────────────────
for (const disposer of ctx.__disposers.reverse()) {
  try { disposer() } catch { /* a suite tearing down must not fail on teardown */ }
}
await freeLane.close()
await new Promise(resolve => chanGateway.close(resolve))
fs.rmSync(home, { recursive: true, force: true })

console.log(failures === 0
  ? '\nchannel-lane: the 白嫖 lane syncs, dials through the pack gateway, and carries a chain fallback end to end'
  : `\nchannel-lane: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
