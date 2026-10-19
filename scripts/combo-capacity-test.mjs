/**
 * The combo chain's chain-level capacity override.
 *
 * The channel lane cannot read capacities out of its gateway, so every `chan:`
 * row falls back to 128K/32K and the intersection rule drags a whole chain down
 * to that fallback. `contextWindow` / `maxOutput` on a stored chain are the
 * user's escape hatch: the built catalog row, `resolveModel`'s answer and the
 * request body must all carry the typed number, for every member of the chain.
 *
 * Run: node scripts/combo-capacity-test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import process from 'node:process'
import { chatFrames } from './lib/fake-kernel.mjs'

let activeCase
const TASK = 'COMBO_CAPACITY_TASK: answer the original question'
const ANSWER = 'VISIBLE_ANSWER_SENTINEL'
const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const healthy = sse({ choices: [{ index: 0, delta: { content: ANSWER } }] })
  + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  + 'data: [DONE]\n\n'

const server = http.createServer((req, res) => {
  const pieces = []
  req.on('data', piece => pieces.push(piece))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(pieces).toString('utf8'))
    if (!JSON.stringify(body).includes(TASK)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatFrames('healthy local boot probe'))
      return
    }
    activeCase.requests.push({ body, path: req.url })
    const raw = activeCase.responses[activeCase.requests.length - 1] ?? activeCase.responses[activeCase.responses.length - 1]
    const answer = typeof raw === 'string' ? { body: raw } : raw
    if (answer.status !== undefined) {
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(answer.body ?? '')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(answer.body ?? '')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
server.unref()
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`

const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')
const { buildCatalog } = await import('../src/catalog.js')
const { buildComboCatalog, normalizeCombos } = await import('../src/combos.js')

const MODELS = ['deepseek-v4-flash-free', 'mimo-v2.5-free']
const COMBO_ID = 'combo:lifted'
const COMBOS = normalizeCombos([
  { name: 'lifted', models: MODELS, strategy: 'fallback', contextWindow: 1000000, maxOutput: 200000 },
])
const FREE_CATALOG = buildCatalog(MODELS)
const CATALOG = [...FREE_CATALOG, ...buildComboCatalog(COMBOS, FREE_CATALOG)]

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

function adapterWith(catalog, settings) {
  return new FreeModelAdapter({
    state: () => ({
      catalog,
      membership: { [ROUTE_MAIN]: MODELS },
      settings: { enabled: true, streamRecovery: false, ...settings },
      attributionUserAgent: 'offline-combo-capacity-test',
    }),
    recordUsage: () => {},
    recordTurn: () => {},
    warn: () => {},
  })
}

/**
 * One complete combo turn against the stand-in; returns the seen requests.
 * `responses` is indexed by request ordinal, so a scenario can refuse the
 * first candidate and answer on the second.
 */
async function drive(model, maxTokens, responses = [healthy]) {
  const scenario = { responses, requests: [] }
  activeCase = scenario
  const controller = new AbortController()
  const stream = adapterWith(CATALOG, { defaultMaxTokens: 32768 }).stream({
    provider: ROUTE_MAIN,
    model,
    maxTokens,
    reasoningEffort: 'deep',
    sessionId: 'combo-capacity-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    signal: controller.signal,
  })
  try { for await (const chunk of stream) void chunk } finally { controller.abort() }
  return scenario
}

await check('an explicit chain window replaces the members intersection', async () => {
  const row = CATALOG.find(entry => entry.id === COMBO_ID)
  assert.equal(row?.contextWindow, 1000000)
})

await check('an explicit chain output replaces the intersection', async () => {
  const row = CATALOG.find(entry => entry.id === COMBO_ID)
  assert.equal(row?.maxOutput, 200000)
  assert.equal(row?.maxOutputOverride, 200000)
})

await check('a chain without explicit numbers keeps the intersection', async () => {
  const plain = buildComboCatalog(normalizeCombos([{ name: 'plain', models: MODELS }]), FREE_CATALOG)
  assert.equal(plain[0]?.contextWindow, 128000)
  assert.equal(plain[0]?.maxOutput, 64000)
  assert.equal(plain[0]?.maxOutputOverride, undefined)
})

await check('a window alone keeps the output side on the intersection', async () => {
  const rows = buildComboCatalog(normalizeCombos([{ name: 'window-only', models: MODELS, contextWindow: 2000000 }]), FREE_CATALOG)
  assert.equal(rows[0]?.contextWindow, 2000000)
  assert.equal(rows[0]?.maxOutput, 64000)
  assert.equal(rows[0]?.maxOutputOverride, undefined)
})

await check('an output ceiling alone keeps the window on the intersection', async () => {
  const rows = buildComboCatalog(normalizeCombos([{ name: 'output-only', models: MODELS, maxOutput: 99999 }]), FREE_CATALOG)
  assert.equal(rows[0]?.contextWindow, 128000)
  assert.equal(rows[0]?.maxOutput, 99999)
  assert.equal(rows[0]?.maxOutputOverride, 99999)
})

