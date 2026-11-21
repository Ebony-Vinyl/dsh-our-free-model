import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { ModelWorkspace, useAsync,')
const tick = () => new Promise(resolve => setImmediate(resolve))
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
  : tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('')
  : tree && typeof tree === 'object' ? text(tree.children) : String(tree ?? '')
const alert = tree => nodes(tree).find(node => node.props.role === 'alert')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function mount(fetch = () => { throw new Error('unexpected fetch') }) {
  const cells = [], effects = [], cleanups = new Map(), setups = new Map()
  let cursor = 0, record, mounted = true, writesAfterUnmount = 0, storageWrites = 0
  const changed = (old, deps) => !old || !deps || deps.length !== old.deps.length
    || deps.some((value, index) => !Object.is(value, old.deps[index]))
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], value => {
        if (!mounted) writesAfterUnmount++
        cells[index] = typeof value === 'function' ? value(cells[index]) : value
      }]
    },
    useRef(initial) { return cells[cursor++] ??= { current: initial } },
    useMemo(fn, deps) {
      const index = cursor++
      if (changed(cells[index], deps)) cells[index] = { value: fn(), deps }
      return cells[index].value
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps) },
    useEffect(fn, deps) {
      const index = cursor++
      if (changed(cells[index], deps)) {
        cells[index] = { deps }
        effects.push(() => {
          cleanups.get(index)?.()
          setups.set(index, fn)
          cleanups.set(index, fn())
        })
      }
    },
  }
  const window = {
    __ModuleLoader__: { load: value => { record = value } },
    addEventListener() {}, removeEventListener() {},
    location: { origin: 'http://offline.invalid' },
    localStorage: { getItem: () => null, setItem() { storageWrites++ } },
  }
  const document = { baseURI: 'http://offline.invalid/', documentElement: { lang: 'en', parentElement: null } }
  vm.runInNewContext(source, {
    window, document, navigator: { language: 'en' }, URL, AbortController, setTimeout, clearTimeout, fetch,
    MutationObserver: class { observe() {} disconnect() {} },
  }, { filename: 'client.js', timeout: 3000 })
  const exposed = record.factory(name => name === 'react-dom'
    ? { createPortal: (children, host) => ({ type: 'portal', children, host }) } : react).__test
  return {
    ...exposed,
    render(fn, props) { cursor = 0; return fn(props) },
    commit() { for (const effect of effects.splice(0)) effect() },
    replayEffects() {
      for (const cleanup of cleanups.values()) cleanup?.()
      for (const [index, setup] of setups) cleanups.set(index, setup())
    },
    unmount() { mounted = false; for (const cleanup of cleanups.values()) cleanup?.(); cleanups.clear() },
    writesAfterUnmount: () => writesAfterUnmount,
    storageWrites: () => storageWrites,
  }
}

function asyncFixture() {
  const app = mount(), pending = []
  const loader = () => { const next = deferred(); pending.push(next); return next.promise }
  const render = (dep = 0) => app.render(() => app.useAsync(loader, [dep]))
  render(); app.commit()
  return { app, pending, render }
}

test('latest reload keeps revision 3 when older revision 2 arrives late', async () => {
  const { app, pending, render } = asyncFixture()
  pending[0].resolve({ revision: 1 }); await tick()
  render().reload(); render().reload()
  pending[2].resolve({ revision: 3, enabled: true }); await tick()
  assert.equal(render().data.revision, 3)
  pending[1].resolve({ revision: 2, enabled: false }); await tick()
  assert.equal(render().data.revision, 3)
  assert.equal(render().data.enabled, true)
  app.unmount()
})

test('a stale rejection cannot discard newer data', async () => {
  const { app, pending, render } = asyncFixture()
  render().reload()
  pending[1].resolve({ revision: 2 }); await tick()
  pending[0].reject(new Error('older request failed')); await tick()
  assert.equal(render().status, 'ready')
  assert.equal(render().data.revision, 2)
  assert.equal(render().error, '')
  app.unmount()
})

test('a stale completion cannot clear loading or replace the latest error', async () => {
  const { app, pending, render } = asyncFixture()
  render().reload()
  pending[0].resolve({ revision: 1 }); await tick()
  assert.equal(render().status, 'loading')
  pending[1].reject(new Error('current diagnostic')); await tick()
  assert.equal(render().status, 'error')
  assert.equal(render().error, 'current diagnostic')
  assert.equal(render().data, undefined)
  render().reload()
  pending[2].resolve({ revision: 3 }); await tick()
  assert.equal(render().status, 'ready')
  assert.equal(render().error, '')
  app.unmount()
})

