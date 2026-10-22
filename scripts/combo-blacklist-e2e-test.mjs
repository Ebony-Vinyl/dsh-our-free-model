/**
 * 连续失败拉黑，端到端跑真实 Adapter + 真实 HTTP 假服务器。
 *
 * 单测覆盖计数与窗口；这里覆盖接线：一条链的某个成员连续失败 N 次后，
 * 后续回合的第一次请求必须打到下一个成员，而不是再次拨被拉黑的那个。
 *
 * Run: node scripts/combo-blacklist-e2e-test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import process from 'node:process'
import { chatFrames } from './lib/fake-kernel.mjs'

let activeCase
const TASK = 'COMBO_BLACKLIST_TASK: answer the original question'
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
    const scenario = activeCase
    scenario.requests.push({ body, path: req.url })
    const answer = scenario.answers[scenario.requests.length - 1]
    if (answer === undefined) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"unexpected extra request"}}')
      return
    }
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
const { buildComboCatalog, failureCount, isBlacklisted, normalizeCombos, resetBlacklist } = await import('../src/combos.js')

const MODELS = ['deepseek-v4-flash-free', 'mimo-v2.5-free']
const COMBO_ID = 'combo:blackout'
const FREE_CATALOG = buildCatalog(MODELS)

let failures = 0
const check = async (name, fn) => {
  resetBlacklist()
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

function makeAdapter(threshold, minutes) {
  const combos = normalizeCombos([{
    name: 'blackout', models: MODELS, strategy: 'fallback',
    failureThreshold: threshold, blackoutMinutes: minutes,
  }])
  const catalog = [...FREE_CATALOG, ...buildComboCatalog(combos, FREE_CATALOG)]
  const turns = []
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog,
      membership: { [ROUTE_MAIN]: MODELS },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false },
      attributionUserAgent: 'offline-combo-blacklist-test',
    }),
    recordUsage: () => {},
    recordTurn: row => turns.push(row),
    warn: () => {},
  })
  return { adapter, turns }
}

/** One complete combo turn; returns the requests it made and the answer text. */
async function drive(adapter, answers) {
  const scenario = { answers, requests: [] }
  activeCase = scenario
  const controller = new AbortController()
  const stream = adapter.stream({
    provider: ROUTE_MAIN,
    model: COMBO_ID,
    maxTokens: 4096,
    sessionId: 'combo-blacklist-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    signal: controller.signal,
  })
  const chunks = []
  try { for await (const chunk of stream) chunks.push(chunk) } finally { controller.abort() }
  return {
    requests: scenario.requests,
    text: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
    finish: chunks.find(chunk => chunk.type === 'finish')?.reason,
  }
}

const refusal = { status: 500, body: '{"error":{"message":"internal server error"}}' }
const ok = { body: healthy }

await check('N consecutive failures of the first member route the next turn to the second', async () => {
  const { adapter } = makeAdapter(2, 5)
  // 第一回合: 首成员失败一次, 次成员成功 -> 计数 1, 未拉黑。
  await drive(adapter, [refusal, ok])
  // 第二回合: 首成员再失败 -> 达到 2, 拉黑; 次成员成功。
  await drive(adapter, [refusal, ok])
  // 第三回合: 首成员已被拉黑, 第一次请求就应打到次成员。
  const third = await drive(adapter, [ok])
  assert.equal(third.requests.length, 1, 'the benched member must not be dialled again')
  assert.ok(third.text.includes(ANSWER))
})

await check('a success resets the streak so a later failure does not bench', async () => {
  const { adapter } = makeAdapter(2, 5)
  await drive(adapter, [refusal, ok])          // 首成员失败 1 次
  assert.equal(failureCount(COMBO_ID, MODELS[0]), 1, 'the first failure is counted')
  await drive(adapter, [ok])                   // 首成员成功 -> 清零
  assert.equal(failureCount(COMBO_ID, MODELS[0]), 0, 'a success clears the consecutive count')
  await drive(adapter, [refusal, ok])          // 首成员再失败 1 次, 未达 2
  assert.equal(isBlacklisted(COMBO_ID, MODELS[0]), false, 'one failure after a success is not a bench')
  const next = await drive(adapter, [ok])
  assert.equal(next.requests.length, 1, 'the first member answers, so it was not benched')
})

await check('a chain without the policy keeps dialling the first member', async () => {
  const { adapter } = makeAdapter(undefined, undefined)
  for (let i = 0; i < 4; i += 1) await drive(adapter, [refusal, ok])
  const next = await drive(adapter, [ok])
  assert.equal(next.requests.length, 1)
  assert.ok(next.text.includes(ANSWER))
})

server.close()
if (failures > 0) console.error(`combo-blacklist-e2e-test: ${failures} failure(s)`)
else console.log('combo-blacklist-e2e-test: a benched member is skipped on later turns')
process.exitCode = failures > 0 ? 1 : 0
