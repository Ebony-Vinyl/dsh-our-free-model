/**
 * 链路成员：可见性一致 + 跨适配器调度。
 *
 * ## 固定的两条契约
 *
 * 1. **「添加成员」与模型选择器同源。** 编辑器必须列出选择器愿意展示的
 *    模型：组开关（`hideFreeModels` / `hideEacModels`）与按 id 隐藏都要生效，
 *    否则会出现「选择器里已关闭、路由页仍能添加」的矛盾。
 *
 * 2. **链路可以链接到别的适配器的模型。** 渠道包（buddy / gemini / …）自己
 *    向宿主注册适配器，其模型不在本插件目录里。链路必须能调度它们，否则
 *    编辑器即便列出也无法真正调用。
 *
 * 这套件直接驱动 `buildComboCatalog` / `comboChain` 与 `FreeModelAdapter`，
 * 不启动任何 OAuth 监听，因此完全离线、可重复运行。
 *
 * Run: node scripts/chain-members-test.mjs
 */
import assert from 'node:assert/strict'
import { buildComboCatalog, chainMemberRows, comboChain, normalizeCombos, resetRotation } from '../src/combos.js'
import { FreeModelAdapter } from '../src/adapter.js'
import { isModelHidden } from '../src/store.js'

let checks = 0
async function check(name, run) {
  await run()
  checks++
  console.log(`ok  ${name}`)
}

const ownCatalog = [
  { id: 'free-a', name: 'Free A', channel: 'anonymous', vision: true, contextWindow: 200000, maxOutput: 32000 },
  { id: 'eac-b', name: 'EAC B', channel: 'eac', vision: false, contextWindow: 128000, maxOutput: 16000 },
]

/** 一条「外部车道」模型：渠道包会这样描述它（没有上下文窗口等能力字段）。 */
const foreignRow = {
  id: 'gemini-2.5-pro',
  name: 'Gemini 2.5 Pro',
  provider: 'gemini',
  channel: 'gemini',
  foreign: true,
  vision: false,
}

const foreignLookup = () => id => (id === foreignRow.id ? foreignRow : undefined)

