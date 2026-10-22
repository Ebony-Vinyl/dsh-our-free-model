/**
 * DSH 自带模型车道（`dsh:`），端到端接线测试。
 *
 * 宿主设置页添加的模型由 `ctx.llm` 的 provider 目录发布。它们必须：
 * 1. 出现在组合链编辑器可选的模型列表里；
 * 2. 不单独出现在本插件的模型选择器里；
 * 3. 在组合链前序成员失败后，经 `ctx.llm.stream` 收到原始消息、工具与输出上限；
 * 4. 把正文、思考、工具调用、用量和终止帧透传给调用方；
 * 5. 首个可见正文或工具调用出现后不再降级。
 *
 * Run: node scripts/dsh-lane-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callRoute, chatFrames, fakeContext, stubUpstream, until } from './lib/fake-kernel.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH_ROOT = path.join(ROOT, '.verify')
fs.mkdirSync(SCRATCH_ROOT, { recursive: true })

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

const TASK = 'DSH_LANE_TASK_SENTINEL: answer the original question'
const FREE_ID = 'deepseek-v4-flash-free'
const PROVIDER = 'beichen'
const MODEL = 'deepseek-v4.1-flash'
const DSH_ID = `dsh:${PROVIDER}/${MODEL}`
const COMBO_ID = 'combo:dsh-failover'
const COMMITTED_COMBO_ID = 'combo:dsh-committed'
const DSH_ANSWER = 'ANSWERED_BY_THE_DSH_LANE'
const FAILOVER_TASK = 'DSH_LANE_FAILOVER_SENTINEL: let the free lane answer'
const TOOL = { type: 'function', function: { name: 'dsh_lane_probe_tool', description: 'caller tool', parameters: { type: 'object', properties: {} } } }
const TURN_TOOL = { type: 'function', function: { name: 'dsh_lane_turn_tool', description: 'turn tool', parameters: { type: 'object', properties: {} } } }

const freeLane = await stubUpstream({
  listing: [FREE_ID],
  answer: (id, body) => JSON.stringify(body).includes(TASK)
    ? { status: 429, body: JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }) }
    : { body: chatFrames('probe ok') },
})
process.env.OUR_FREE_MODEL_BASE = freeLane.base

const home = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'dsh-lane-'))
process.env.DSH_HOME = home
const dataDir = path.join(home, 'our-free-model')
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  enabled: true,
  probeIntervalMinutes: 15,
  defaultMaxTokens: 32768,
  streamRecovery: false,
  combos: [
    { id: COMBO_ID, name: 'DSH Failover', models: [FREE_ID, DSH_ID], strategy: 'fallback', stickyLimit: 1, enabled: true },
    { id: COMMITTED_COMBO_ID, name: 'DSH Committed', models: [DSH_ID, FREE_ID], strategy: 'fallback', stickyLimit: 1, enabled: true },
  ],
}))

const { DSH_LANE, DSH_PREFIX, dshCatalogId, parseDshCatalogId, buildDshCatalog } = await import('../src/dsh-lane.js')
{
  check('the lane names itself', [DSH_LANE, DSH_PREFIX], ['dsh', 'dsh:'])
  check('a catalog id is provider/model under the dsh prefix', dshCatalogId(PROVIDER, MODEL), DSH_ID)
  check('the id parses back apart', parseDshCatalogId(DSH_ID), { providerId: PROVIDER, modelId: MODEL })
  check('only a dsh-prefixed provider/model id parses', [parseDshCatalogId(FREE_ID), parseDshCatalogId('dsh:'), parseDshCatalogId(null)], [null, null, null])
  check('the model half keeps its own slashes', parseDshCatalogId('dsh:a/b/c'), { providerId: 'a', modelId: 'b/c' })
  const entries = buildDshCatalog([{ provider: PROVIDER, id: MODEL, name: 'DSH fixture', contextWindow: 500000, maxTokens: 200000, inputModalities: ['text', 'image'], reasoning: true }])
  check('the entry carries its lane, provider and model', [entries[0].channel, entries[0].providerId, entries[0].modelId, entries[0].wire], [DSH_LANE, PROVIDER, MODEL, 'host'])
  check('the entry carries capacity metadata', [entries[0].contextWindow, entries[0].maxOutput, entries[0].vision, entries[0].reasoning], [500000, 200000, true, true])
}

const { apply, inject } = await import('../index.js')
const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'timer', 'connection', 'attachments'], onRegister: route => routes.push(route) })
const hostModels = [{ provider: PROVIDER, id: MODEL, name: 'DSH fixture', description: 'host-owned model', inputModalities: ['text', 'image'] }]
let streamCalls = []
ctx.__services.llm.listProviders = () => [
  { id: PROVIDER, name: 'Beichen' },
  { id: 'cline', name: 'Cline' },
  { id: 'broken-provider', name: 'Broken' },
]
ctx.__services.llm.listModels = async provider => {
  if (provider === 'broken-provider') throw new Error('the host catalog never resolves keys')
  if (provider === 'cline') return [{ provider: 'cline', id: 'hy3', name: 'Hy3' }]
  return provider === PROVIDER ? hostModels : []
}
ctx.__services.llm.resolveModelInfo = async () => ({
  provider: PROVIDER, id: MODEL, name: 'DSH fixture', inputModalities: ['text', 'image'],
  context: { contextWindow: 500000 }, defaultMaxTokens: 200000,
  reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
})
ctx.__services.llm.stream = options => {
  streamCalls.push(options)
  return (async function* () {
    if (JSON.stringify(options.messages).includes(TASK)) {
      yield { type: 'text-delta', index: 0, text: DSH_ANSWER }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } else {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })()
}
apply(ctx, {})
const api = () => routes.find(route => route.kind === 'prefix')?.handler
await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
const adapter = ctx.__captured.adapters[0]?.adapter
const summary = () => callRoute(api(), 'GET', '/api/our-free-model/summary')
const get = url => callRoute(api(), 'GET', `/api/our-free-model${url}`)
const post = (url, body) => callRoute(api(), 'POST', `/api/our-free-model${url}`, body)

await until(async () => (await summary()).json?.catalog?.some(entry => entry.id === DSH_ID), {
  what: `the ${DSH_ID} row to join the catalog (host logs: ${ctx.__logs.slice(-4).join(' | ') || 'none'})`,
  timeoutMs: 20000,
})
const summaryJson = (await summary()).json
const byId = new Map(summaryJson.catalog.map(entry => [entry.id, entry]))
const dshRow = byId.get(DSH_ID)
checkThat('the DSH model joined the catalog', dshRow !== undefined, [...byId.keys()].join(', '))
checkThat('a channel-pack provider is left to the chan lane', !byId.has('dsh:cline/hy3'), [...byId.keys()].join(', '))
checkThat('one failing host provider does not hide the others', ctx.__logs.some(line => line.includes('DSH provider listing failed')), ctx.__logs.slice(-6).join(' | '))
check('the row is tagged with its lane', dshRow?.channel, 'dsh')
check('the row keeps provider and model separate', [dshRow?.providerId, dshRow?.modelId], [PROVIDER, MODEL])
check('the row is routing-only', dshRow?.route, null)
check('a listed row is not claimed as tested', [dshRow?.availability, dshRow?.availabilitySource, dshRow?.probedAt], ['unknown', 'listing', 0])
checkThat('listModels never advertises a dsh row standalone', !(await adapter.listModels('our-free-model')).some(row => row.id === DSH_ID))
const combos = await get('/combos')
checkThat('the chain editor offers the DSH model', (combos.json?.models ?? []).some(row => row.id === DSH_ID && row.channel === 'dsh'), JSON.stringify((combos.json?.models ?? []).map(row => row.id)))
check('the chain kept both links', byId.get(COMBO_ID)?.combo, [FREE_ID, DSH_ID])
const comboModel = await adapter.resolveModel('our-free-model', COMBO_ID)
check('the chain advertises its session ceiling', comboModel.defaultMaxTokens, 32768)
const dshModel = await adapter.resolveModel('our-free-model', DSH_ID)
check('the DSH row resolves with the host capability menu', dshModel.reasoning?.efforts?.map(effort => effort.id), ['high'])

hostModels.push({ provider: PROVIDER, id: 'added-after-boot', name: 'Added after boot' })
ctx.emit('llm/adapters-updated')
await until(async () => (await summary()).json?.catalog?.some(entry => entry.id === `dsh:${PROVIDER}/added-after-boot`), {
  what: 'a newly added DSH model to join the catalog', timeoutMs: 5000,
})
hostModels.splice(1, 1)
const refreshed = await post('/refresh')
check('the manual refresh answers', refreshed.status, 200)
await until(async () => !(await summary()).json?.catalog?.some(entry => entry.id === `dsh:${PROVIDER}/added-after-boot`), {
  what: 'a removed DSH model to leave the catalog', timeoutMs: 5000,
})

streamCalls = []
const chunks = []
const controller = new AbortController()
try {
  for await (const chunk of adapter.stream({
    provider: 'our-free-model',
    model: COMBO_ID,
    maxTokens: 4096,
    reasoningEffort: 'high',
    sessionId: 'dsh-lane-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    tools: [TOOL, TURN_TOOL],
    signal: controller.signal,
  })) chunks.push(chunk)
} finally { controller.abort() }
const answer = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
checkThat('the DSH stream received the original turn', streamCalls.length === 1, JSON.stringify(streamCalls.map(call => call.model)))
check('it received the host provider and model separately', [streamCalls[0]?.provider, streamCalls[0]?.model], [PROVIDER, MODEL])
check('it received the caller messages', streamCalls[0]?.messages, [{ role: 'user', content: [{ type: 'text', text: TASK }] }])
check('it received the caller tools unchanged', streamCalls[0]?.tools, [TOOL, TURN_TOOL])
check('it received the caller output ceiling', streamCalls[0]?.maxTokens, 4096)
check('it received the caller reasoning level unchanged', streamCalls[0]?.reasoningEffort, 'high')
check('the answer reached the caller', answer, DSH_ANSWER)
check('the turn finishes cleanly', chunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'stop' })
check('the usage frame reached the caller', chunks.find(chunk => chunk.type === 'usage')?.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 })
check('exactly one finish reached the caller', chunks.filter(chunk => chunk.type === 'finish').length, 1)

const stats = (await get('/stats')).json
const comboStats = stats.models.find(row => row.model === COMBO_ID)
checkThat('the logical turn is attributed to the chain', comboStats !== undefined, JSON.stringify(stats.models.map(row => row.model)))
check('recorded as one turn', comboStats?.turns, 1)
check('not a failed turn', comboStats?.failedTurns, 0)

streamCalls = []
ctx.__services.llm.stream = options => {
  streamCalls.push(options)
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: 'call_dsh_lane', name: TURN_TOOL.function.name, argumentsDelta: '{"lane":"dsh"}' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_dsh_lane', name: TURN_TOOL.function.name, arguments: '{"lane":"dsh"}' } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })()
}
const toolChunks = []
for await (const chunk of adapter.stream({
  provider: 'our-free-model', model: COMMITTED_COMBO_ID, maxTokens: 1024,
  sessionId: 'dsh-lane-tool-test',
  messages: [{ role: 'user', content: [{ type: 'text', text: TURN_TOOL.function.name }] }],
  tools: [TURN_TOOL],
  signal: new AbortController().signal,
})) toolChunks.push(chunk)
check('a host tool-call ending stays a tool-calls finish', toolChunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'tool-calls' })
check('the host tool call reaches the caller', toolChunks.find(chunk => chunk.type === 'block-end')?.block, { type: 'tool-call', id: 'call_dsh_lane', name: TURN_TOOL.function.name, arguments: '{"lane":"dsh"}' })
check('the committed tool call does not fall through to the free lane', streamCalls.length, 1)

streamCalls = []
ctx.__services.llm.stream = options => {
  streamCalls.push(options)
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'partial answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'partial answer' } }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })()
}
const maxTokenChunks = []
for await (const chunk of adapter.stream({
  provider: 'our-free-model', model: COMMITTED_COMBO_ID, maxTokens: 1024,
  sessionId: 'dsh-lane-max-tokens-test',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'DSH_LANE_MAX_TOKENS_SENTINEL' }] }],
  signal: new AbortController().signal,
})) maxTokenChunks.push(chunk)
check('a host output-ceiling ending stays a max-tokens finish', maxTokenChunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'max-tokens' })
check('the output-ceiling turn does not fall through to the free lane', streamCalls.length, 1)

streamCalls = []
ctx.__services.llm.stream = options => {
  streamCalls.push(options)
  return (async function* () {
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'host quota exceeded', code: 'QUOTA_EXHAUSTED' } } }
  })()
}
const failoverChunks = []
try {
  for await (const chunk of adapter.stream({
    provider: 'our-free-model', model: COMMITTED_COMBO_ID, maxTokens: 1024,
    sessionId: 'dsh-lane-failover-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: FAILOVER_TASK }] }],
    signal: new AbortController().signal,
  })) failoverChunks.push(chunk)
} catch { /* the caller sees the terminal frame */ }
check('a pre-output host failure advances to the free lane', freeLane.requests.filter(row => JSON.stringify(row.body).includes(FAILOVER_TASK)).length, 1)
check('the fallback answer finishes cleanly', failoverChunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'stop' })

streamCalls = []
const exhaustedChunks = []
try {
  for await (const chunk of adapter.stream({
    provider: 'our-free-model', model: COMBO_ID, maxTokens: 1024,
    sessionId: 'dsh-lane-exhausted-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    signal: new AbortController().signal,
  })) exhaustedChunks.push(chunk)
} catch { /* the caller sees the terminal frame */ }
check('the final member was the DSH lane', streamCalls.length, 1)
check('the chain keeps the last member failure code', exhaustedChunks.find(chunk => chunk.type === 'finish')?.reason?.failure?.code, 'QUOTA_EXHAUSTED')

for (const disposer of ctx.__disposers.reverse()) {
  try { disposer() } catch { /* teardown must not mask the suite */ }
}
await freeLane.close()
fs.rmSync(home, { recursive: true, force: true })

console.log(failures === 0
  ? '\ndsh-lane: host-added models join the chain editor and answer through the host stream'
  : `\ndsh-lane: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
