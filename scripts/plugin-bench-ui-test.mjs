/** Model listing and benchmark UI regressions, using real client callbacks. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { SettingsPage, ModelCard, Roster,')
const tick = () => new Promise(resolve => setImmediate(resolve))
let checks = 0
async function check(name, run) { await run(); checks++; console.log('  ok  ' + name) }
function flatten(value, out = []) {
  if (Array.isArray(value)) for (const child of value) flatten(child, out)
  else if (value && typeof value === 'object') { out.push(value); flatten(value.children, out) }
  else if (typeof value === 'string') out.push(value)
  return out
}
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.className = ''; this.parentNode = null; this.style = {} }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] ?? null }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node }
  removeChild(node) { this.children = this.children.filter(child => child !== node); node.parentNode = null }
  remove() { this.parentNode?.removeChild(this) }
  addEventListener() {}
  get firstElementChild() { return this.children[0] }
}
function boot({ storage = new Map(), failStorage = false, fetchImpl } = {}) {
  let bundle, cursor = 0, tree, dirty = true
  const cells = [], effects = [], listeners = new Map(), frames = new Map(), timers = [], calls = []
  const html = new Node('html'), head = html.appendChild(new Node('head')), body = html.appendChild(new Node('body'))
  const matches = (node, selector) => {
    const className = selector.match(/^\.([\w-]+)/)?.[1]
    if (className && !node.className.split(/\s+/).includes(className)) return false
    const attr = selector.match(/\[([\w-]+)\]/)?.[1]
    return (!attr || node.getAttribute(attr) !== null) && Boolean(className || attr)
  }
  const all = () => flattenDom(html)
  const document = {
    documentElement: html, head, body, baseURI: 'http://ofm.invalid/',
    createElement: tag => new Node(tag), createTextNode: text => Object.assign(new Node('#text'), { textContent: text }),
    querySelectorAll: selector => all().filter(node => selector.split(',').some(part => matches(node, part.trim()))),
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
  }
  function flattenDom(node) { return [node, ...node.children.flatMap(flattenDom)] }
  const localStorage = {
    getItem(key) { if (failStorage) throw new Error('storage read denied'); return storage.get(key) ?? null },
    setItem(key, value) { if (failStorage) throw new Error('storage write denied'); storage.set(key, value) },
  }
  const window = {
    __ModuleLoader__: { load: value => { bundle = value } }, localStorage,
    matchMedia: () => ({ matches: false }),
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn) },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event) },
  }
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment',
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
        const previous = cells[index]; cells[index] = { deps, cleanup: previous?.cleanup }
        effects.push(() => { previous?.cleanup?.(); cells[index].cleanup = fn() })
      }
    },
  }
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps)
  vm.runInNewContext(source, {
    window, document, URL, AbortController,
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options) } },
    setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: fn => { const id = frames.size + 1; frames.set(id, fn); return id }, cancelAnimationFrame: id => frames.delete(id),
    fetch: async (url, options) => {
      const endpoint = new URL(url, document.baseURI).pathname.replace('/api/our-free-model', '')
      calls.push({ endpoint, options, timeout: timers.at(-1)?.delay })
      const value = await fetchImpl?.(endpoint, options) ?? {}
      return { ok: value.httpOk !== false, text: async () => JSON.stringify(value.httpOk === false ? { error: value.error } : value) }
    },
  })
  const plugin = bundle.factory(name => name === 'react' ? react : { createPortal: (children, host) => ({ children, host }) })
  const api = plugin.__test
  const t = Object.assign(key => api.DICT.zh[key] ?? key, { locale: 'zh-CN' })
  const draw = (component = api.SettingsPage, props = { t }) => {
    let passes = 0
    do {
      if (++passes > 30) throw new Error('hook render loop')
      dirty = false; cursor = 0; tree = component(props)
      for (const effect of effects.splice(0)) effect()
    } while (dirty)
    return tree
  }
  return { api, plugin, t, draw, document, window, frames, timers, calls, storage,
    root(className = 'ofm_root') { const node = new Node(); node.className = className; body.appendChild(node); return node },
    dispose() { for (const cell of cells) cell?.cleanup?.() },
  }
}

await check('listing stays selectable and does not imply verified inference; manual failures show their error', () => {
  const app = boot(), { ModelCard, Roster } = app.api
  const model = { id: 'fixture', name: 'Fixture', availabilitySource: 'listing', availability: 'unknown', route: 'our-free-model' }
  const props = { model, t: app.t, onBench() {}, onVisibility() {} }
  let nodes = flatten(ModelCard(props))
  assert.ok(nodes.includes('已列出 · 未实测')); assert.ok(nodes.includes(app.t('hint.listed')))
  assert.equal(nodes.find(node => node?.type === 'article').props.className, 'ofm_card')
  assert.equal(Boolean(nodes.find(node => node?.props?.label === app.t('visibility.showModel')).props.disabled), false)
  const roster = flatten(Roster({ summary: { catalog: [model], settings: {} }, t: app.t }))
  assert.ok(roster.includes('可选模型')); assert.ok(roster.some(node => node?.type === ModelCard))
  nodes = flatten(ModelCard({ ...props, model: { ...model, availabilitySource: 'manual', availability: 'unknown', detail: 'No normal finish' } }))
  assert.ok(nodes.includes('No normal finish')); assert.ok(!nodes.includes('可用'))
  nodes = flatten(ModelCard({ ...props, model: { ...model, availabilitySource: 'manual', availability: 'available', probedAt: Date.now(), ttftMs: 321 } }))
  assert.ok(nodes.includes('最近测量')); assert.ok(nodes.some(node => node?.children?.includes(321)))
})
for (const persisted of [true, false]) {
  await check('benchmark waits 330s, refreshes summary and keeps success when persisted=' + persisted, async () => {
    const summary = { catalog: [{ id: 'listing', availability: 'available', availabilitySource: 'listing' }], settings: {} }
    const app = boot({ fetchImpl: endpoint => endpoint === '/summary' ? summary : endpoint === '/bench'
      ? { ttftMs: 123, tokensPerSecond: 45, reasoningTokens: 6, persisted } : {} })
    const props = { t: app.t }, draw = () => app.draw(app.api.SettingsPage, props)
    draw(); await tick(); let tree = draw()
    assert.equal(tree.props.counts.available ?? 0, 0, 'listing must not enter the confirmed-available count')
    await tree.props.bench({ id: 'fixture' }); await tick(); tree = draw()
    assert.equal(app.calls.find(call => call.endpoint === '/bench').timeout, 330_000)
    assert.equal(JSON.parse(app.calls.find(call => call.endpoint === '/bench').options.body).model, 'fixture')
    assert.ok(app.calls.filter(call => call.endpoint === '/summary').length >= 2)
    assert.equal(tree.props.benches.fixture.running, false)
    assert.match(tree.props.benches.fixture.result, /文本响应通过.*123.*45/)
    assert.equal(tree.props.benches.fixture.result.includes('结果未能保存'), !persisted)
    assert.ok(!app.calls.some(call => call.endpoint === '/settings'), 'Benchmarks do not change service settings')
    app.dispose()
  })
}
await check('a failed benchmark releases its busy state, keeps the error and refreshes persisted status', async () => {
  const app = boot({ fetchImpl: endpoint => endpoint === '/summary' ? { catalog: [], settings: {} }
    : endpoint === '/bench' ? { httpOk: false, error: 'No visible text' } : {} })
  const draw = () => app.draw(app.api.SettingsPage, { t: app.t })
  draw(); await tick(); const tree = draw(); await tree.props.bench({ id: 'fixture' }); await tick()
  const result = draw().props.benches.fixture
  assert.equal(result.running, false); assert.equal(result.result, 'No visible text')
  assert.ok(app.calls.filter(call => call.endpoint === '/summary').length >= 2); app.dispose()
})

console.log(checks + ' plugin benchmark UI checks passed')
