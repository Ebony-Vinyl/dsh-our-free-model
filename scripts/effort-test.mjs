/**
 * Proves the effort level is an intensity indicator (not a token budget), and
 * that the level the plugin records is the level it sent.
 *
 * 档位与预算解耦（2026-10-22）：免费车道 38 个模型中 37 个已经声明自己的
 * 档位菜单，档位以 `reasoning_effort` 透传给上游，由上游决定思考量与输出
 * 容量；剩下那一个不思考。所以档位不再携带 token 上限，输出预算改由模型
 * 容量、会话的 `maxTokens` 与插件默认值决定。
 *
 * 这条绑定曾经造成真实故障：`mimo-v2.6-flash-free` 的 balanced 档只有
 * 8192 token，思考与回答共用它（issue #2），长回合频繁以 finish `length`
 * 收尾；而漏登记档位时（见 `vendor/channel-pack/src/reasoning-ladder.ts`）
 * 所有客户端档位都落到 2048 的 light，长回答稳定截断成
 * `incomplete / max_output_tokens`。
 *
 * Run: node scripts/effort-test.mjs
 */
import { chatFrames, stubUpstream } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/**
 * The gateway stand-in goes up before the plugin modules are imported, because
 * `src/upstream.js` reads `OUR_FREE_MODEL_BASE` once, at import time — a static
 * import of anything downstream of it would pin the real host.
 */
const stub = await stubUpstream({ listing: ['mimo-v2.6-flash-free'], answer: () => ({ body: chatFrames('done') }) })
process.env.OUR_FREE_MODEL_BASE = stub.base
const { MIN_BUDGET, budgetFor, budgetLadder, effortPatchFor, resolveLevel, upstreamEffortFor } = await import('../src/effort.js')
const { buildCatalog } = await import('../src/catalog.js')
const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')

const catalog = id => buildCatalog([id])[0]
const MIMO = catalog('mimo-v2.6-flash-free')
const MUSE = catalog('muse-spark-1.3-contributor-free')
const UNION = catalog('union-alpha')
const DEFAULTS = 32768

check('the catalog still records that mimo cannot think nothing', MIMO.canDisableThinking, false)
check('muse spark can', MUSE.canDisableThinking, true)

// ── the ladder as the settings page and the picker see it ────────────────────
// 三档的额度相同：档位只表示强度，不再改变预算。
check('the rungs no longer move the budget', budgetLadder(MIMO, undefined, DEFAULTS).map(row => row.tokens), [32768, 32768, 32768])
check('muse spark is the same', budgetLadder(MUSE, undefined, DEFAULTS).map(row => row.tokens), [32768, 32768, 32768])
check('a model with no effort menu spends its whole window on the answer',
  budgetLadder(UNION, undefined, DEFAULTS).map(row => row.tokens), [32768, 32768, 32768])
check('the default rung is marked, so the page cannot pick a different one',
  budgetLadder(MIMO, undefined, DEFAULTS).map(row => row.isDefault), [false, true, false])

const ladder = budgetLadder(MIMO, undefined, DEFAULTS).map(row => row.tokens)
check('the ladder is flat', ladder.every(value => value === ladder[0]), true)

// ── the terms that cap it ────────────────────────────────────────────────────
// 目录的容量表决定「默认按最大值」到底是多少。家族通用规则里的 32K 是发布
// 口径的下限，不是这条车道实际服务的容量；照抄它会把长回答提前截断，所以
// 每个当前在线的免费模型都必须有自己的一条记录。
check('free-lane capacities come from the served model, not the family floor',
  [
    catalog('beam-free').maxOutput,
    catalog('flint-40b-free').maxOutput,
    catalog('minimax-m3.1-flash-free').maxOutput,
    catalog('nemotron-3.5-lightning-free').maxOutput,
    catalog('mimo-v2.6-flash-free').maxOutput,
  ],
  [131072, 65536, 512000, 262144, 131072])
check('and none of the served free models is left on the 32K family floor',
  ['beam-free', 'flint-40b-free', 'minimax-m3.1-flash-free', 'nemotron-3.5-lightning-free']
    .map(id => catalog(id).maxOutput > 32768), [true, true, true, true])

check('the session ceiling wins over the model capacity', budgetFor(MIMO, 4000, DEFAULTS), 4000)
check('the plugin default wins over the model capacity', budgetFor(MIMO, undefined, 12000), 12000)
check('the budget never rises above capacity', budgetFor(MIMO, undefined, 8192), 8192)
check('and never falls below what an answer needs when nobody said otherwise',
  budgetFor({ maxOutput: 256, reasoning: true }, undefined, undefined), MIN_BUDGET)

