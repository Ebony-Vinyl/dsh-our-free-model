/**
 * The Kilo channel, offline.
 *
 * Kilo AI's gateway is the plugin's keyless lane: no credential exists on it,
 * so nothing here signs, seals, or gates — the promises to pin are the ones a
 * keyless lane can still break:
 *
 * 1. **Roster** — only the listing's `isFree: true` rows are served (a paid id
 *    keyless is a guaranteed 401), ids dedupe, and the persisted cache revives
 *    into the same roster after a restart with the gateway unreachable.
 *    Successful empty free pools clear both views; failed or malformed
 *    listings retain the last roster, including an already-cleared roster.
 * 2. **Mount** — the channel's entries join the catalog under `channel:
 *    'kilo'`, land on the main route without ever being probed (a probe would
 *    spend itself against the wrong gateway), and the shared free-pool UI reports
 *    listed Kilo models as untested candidates, not verified successes.
 * 3. **Turn** — a streamed answer survives this gateway's wire dialect: the
 *    `: KILO PROCESSING` keep-alive comment lines, reasoning under
 *    `delta.reasoning`, indexed tool-call deltas, the usage frame, `[DONE]` —
 *    and a paid id asked keyless comes back as a plain request defect, not a
 *    broken-credential verdict.
 *
 * Kilo is a loopback HTTP server; the free lane points at a dead port. Nothing
 * real is contacted, no quota is spent.
 *
 * Run: node scripts/kilo-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { callRoute, fakeContext, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

// ── 1. the roster, pure ──────────────────────────────────────────────────────
const { buildKiloCatalog, isKiloEntry, kiloDisplayName, reviveKiloCatalog } = await import('../src/catalog.js')
{
  const rows = [
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'NVIDIA: Nemotron 3 Ultra (free)', isFree: true, context_length: 1000000, top_provider: { max_completion_tokens: 65536 }, architecture: { input_modalities: ['text'] }, supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning'] },
    { id: 'stepfun/step-3.7-flash:free', name: 'StepFun: Step 3.7 Flash (free)', isFree: true, top_provider: { context_length: 262144, max_completion_tokens: 262144 }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['max_tokens', 'reasoning'] },
    { id: 'kilo-auto/free', name: 'Auto Free', isFree: true, context_length: 256000, top_provider: { max_completion_tokens: 32768 }, architecture: { input_modalities: ['text'] }, supported_parameters: ['max_tokens', 'reasoning'] },
    // A paid id: never served keyless.
    { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', isFree: false, context_length: 200000 },
    // A repeat and a malformed row: neither widens the roster.
    { id: 'kilo-auto/free', name: 'Auto Free', isFree: true },
    { id: '', isFree: true },
    null,
  ]
  const catalog = buildKiloCatalog(rows)
  check('only free rows build catalog entries', catalog.map(entry => entry.id), [
    'nvidia/nemotron-3-ultra-550b-a55b:free', 'stepfun/step-3.7-flash:free', 'kilo-auto/free',
  ])
  check('every entry carries the channel tag end to end', catalog.every(entry => isKiloEntry(entry) && entry.wire === 'chat'), true)
  check('the picker name drops the vendor prefix and the (free) tail',
    catalog[0].name, 'Kilo Nemotron 3 Ultra')
  check('capacities come from the listing with fallbacks',
    [catalog[0].contextWindow, catalog[0].maxOutput, catalog[1].contextWindow], [1000000, 65536, 262144])
  check('vision follows the declared input modalities', catalog[1].vision, true)
  check('an unnamed row falls back to prettifying the id',
    kiloDisplayName({ id: 'some-org/some-model:free' }).startsWith('Kilo '), true)
  check('a model whose endpoint honours the off rung declares the full menu',
    [catalog[0].efforts, catalog[0].effortDefault, catalog[0].canDisableThinking, catalog[0].effortPatch],
    [['disabled', 'low', 'medium', 'high'], 'high', true, { reasoning: { effort: '$effort' } }])
  check('a model whose endpoint rejects disabling omits the off rung, not the whole menu',
    [catalog[1].efforts, catalog[1].effortOffPatch, catalog[1].canDisableThinking],
    [['low', 'medium', 'high'], undefined, false])
  check('an endpoint that ignores the off rung (the auto-router) omits it too',
    catalog[2].efforts, ['low', 'medium', 'high'])

  const revived = reviveKiloCatalog(JSON.parse(JSON.stringify(catalog)))
  check('the persisted cache revives into the same roster, menus included', revived, catalog)
  check('a damaged cache degrades to a shorter roster',
    reviveKiloCatalog([{ id: 'kept:free', channel: 'kilo', name: 'Kilo Kept', contextWindow: 1024, maxOutput: 512, vision: false }, 'garbage', { channel: 'kilo' }, null]).map(entry => entry.id), ['kept:free'])
}

// ── 2. the mount + the turn, against a loopback gateway ──────────────────────
const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const KILO_MODELS = [
  { id: 'nvidia/nemotron-3.5-lightning:free', name: 'NVIDIA: Nemotron 3.5 Lightning (free)', isFree: true, context_length: 1000000, top_provider: { max_completion_tokens: 65536 }, architecture: { input_modalities: ['text'] }, supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning'] },
  { id: 'kilo-auto/free', name: 'Auto Free', isFree: true, context_length: 256000, top_provider: { max_completion_tokens: 32768 }, architecture: { input_modalities: ['text'] }, supported_parameters: ['max_tokens', 'reasoning'] },
  { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', isFree: false },
]
let kiloListing = { status: 200, payload: { data: KILO_MODELS } }
const turns = []
const kiloServer = http.createServer((req, res) => {
  const chunks = []
  req.on('data', piece => chunks.push(piece))
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/models') {
      if (kiloListing.disconnect) { req.destroy(); return }
      res.writeHead(kiloListing.status, { 'content-type': 'application/json' })
      res.end(kiloListing.raw ?? JSON.stringify(kiloListing.payload))
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    turns.push(body)
    if (String(body.model).startsWith('anthropic/')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'PAID_MODEL_AUTH_REQUIRED', message: 'You need to sign in to use this model.' }, error_type: 'paid_model_auth_required' }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // The gateway's own dialect: keep-alive comment lines while the model is
    // scheduled, reasoning under `delta.reasoning`, an indexed tool call, the
    // usage frame on the tail, then `[DONE]`.
    res.write(': KILO PROCESSING\n\n')
    setTimeout(() => {
      res.write(': KILO PROCESSING\n\n')
      res.write(sse({ choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'thinking ' } }] }))
      res.write(sse({ choices: [{ index: 0, delta: { content: 'Kilo answer' } }] }))
      const toolDelta = call => ({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })
      const argsHead = '{"path"'
      const argsTail = ':"x"}'
      res.write(sse(toolDelta({ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: argsHead } })))
      res.write(sse(toolDelta({ index: 0, function: { arguments: argsTail } })))
      // The full usage lands on the tail frame, as the live gateway sends it.
      res.write(sse({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 20, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } },
      }))
      res.end('data: [DONE]\n\n')
    }, 30).unref?.()
  })
})
await new Promise(resolve => kiloServer.listen(0, '127.0.0.1', resolve))
kiloServer.unref()
process.env.OUR_FREE_MODEL_KILO_BASE = `http://127.0.0.1:${kiloServer.address().port}`

const dead = http.createServer()
await new Promise(resolve => dead.listen(0, '127.0.0.1', resolve))
const deadBase = `http://127.0.0.1:${dead.address().port}`
await new Promise(resolve => dead.close(resolve))
process.env.OUR_FREE_MODEL_BASE = deadBase

const { apply, inject } = await import('../index.js')
const { ROUTE_MAIN } = await import('../src/adapter.js')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-kilo-'))
process.env.DSH_HOME = home
const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'attachments'], onRegister: route => routes.push(route) })
apply(ctx, {})
const api = () => routes.find(route => route.kind === 'prefix')?.handler
await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })

// The boot round (egress sync → catalog refresh) is an async effect; poll the
// summary until the Kilo roster has landed.
let summaryJson
await until(async () => {
  const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
  summaryJson = summary.json
  return (summaryJson.catalog ?? []).some(entry => entry.channel === 'kilo')
}, { what: 'the Kilo roster to join the catalog', timeoutMs: 10000 })
const summary = { json: summaryJson }
const kiloRows = (summaryJson.catalog ?? []).filter(entry => entry.channel === 'kilo')
check('the Kilo roster joins the catalog from the live listing', kiloRows.map(entry => entry.id),
  ['nvidia/nemotron-3.5-lightning:free', 'kilo-auto/free'])
check('a paid id is never advertised keyless', kiloRows.some(entry => entry.id === 'anthropic/claude-sonnet-5'), false)
check('roster presence is listed, not a successful inference verdict',
  kiloRows.every(entry => entry.availabilitySource === 'listing' && entry.availability === 'unknown'), true)
check('the entries sit on the main route', kiloRows.every(entry => entry.route === ROUTE_MAIN), true)
check('a verified-off family declares the full thinking menu, EAC shape',
  kiloRows.find(entry => entry.id === 'nvidia/nemotron-3.5-lightning:free')?.efforts, ['disabled', 'low', 'medium', 'high'])
check('the auto-router declares the menu without the off rung it ignores',
  kiloRows.find(entry => entry.id === 'kilo-auto/free')?.efforts, ['low', 'medium', 'high'])
check('menu models show a flat output ceiling (the level is the control, not a ladder)',
  kiloRows.every(entry => Array.isArray(entry.budgets) && entry.budgets.length === 3
    && entry.budgets.every(rung => rung.tokens === 32768)), true)
check('the default effort is the menu top, as on the EAC lane',
  kiloRows.every(entry => entry.effortDefault === 'high'), true)

// The store coalesces writes (800 ms); wait for the flush instead of racing it.
let persistedRows = []
await until(() => {
  try {
    persistedRows = JSON.parse(fs.readFileSync(path.join(home, 'our-free-model', 'catalog.json'), 'utf8')).kiloRows ?? []
  } catch { persistedRows = [] }
  return persistedRows.length > 0
}, { what: 'the persisted roster to flush', timeoutMs: 5000 })
check('the roster persists for the next cold start', persistedRows.map(entry => entry.id),
  ['nvidia/nemotron-3.5-lightning:free', 'kilo-auto/free'])


// The turn: the adapter routes the entry to the Kilo wire with the caller's
// tools as declared, and the dialect parses end to end.
const adapter = ctx.__captured.adapters[0]?.adapter
const turnOptions = {
  provider: ROUTE_MAIN, sessionId: 'kilo:turn',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
}
const chunks = []
for await (const chunk of adapter.stream({ ...turnOptions, model: 'nvidia/nemotron-3.5-lightning:free' })) chunks.push(chunk)
check('reasoning arrives as a reasoning block',
  chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'thinking '), true)
check('the answer text survives the keep-alive comments',
  chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Kilo answer'), true)
check('an indexed tool-call delta stream assembles into one callable block',
  chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call').map(chunk => chunk.block),
  [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"x"}' }])
const finish = chunks.find(chunk => chunk.type === 'finish')?.reason
check('the turn finishes normally', finish?.kind, 'tool-calls')
const usage = chunks.find(chunk => chunk.type === 'usage')?.usage
check('usage follows the disjoint-count rule (cache read subtracted, reasoning named)',
  [usage?.inputTokens, usage?.outputTokens, usage?.cacheReadTokens, usage?.reasoningTokens], [16, 9, 4, 3])
check('the request carried the declared tools and no tool-name gate rewrite',
  [turns[0].tools?.[0]?.function?.name, turns[0].tool_choice === undefined ? 'unset' : 'set'], ['read', 'unset'])
check('an unspecified level rides the menu default (High), like the EAC lane',
  turns[0].reasoning, { effort: 'high' })

// The selected level goes out as the model's own effort field — the real
// control this channel's gateways honour — not as a token-budget rung.
for await (const chunk of adapter.stream({ ...turnOptions, model: 'nvidia/nemotron-3.5-lightning:free', reasoningEffort: 'disabled' })) void chunk
for await (const chunk of adapter.stream({ ...turnOptions, model: 'nvidia/nemotron-3.5-lightning:free', reasoningEffort: 'low' })) void chunk
for await (const chunk of adapter.stream({ ...turnOptions, model: 'kilo-auto/free', reasoningEffort: 'disabled' })) void chunk
check('the off rung sends reasoning.enabled=false', turns[1].reasoning, { enabled: false })
check('a named level rides the wire verbatim', turns[2].reasoning, { effort: 'low' })
check('a model without the off rung falls back to its menu default, never a doomed request',
  turns[3].reasoning, { effort: 'high' })
check('every turn went out with no authorization material at all',
  turns.length, 4)

// A paid id asked keyless: the same vocabulary as every other lane, named for
// what it is — a model this lane does not serve, not a broken credential. The
// poster is pinned directly: a paid id never enters the catalog, so the adapter
// would refuse it locally and the gateway's own refusal would never be exercised.
const { postKiloStreamed } = await import('../src/kilo.js')
let paidFailure
try {
  await postKiloStreamed({
    body: { model: 'anthropic/claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], stream: true },
    onData: () => {},
  })
} catch (error) { paidFailure = error }
check('a paid id keyless fails as a plain request defect', paidFailure?.code, 'CLIENT_ERROR')
check('with the message naming the lane, not a credential store',
  /not on the free pool/.test(paidFailure?.message ?? ''), true)

// Drive actual catalog refreshes; an HTTP success with no free models is an
// authoritative roster, while a failed listing is not an empty-pool signal.
const expectedIds = kiloRows.map(row => row.id)
// Discovery and picker rows omit the internal channel tag.
const kiloIds = rows => rows.filter(row => row.channel === 'kilo' || expectedIds.includes(row.id)).map(row => row.id)
const catalogFile = path.join(home, 'our-free-model', 'catalog.json')
const cachedKiloIds = () => JSON.parse(fs.readFileSync(catalogFile, 'utf8')).kiloRows.map(row => row.id)
const waitForCache = expected => until(() => {
  try { return JSON.stringify(cachedKiloIds()) === JSON.stringify(expected) } catch { return false }
}, { what: `Kilo cache to contain ${expected.length} models`, timeoutMs: 5000 })
const visibleKiloIds = async () => kiloIds((await callRoute(api(), 'GET', '/api/our-free-model/summary')).json.catalog)
const refreshKiloIds = async () => kiloIds(await ctx.__captured.discovery())
const stopContext = async context => {
  for (const stop of context.__disposers.slice().reverse()) await stop()
}
let restarted
let stopped = false
try {
  kiloListing = { status: 200, payload: { data: KILO_MODELS.map(row => ({ ...row, isFree: false })) } }
  check('a successful all-paid listing clears discovery', await refreshKiloIds(), [])
  check('and clears the current settings catalog', await visibleKiloIds(), [])
  check('and clears the adapter picker', kiloIds(await adapter.listModels(ROUTE_MAIN)), [])
  await waitForCache([])
  check('a successful empty free pool clears the persisted roster', cachedKiloIds(), [])
  const before = turns.length
  const refused = []
  for await (const chunk of adapter.stream({ ...turnOptions, model: expectedIds[0] })) refused.push(chunk)
  check('a stale selected model is refused locally after removal',
    refused.some(chunk => chunk.type === 'finish' && chunk.reason?.kind === 'error'), true)
  check('and the removed model spends no upstream request', turns.length, before)

  kiloListing = { status: 200, payload: { data: KILO_MODELS } }
  check('models can rejoin when the free pool returns', await refreshKiloIds(), expectedIds)
  await waitForCache(expectedIds)
  for (const [label, response] of [
    ['HTTP 503', { status: 503, payload: { error: { message: 'temporary listing failure' } } }],
    ['network disconnect', { disconnect: true }],
    ['HTTP 200 error envelope', { status: 200, payload: { error: { message: 'temporary listing failure' } } }],
    ['HTTP 200 error with empty data', { status: 200, payload: { error: { message: 'temporary listing failure' }, data: [] } }],
    ['wrong data shape', { status: 200, payload: { data: {} } }],
    ['non-JSON response', { status: 200, raw: '<html>temporarily unavailable</html>' }],
  ]) {
    kiloListing = response
    check(`${label} retains the last free roster`, await refreshKiloIds(), expectedIds)
    check(`${label} retains its persisted cache`, cachedKiloIds(), expectedIds)
  }

  kiloListing = { status: 200, payload: { data: [] } }
  check('an explicitly empty listing also clears discovery', await refreshKiloIds(), [])
  check('and clears the settings catalog', await visibleKiloIds(), [])
  await waitForCache([])
  await stopContext(ctx)
  stopped = true

  // Mount a fresh instance from the same disk state while its gateway fails.
  // Merely reviving [] through the pure helper would not test the boot path.
  kiloListing = { status: 503, payload: { error: { message: 'offline at restart' } } }
  restarted = fakeContext({ inject, mounted: ['llm', 'webServer', 'attachments'] })
  apply(restarted, {})
  const restartAdapter = restarted.__captured.adapters[0].adapter
  check('a restart loads the empty cache without resurrecting old models',
    kiloIds(await restartAdapter.listModels(ROUTE_MAIN)), [])
  check('a failed refresh after restart still keeps that empty roster',
    kiloIds(await restarted.__captured.discovery()), [])
  check('and the empty cache stays empty on disk', cachedKiloIds(), [])
} finally {
  if (restarted) await stopContext(restarted)
  if (!stopped) await stopContext(ctx)
  await new Promise(resolve => kiloServer.close(resolve))
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nkilo-test: all checks passed' : `\nkilo-test: ${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
