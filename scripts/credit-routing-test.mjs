import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * 积分路由调度回归：分档纯函数 + 余额缓存选号器 + TRAE/Qoder 适配器接线。
 *
 * 结构与 channel-queue-rotation-test.mjs 同款：导出 verify 函数，由
 * channel-pack-test.mjs 的 --source 模式装载；也可独立运行
 * （node scripts/credit-routing-test.mjs）。
 *
 * vendored src 内部以 `.js` 后缀互相导入（esbuild/hook 约定）；独立
 * 运行时用与 channel-pack-test.mjs 同款的 resolve hook 把 `.js` 重写为
 * `.ts`，使纯函数与选号器可在裸 Node 下验证。
 */
const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const usingOwnHooks = process.env.OFM_CREDIT_ROUTING_INHERITED_HOOKS === undefined
if (usingOwnHooks) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
        const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
        if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}
const now = 1_700_000_000_000

const pkg = (remaining, options = {}) => ({
  name: options.name ?? 'fixture',
  unit: 'credits',
  remaining,
  total: remaining,
  used: 0,
  active: options.active ?? true,
  cycleStartTime: '',
  cycleEndTime: '',
  expiredTime: '',
  ...(options.deductionEndTime !== undefined ? { deductionEndTime: options.deductionEndTime } : {}),
})

/** 供 verifyChannelCreditRouting 与独立运行共用的实现体。 */
export async function verifyCreditRoutingRank() {
  const { CREDIT_TIER, creditTierOf, rankCreditAccounts } = await import('../vendor/channel-pack/src/credit-routing-rank.ts')

  const day = 86_400_000
  const windowDays = 15
  const opts = { windowDays, now }

  // tier 0：有效包 remaining>0 且 deductionEndTime 落在临期窗内
  assert.equal(creditTierOf({ id: 'a', balance: { total: 150, expiredTotal: 0, packages: [pkg(150, { deductionEndTime: now + 3 * day })] } }, opts), CREDIT_TIER.expiring)
  // 窗口边界：恰好等于 now + 窗口也算临期（≤）
  assert.equal(creditTierOf({ id: 'a', balance: { total: 150, expiredTotal: 0, packages: [pkg(150, { deductionEndTime: now + windowDays * day })] } }, opts), CREDIT_TIER.expiring)
  // 已过期（deductionEndTime 在过去）但 remaining>0 的包：仍属临期档，优先烧掉
  assert.equal(creditTierOf({ id: 'a', balance: { total: 150, expiredTotal: 0, packages: [pkg(150, { deductionEndTime: now - day })] } }, opts), CREDIT_TIER.expiring)

  // tier 1：有余额但无 deductionEndTime（Qoder 套餐额度的真实形态）
  assert.equal(creditTierOf({ id: 'a', balance: { total: 100, expiredTotal: 0, packages: [pkg(100)] } }, opts), CREDIT_TIER.usable)
  // 有 deductionEndTime 但在窗外 → 常规
  assert.equal(creditTierOf({ id: 'a', balance: { total: 100, expiredTotal: 0, packages: [pkg(100, { deductionEndTime: now + 60 * day })] } }, opts), CREDIT_TIER.usable)

  // tier 2：查询成功且全部有效包归零
  assert.equal(creditTierOf({ id: 'a', balance: { total: 0, expiredTotal: 0, packages: [pkg(0)] } }, opts), CREDIT_TIER.zero)
  // 失效包里的剩余不算：active:false 的包有 remaining 也判 zero
  assert.equal(creditTierOf({ id: 'a', balance: { total: 0, expiredTotal: 50, packages: [pkg(50, { active: false })] } }, opts), CREDIT_TIER.zero)
  // 混合：一个失效包有分 + 一个有效包归零 → zero（失效包不参与）
  assert.equal(creditTierOf({ id: 'a', balance: { total: 0, expiredTotal: 50, packages: [pkg(50, { active: false }), pkg(0)] } }, opts), CREDIT_TIER.zero)

  // tier 3：balance 缺失 = 查询失败 —— 与「归零」严格分开
  assert.equal(creditTierOf({ id: 'a' }, opts), CREDIT_TIER.unknown)
  assert.equal(creditTierOf({ id: 'a', balance: undefined }, opts), CREDIT_TIER.unknown)

  // 临期包与常规包并存：临期包决定档位
  assert.equal(creditTierOf({
    id: 'a',
    balance: { total: 250, expiredTotal: 0, packages: [pkg(100), pkg(150, { deductionEndTime: now + 2 * day })] },
  }, opts), CREDIT_TIER.expiring)

  // 排序：tier 升序，档内保持传入顺序（稳定）
  const a = { id: 'a', balance: { total: 100, expiredTotal: 0, packages: [pkg(100)] } }
  const b = { id: 'b', balance: { total: 150, expiredTotal: 0, packages: [pkg(150, { deductionEndTime: now + day })] } }
  const c = { id: 'c' }
  const d = { id: 'd', balance: { total: 0, expiredTotal: 0, packages: [pkg(0)] } }
  assert.deepEqual(rankCreditAccounts([a, b, c, d], opts).map(row => row.id), ['b', 'a', 'd', 'c'])
  assert.deepEqual(rankCreditAccounts([d, c, b, a], opts).map(row => row.id), ['b', 'a', 'd', 'c'], '档内保持传入顺序')
  // 全 unknown：原序返回
  assert.deepEqual(rankCreditAccounts([c, { id: 'e' }], opts).map(row => row.id), ['c', 'e'])
  // 空数组
  assert.deepEqual(rankCreditAccounts([], opts), [])

  // 顶层 total 与包明细不一致时以包明细为准（逐包判，不信 total）
  assert.equal(creditTierOf({ id: 'x', balance: { total: 999, expiredTotal: 0, packages: [pkg(0)] } }, opts), CREDIT_TIER.zero)

  console.log('ok  credit routing rank: expiring/usable/zero/unknown tiers, stable order')
}