// The two ways a ceiling stops being a number. The settings page's own cleared
// input field posts `Number('') || 0`, and a 0 ceiling is not "no ceiling":
// `min(capacity, 0)` came out as the 512-token floor on every model. A ceiling
// that is not a number reads as "unset", so the model's own capacity is used.
check('a zero default ceiling reads as unset, not as the floor', budgetFor(MIMO, undefined, 0), MIMO.maxOutput)
check('so does a negative one', budgetFor(MIMO, undefined, -1), MIMO.maxOutput)
check('and one typed rather than chosen', budgetFor(MIMO, undefined, 'abc'), MIMO.maxOutput)
check('while a ceiling that is a number still binds', budgetFor(MIMO, undefined, 6000), 6000)
check('the same holds for the session’s own maxTokens', budgetFor(MIMO, 0, DEFAULTS), DEFAULTS)

// ── the rung in force, which is what gets recorded ───────────────────────────
check('no rung on a menu model means the default rung', resolveLevel(undefined, MIMO)?.id, 'balanced')
check('a rung on a model with no menu is not applied', resolveLevel('light', UNION), undefined)
check('a stale rung name still resolves to the default', resolveLevel('maximum', MIMO)?.id, 'balanced')

check('legacy medium selects balanced', resolveLevel('medium', MIMO)?.id, 'balanced')
check('legacy high spellings select the strongest rung',
  ['high', 'xhigh', 'max'].map(level => resolveLevel(level, MIMO)?.id),
  ['deep', 'deep', 'deep'])
check('legacy aliases ignore surrounding whitespace and case', resolveLevel('  HIGH ', MIMO)?.id, 'deep')
check('invalid legacy values keep the default',
  [null, 42, {}, '', 'turbo'].map(level => resolveLevel(level, MIMO)?.id),
  ['balanced', 'balanced', 'balanced', 'balanced', 'balanced'])
check('aliases do not invent a menu for a model without one', resolveLevel('high', UNION), undefined)

// ── what goes on the wire, through the real adapter ─────────────────────────
const entry = MIMO
const records = []
const adapter = new FreeModelAdapter({
  state: () => ({ catalog: [entry], membership: { [ROUTE_MAIN]: [entry.id] }, settings: { enabled: true, defaultMaxTokens: DEFAULTS }, attributionUserAgent: 'test/1.0' }),
  recordUsage: record => records.push(record),
  warn: () => {},
})

/** Send one turn and report the `max_tokens` the adapter put on the request. */
async function sentBudget(options) {
  const before = stub.requests.length
  for await (const chunk of adapter.stream({ provider: ROUTE_MAIN, model: entry.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...options })) void chunk
  return stub.requests[before].body
}

check('a rung no longer cuts the request budget', (await sentBudget({ reasoningEffort: 'balanced' })).max_tokens, 32768)
check('the weakest rung sends the same budget', (await sentBudget({ reasoningEffort: 'light' })).max_tokens, 32768)
check('the strongest rung sends the same budget', (await sentBudget({ reasoningEffort: 'deep' })).max_tokens, 32768)
check('legacy aliases reach the same budget',
  [(await sentBudget({ reasoningEffort: 'high' })).max_tokens,
    (await sentBudget({ reasoningEffort: 'medium' })).max_tokens,
    (await sentBudget({ reasoningEffort: 'minimal' })).max_tokens],
  [32768, 32768, 32768])
await sentBudget({ reasoningEffort: 'high' })
check('the recorded legacy alias is the rung that ran', records.at(-1).effort, 'deep')
check('a caller that names no rung gets the default one',
  (await sentBudget({})).max_tokens, 32768)
check('the recorded effort is the rung that ran', records.at(-1).effort, 'balanced')

// 客户端自己给的 maxTokens 是唯一的会话级上限，档位不参与。
check('the session maxTokens still caps the request', (await sentBudget({ reasoningEffort: 'deep', maxTokens: 4096 })).max_tokens, 4096)
check('and the session maxTokens wins over the plugin default', (await sentBudget({ maxTokens: 8192 })).max_tokens, 8192)
check('a small session budget is sent as given, not raised to the floor',
  (await sentBudget({ reasoningEffort: 'max', maxTokens: 200 })).max_tokens, 200)

await sentBudget({ reasoningEffort: 'light' })
check('a named rung is recorded as itself', records.at(-1).effort, 'light')
await sentBudget({ reasoningEffort: 'turbo' })
check('a rung the plugin does not declare is recorded as the default it became', records.at(-1).effort, 'balanced')

