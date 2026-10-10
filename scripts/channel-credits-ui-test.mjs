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