try {
  await check('外部模型成为链路的合法成员，不再被静默丢弃', async () => {
    const combos = normalizeCombos([{ name: 'mix', models: ['free-a', foreignRow.id] }])
    const built = buildComboCatalog(combos, ownCatalog, { foreign: foreignLookup() })
    assert.equal(built.length, 1, '链路被整条丢弃了')
    assert.deepEqual(built[0].combo, ['free-a', foreignRow.id], '外部成员没有进入链路')
    // 车道摘要要能说出它同时覆盖两条车道，面板据此显示来源。
    assert.deepEqual(built[0].lanes.sort(), ['anonymous', 'gemini'])
  })

  await check('comboChain 同时解析本车道与外部车道，且保持给定顺序', async () => {
    resetRotation()
    const combos = normalizeCombos([{ name: 'mix', models: [foreignRow.id, 'free-a'] }])
    const [entry] = buildComboCatalog(combos, ownCatalog, { foreign: foreignLookup() })
    const chain = comboChain(entry, ownCatalog, { foreign: foreignLookup() })
    assert.equal(chain.length, 2)
    assert.equal(chain[0].id, foreignRow.id, '外部成员应保持链首位置')
    assert.equal(chain[1].id, 'free-a')
    assert.equal(FreeModelAdapter.isForeignLink(chain[0]), true)
    assert.equal(FreeModelAdapter.isForeignLink(chain[1]), false)
  })

  await check('外部成员没有窗口信息时，不会凭空抬高链路容量', async () => {
    const combos = normalizeCombos([{ name: 'mix', models: ['free-a', foreignRow.id] }])
    const [entry] = buildComboCatalog(combos, ownCatalog, { foreign: foreignLookup() })
    // 已知窗口只有 free-a 的 200000；外部行没有数字，不能当成无限大，
    // 也不能把链路拉低到一个编造的值。
    assert.equal(entry.contextWindow, 200000)
    // 交集语义不变：外部行未声明视觉，因此整条链不宣称视觉。
    assert.equal(entry.vision, false)
  })

  await check('外部模型走宿主 llm.stream()，而不是本插件的上游', async () => {
    resetRotation()
    const dispatched = []
    const adapter = new FreeModelAdapter({
      state: () => ({ catalog: ownCatalog, membership: {}, settings: {}, attributionUserAgent: 'test' }),
      recordUsage: () => {},
      recordTurn: () => {},
      resolveForeignLink: foreignLookup(),
      dispatchForeign: options => {
        dispatched.push(options)
        return (async function* () {
          yield { type: 'text-delta', text: 'FOREIGN_ANSWER' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    })
    const combos = normalizeCombos([{ name: 'mix', models: [foreignRow.id] }])
    const [entry] = buildComboCatalog(combos, ownCatalog, { foreign: foreignLookup() })
    const snapshot = { catalog: [...ownCatalog, entry], settings: {}, attributionUserAgent: 'test' }

    const chunks = []
    for await (const chunk of adapter.runStream({ model: entry.id, messages: [], provider: 'our-free-model' }, entry, snapshot)) {
      chunks.push(chunk)
    }

    assert.equal(dispatched.length, 1, '没有通过宿主调度外部模型')
    assert.equal(dispatched[0].provider, 'gemini')
    assert.equal(dispatched[0].model, foreignRow.id)
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    assert.equal(text, 'FOREIGN_ANSWER', '外部通道的正文没有透传给调用方')
  })

  await check('外部通道失败时，链路按既有规则继续降级', async () => {
    resetRotation()
    const adapter = new FreeModelAdapter({
      state: () => ({ catalog: ownCatalog, membership: {}, settings: {}, attributionUserAgent: 'test' }),
      recordUsage: () => {},
      recordTurn: () => {},
      resolveForeignLink: foreignLookup(),
      dispatchForeign: () => {
        // 在建流阶段就失败：这是「任何一个候选在产出正文前失败」的形态。
        throw Object.assign(new Error('foreign lane is down'), { code: 'UNAVAILABLE' })
      },
    })
    const combos = normalizeCombos([{ name: 'mix', models: [foreignRow.id] }])
    const [entry] = buildComboCatalog(combos, ownCatalog, { foreign: foreignLookup() })
    const snapshot = { catalog: [...ownCatalog, entry], settings: {}, attributionUserAgent: 'test' }

    const chunks = []
    for await (const chunk of adapter.runStream({ model: entry.id, messages: [], provider: 'our-free-model' }, entry, snapshot)) {
      chunks.push(chunk)
    }
    const finish = chunks.find(chunk => chunk.type === 'finish')
    assert.ok(finish, '失败时没有给出收尾帧')
    // 链路只有这一个候选，耗尽后如实报告失败，而不是静默成功。
    assert.equal(finish.reason.kind, 'error')
    assert.match(finish.reason.failure.message, /no model available|could not reach|exhausted/i)
  })

  await check('关掉的模型不进「添加成员」：组开关与按 id 隐藏都生效', async () => {
    // 需求原文：选择器里关闭的模型，在链路编辑器的「添加成员」里也不应出现。
    // 判据复用 isModelHidden，因此这里直接驱动真实谓词，而不是另写一套。
    const own = [
      { id: 'free-a', name: 'Free A', channel: 'anonymous' },
      { id: 'eac-b', name: 'EAC B', channel: 'eac' },
      { id: 'agg-c', name: 'Agg C', channel: 'aggregate' },
    ]
    const foreign = new Map([
      [foreignRow.id, foreignRow],
      ['buddy-x', { id: 'buddy-x', name: 'Buddy X', channel: 'buddy', foreign: true }],
    ])

    // 1) 全部可见
    let rows = chainMemberRows(own, foreign, entry => isModelHidden(entry, {}))
    assert.deepEqual(rows.map(row => row.id).sort(), ['agg-c', 'buddy-x', 'eac-b', 'free-a', 'gemini-2.5-pro'])

    // 2) 关闭「免费模型」组：免费车道消失，EAC / 聚合 / 渠道仍在
    rows = chainMemberRows(own, foreign, entry => isModelHidden(entry, { hideFreeModels: true }))
    assert.equal(rows.some(row => row.id === 'free-a'), false, '免费车道的模型仍可添加')
    assert.equal(rows.some(row => row.id === 'eac-b'), true, 'EAC 被误伤')
    assert.equal(rows.some(row => row.id === 'buddy-x'), true, '渠道模型被误伤')

    // 3) 关闭「EAC 模型」组
    rows = chainMemberRows(own, foreign, entry => isModelHidden(entry, { hideEacModels: true }))
    assert.equal(rows.some(row => row.id === 'eac-b'), false, 'EAC 车道的模型仍可添加')
    assert.equal(rows.some(row => row.id === 'free-a'), true, '免费车道被误伤')

    // 4) 按 id 隐藏：对渠道模型同样生效（这正是过去会漏掉的一半）
    rows = chainMemberRows(own, foreign, entry => isModelHidden(entry, { hiddenModelIds: [foreignRow.id] }))
    assert.equal(rows.some(row => row.id === foreignRow.id), false, '按 id 隐藏的渠道模型仍可添加')
  })

  await check('本车道与外部车道同名时，以本车道的条目为准', async () => {
    // 外部索引是按「本插件目录里没有的 id」建立的，但防御性地再挡一次：
    // 同一个 id 只能出现一行，且必须带上下文窗口等本车道的能力字段。
    const own = [{ id: 'shared-id', name: 'Own Name', channel: 'anonymous', contextWindow: 111 }]
    const foreign = new Map([['shared-id', { id: 'shared-id', name: 'Foreign Name', channel: 'buddy', foreign: true }]])
    const rows = chainMemberRows(own, foreign, () => false)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'Own Name')
    assert.equal(rows[0].contextWindow, 111)
  })

  await check('同名模型分属多个渠道时，每条都保留且各自可调度', async () => {
    // 这是「选择器里 10 个、添加成员只有 6 个」的成因：`deepseek-v4-flash`
    // 这类 id 同时由 codearts / buddy / lobsterai 提供，按裸 id 去重会把
    // 不同渠道的行吞掉。修法是 `provider/model` 复合 id。
    const a = { id: 'codearts/deepseek-v4-flash', model: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'codearts', channel: 'codearts', foreign: true }
    const b = { id: 'buddy/deepseek-v4-flash', model: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'buddy', channel: 'buddy', foreign: true }
    const foreign = new Map([[a.id, a], [b.id, b]])

    const rows = chainMemberRows([], foreign, () => false)
    assert.equal(rows.length, 2, '同名模型被合并了')
    assert.deepEqual(rows.map(row => row.id).sort(), ['buddy/deepseek-v4-flash', 'codearts/deepseek-v4-flash'])

    // 链路上把一条放进去，调度必须打到它自己的渠道、用裸模型名。
    const dispatched = []
    const adapter = new FreeModelAdapter({
      state: () => ({ catalog: [], membership: {}, settings: {}, attributionUserAgent: 'test' }),
      recordUsage: () => {},
      recordTurn: () => {},
      resolveForeignLink: id => foreign.get(id),
      dispatchForeign: options => {
        dispatched.push({ provider: options.provider, model: options.model })
        return (async function* () {
          yield { type: 'text-delta', text: `from ${options.provider}` }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    })
    const combos = normalizeCombos([{ name: 'dupes', models: ['codearts/deepseek-v4-flash'] }])
    const [entry] = buildComboCatalog(combos, [], { foreign: id => foreign.get(id) })
    const snapshot = { catalog: [entry], settings: {}, attributionUserAgent: 'test' }

    for await (const _chunk of adapter.runStream({ model: entry.id, messages: [], provider: 'our-free-model' }, entry, snapshot)) { /* drain */ }

    assert.equal(dispatched.length, 1)
    // 关键：传给宿主的必须是**裸**模型名与正确的 provider，而不是复合 id。
    assert.equal(dispatched[0].provider, 'codearts')
    assert.equal(dispatched[0].model, 'deepseek-v4-flash')
  })

  await check('裸 id 别名不重复出现在成员清单里', async () => {
    // 旧链路存的是裸 id。索引为此保留别名，但别名是查找用的，不是第二个
    // 成员行——否则唯一模型会在列表里出现两次。
    const row = { id: 'gemini/gemini-2.5-pro', model: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', channel: 'gemini', foreign: true }
    const foreign = new Map([[row.id, row], ['gemini-2.5-pro', row]])
    const rows = chainMemberRows([], foreign, () => false)
    assert.equal(rows.length, 1, '别名被当成了独立成员')
    assert.equal(rows[0].id, 'gemini/gemini-2.5-pro')
  })

  await check('外部通道以 finish 错误帧失败时，链路降级到下一个成员', async () => {
    // ⚠️ 这正是线上「跑满一个却不切换」的成因。宿主把适配器的异常转成
    // `finish` + `reason.kind === 'error'`（dsh-llm 的 adapterFailureChunk），
    // 于是消费方遍历流时是**正常结束**的。把「循环结束」读成「模型答复了」
    // 就会对每一次渠道失败都返回 advance:false —— 明明什么都没提交，链路却
    // 停在原地。
    resetRotation()
    const first = { id: 'buddy/glm-5.3', model: 'glm-5.3', name: 'GLM 5.3', provider: 'buddy', channel: 'buddy', foreign: true }
    const second = { id: 'codearts/deepseek-v4.1-flash', model: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1', provider: 'codearts', channel: 'codearts', foreign: true }
    const foreign = new Map([[first.id, first], [second.id, second]])

    const dispatched = []
    const adapter = new FreeModelAdapter({
      state: () => ({ catalog: ownCatalog, membership: {}, settings: {}, attributionUserAgent: 'test' }),
      recordUsage: () => {},
      recordTurn: () => {},
      resolveForeignLink: id => foreign.get(id),
      dispatchForeign: options => {
        dispatched.push(options.provider)
        if (options.provider === 'buddy') {
          // 渠道包对内容拦截抛的是 LlmError(code='PERMISSION_DENIED', status:200)，
          // 它带 2 分钟冷却，判定表认为该降级。
          return (async function* () {
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  message: 'buddy: 当前账号被服务端安全策略拦截。Illegal API invocation from an unapproved channel',
                  code: 'PERMISSION_DENIED',
                  status: 200,
                },
              },
            }
          })()
        }
        return (async function* () {
          yield { type: 'text-delta', text: 'SECOND_ANSWER' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    })

    const combos = normalizeCombos([{ name: 'failover', models: [first.id, second.id] }])
    const [entry] = buildComboCatalog(combos, [], { foreign: id => foreign.get(id) })
    const snapshot = { catalog: [entry], settings: {}, attributionUserAgent: 'test' }

    const chunks = []
    for await (const chunk of adapter.runStream({ model: entry.id, messages: [], provider: 'our-free-model' }, entry, snapshot)) {
      chunks.push(chunk)
    }

    assert.deepEqual(dispatched, ['buddy', 'codearts'], `链路没有降级，只尝试了 ${dispatched.join(',') || '（无）'}`)
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    assert.equal(text, 'SECOND_ANSWER', '降级后没有把下一个成员的正文交给调用方')
    // 失败的那个成员不能把它的错误帧泄漏给用户：它已被整段丢弃。
    const finish = chunks.find(chunk => chunk.type === 'finish')
    assert.equal(finish.reason.kind, 'stop', '被丢弃的失败不应成为本轮结局')
  })

  await check('外部通道已产出正文后失败，则不降级（与本地车道同一提交规则）', async () => {
    // 这是**设计如此**，不是缺陷：正文一旦交付，切换模型会把两个模型的
    // 输出拼在一起。本用例把这条规则钉住，免得后续「修降级」时把它一起改掉。
    resetRotation()
    const first = { id: 'buddy/g', model: 'g', name: 'G', provider: 'buddy', channel: 'buddy', foreign: true }
    const second = { id: 'codearts/d', model: 'd', name: 'D', provider: 'codearts', channel: 'codearts', foreign: true }
    const foreign = new Map([[first.id, first], [second.id, second]])

    const dispatched = []
    const adapter = new FreeModelAdapter({
      state: () => ({ catalog: ownCatalog, membership: {}, settings: {}, attributionUserAgent: 'test' }),
      recordUsage: () => {},
      recordTurn: () => {},
      resolveForeignLink: id => foreign.get(id),
      dispatchForeign: options => {
        dispatched.push(options.provider)
        if (options.provider === 'buddy') {
          return (async function* () {
            yield { type: 'text-delta', text: 'VISIBLE' }
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'blocked mid-answer', code: 'PERMISSION_DENIED', status: 200 } } }
          })()
        }
        return (async function* () {
          yield { type: 'text-delta', text: 'SECOND_ANSWER' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    })

    const combos = normalizeCombos([{ name: 'committed', models: [first.id, second.id] }])
    const [entry] = buildComboCatalog(combos, [], { foreign: id => foreign.get(id) })
    const snapshot = { catalog: [entry], settings: {}, attributionUserAgent: 'test' }

    const chunks = []
    for await (const chunk of adapter.runStream({ model: entry.id, messages: [], provider: 'our-free-model' }, entry, snapshot)) {
      chunks.push(chunk)
    }

    assert.deepEqual(dispatched, ['buddy'], '已提交正文后仍然切换了模型')
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    assert.equal(text, 'VISIBLE', '已交付的正文被改写')
  })

  console.log(`chain-members: ${checks}/${checks} 项通过`)
} finally {
  resetRotation()
}
