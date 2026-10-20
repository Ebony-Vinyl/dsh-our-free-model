import assert from 'node:assert/strict'
import fs from 'node:fs'

/** 实际共享组件的余额能力、查询反馈与请求交错回归。 */
export async function verifyChannelCreditsUi() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .replace('exports.__test = {', 'exports.__test = { ChannelCard, DICT,')
  const settle = () => new Promise(resolve => setImmediate(resolve))
  function mount(provider, rpcImpl) {
    let bundle, cursor = 0, effects = []
    const cells = [], calls = [], errors = [], events = new Map()
    const window = {
      __ModuleLoader__: { load: value => { bundle = value } },
      addEventListener: (name, callback) => events.set(name, callback),
      removeEventListener: name => events.delete(name),
    }
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      Fragment: 'fragment',
      useState(initial) {
        const index = cursor++
        if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
        return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
      },
      useRef(initial) { return cells[cursor++] ??= { current: initial } },
      useEffect(fn) { effects.push(fn) },
      useMemo: fn => fn(),
      useCallback: fn => fn,
    }
    new Function('window', source)(window)
    const { ChannelCard, DICT } = bundle.factory(() => react).__test
    const props = {
      channel: { id: provider, name: provider },
      status: { accounts: { total: 2, enabled: 2 }, models: { total: 0 } },
      t: key => DICT.zh[key],
      onChanged() {},
      onError: (_channel, error) => errors.push(error.message),
      rpc: async (method, payload) => {
        calls.push({ method, payload })
        return rpcImpl(method, payload)
      },
    }
    function render() {
      cursor = 0; effects = []
      return ChannelCard(props)
    }
    function nodes(tree) {
      const all = []
      const visit = node => {
        if (Array.isArray(node)) return node.forEach(visit)
        if (!node || typeof node !== 'object') return
        all.push(node); visit(node.children)
      }
      visit(tree)
      return all
    }
    const button = label => nodes(render()).find(node => node.type === 'button' && node.children.includes(label))
    const text = () => JSON.stringify(render())
    render()
    const load = effects[0], subscribe = effects[2]
    const cleanup = load()
    subscribe()
    return { calls, errors, cells, button, text, cleanup, events }
  }
  const claimable = new Set(['codearts', 'buddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'loomy', 'minimax', 'zcode'])
  for (const provider of [...claimable, 'workbuddy', 'cline', 'raccoon', 'gemini']) {
    const app = mount(provider, async () => ({ accounts: [] }))
    await settle()
    assert.equal(app.calls[0].method, 'credits.balances', `${provider} 必须查询已有后端余额能力`)
    assert.equal(app.calls[0].payload.provider, provider)
    assert.ok(app.button('刷新余额'))
    assert.equal(Boolean(app.button('一键领取')), claimable.has(provider), `${provider} 必须单独判断签到能力`)
    if (provider === 'zcode') assert.ok(app.text().includes('剩余 Token'))
    if (provider === 'cline') assert.ok(app.text().includes('USD'))
    if (provider === 'gemini') assert.ok(app.text().includes('剩余配额'))
    app.cleanup()
  }

  let fail = false
  const accountRows = [{ id: 'one', nickname: '账号一', enabled: true }, { id: 'two', nickname: '账号二', enabled: true }]
  let balances = [
    { accountId: 'one', balance: { total: 0 } },
    { accountId: 'two', balance: null, error: '凭据已失效，请重新登录' },
  ]
  const app = mount('buddy', async method => {
    if (method === 'account.list') return { accounts: accountRows }
    if (method === 'credits.status') return { accounts: [{ accountId: 'one', status: { todayCheckedIn: true, todayCredit: 10 } }] }
    if (method === 'credits.balances') {
      if (fail) throw new Error('网络暂时断开')
      return { accounts: balances }
    }
    if (method === 'credits.claimAll') return { summary: { claimed: 0 }, results: [{ accountId: 'two', outcome: { kind: 'failed', message: '签到凭据过期' } }] }
    throw new Error(`意外的 RPC ${method}`)
  })
  await settle()
  assert.ok(app.text().includes('1 个账号未能查询余额'))
  app.button('账号').props.onClick()
  await settle()
  assert.ok(app.text().includes('凭据已失效，请重新登录'))
  assert.ok(app.text().includes('剩余积分 0'), '零余额必须显示，不能变成查询失败')
  assert.ok(app.text().includes('今日已领 10'), '签到状态只解包一次')
  fail = true
  app.button('刷新余额').props.onClick()
  await settle()
  assert.equal(app.calls.filter(row => row.method === 'credits.balances').at(-1).payload.force, true, '手动重试必须跳过配额缓存')
  assert.ok(app.text().includes('余额查询失败：网络暂时断开'))
  assert.equal(app.button('刷新余额').props.disabled, false)
  fail = false
  balances = accountRows.map(row => ({ accountId: row.id, balance: { total: 123 } }))
  app.button('刷新余额').props.onClick()
  await settle()
  assert.ok(app.text().includes('剩余积分 123'))
  assert.ok(!app.text().includes('网络暂时断开'))
  const beforeEvent = app.calls.length
  app.events.get('ofm:channels')()
  await settle()
  assert.ok(app.calls.slice(beforeEvent).some(row => row.method === 'credits.balances'), '账号变化事件必须刷新余额')
  app.button('一键领取').props.onClick()
  await settle()
  assert.ok(app.text().includes('领取失败：签到凭据过期'), '后端领取失败不能伪装成无可领积分')
  app.cleanup()

  let resolveOld, resolveNew, readCount = 0
  const race = mount('qoder', async method => {
    if (method === 'credits.balances') {
      readCount++
      return new Promise(resolve => { if (readCount === 1) resolveOld = resolve; else resolveNew = resolve })
    }
    if (method === 'account.list') return { accounts: accountRows }
    if (method === 'credits.claimAll') return { summary: { claimed: 1, totalCredit: 100 }, results: [] }
    throw new Error(`意外的 RPC ${method}`)
  })
  const busyText = race.text()
  assert.ok(busyText.includes('余额查询中'))
  race.events.get('ofm:channels')()
  assert.equal(readCount, 1, '轮询和事件共用正在执行的只读请求')
  const claimButton = race.button('一键领取')
  claimButton.props.onClick()
  claimButton.props.onClick()
  await settle()
  assert.equal(race.calls.filter(row => row.method === 'credits.claimAll').length, 1, '重复点击不能重复领取')
  assert.equal(readCount, 2, '写入后必须查询新余额，不能复用写入前的在途请求')
  resolveNew({ accounts: [{ accountId: 'one', balance: { total: 456 } }] })
  await settle()
  resolveOld({ accounts: [{ accountId: 'one', balance: { total: 123 } }] })
  await settle()
  assert.ok(race.text().includes('456'))
  assert.ok(!race.text().includes('"123"'), '旧请求晚到不能覆盖新余额')
  race.cleanup()

  let resolveUnmount
  const unmounted = mount('qoder', async () => new Promise(resolve => { resolveUnmount = resolve }))
  unmounted.cleanup()
  resolveUnmount({ accounts: [{ accountId: 'one', balance: { total: 999 } }] })
  await settle()
  assert.equal(unmounted.cells[4], undefined, '卸载后不回写余额')

  const quota = mount('gemini', async method => method === 'account.list'
    ? { accounts: [accountRows[0]] }
    : { accounts: [{ accountId: 'one', balance: { total: 60, packages: [{ name: '5 小时', remaining: 80 }, { name: '每周', remaining: 40 }] } }] })
  await settle()
  quota.button('账号').props.onClick()
  await settle()
  assert.ok(quota.text().includes('5 小时 80% · 每周 40%'), '不同配额窗口不能相加成积分')
  assert.ok(quota.text().includes('已查询 1 个账号'))
  quota.cleanup()
}

/**
 * 剩余百分比的回归。
 *
 * 夹具是 2026-10-20 从真实网关抓取的 `credits.balances` 数值（见 PR 描述），
 * 不是手写的示意形状 —— 这三个渠道各自代表一种分母情形，改动它们前请先重新抓取：
 *
 *   - codearts：资源包**重叠**（总积分包 = 基础 + 赠送），`used` 也被重复计数；
 *   - buddy：**不重叠**，但含 4 个 `active:false` 失效包；
 *   - minimax：只有一个总数，`packages` 为空。
 */
export function verifyBalancePercent() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .replace('exports.__test = {', 'exports.__test = { balancePercent,')
  let bundle
  const window = { __ModuleLoader__: { load: value => { bundle = value } } }
  new Function('window', source)(window)
  const { balancePercent } = bundle.factory(() => ({})).__test

  // codearts（实测）：总积分包 7150.69 是剩余总量，且它就是聚合包。
  // 朴素 `total + Σused(active)` 会把 349.31 算两次 → 7849.31 → 91.1%（错）。
  // 正确分母是聚合包自身的 total：7150.69 + 349.31 = 7500 → 95.3%。
  const codearts = balancePercent({ total: 7150.69, packages: [
    { name: '总积分包', remaining: 7150.69, total: 7500, used: 349.31, active: true },
    { name: '基础积分包', remaining: 500, total: 500, used: 0, active: true },
    { name: '赠送积分包', remaining: 6650.69, total: 7000, used: 349.31, active: true },
  ] })
  assert.equal(codearts.total, 7500, '重叠包的 used 不能重复计入分母')
  assert.equal(codearts.percent, 95.3)

  // buddy（实测）：31 个有效包不重叠，Σ(total,active) = 4539.00、
  // Σ(remaining,active) = 3896.29、Σ(used,active) = 642.71；
  // 另外 4 个 active:false 失效包（各 total 100 / used 100）不得计入。
  // 这里用少数几个包复现上面三项和（真实响应有 35 个包，逐一内联只是噪声）。
  const buddy = balancePercent({ total: 3896.29, packages: [
    { name: '体验版', remaining: 363.04, total: 500, used: 136.96, active: true },
    { name: '拉新权益包', remaining: 494.25, total: 1000, used: 505.75, active: true },
    ...Array.from({ length: 4 }, () => ({ name: '失效裂变包', remaining: 0, total: 100, used: 100, active: false })),
    { name: '裂变包A', remaining: 100, total: 100, used: 0, active: true },
    { name: '裂变包B', remaining: 2939, total: 2939, used: 0, active: true },
  ] })
  assert.equal(buddy.total, 4539, '失效包不能进入分母')
  assert.equal(buddy.percent, 85.8)

  // minimax（实测：`packages: []`）：没有可除的额度，必须拒绝给百分比。
  // 旧实现会退化成 remaining / remaining = 100%，把「用过的账号」显示成
  // 「从未使用」—— 这是最误导的一种显示，故明确返回 null。
  assert.equal(balancePercent({ total: 123, packages: [] }), null, '无资源包明细时不得编造百分比')
  assert.equal(balancePercent({ total: 500 }), null, '缺少 packages 字段时同样不产出百分比')
  // 只有失效包时也不可用：可见额度无从计算。
  assert.equal(balancePercent({ total: 500, packages: [{ name: 'x', remaining: 0, total: 1000, used: 1000, active: false }] }), null)

  // 单个包自映射（cline 的形状，`cline-credits.ts` 的 total == remaining）：
  // 命中聚合分支，属于真实读数，可以显示。
  assert.equal(balancePercent({ total: 12.5, packages: [{ name: 'Cline 账户余额', unit: 'USD', remaining: 12.5, total: 12.5, used: 0, active: true }] }).percent, 100)
  // 分母小于剩余量的异常形状不产出百分比，避免 >100% 的读数。
  assert.equal(balancePercent({ total: 100, packages: [{ name: 'x', remaining: 40, total: 40, used: 30, active: true }] }), null)
  console.log('ok  remaining percent: overlapping bundles, expired bundles and detail-less channels')
}
