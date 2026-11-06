/** Composer balance badge: seat gating, reading order, refresh and the settings switch. */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { BalanceBadge, BalanceBadgeSeat, ChannelsPage, DICT, badgeReading, channelOfSelection,')
const tick = () => new Promise(resolve => setImmediate(resolve))
let checks = 0
async function check(name, run) { await run(); checks++; console.log('  ok  ' + name) }
function flatten(value, out = []) {
  if (Array.isArray(value)) for (const child of value) flatten(child, out)
  else if (value && typeof value === 'object') { out.push(value); flatten(value.children, out) }
  else if (typeof value === 'string') out.push(value)
  return out
}
const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))

function boot({ fetchImpl } = {}) {
  let bundle
  const cells = [], effects = [], timers = [], calls = [], listeners = new Map()
  let cursor = 0, dirty = false
  const window = {
    __ModuleLoader__: { load: value => { bundle = value } },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn) },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event) },
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [cells[index].value, value => { cells[index].value = typeof value === 'function' ? value(cells[index].value) : value; dirty = true }]
    },
    useRef(initial) { return cells[cursor++] ??= { current: initial } },
    useMemo(factory, deps) { const index = cursor++; if (!cells[index] || changed(cells[index].deps, deps)) cells[index] = { value: factory(), deps }; return cells[index].value },
    useEffect(fn, deps) {
      const index = cursor++
      if (!cells[index] || changed(cells[index].deps, deps)) {
        const previous = cells[index]
        cells[index] = { deps, cleanup: previous?.cleanup }
        effects.push(() => { previous?.cleanup?.(); cells[index].cleanup = fn() })
      }
    },
  }
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps)
  new Function('window', 'document', 'setTimeout', 'setInterval', 'clearInterval', 'AbortController', 'URL', 'CustomEvent', source)(
    window,
    { baseURI: 'http://ofm.invalid/' },
    () => 0,
    (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer },
    () => 1,
    () => {},
    AbortController,
    URL,
    class { constructor(type, options) { this.type = type; Object.assign(this, options) } },
  )
  const api = { ...bundle.factory(name => name === 'react' ? react : { createPortal: (children, host) => ({ children, host }) }).__test }
  ;(globalThis.fetch = async (url, options) => {
    const endpoint = String(url).replace('/api/our-free-model', '')
    calls.push({ endpoint, options })
    const value = await fetchImpl?.(endpoint, options) ?? {}
    return { ok: value.httpOk !== false, text: async () => JSON.stringify(value) }
  })
  const t = Object.assign(key => api.DICT.zh[key] ?? key, { locale: 'zh-CN' })
  const draw = (component, props) => {
    let passes = 0
    do {
      if (++passes > 30) throw new Error('hook render loop')
      dirty = false; cursor = 0
      const tree = component(props)
      for (const effect of effects.splice(0)) effect()
      if (tree === null || tree === undefined) return tree
      if (!dirty) return tree
    } while (true)
  }
  return { api, t, draw, cells, timers, calls, window, flatten }
}

const zh = boot().api.DICT.zh
const t0 = boot().t