// 宿主在调用方没给 maxTokens 时会用适配器上报的 defaultMaxTokens 填入，
// 所以那一个数字也必须跟随模型容量；否则客户端预算「不限制」的设置会被
// 宿主自己的填值路径重新压回 32K。
{
  const adapterNoCap = new FreeModelAdapter({
    state: () => ({ catalog: [MIMO], membership: { [ROUTE_MAIN]: [MIMO.id] }, settings: { enabled: true, defaultMaxTokens: 0 }, attributionUserAgent: 'test/1.0' }),
    recordUsage: () => {}, warn: () => {},
  })
  check('the model default follows its capacity when the user set no cap',
    (await adapterNoCap.resolveModel(ROUTE_MAIN, MIMO.id)).defaultMaxTokens, MIMO.maxOutput)
  const adapterCapped = new FreeModelAdapter({
    state: () => ({ catalog: [MIMO], membership: { [ROUTE_MAIN]: [MIMO.id] }, settings: { enabled: true, defaultMaxTokens: 5000 }, attributionUserAgent: 'test/1.0' }),
    recordUsage: () => {}, warn: () => {},
  })
  check('a cap the user did set still binds the model default',
    (await adapterCapped.resolveModel(ROUTE_MAIN, MIMO.id)).defaultMaxTokens, 5000)
}

// ── the free lane's own ids that declare a real level menu ───────────────────
// Re-probed 2026-10-17: the gateway now validates `reasoning_effort` and the
// level moves the reasoning volume, so the ids that publish a level set carry
// it on the wire instead of the token ladder — the same shape the absorbed
// channels use. A model with no declared set keeps the ladder untouched.
const DS = catalog('deepseek-v4.1-flash-free')
const GLM = catalog('glm-5.3-flash-free')
check('the served capacity is the measured 1M window, not the published floor', DS.contextWindow, 1048576)
check('and the same for glm', GLM.contextWindow, 1048576)
check('deepseek declares its own level menu', DS.efforts, ['disabled', 'low', 'high', 'max'])
check('glm declares only the levels it honours — no Off rung', GLM.efforts, ['low', 'high', 'max'])
check('glm therefore cannot be told to stop thinking', GLM.canDisableThinking, false)
check('declared menus retain their literal level ids',
  ['high', 'max', 'low', 'disabled'].map(level => resolveLevel(level, DS)?.id),
  ['high', 'max', 'low', 'disabled'])
check('legacy aliases do not change declared-menu fallback',
  ['light', 'deep', 'none', 'off', '  MAX '].map(level => resolveLevel(level, DS)?.id),
  ['high', 'high', 'high', 'high', 'high'])
check('a declared menu without Off keeps its own default', resolveLevel('disabled', GLM)?.id, GLM.effortDefault)
check('a declared level goes on the wire as reasoning_effort',
  effortPatchFor('max', DS), { reasoning_effort: 'max' })
check('the off rung maps to the wire value that switches thinking off',
  effortPatchFor('disabled', DS), { reasoning_effort: 'none' })
// 档位不再影响预算：菜单模型的额度就是容量，只被插件默认值（这里传 32768）
// 与会话自己的 maxTokens 限制。
check('a menu model is not cut to a ladder rung', budgetFor(DS, undefined, DEFAULTS), DEFAULTS)
check('and with no fallback it spends the whole measured capacity', budgetFor(DS, undefined, undefined), 384000)

{
  const records2 = []
  const adapter2 = new FreeModelAdapter({
    state: () => ({ catalog: [DS], membership: { [ROUTE_MAIN]: [DS.id] }, settings: { enabled: true, defaultMaxTokens: DEFAULTS }, attributionUserAgent: 'test/1.0' }),
    recordUsage: record => records2.push(record),
    warn: () => {},
  })
  const sent = async options => {
    const before = stub.requests.length
    for await (const chunk of adapter2.stream({ provider: ROUTE_MAIN, model: DS.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...options })) void chunk
    return stub.requests[before].body
  }
  check('the selected level rides the request body', (await sent({ reasoningEffort: 'high' })).reasoning_effort, 'high')
  check('and the recorded effort is that same level', records2.at(-1).effort, 'high')
  check('a declared max stays max on the wire', (await sent({ reasoningEffort: 'max' })).reasoning_effort, 'max')
  check('and is recorded without legacy normalization', records2.at(-1).effort, 'max')
  check('the off level sends the wire value, not the word disabled',
    (await sent({ reasoningEffort: 'disabled' })).reasoning_effort, 'none')
}