await check('normalize drops non-positive overrides and keeps whole numbers', async () => {
  const dirty = normalizeCombos([
    { name: 'dirty', models: ['deepseek-v4-flash-free'], contextWindow: 0, maxOutput: -5 },
    { name: 'kept', models: ['deepseek-v4-flash-free'], contextWindow: '262144', maxOutput: 65536.9 },
  ])
  assert.equal('contextWindow' in dirty[0], false)
  assert.equal('maxOutput' in dirty[0], false)
  assert.equal(dirty[1]?.contextWindow, 262144)
  assert.equal(dirty[1]?.maxOutput, 65536)
})

// 0.5 个 token 不是容量。截断成 0 会覆盖成员交集、给请求一个 0 预算,所以小于 1
// 的小数必须和「没填」一样回落到交集(审查意见 #341: "0.5 容量截断成 0")。
await check('a fractional capacity below one falls back instead of truncating to zero', async () => {
  const rows = normalizeCombos([{ name: 'fractional', models: MODELS, contextWindow: 0.5, maxOutput: 0.5 }])
  assert.equal('contextWindow' in rows[0], false, '0.5 must not be stored as 0')
  assert.equal('maxOutput' in rows[0], false, '0.5 must not be stored as 0')
  const built = buildComboCatalog(rows, FREE_CATALOG)[0]
  assert.equal(built.contextWindow, 128000, 'the intersection window is back in charge')
  assert.equal(built.maxOutput, 64000, 'the intersection ceiling is back in charge')
  assert.equal(built.maxOutputOverride, undefined, 'no override may be reported')
  const resolved = await adapterWith([...FREE_CATALOG, built], { defaultMaxTokens: 32768 })
    .resolveModel(ROUTE_MAIN, 'combo:fractional')
  assert.equal(resolved.context.contextWindow, 128000)
  assert.equal(resolved.defaultMaxTokens, 32768)
  const scenario = { responses: [healthy], requests: [] }
  activeCase = scenario
  const controller = new AbortController()
  const stream = adapterWith([...FREE_CATALOG, built], { defaultMaxTokens: 32768 }).stream({
    provider: ROUTE_MAIN,
    model: 'combo:fractional',
    maxTokens: 200000,
    reasoningEffort: 'deep',
    sessionId: 'combo-capacity-fractional',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    signal: controller.signal,
  })
  try { for await (const chunk of stream) void chunk } finally { controller.abort() }
  assert.equal(scenario.requests[0].body.max_tokens, 32768, 'a stale zero must not shrink the budget')
})

await check('resolveModel reports the chain window and the chain ceiling', async () => {
  const resolved = await adapterWith(CATALOG, { defaultMaxTokens: 32768 }).resolveModel(ROUTE_MAIN, COMBO_ID)
  assert.equal(resolved.context.contextWindow, 1000000)
  assert.equal(resolved.defaultMaxTokens, 200000)
})

await check('the request sends the chain ceiling even above a link capacity', async () => {
  const scenario = await drive(COMBO_ID, 200000)
  assert.equal(scenario.requests.length, 1)
  assert.equal(scenario.requests[0].body.max_tokens, 200000)
})

await check('every candidate in the chain receives the same chain ceiling', async () => {
  const scenario = await drive(COMBO_ID, 200000, [
    { status: 429, body: '{"error":{"message":"rate limit exceeded"}}' },
    { body: healthy },
  ])
  assert.equal(scenario.requests.length, 2, 'the refusal must advance to the second candidate')
  assert.equal(scenario.requests[0].body.max_tokens, 200000)
  assert.equal(scenario.requests[1].body.max_tokens, 200000)
})

await check('a smaller session request still wins over the chain ceiling', async () => {
  const scenario = await drive(COMBO_ID, 4096)
  assert.equal(scenario.requests[0].body.max_tokens, 4096)
})

await check('a chain left on the intersection keeps the session default in charge', async () => {
  const plain = normalizeCombos([{ name: 'plain', models: MODELS }])
  const row = buildComboCatalog(plain, FREE_CATALOG)[0]
  assert.ok(row !== undefined)
  const scenario = { responses: [healthy], requests: [] }
  activeCase = scenario
  const controller = new AbortController()
  const stream = adapterWith([...FREE_CATALOG, row], { defaultMaxTokens: 32768 }).stream({
    provider: ROUTE_MAIN,
    model: 'combo:plain',
    maxTokens: 200000,
    reasoningEffort: 'deep',
    sessionId: 'combo-capacity-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    signal: controller.signal,
  })
  try { for await (const chunk of stream) void chunk } finally { controller.abort() }
  assert.equal(scenario.requests[0].body.max_tokens, 32768)
})

server.close()
if (failures > 0) console.error(`combo-capacity-test: ${failures} failure(s)`)
else console.log('combo-capacity-test: a chain-level window and output ceiling reach the catalog and the wire')
process.exitCode = failures > 0 ? 1 : 0