/** 选号器：双 TTL 缓存、分档挑选、失败开放。 */
export async function verifyCreditRoutingSelector() {
  const { CreditBalanceSelector, CREDIT_BALANCE_CACHE_TTL_MS, CREDIT_BALANCE_ERROR_CACHE_TTL_MS } = await import('../vendor/channel-pack/src/credit-balance-selector.ts')
  const { CREDIT_TIER } = await import('../vendor/channel-pack/src/credit-routing-rank.ts')

  const day = 86_400_000
  const credential = id => ({ access_token: `fixture-${id}` })
  const entryOf = id => ({ id, credentialRef: `ref-${id}` })
  // 选号器内的「当前时刻」由 clock 注入（从 0 起），fixture 余额的到期
  // 时间必须相对 clock 设定，而不是模块级的大常量 now。
  const clockNow = () => clock

  // 60s 成功 / 5s 失败 TTL 常量与 Loomy 对齐
  assert.equal(CREDIT_BALANCE_CACHE_TTL_MS, 60_000)
  assert.equal(CREDIT_BALANCE_ERROR_CACHE_TTL_MS, 5_000)

  let clock = 0
  const makeDeps = respond => {
    const fetched = []
    return {
      fetched,
      deps: {
        resolveCredential: async ref => credential(ref.slice('ref-'.length)),
        // push 必须在 respond 之前：respond 抛错（查询失败）也要留下
        // 「确实发起过一次查询」的痕迹，否则失败缓存用例无从断言。
        fetchBalance: async cred => {
          fetched.push([cred.access_token, clock])
          return await respond(cred)
        },
        now: () => clock,
        windowDays: 15,
      },
    }
  }

  // ① 成功缓存：同轮重复 pick 不重复查
  {
    const { deps, fetched } = makeDeps(async () => ({ total: 100, expiredTotal: 0, packages: [pkg(100)] }))
    const selector = new CreditBalanceSelector(deps)
    const candidates = [entryOf('a'), entryOf('b')]
    const first = await selector.pick(candidates)
    const second = await selector.pick(candidates)
    assert.equal(first.account.id, 'a')
    assert.equal(second.account.id, 'a')
    assert.equal(fetched.length, 2, '两个账号各查一次')
    await selector.pick(candidates)
    assert.equal(fetched.length, 2, 'TTL 内不重复查询')
  }

  // ② 失败只缓存 5s：一次抖动不得伪装「没分」一分钟
  {
    clock = 100 // 与用例 ① 的时间线隔离
    let fail = true
    const { deps, fetched } = makeDeps(async () => {
      if (fail) throw new Error('fixture unavailable')
      return { total: 123, expiredTotal: 0, packages: [pkg(123)] }
    })
    const selector = new CreditBalanceSelector(deps)
    const candidates = [entryOf('a')]
    assert.equal(await selector.pick(candidates), undefined, '全部查询失败 → 不选出（退回现行为）')
    assert.equal(fetched.length, 1)
    clock += 6_000 // 失败 TTL 5s 已过
    fail = false
    const picked = await selector.pick(candidates)
    assert.equal(picked.account.id, 'a', '失败结论 5s 后过期，重查成功')
    assert.equal(fetched.length, 2)
  }

  // ③ 成功缓存 60s 内不重查，过期后重查
  {
    clock = 1_000_000 // 独立时间线
    const { deps, fetched } = makeDeps(async () => ({ total: 100, expiredTotal: 0, packages: [pkg(100)] }))
    const selector = new CreditBalanceSelector(deps)
    const candidates = [entryOf('a')]
    await selector.pick(candidates)
    clock += 59_000
    await selector.pick(candidates)
    assert.equal(fetched.length, 1, '59s 时仍用缓存')
    clock += 2_000
    await selector.pick(candidates)
    assert.equal(fetched.length, 2, '60s 后重查')
  }

  // ④ 分档选号：临期优先、档内手动顺序、zero/unknown 不选出
  {
    // 独立时间线：clock 起点 3_000_000，临期包到期 = 起点 + 1 天。
    clock = 3_000_000
    const expiringEnd = clockNow() + day
    const balances = {
      'fixture-a': { total: 100, expiredTotal: 0, packages: [pkg(100)] },                              // usable
      'fixture-b': { total: 150, expiredTotal: 0, packages: [pkg(150, { deductionEndTime: expiringEnd })] }, // expiring
      'fixture-c': { total: 0, expiredTotal: 0, packages: [pkg(0)] },                                 // zero
    }
    const { deps } = makeDeps(async cred => balances[cred.access_token])
    const selector = new CreditBalanceSelector(deps)
    // 池序 [a,b] → 临期 b 先
    assert.equal((await selector.pick([entryOf('a'), entryOf('b')])).account.id, 'b')
    // b 排除后 → a
    assert.equal((await selector.pick([entryOf('a'), entryOf('b')], new Set(['b']))).account.id, 'a')
    // 只剩 zero / unknown → undefined（不阻断，由调用方退回现行为）
    assert.equal(await selector.pick([entryOf('c')]), undefined)
    assert.equal(await selector.pick([{ id: 'd', credentialRef: 'ref-d' }]), undefined)
  }

  // ⑤ 凭据解析失败 → unknown，不抛错
  {
    const { deps } = makeDeps(async () => ({ total: 1, expiredTotal: 0, packages: [pkg(1)] }))
    const selector = new CreditBalanceSelector({
      ...deps,
      resolveCredential: async () => { throw new Error('读取凭据失败') },
    })
    assert.equal(await selector.pick([entryOf('a')]), undefined)
  }

  // ⑤b pick 结果带档位与余额（日志与账本对账用）
  {
    clock = 4_000_000 // 独立时间线
    const expiringEnd = clockNow() + day
    const expiring = { total: 150, expiredTotal: 0, packages: [pkg(150, { deductionEndTime: expiringEnd })] }
    const { deps } = makeDeps(async () => expiring)
    const selector = new CreditBalanceSelector(deps)
    const picked = await selector.pick([entryOf('a')])
    assert.equal(picked.tier, CREDIT_TIER.expiring)
    assert.equal(picked.balance.total, 150)
  }

  // ⑥ invalidate 单账号：清指定；无参清全部（行为以 fetch 计数验证）
  {
    clock = 2_000_000 // 独立时间线
    const { deps, fetched } = makeDeps(async () => ({ total: 100, expiredTotal: 0, packages: [pkg(100)] }))
    const selector = new CreditBalanceSelector(deps)
    const candidates = [entryOf('a'), entryOf('b')]
    await selector.pick(candidates) // a、b 各 1 次
    assert.equal(fetched.length, 2)
    selector.invalidate('a')
    await selector.pick(candidates) // b 用缓存，a 重查
    assert.equal(fetched.length, 3)
    assert.deepEqual(fetched[2], ['fixture-a', clock], 'invalidate(a) 只重查 a')
    clock += 100 // 仍在 TTL 内
    selector.invalidate()
    await selector.pick(candidates) // 全清：a、b 都重查
    assert.equal(fetched.length, 5)
  }

  console.log('ok  credit routing selector: 60s/5s dual TTL, tier pick, fail-open')
}

