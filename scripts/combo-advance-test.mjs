/**
 * The combo chain's advance policy, driven through the real Adapter against a
 * local HTTP stand-in.
 *
 * The commit rule is the feature's whole contract, and it lives across two
 * files: `commitsAnswer` (what may not be taken back) and `advanceVerdict`
 * (what a candidate's failure must report so the chain may move on). The two
 * must agree on one definition of "answer": visible text or a streamed tool
 * call — never thinking. A model that burns a minute of reasoning and then
 * hits a quota wall is the single most valuable case to fail over, and these
 * scenarios pin it from both sides:
 *
 * - reasoning deltas, then an in-stream rate-limit refusal -> the chain moves
 *   to the next candidate and the caller never sees the held thinking;
 * - reasoning deltas, then a stream that ends cleanly with no finish token
 *   (closeAll's reasoning block-end must not commit either);
 * - visible text, then a refusal -> committed, the failure ends the turn;
 * - a refusal before any output -> the plain advance that always worked.
 *
 * Single-model checkpoint recovery is switched off (`streamRecovery: false`)
 * so the chain's own advance is the only recovery path a scenario can take.
 *
 * Run: node scripts/combo-advance-test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import process from 'node:process'
import { chatFrames } from './lib/fake-kernel.mjs'

let activeCase
const TASK = 'COMBO_TASK_SENTINEL: answer the original question'
const ANSWER = 'VISIBLE_ANSWER_SENTINEL'
const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const reasoningFrames = text => [
  sse({ choices: [{ index: 0, delta: { reasoning: text } }] }),
  sse({ choices: [{ index: 0, delta: { reasoning: `${text} (part two)` } }] }),
].join('')

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
    const scenario = activeCase
    const ordinal = scenario.requests.length
    scenario.requests.push({ body, path: req.url })
    const answer = scenario.answers[ordinal] ?? { status: 500, body: '{"error":{"message":"unexpected extra request"}}' }
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

const MODELS = ['deepseek-v4-flash-free', 'mimo-v2.5-free', 'mimo-v2.6-flash-free']
const COMBO_ID = 'combo:failover'
const COMBOS = normalizeCombos([
  { name: 'failover', models: ['deepseek-v4-flash-free', 'mimo-v2.5-free'], strategy: 'fallback', stickyLimit: 1 },
])
const FREE_CATALOG = buildCatalog(MODELS)
const CATALOG = [...FREE_CATALOG, ...buildComboCatalog(COMBOS, FREE_CATALOG)]

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

function setup(answers) {
  const scenario = { answers, requests: [] }
  activeCase = scenario
  const turns = []
  const controller = new AbortController()
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog: CATALOG,
      membership: { [ROUTE_MAIN]: MODELS },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false },
      attributionUserAgent: 'offline-combo-advance-test',
    }),
    recordUsage: () => {},
    recordTurn: row => turns.push(row),
    warn: () => {},
  })
  const stream = adapter.stream({
    provider: ROUTE_MAIN,
    model: COMBO_ID,
    maxTokens: 4096,
    sessionId: 'combo-advance-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    signal: controller.signal,
  })
  return { scenario, turns, controller, stream }
}

async function drive(answers) {
  const run = setup(answers)
  const chunks = []
  try {
    for await (const chunk of run.stream) chunks.push(chunk)
    return {
      ...run,
      chunks,
      finish: chunks.find(chunk => chunk.type === 'finish')?.reason,
      text: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
    }
  } finally {
    run.controller.abort()
  }
}

const noThinking = chunks => chunks.every(chunk => chunk.type !== 'reasoning-delta'
  && !(chunk.type === 'block-end' && chunk.block?.type === 'reasoning'))

await check('thinking then an in-stream quota wall advances to the next candidate', async () => {
  const run = await drive([
    // The free lane speaks the chat wire; the in-band refusal arrives after the
    // reasoning deltas, when the status line is long spent.
    { body: reasoningFrames('weighing the options carefully') + sse({ error: { message: 'rate limit exceeded' } }) },
    { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' },
  ])
  assert.equal(run.scenario.requests.length, 2, 'the chain must try the second candidate')
  assert.equal(run.finish?.kind, 'stop', 'the second candidate answers the turn')
  assert.ok(run.text.includes(ANSWER), 'the caller gets the second candidate’s answer')
  assert.ok(noThinking(run.chunks), 'the failed candidate’s held thinking is discarded')
  assert.equal(run.chunks.filter(chunk => chunk.type === 'finish').length, 1, 'exactly one finish')
  assert.equal(run.turns.length, 1, 'one logical turn')
  assert.equal(run.turns[0].model, COMBO_ID, 'the turn is recorded under the chain’s own id')
  assert.equal(run.turns[0].ok, true)
  assert.equal(run.turns[0].attempts, 2)
})

await check('a reasoning block-end does not commit the chain', async () => {
  const run = await drive([
    // Reasoning deltas, then a clean EOF with no finish token: closeAll closes
    // the thinking block with a block-end right before the failure surfaces.
    { body: reasoningFrames('a long analysis that never got to speak') },
    { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' },
  ])
  assert.equal(run.scenario.requests.length, 2, 'the reasoning block-end must not have committed the chain')
  assert.equal(run.finish?.kind, 'stop')
  assert.ok(run.text.includes(ANSWER))
  assert.ok(noThinking(run.chunks), 'the held thinking goes out with the discarded attempt')
  assert.equal(run.turns[0].attempts, 2)
})

await check('visible text commits the chain: a later refusal ends the turn', async () => {
  const run = await drive([
    { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ error: { message: 'rate limit exceeded' } }) },
  ])
  assert.equal(run.scenario.requests.length, 1, 'a committed candidate is not retried on another model')
  assert.equal(run.finish?.kind, 'error', 'the failure ends the turn the normal way')
  assert.ok(run.text.includes(ANSWER), 'the released answer stays with the caller')
  assert.equal(run.turns.length, 1)
  assert.equal(run.turns[0].ok, false)
  assert.equal(run.turns[0].attempts, 1)
})

await check('a refusal before any output still advances (the plain case)', async () => {
  const run = await drive([
    { status: 429, body: '{"error":{"message":"rate limit exceeded"}}' },
    { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' },
  ])
  assert.equal(run.scenario.requests.length, 2)
  assert.equal(run.finish?.kind, 'stop')
  assert.ok(run.text.includes(ANSWER))
  assert.equal(run.turns[0].attempts, 2)
})

// 用户报的现象: 链上一个模型失败, 没切下一个, 一个失败就结束。机制:
// runCombo 只在 advance===true 时继续下一环, 而 advance 复用了单模型重试语义
// (shouldAdvance = retryable||cooldownMs>0)。request 级失败(region/上下文/4xx)
// 对同模型重放无意义, 但换一个模型正是答案 — 不同窗口、不同区域、不同校验。
for (const [label, refusal] of [
  ['4xx 普通请求错误', { status: 400, body: '{"error":{"message":"bad request"}}' }],
  ['上下文超限', { status: 400, body: '{"error":{"code":"context_length_exceeded","message":"too long"}}' }],
  ['区域封锁', { status: 403, body: '{"error":{"type":"RegionError","message":"not available in your country"}}' }],
]) {
  await check(`a chain advances past a request-scoped failure (${label})`, async () => {
    const run = await drive([
      refusal,
      { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' },
    ])
    assert.equal(run.scenario.requests.length, 2, 'the chain must try the next candidate after this failure')
    assert.equal(run.finish?.kind, 'stop', 'the next candidate answers the turn')
    assert.ok(run.text.includes(ANSWER))
  })
}

server.close()
if (failures > 0) console.error(`combo-advance-test: ${failures} failure(s)`)
else console.log('combo-advance-test: the chain commits on answers only and fails over on everything else')
process.exitCode = failures > 0 ? 1 : 0
