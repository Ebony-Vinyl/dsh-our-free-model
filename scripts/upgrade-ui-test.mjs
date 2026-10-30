/** Upgrade UI behavior uses the real hooks and async callbacks in a VM.
 * Host reload checks below run against an isolated copy; no real account/network.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { callRoute, fakeContext, until } from './lib/fake-kernel.mjs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const baseline = {
  current: '1.4.5', installedVersion: '1.4.5', latest: '1.4.6', managed: false,
  available: true, applying: false, recoveryRequired: false, versionMismatch: false, hotReloadAvailable: true, autoReloadWatch: true,
}
let checks = 0
async function check(name, run) {
  await run(); checks += 1; console.log('  ok  ' + name)
}
function flatten(value, out = []) {
  if (Array.isArray(value)) for (const child of value) flatten(child, out)
  else if (value !== null && typeof value === 'object') { out.push(value); flatten(value.children, out) }
  else if (typeof value === 'string') out.push(value)
  return out
}
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const response = (body, ok = true) => ({ ok, text: async () => JSON.stringify(body) })
const tick = () => new Promise(resolve => setImmediate(resolve))

async function mount(fixture = baseline, { locale, initialPending } = {}) {
  const cells = [], pendingEffects = [], listeners = new Map(), calls = [], patches = []
  let cursor = 0, bundle, tree, dirty = true, status = fixture, getStatus = () => response(status)
  let sendAction = () => response({ version: '1.4.6', reloaded: true })
  if (initialPending) getStatus = () => initialPending.promise
  const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [cells[index].value, value => { cells[index].value = typeof value === 'function' ? value(cells[index].value) : value; dirty = true }]
    },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial } },
    useMemo(factory, deps) {
      const index = cursor++
      if (!cells[index] || depsChanged(cells[index].deps, deps)) cells[index] = { value: factory(), deps }
      return cells[index].value
    },
    useCallback(fn, deps) { return this.useMemo(() => fn, deps) },
    useEffect(fn, deps) {
      const index = cursor++
      if (!cells[index] || depsChanged(cells[index].deps, deps)) {
        const previous = cells[index]
        cells[index] = { deps, cleanup: previous?.cleanup }
        pendingEffects.push(() => { previous?.cleanup?.(); cells[index].cleanup = fn() })
      }
    },
  }
  // The client destructures hooks, so callbacks must not depend on a receiver.
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps)
  const window = {
    __ModuleLoader__: { load: value => { bundle = value } },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn) },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event) },
  }
  vm.runInNewContext(source, { window, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      const endpoint = url.replace('/api/our-free-model', '')
      calls.push({ endpoint, options })
      return endpoint === '/update/status' ? getStatus() : sendAction(endpoint, options)
    },
  })
  const { UpgradePanel, DICT } = bundle.factory(name => name === 'react' ? react : {}).__test
  const t = locale ? Object.assign(key => DICT[locale][key], { locale }) : key => key
  const props = { t, settings: { autoReloadWatch: true, updateCheckHours: 6 }, onApply: patch => patches.push(patch), busy: false }
  const draw = () => {
    let passes = 0
    do {
      if (++passes > 20) throw new Error('hook render loop')
      dirty = false; cursor = 0; tree = UpgradePanel(props)
      for (const effect of pendingEffects.splice(0)) effect()
    } while (dirty)
    return flatten(tree)
  }
  const flush = async () => { await tick(); draw(); await tick(); return draw() }
  draw(); await flush()
  return {
    calls, patches, draw, flush, props,
    button: label => draw().find(node => node?.children?.includes(t(label)) && typeof node?.props?.onClick === 'function'),
    setStatus(value) { status = value; getStatus = () => response(status); window.dispatchEvent({ type: 'ofm:upgraded', detail: {} }) },
    setStatusLoader(loader) { getStatus = loader },
    emit() { window.dispatchEvent({ type: 'ofm:upgraded', detail: {} }) },
    setAction(fn) { sendAction = fn },
    dispose() { for (const cell of cells) cell?.cleanup?.() },
    text: () => flatten(tree).filter(node => typeof node === 'string').join(' '),
  }
}

await check('upgrade panel names both running and disk versions', async () => {
  const app = await mount({ ...baseline, installedVersion: '1.4.6', versionMismatch: true })
  assert.ok(app.draw().includes('upgrade.current: 1.4.5'))
  assert.ok(app.draw().includes('upgrade.installed: 1.4.6'))
  assert.ok(app.draw().includes('upgrade.mismatch'))
  assert.ok(!app.draw().includes('upgrade.upToDate')); app.dispose()
})
await check('same-version incomplete install still warns and disables upgrade and reload', async () => {
  const app = await mount({ ...baseline, recoveryRequired: true, recoveryBackup: '/retained/rollback', error: 're-import failed; rollback also failed' })
  assert.ok(app.draw().includes('upgrade.recovery'))
  assert.ok(app.draw().includes('upgrade.backup: /retained/rollback'))
  assert.equal(app.button('upgrade.apply').props.disabled, true)
  assert.equal(app.button('reload.now').props.disabled, true)
  assert.ok(!app.draw().includes('upgrade.upToDate')); app.dispose()
})
await check('an unfinished upgrade cannot render an up-to-date indicator', async () => {
  const app = await mount({ ...baseline, available: false, applying: true })
  assert.ok(!app.draw().includes('upgrade.upToDate'))
  app.setStatus({ ...baseline, available: false }); await app.flush()
  assert.ok(app.draw().includes('upgrade.upToDate')); app.dispose()
})
await check('restart-required install explains why reload is disabled and reports restart activation', async () => {
  const app = await mount({ ...baseline, hotReloadAvailable: false, autoReloadWatch: false })
  assert.ok(app.draw().includes('upgrade.restartHint'))
  assert.equal(app.button('reload.now').props.disabled, true)
  app.setAction(() => response({ version: '1.4.6', restartRequired: true }))
  await app.button('upgrade.apply').props.onClick(); await app.flush()
  assert.ok(app.draw().includes('upgrade.restart'))
  assert.ok(app.draw().includes('upgrade.restartHint')); app.dispose()
})
for (const succeeds of [true, false]) {
  await check('upgrade response releases controls without SSE (success=' + succeeds + ')', async () => {
    const app = await mount(), pending = defer()
    app.setAction(() => pending.promise)
    const action = app.button('upgrade.apply').props.onClick()
    assert.ok(app.draw().some(node => node?.props?.className === 'ofm_prog'))
    assert.equal(app.button('reload.now').props.disabled, true)
    pending.resolve(response(succeeds ? { version: '1.4.6' } : { error: 'activation version mismatch' }, succeeds))
    await action; await app.flush()
    assert.equal(app.calls.filter(call => call.endpoint === '/update/status').length, 2)
    assert.ok(!app.draw().some(node => node?.props?.className === 'ofm_prog'))
    assert.equal(app.button('upgrade.check').props.disabled, false)
    assert.equal(app.button('reload.now').props.disabled, false)
    assert.ok(app.draw().includes(succeeds ? 'upgrade.doneRefresh' : 'upgrade.failed')); app.dispose()
  })
}
for (const locale of ['zh', 'en']) {
  await check('managed controls refuse handlers and show localized guidance (' + locale + ')', async () => {
    const app = await mount({ ...baseline, managed: true, error: 'use the package manager' }, { locale })
    for (const label of ['upgrade.check', 'upgrade.apply', 'reload.now']) {
      const button = app.button(label); assert.equal(button.props.disabled, true); await button.props.onClick()
    }
    const watch = app.draw().find(node => node?.props?.label?.includes(locale === 'zh' ? '文件变化' : 'Reload on'))
      ?? app.draw().find(node => node?.props?.checked === false && node?.props?.onChange)
    assert.equal(watch.props.disabled, true); watch.props.onChange()
    assert.equal(app.patches.length, 0)
    assert.equal(app.calls.filter(call => call.endpoint !== '/update/status').length, 0)
    assert.match(app.text(), locale === 'zh' ? /由安装它的宿主管理.*原安装方式更新/ : /managed by the host.*original installation method/)
    assert.doesNotMatch(app.text(), /升级失败|Upgrade failed|无需.*重启|no restart|自动检查：|Auto-check:/)
    app.dispose()
  })
}
await check('unknown ownership disables all upgrade and reload controls', async () => {
  const pending = defer(), app = await mount(baseline, { initialPending: pending })
  assert.equal(app.button('upgrade.check').props.disabled, true)
  assert.equal(app.button('reload.now').props.disabled, true)
  await app.button('reload.now').props.onClick()
  assert.equal(app.calls.length, 1)
  pending.resolve(response({ error: 'controlled status failure' }, false)); await app.flush()
  assert.ok(app.text().includes('loadFailed'))
  assert.equal(app.button('reload.now').props.disabled, true); app.dispose()
})
await check('self mode keeps check, reload and watch functional and blocks a double action', async () => {
  const app = await mount(), pending = defer()
  app.setAction(() => pending.promise)
  const checkButton = app.button('upgrade.check'), reloadButton = app.button('reload.now')
  const action = checkButton.props.onClick()
  await reloadButton.props.onClick()
  assert.equal(app.calls.filter(call => call.endpoint !== '/update/status').length, 1)
  pending.resolve(response({})); await action; await app.flush()
  app.setAction(() => response({}))
  await app.button('reload.now').props.onClick()
  assert.ok(app.calls.some(call => call.endpoint === '/reload'))
  const watch = app.draw().find(node => node?.props?.label === 'reload.auto')
  assert.equal(Boolean(watch.props.disabled), false); watch.props.onChange()
  assert.equal(app.patches[0].autoReloadWatch, false); app.dispose()
})
for (const label of ['upgrade.check', 'upgrade.apply', 'reload.now']) {
  for (const succeeds of [true, false]) {
    await check('old ' + label + ' cannot overwrite managed then self state (success=' + succeeds + ')', async () => {
      const app = await mount(), pending = defer()
      app.setAction(() => pending.promise)
      const oldButton = app.button(label), action = oldButton.props.onClick()
      app.setStatus({ ...baseline, managed: true }); await app.flush()
      assert.ok(app.draw().includes('upgrade.managed'))
      // A captured self callback is also inert while the installation is managed.
      await oldButton.props.onClick()
      assert.equal(app.calls.filter(call => call.endpoint !== '/update/status').length, 1)
      app.setStatus(baseline); await app.flush()
      pending.resolve(response(succeeds ? { version: '9.9.9' } : { error: 'stale request failure' }, succeeds))
      await action; await app.flush()
      assert.doesNotMatch(app.text(), /stale request failure|9\.9\.9|upgrade.failed|upgrade.doneRefresh/)
      assert.equal(app.button('upgrade.check').props.disabled, false)
      assert.equal(app.button('reload.now').props.disabled, false); app.dispose()
    })
  }
}
for (const label of ['upgrade.check', 'upgrade.apply', 'reload.now']) {
  await check('a refused ' + label + ' refreshes ownership before showing an error', async () => {
    const app = await mount(), refreshed = defer()
    app.setAction(() => response({ error: 'managed install: use the host' }, false))
    app.setStatusLoader(() => refreshed.promise)
    const action = app.button(label).props.onClick()
    await tick(); app.draw()
    assert.ok(!app.draw().includes('upgrade.failed'), 'do not flash an upgrade error before refreshing ownership')
    refreshed.resolve(response({ ...baseline, managed: true }))
    await action; await app.flush()
    assert.ok(app.draw().includes('upgrade.managed'))
    assert.ok(!app.draw().includes('upgrade.failed')); app.dispose()
  })
}
for (const succeeds of [true, false]) {
  await check('older status response cannot replace newer managed status (success=' + succeeds + ')', async () => {
    const app = await mount(), older = defer(), newer = defer()
    const pending = [older, newer]
    app.setStatusLoader(() => pending.shift().promise)
    app.emit(); app.emit()
    newer.resolve(response({ ...baseline, managed: true })); await app.flush()
    older.resolve(response(succeeds ? baseline : { error: 'stale status error' }, succeeds)); await app.flush()
    assert.ok(app.draw().includes('upgrade.managed'))
    assert.doesNotMatch(app.text(), /stale status error/)
    assert.equal(app.button('upgrade.check').props.disabled, true); app.dispose()
  })
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-reload-isolation-'))
const pkgDir = path.join(root, 'package')
const home = path.join(root, 'home')
const env = { DSH_HOME: process.env.DSH_HOME, OUR_FREE_MODEL_BASE: process.env.OUR_FREE_MODEL_BASE }
const originalFetch = globalThis.fetch
const contexts = []
function dispose() {
  for (const ctx of contexts) for (const disposer of [...ctx.__disposers].reverse()) disposer()
}
try {
  fs.mkdirSync(pkgDir, { recursive: true })
  for (const rel of ['index.js', 'src', 'adapter', 'package.json']) {
    fs.cpSync(new URL(`../${rel}`, import.meta.url), path.join(pkgDir, rel), { recursive: true })
  }
  const pkgFile = path.join(pkgDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  fs.writeFileSync(pkgFile, JSON.stringify({ ...packageJson, version: '1.4.5' }))
  process.env.DSH_HOME = home
  process.env.OUR_FREE_MODEL_BASE = 'http://127.0.0.1:1'
  globalThis.fetch = async () => { throw new Error('external network disabled in reload isolation test') }
  const module = await import(pathToFileURL(path.join(pkgDir, 'index.js')))
  const boot = async () => {
    const ctx = fakeContext({ inject: module.inject, mounted: ['llm', 'webServer'] })
    ctx.loader = { internal: { loadCache: new Map([[pathToFileURL(path.join(pkgDir, 'index.js')).href, { source: 'host fixture cache' }]]) } }
    contexts.push(ctx)
    module.apply(ctx, {})
    await until(() => ctx.__captured.serverRoutes.some(route => route.kind === 'prefix'), { timeoutMs: 5000 })
    return { ctx, handler: ctx.__captured.serverRoutes.find(route => route.kind === 'prefix').handler }
  }

  await check('cached old module keeps its running version when apply is called again', async () => {
    fs.writeFileSync(pkgFile, JSON.stringify({ ...packageJson, version: '1.4.6' }))
    const { handler } = await boot()
    const meta = await callRoute(handler, 'GET', '/api/our-free-model/meta')
    assert.equal(meta.json.version, '1.4.5')
    assert.equal(meta.json.update.current, '1.4.5')
    assert.equal(meta.json.update.installedVersion, '1.4.6')
    assert.equal(meta.json.update.versionMismatch, true)
  })

  await check('failed ordinary reload preserves disk edits and never restores an unrelated backup', async () => {
    const { ctx, handler } = await boot()
    const backupDir = path.join(home, 'our-free-model', 'rollback')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'package.json'), '{"version":"0.9.0"}')
    fs.writeFileSync(path.join(backupDir, 'index.js'), '// unrelated historical backup\n')
    const before = fs.readFileSync(path.join(pkgDir, 'index.js'))
    ctx.fiber.runtime = { callback: module }
    ctx.registry = { get: () => ({ fibers: [ctx.fiber] }) }
    ctx.loader = {
      internal: { loadCache: new Map([[pathToFileURL(path.join(pkgDir, 'index.js')).href, { source: 'host fixture cache' }]]) },
      unwrapExports: value => value,
      import: async () => { throw new Error('controlled ordinary import failure') },
    }
    const response = await callRoute(handler, 'POST', '/api/our-free-model/reload')
    assert.equal(response.status, 202)
    await until(() => ctx.__logs.some(line => line.includes('controlled ordinary import failure')), { timeoutMs: 5000 })
      .catch(error => { throw new Error(`${error.message}: ${ctx.__logs.join(' | ')}`) })
    assert.deepEqual(fs.readFileSync(path.join(pkgDir, 'index.js')), before)
    assert.equal(JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version, '1.4.6')
    assert.ok(fs.existsSync(path.join(pkgDir, 'src', 'adapter.js')))
  })

  await check('manual reload rejects unresolved recovery before acknowledging the request', async () => {
    const stateFile = path.join(home, 'our-free-model', 'upgrade-state.json')
    fs.writeFileSync(stateFile, JSON.stringify({ phase: 'recovery-required', from: '1.4.5', to: '1.4.6' }))
    const { handler } = await boot()
    const response = await callRoute(handler, 'POST', '/api/our-free-model/reload')
    assert.equal(response.status, 409)
    assert.match(response.json.error, /retained upgrade backup/)
  })
} finally {
  dispose()
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
}
console.log(`${checks} upgrade UI and Host checks passed`)