/**
 * 适配器接线回归：TRAE / Qoder（含 qodercn）轮换吃同一分档。
 * 由 channel-pack-test.mjs 的 --source 环境调用（需要 kernel 替身）；
 * 独立运行时跳过。
 */
async function verifyCreditRoutingWiring({ makePool, collect, success }) {
  const now = Date.now()
  const traeCredential = id => ({
    access_token: `fixture-${id}`, refresh_token: `refresh-${id}`,
    expires_at: String(now + 3_600_000), uid: id, machine_id: 'fixture', device_id: `device-${id}`,
  })
  // ① TRAE：HTTP 层轮换 hook —— a(常规) 4008 后换到临期 b
  {
    const { registerTraeLlm } = await import('../vendor/channel-pack/src/trae-adapter.ts')
    const pool = makePool('trae', ['a', 'b'])
    const sent = [], nextCalls = []
    pool.updateModelRateLimit = async (id, model, resetAt) => {
      pool.rows.find(row => row.entry.id === id).entry.modelRateLimits[model] = resetAt
    }
    pool.rows.forEach(row => { row.credential = traeCredential(row.entry.id) })
    let mounted
    const adapter = registerTraeLlm({ llm: { registerAdapter(_ids, value) { mounted = value } } }, {
      credentialRef: 'fixture', accountPool: pool,
      resolveCredential: async () => pool.rows[0].credential,
      refresh: async () => {},
      nextAccount: async (model, tried) => {
        nextCalls.push(model)
        const next = pool.rows.find(row => !tried.has(row.entry.id))
        if (next === undefined) return undefined
        return { accountId: next.entry.id, credential: next.credential }
      },
      fetchImpl: async (_url, init) => {
        const id = [...init.headers].find(([, value]) => String(value).includes('fixture-'))?.[1]
        const who = String(id).includes('fixture-b') ? 'b' : 'a'
        sent.push(who)
        // ⚠️ 用 402 而不是 403：401/403 会先走「刷新凭据后同账号重发」
        // 分支（trae-adapter.ts:1099），那不属于换号逻辑；402 直接进入
        // classify → quota-exceeded → 轮换路径。
        if (who === 'a') return new Response(JSON.stringify({ code: 4008, message: 'quota exceeded' }), { status: 402 })
        return success('trae')
      },
    })
    const model = adapter.listAllModels()[0].id
    const call = await mounted.prepareCall('trae', model)
    await collect(call.stream({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))
    assert.deepEqual(sent, ['a', 'b'], 'TRAE 额度 4008 后必须经 nextAccount 换号')
    assert.ok(nextCalls.length > 0, 'nextAccount 被调用')
    assert.ok(pool.rows[0].entry.modelRateLimits[model] > now, '失败账号被标记限流')
  }

  // ② TRAE：不传 nextAccount → 回退池序换号（既有行为逐字节不变）
  {
    const { registerTraeLlm } = await import('../vendor/channel-pack/src/trae-adapter.ts')
    const pool = makePool('trae', ['a', 'b'])
    const sent = []
    pool.updateModelRateLimit = async (id, model, resetAt) => {
      pool.rows.find(row => row.entry.id === id).entry.modelRateLimits[model] = resetAt
    }
    pool.rows.forEach(row => { row.credential = traeCredential(row.entry.id) })
    let mounted
    const adapter = registerTraeLlm({ llm: { registerAdapter(_ids, value) { mounted = value } } }, {
      credentialRef: 'fixture', accountPool: pool,
      resolveCredential: async () => pool.rows[0].credential,
      refresh: async () => {},
      fetchImpl: async (_url, init) => {
        const id = [...init.headers].find(([, value]) => String(value).includes('fixture-'))?.[1]
        const who = String(id).includes('fixture-b') ? 'b' : 'a'
        sent.push(who)
        // 同①：402 避开 401/403 的同账号刷新重发分支。
        if (who === 'a') return new Response(JSON.stringify({ code: 4008, message: 'quota exceeded' }), { status: 402 })
        return success('trae')
      },
    })
    const model = adapter.listAllModels()[0].id
    const call = await mounted.prepareCall('trae', model)
    await collect(call.stream({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))
    assert.deepEqual(sent, ['a', 'b'], '无 hook 时仍按池序换号（回退路径 = 既有行为）')
  }

  // ③ Qoder（qoder + qodercn 两站共用类，都必须过 hook）：额度错误走
  //    switchAccountOnQuota → nextAccount；返回的凭据必须再过 ensureUid。
  for (const provider of ['qoder', 'qodercn']) {
    const { registerQoderLlm } = await import('../vendor/channel-pack/src/qoder-adapter.ts')
    const product = provider === 'qodercn'
      ? (await import('../vendor/channel-pack/src/qoder-product.ts')).QODER_CN
      : (await import('../vendor/channel-pack/src/qoder-product.ts')).QODER
    const pool = makePool(provider, ['a', 'b'])
    const sent = [], nextCalls = []
    pool.updateModelRateLimit = async (id, model, resetAt) => {
      pool.rows.find(row => row.entry.id === id).entry.modelRateLimits[model] = resetAt
    }
    const qoderCredential = id => ({
      access_token: `fixture-${id}`, uid: `uid-${id}`, machine_id: 'fixture-machine',
      security_oauth_token: `oauth-${id}`,
    })
    pool.rows.forEach(row => { row.credential = qoderCredential(row.entry.id) })
    let mounted
    const adapter = registerQoderLlm({ llm: { registerAdapter(_ids, value) { mounted = value } } }, {
      credentialRef: 'fixture', accountPool: pool, product,
      resolveCredential: async () => pool.rows[0].credential,
      refresh: async () => {},
      resolveUid: async credential => credential,
      currentAccountId: () => 'a',
      nextAccount: async (model, tried) => {
        nextCalls.push([provider, model])
        const next = pool.rows.find(row => !tried.has(row.entry.id))
        if (next === undefined) return undefined
        return { accountId: next.entry.id, credential: next.credential }
      },
      fetchImpl: async (_url, init) => {
        // ⚠️ 加密端点的 Authorization 是 WASM 生成的 `Bearer COSY.<加密载荷>`，
        // 无法从 headers 判定账号 —— 按发送顺序判定（第 1 次 = 初始 a，
        // 之后 = 换号后的 b）。nextAccount 的调用记录已独立断言。
        const who = sent.length === 0 ? 'a' : 'b'
        sent.push(who)
        // ⚠️ 额度错误的真实形态：HTTP 200 + SSE 内嵌**顶层** code/message 帧
        // （Qoder 错误帧不是 {error:{...}} 包裹，见 openai-compat.ts:584 注释）。
        if (who === 'a') return new Response(
          'data: ' + JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'billing_error' }) + '\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
        // b 的成功也用 SSE 帧：信封剥离器按内容判断，JSON body 会触发
        // 「响应不是 SSE」错误（openai-compat.ts:1045 的 sawDataFrame 判定）。
        return new Response(
          'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] }) + '\n\n'
          + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n'
          + 'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const model = adapter.listAllModels()[0].id
    const call = await mounted.prepareCall(provider, model)
    const chunks = await collect(call.stream({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))
    assert.deepEqual(sent, ['a', 'b'], `${provider} 额度错误后必须经 nextAccount 换号`)
    assert.ok(nextCalls.some(([p]) => p === provider), `${provider} 的 nextAccount 被调用`)
    assert.ok(pool.rows[0].entry.modelRateLimits[model] > now, `${provider} 失败账号被标记限流`)
    assert.ok(JSON.stringify(chunks).includes('ok'), `${provider} 换号后正常返回`)
  }

  // ④ Qoder：不传 nextAccount → 回退池序换号（既有行为）
  {
    const { registerQoderLlm } = await import('../vendor/channel-pack/src/qoder-adapter.ts')
    const { QODER } = await import('../vendor/channel-pack/src/qoder-product.ts')
    const pool = makePool('qoder', ['a', 'b'])
    const sent = []
    pool.updateModelRateLimit = async (id, model, resetAt) => {
      pool.rows.find(row => row.entry.id === id).entry.modelRateLimits[model] = resetAt
    }
    const qoderCredential = id => ({
      access_token: `fixture-${id}`, uid: `uid-${id}`, machine_id: 'fixture-machine',
      security_oauth_token: `oauth-${id}`,
    })
    pool.rows.forEach(row => { row.credential = qoderCredential(row.entry.id) })
    let mounted
    const adapter = registerQoderLlm({ llm: { registerAdapter(_ids, value) { mounted = value } } }, {
      credentialRef: 'fixture', accountPool: pool, product: QODER,
      resolveCredential: async () => pool.rows[0].credential,
      refresh: async () => {},
      resolveUid: async credential => credential,
      currentAccountId: () => 'a',
      fetchImpl: async () => {
        // 同③：按发送顺序判定账号（加密头无明文 token）。
        const who = sent.length === 0 ? 'a' : 'b'
        sent.push(who)
        if (who === 'a') return new Response(
          'data: ' + JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'billing_error' }) + '\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
        return new Response(
          'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] }) + '\n\n'
          + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n'
          + 'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const model = adapter.listAllModels()[0].id
    const call = await mounted.prepareCall('qoder', model)
    await collect(call.stream({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))
    assert.deepEqual(sent, ['a', 'b'], '无 hook 时仍按池序换号（回退路径 = 既有行为）')
  }

  console.log('ok  credit routing wiring: trae + qoder/qodercn rotation via nextAccount + pool fallback')
}

export { verifyCreditRoutingWiring }

/** 入口：被 test-all 直跑或独立运行时全量执行。 */
export async function verifyChannelCreditRouting(fixtures) {
  await verifyCreditRoutingRank()
  await verifyCreditRoutingSelector()
  if (fixtures !== undefined) await verifyCreditRoutingWiring(fixtures)
}

// 独立运行入口（node scripts/credit-routing-test.mjs）
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  await verifyChannelCreditRouting()
}