await check('the seat gate only accepts channel providers', () => {
  const { channelOfSelection } = boot().api
  assert.equal(channelOfSelection({ provider: 'qoder', model: 'qmodel' }), 'qoder')
  assert.equal(channelOfSelection({ provider: 'gemini', model: 'gemini-2.5-pro' }), 'gemini')
  assert.equal(channelOfSelection({ provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' }), undefined,
    '免费车道不是渠道模型，不该有徽标')
  assert.equal(channelOfSelection({ provider: 'our-free-model-region', model: 'x' }), undefined)
  assert.equal(channelOfSelection({ provider: '', model: 'x' }), undefined)
  assert.equal(channelOfSelection(undefined), undefined)
  assert.equal(channelOfSelection({ provider: 'openai', model: 'gpt' }), undefined, '非本插件渠道一律不画')
})

await check('windows show their tightest percentage; every other channel shows the whole balance', () => {
  const { badgeReading } = boot().api
  const windows = badgeReading({
    accounts: [{ accountId: 'a', balance: { total: 900 } }],
    subscription: { kind: 'windows', accounts: [{ accountId: 'a', windows: [{ id: 'weekly', remainingPercent: 40 }, { id: 'five_hour', remainingPercent: 12 }] }] },
  }, t0)
  assert.ok(windows.includes('12%'), '窗口取最紧张的一档，且不把不同窗口相加')
  assert.ok(!windows.includes('900'), '有窗口时不能用积分顶替')

  const planBacked = badgeReading({
    accounts: [{ accountId: 'a', balance: { total: 1007 } }],
    subscription: { kind: 'plan', accounts: [{ accountId: 'a', plan: { remaining: 207 } }] },
  }, t0)
  assert.ok(planBacked.includes('1,007'), '套餐渠道也显示总额，不能只显示套餐包那一个数')
  assert.ok(!planBacked.includes('207'), '只显示套餐包会比设置页小，两个数打架')

  const credits = badgeReading({ accounts: [{ accountId: 'a', balance: { total: 88.5 } }] }, t0)
  assert.ok(credits.includes('88.5'), '没有订阅时同样走总额')

  const many = badgeReading({
    accounts: [{ accountId: 'a', balance: { total: 2000 } }, { accountId: 'b', balance: { total: 500 } }],
  }, t0)
  assert.ok(many.includes('2,500'), '多账号求和并按千位分组')
})

await check('a failed or empty reading hides the badge instead of printing zero', () => {
  const { badgeReading } = boot().api
  assert.equal(badgeReading(undefined, t0), undefined, '没有读数不画 0')
  assert.equal(badgeReading({ accounts: [] }, t0), undefined, '没有账号不画 0')
  assert.equal(badgeReading({ accounts: [{ accountId: 'a', balance: null, error: 'expired' }] }, t0), undefined,
    '查询失败不是余额 0')
  assert.equal(badgeReading({ subscription: { kind: 'plan', accounts: [] }, accounts: [] }, t0), undefined,
    '空套餐不等于 0')
  const zero = badgeReading({ accounts: [{ accountId: 'a', balance: { total: 0 } }] }, t0)
  assert.ok(zero !== undefined && zero.includes('0'), '真的余额 0 要显示')
})

await check('the badge reads usage.badge once and again on a minute, hiding on failure', async () => {
  const app = boot({ fetchImpl: () => ({ provider: 'qoder', accounts: [{ accountId: 'a', balance: { total: 42 } }] }) })
  const rpc = async (method, payload) => {
    app.calls.push({ endpoint: `rpc:${method}`, options: payload })
    return { provider: payload.provider, accounts: [{ accountId: 'a', balance: { total: 42 } }] }
  }
  let tree = app.draw(app.api.BalanceBadge, { t: app.t, provider: 'qoder', rpc })
  await tick(); await tick()
  tree = app.draw(app.api.BalanceBadge, { t: app.t, provider: 'qoder', rpc })
  const nodes = flatten(tree)
  assert.ok(nodes.includes('剩余 42'), '读数要显示成「剩余 N」')
  const reads = app.calls.filter(call => call.endpoint === 'rpc:usage.badge')
  assert.equal(reads.length >= 1, true, '必须走渠道包已有的 usage.badge 端点')
  assert.equal(reads[0].options.provider, 'qoder')
  assert.equal(app.timers.some(timer => timer.delay === 60_000), true, '按分钟轮询，不按秒')

  const failing = boot()
  let failed = failing.draw(failing.api.BalanceBadge, {
    t: failing.t, provider: 'qoder', rpc: async () => { throw new Error('upstream down') },
  })
  await tick(); await tick()
  failed = failing.draw(failing.api.BalanceBadge, {
    t: failing.t, provider: 'qoder', rpc: async () => { throw new Error('upstream down') },
  })
  assert.equal(failed, null, '查询失败整枚徽标隐藏，不能显示旧数字或 0')
})

await check('the refresh button forces one uncached read', async () => {
  const app = boot()
  const seen = []
  const rpc = async (method, payload) => {
    seen.push(payload)
    return { provider: 'zcode', accounts: [{ accountId: 'a', balance: { total: 7 } }] }
  }
  let tree = app.draw(app.api.BalanceBadge, { t: app.t, provider: 'zcode', rpc })
  await tick(); await tick()
  tree = app.draw(app.api.BalanceBadge, { t: app.t, provider: 'zcode', rpc })
  const button = flatten(tree).find(node => node?.props?.['aria-label'] === app.t('badge.refresh'))
  assert.ok(button !== undefined, '徽标要有一个刷新按钮')
  button.props.onClick()
  await tick(); await tick()
  assert.equal(seen.at(-1)?.force, true, '手动刷新必须绕过宿主缓存')
})

await check('the seat stays empty without the transport, a channel model, or the switch', async () => {
  const app = boot({ fetchImpl: () => ({ settings: { showBalanceBadge: true } }) })
  const selection = { current: { provider: 'qoder', model: 'qmodel' } }
  const directory = { getSnapshot: () => selection, subscribe: () => () => {} }
  let tree = app.draw(app.api.BalanceBadgeSeat, { t: app.t, directory, ctx: {} })
  await tick(); await tick()
  assert.equal(tree, null, '包装包还没挂上时座位留空，而不是显示空壳')

  const other = boot({ fetchImpl: () => ({ settings: { showBalanceBadge: true } }) })
  const free = { current: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' } }
  const freeDirectory = { getSnapshot: () => free, subscribe: () => () => {} }
  assert.equal(other.draw(other.api.BalanceBadgeSeat, { t: other.t, directory: freeDirectory, ctx: {} }), null,
    '免费车道的会话不该出现徽标')

  const off = boot({ fetchImpl: () => ({ settings: { showBalanceBadge: false } }) })
  const enabled = { current: { provider: 'qoder', model: 'qmodel' } }
  const offDirectory = { getSnapshot: () => enabled, subscribe: () => () => {} }
  let seat = off.draw(off.api.BalanceBadgeSeat, { t: off.t, directory: offDirectory, ctx: {} })
  await tick(); await tick()
  seat = off.draw(off.api.BalanceBadgeSeat, { t: off.t, directory: offDirectory, ctx: {} })
  assert.equal(seat, null, '开关关掉后徽标必须消失')

  const on = boot({ fetchImpl: () => ({ settings: { showBalanceBadge: true } }) })
  let shown = on.draw(on.api.BalanceBadgeSeat, { t: on.t, directory: offDirectory, ctx: {} })
  await tick(); await tick()
  shown = on.draw(on.api.BalanceBadgeSeat, { t: on.t, directory: offDirectory, ctx: {} })
  assert.equal(shown, null, '包装包 RPC 不可用时不画空壳')
})

await check('the channel page renders the switch, mirrors it, and writes its opposite', () => {
  const page = boot()
  const settings = { showBalanceBadge: true }
  const written = []
  const tree = page.api.ChannelsPage({ t: page.t, ctx: {}, summary: { data: { channels: { state: 'ready' } } }, settings, busy: false, onApply: patch => written.push(patch) })
  const toggle = flatten(tree).find(node => node?.props?.label === page.t('badge.toggle'))
  assert.ok(toggle !== undefined, '渠道页要渲染这个开关')
  assert.equal(toggle.props.checked, true, '开关要镜像已存的设置')
  toggle.props.onChange()
  assert.deepEqual(written, [{ showBalanceBadge: false }], '开着的开关点一下要写入 false')

  written.length = 0
  const offTree = page.api.ChannelsPage({ t: page.t, ctx: {}, summary: { data: { channels: { state: 'ready' } } }, settings: { showBalanceBadge: false }, busy: false, onApply: patch => written.push(patch) })
  const offToggle = flatten(offTree).find(node => node?.props?.label === page.t('badge.toggle'))
  assert.equal(offToggle.props.checked, false, '关掉的开关不能画成开')
  offToggle.props.onChange()
  assert.deepEqual(written, [{ showBalanceBadge: true }], '关着的开关点一下要写入 true')

  const busyTree = page.api.ChannelsPage({ t: page.t, ctx: {}, summary: { data: { channels: {} } }, settings, busy: true, onApply: () => written.push({ oops: true }) })
  const busyToggle = flatten(busyTree).find(node => node?.props?.label === page.t('badge.toggle'))
  assert.equal(busyToggle.props.disabled, true, '写入进行中开关要禁用')
})

await check('the summary handle is never read as a settings object', () => {
  const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(!client.includes('summary?.settings?.showBalanceBadge'),
    'summary 是 useAsync 句柄，读 summary.settings 会永远是 undefined，开关永远关不掉')
  assert.ok(client.includes('settings: data.settings'), '设置要作为解析后的对象传进渠道页')
})

await check('dictionary carries the switch copy in both languages', () => {
  const dictionaries = boot().api.DICT
  for (const key of ['badge.toggle', 'badge.toggleHint', 'badge.label', 'badge.loading', 'badge.refresh']) {
    assert.ok(typeof dictionaries.zh[key] === 'string' && dictionaries.zh[key] !== '', `zh 缺 ${key}`)
    assert.ok(typeof dictionaries.en[key] === 'string' && dictionaries.en[key] !== '', `en 缺 ${key}`)
  }
  assert.ok(dictionaries.zh['badge.toggle'].includes('余额'), '开关文案要说清是余额')
})

console.log(`${checks} balance badge checks passed`)