for (const outcome of ['resolve', 'reject']) {
  test(`pending manual reload ${outcome} must not set state after unmount`, async () => {
    const { app, pending, render } = asyncFixture()
    pending[0].resolve({ revision: 1 }); await tick()
    const reload = render().reload
    reload(); app.unmount()
    pending[1][outcome](outcome === 'resolve' ? { revision: 2 } : new Error('late failure')); await tick()
    assert.equal(app.writesAfterUnmount(), 0)
    reload()
    assert.equal(pending.length, 2, 'retained callbacks must not start requests after unmount')
    assert.equal(app.writesAfterUnmount(), 0)
  })
}

test('dependency replacement invalidates pending reloads and old callbacks', async () => {
  const { app, pending, render } = asyncFixture()
  const oldReload = render().reload
  oldReload()
  render(1); app.commit()
  pending[2].resolve({ revision: 3 }); await tick()
  pending[1].resolve({ revision: 2 }); await tick()
  pending[0].reject(new Error('obsolete dependency')); await tick()
  assert.equal(render(1).data.revision, 3)
  oldReload()
  assert.equal(pending.length, 3)
  app.unmount()
})

test('effect cleanup and setup replay invalidates the previous request', async () => {
  const { app, pending, render } = asyncFixture()
  app.replayEffects()
  pending[1].resolve({ revision: 2 }); await tick()
  pending[0].resolve({ revision: 1 }); await tick()
  assert.equal(render().data.revision, 2)
  app.unmount()
})

test('synchronous loader errors use the same error state', async () => {
  const app = mount()
  const render = () => app.render(() => app.useAsync(() => { throw new Error('sync diagnostic') }, []))
  render(); app.commit(); await tick()
  assert.equal(render().status, 'error')
  assert.equal(render().error, 'sync diagnostic')
  app.unmount()
})

function workspaceFixture() {
  const requests = []
  const app = mount((url, options) => {
    assert.match(url, /^\/api\/our-free-model\/engine\/(start|refresh)$/)
    assert.equal(options.method, 'POST')
    const next = deferred(); requests.push(next); return next.promise
  })
  let reloads = 0
  const summary = { reload: () => { reloads++ } }
  const render = language => app.render(app.ModelWorkspace, {
    t: Object.assign(key => app.DICT[language][key], { locale: language }), summary,
  })
  render('en'); app.commit()
  return { app, requests, render, reloads: () => reloads }
}

for (const switchWhilePending of [false, true]) {
  test(`workspace startup failure translates on render (switch while pending: ${switchWhilePending})`, async () => {
    const { app, requests, render } = workspaceFixture()
    if (switchWhilePending) { render('zh'); app.commit() }
    requests[0].reject(new Error('synthetic raw diagnostic')); await tick()
    const chinese = render('zh'); app.commit()
    assert.ok(text(alert(chinese)).includes('工作台启动失败'))
    assert.ok(text(alert(chinese)).includes('synthetic raw diagnostic'))
    const english = render('en'); app.commit()
    assert.ok(text(alert(english)).includes('Workspace could not start'))
    assert.ok(text(alert(english)).includes('synthetic raw diagnostic'))
    assert.equal(requests.length, 1, 'locale changes must not restart the workspace')
    assert.equal(app.storageWrites(), 0)
    app.unmount()
  })
}

test('workspace refresh errors retranslate and preserve raw HTTP diagnostics', async () => {
  const { app, requests, render, reloads } = workspaceFixture()
  requests[0].resolve({ ok: true, text: async () => '{}' }); await tick()
  const ready = render('en'); app.commit()
  nodes(ready).find(node => node.props['aria-label'] === app.DICT.en['engine.refresh']).props.onClick()
  requests[1].resolve({ ok: false, status: 503, text: async () => JSON.stringify({ error: 'raw server 原因 <detail>' }) }); await tick()
  assert.ok(text(alert(render('en'))).includes('Workspace could not start'))
  const chinese = render('zh'); app.commit()
  assert.ok(text(alert(chinese)).includes('工作台启动失败'))
  assert.ok(text(alert(chinese)).includes('raw server 原因 <detail>'))
  assert.equal(requests.length, 2)
  assert.equal(reloads(), 1)
  assert.equal(app.storageWrites(), 0)
  app.unmount()
})

test('workspace startup retry clears the error and retains its existing success behavior', async () => {
  const { app, requests, render, reloads } = workspaceFixture()
  requests[0].reject(new Error('first attempt')); await tick()
  const failed = render('zh'); app.commit()
  nodes(failed).find(node => node.props.kind === 'primary').props.onClick()
  render('zh'); app.commit()
  assert.equal(alert(render('zh')), undefined)
  requests[1].resolve({ ok: true, text: async () => '{}' }); await tick()
  const ready = render('zh'); app.commit()
  assert.ok(nodes(ready).some(node => node.type === 'iframe'))
  assert.equal(alert(ready), undefined)
  assert.equal(reloads(), 1)
  assert.equal(app.storageWrites(), 0)
  app.unmount()
})