// ── the rung on the wire for a model with no declared menu ──────────────────
// The gateway validates `reasoning_effort` and answers 400 `Invalid option`
// for anything outside `none|minimal|low|medium|high|xhigh|max` (measured
// 2026-10-22 on `mimo-v2.6-flash-free`). So the plugin's own rung ids cannot
// travel as themselves — they travel as the intensity value they stand for.
check('the weakest rung stands for the upstream low intensity', upstreamEffortFor('light'), 'low')
check('the middle rung stands for medium', upstreamEffortFor('balanced'), 'medium')
check('the strongest rung stands for high', upstreamEffortFor('deep'), 'high')
check('the aliases land on the same three values',
  ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(upstreamEffortFor),
  ['low', 'low', 'medium', 'high', 'high', 'high', 'high'])
check('an unknown rung has no upstream value', upstreamEffortFor('turbo'), undefined)
check('and no rung at all has none either', upstreamEffortFor(undefined), undefined)

{
  const records3 = []
  const entry3 = { id: 'mimo-v2.6-flash-free', name: 'MiMo', availability: 'available', vision: false, reasoning: true, contextWindow: 1048576, maxOutput: 131072 }
  const adapter3 = new FreeModelAdapter({
    state: () => ({ catalog: [entry3], membership: { [ROUTE_MAIN]: [entry3.id] }, settings: { enabled: true, defaultMaxTokens: DEFAULTS }, attributionUserAgent: 'test/1.0' }),
    recordUsage: record => records3.push(record),
    warn: () => {},
  })
  const sent3 = async options => {
    const before = stub.requests.length
    for await (const chunk of adapter3.stream({ provider: ROUTE_MAIN, model: entry3.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...options })) void chunk
    return stub.requests[before].body
  }
  check('a model with no declared menu still sends an upstream intensity',
    (await sent3({ reasoningEffort: 'balanced' })).reasoning_effort, 'medium')
  check('the weakest rung sends low', (await sent3({ reasoningEffort: 'light' })).reasoning_effort, 'low')
  check('the strongest rung sends high', (await sent3({ reasoningEffort: 'deep' })).reasoning_effort, 'high')
  check('the recorded effort is still the rung the caller named, not the mapped value',
    records3.at(-1).effort, 'deep')
  check('and the rung does not move the budget',
    (await sent3({ reasoningEffort: 'deep' })).max_tokens, 32768)
  check('a caller that names no rung sends no intensity field at all',
    (await sent3({})).reasoning_effort, undefined)
}

// ── DSML leak scrubbing ──────────────────────────────────────────────────────
// DeepSeek v4 models sometimes stream their internal control markup as visible
// content at the reasoning→action boundary. The sink must strip it live, split
// across deltas or not, without touching the real answer or the tool calls.
{
  const { readStream } = await import('../src/stream.js')
  await (async () => {
    const frames = [
      '{"choices":[{"index":0,"delta":{"content":"\\n\\n<｜"}}]}',
      '{"choices":[{"index":0,"delta":{"content":"DSML｜ calls>\\n"}}]}',
      '{"choices":[{"index":0,"delta":{"content":"正式回答"}}]}',
      '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]
    const chunks = []
    for await (const chunk of readStream(frames, 'chat', new Map())) chunks.push(chunk)
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    check('no DSML fragment reaches the user', /DSML｜/.test(text), false)
    check('the real answer survives the scrub', text, '\n\n\n正式回答')
    const end = chunks.find(c => c.type === 'block-end' && c.block?.type === 'text')
    check('the closed block carries the same clean text', end?.block?.text, '\n\n\n正式回答')
  })()
  await (async () => {
    const frames = [
      '{"choices":[{"index":0,"delta":{"content":"完整标记<｜DSML｜ calls>一次到达"}}]}',
      '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]
    const chunks = []
    for await (const chunk of readStream(frames, 'chat', new Map())) chunks.push(chunk)
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    check('a tag arriving whole in one delta is stripped too', text, '完整标记一次到达')
  })()
  await (async () => {
    const frames = [
      '{"choices":[{"index":0,"delta":{"content":"普通 <div> 标签和结尾的孤立 < 保留"}}]}',
      '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]
    const chunks = []
    for await (const chunk of readStream(frames, 'chat', new Map())) chunks.push(chunk)
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    check('ordinary markup passes untouched', text, '普通 <div> 标签和结尾的孤立 < 保留')
  })()
}

await stub.close()
console.log(failures === 0 ? '\neffort: the level is an intensity indicator, the budget is not' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
