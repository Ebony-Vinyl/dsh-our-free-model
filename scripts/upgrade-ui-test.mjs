/**
 * Upgrade status rendering and ordinary-reload isolation, using the real client
 * component and an isolated copy of the Host plugin. No real installed files,
 * external network, or Windows ACL changes are involved.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { callRoute, fakeContext, until } from './lib/fake-kernel.mjs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let record
let data
let stateHook
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'fragment',
  useState: initial => stateHook !== undefined ? stateHook(initial) : [
    initial?.status === 'loading' ? { status: 'ready', data, error: '' } : initial,
    () => {},
  ],
  useEffect() {},
  useMemo: factory => factory(),
  useCallback: fn => fn,
  useRef: () => ({ current: null }),
}
new Function('window', source)({ __ModuleLoader__: { load: value => { record = value } } })
const { UpgradePanel } = record.factory(() => react).__test
function flatten(value, out = []) {
  if (Array.isArray(value)) for (const child of value) flatten(child, out)
  else if (value !== null && typeof value === 'object') {
    out.push(value)
    flatten(value.children, out)
  } else if (typeof value === 'string') out.push(value)
  return out
}
const render = status => {
  data = status
  return flatten(UpgradePanel({ t: key => key, settings: {}, onApply() {} }))
}
const baseline = {
  current: '1.4.5', installedVersion: '1.4.5', latest: '1.4.6',
  available: true, applying: false, recoveryRequired: false, versionMismatch: false,
}
let checks = 0
async function check(name, run) {
  await run()
  checks += 1
  console.log(`  ok  ${name}`)
}

await check('upgrade panel names both running and disk versions', () => {
  const nodes = render({ ...baseline, installedVersion: '1.4.6', versionMismatch: true })
  assert.ok(nodes.includes('upgrade.current: 1.4.5'))
  assert.ok(nodes.includes('upgrade.installed: 1.4.6'))
  assert.ok(nodes.includes('upgrade.mismatch'))
  assert.ok(!nodes.includes('upgrade.upToDate'))
})
await check('same-version incomplete install still warns and disables upgrade and reload', () => {
  const nodes = render({
    ...baseline, recoveryRequired: true, recoveryBackup: '/retained/rollback',
    error: 're-import failed; rollback also failed',
  })
  assert.ok(nodes.includes('upgrade.recovery'))
  assert.ok(nodes.includes('upgrade.backup: /retained/rollback'))
  const apply = nodes.find(node => node?.props?.kind === 'primary')
  const reload = nodes.find(node => node?.children?.includes('reload.now'))
  assert.equal(apply.props.disabled, true)
  assert.equal(reload.props.disabled, true)
  assert.ok(!nodes.includes('upgrade.upToDate'))
})
await check('a managed install disables check, explains itself, and never renders a fake failure (issue #517)', () => {
  // Every upgrade endpoint answers 409 by design on a managed install, so an
  // enabled button can only ever produce a red error that reads as a fault.
  const nodes = render({
    ...baseline, managed: true, latest: '', available: false, checkedAt: 0,
  })
  const check = nodes.find(node => node?.children?.includes('upgrade.check'))
  assert.equal(check.props.disabled, true, 'the button must not invite a guaranteed 409')
  assert.ok(nodes.includes('upgrade.managed'), 'the panel must say why upgrade is off')
  assert.ok(nodes.includes('upgrade.managedShort'), 'the "never checked" pill must be replaced by the honest one')
  assert.ok(!nodes.includes('upgrade.failed'), 'a by-design 409 must not look like a failed upgrade')
  assert.ok(!nodes.includes('upgrade.upToDate'))
})
await check('an unfinished upgrade cannot render an up-to-date indicator', () => {
  assert.ok(!render({ ...baseline, available: false, applying: true }).includes('upgrade.upToDate'))
  assert.ok(render({ ...baseline, available: false }).includes('upgrade.upToDate'))
})

for (const succeeds of [true, false]) {
  await check(`upgrade response releases local controls without an SSE event (success=${succeeds})`, async () => {
    const originalFetch = globalThis.fetch
    const states = []
    let cursor = 0
    let settle
    let statusReads = 0
    const completed = {
      ...baseline, current: '1.4.6', installedVersion: '1.4.6', available: false,
    }
    const draw = () => {
      cursor = 0
      return flatten(UpgradePanel({ t: key => key, settings: {}, onApply() {} }))
    }
    stateHook = initial => {
      const index = cursor++
      if (!(index in states)) {
        states[index] = initial?.status === 'loading'
          ? { status: 'ready', data: baseline, error: '' } : initial
      }
      return [states[index], value => {
        states[index] = typeof value === 'function' ? value(states[index]) : value
      }]
    }
    globalThis.fetch = async url => {
      if (url.endsWith('/update/apply')) return new Promise(resolve => { settle = resolve })
      assert.ok(url.endsWith('/update/status'))
      statusReads += 1
      return { ok: true, text: async () => JSON.stringify(succeeds ? completed : baseline) }
    }
    try {
      const action = draw().find(node => node?.props?.kind === 'primary').props.onClick()
      assert.ok(draw().some(node => node?.props?.className === 'ofm_prog'))
      assert.equal(draw().find(node => node?.children?.includes('reload.now')).props.disabled, true)
      settle({
        ok: succeeds,
        text: async () => JSON.stringify(succeeds ? { version: '1.4.6', reloaded: true } : { error: 'activation version mismatch' }),
      })
      await action
      await until(() => states[0].status === 'ready')
      const nodes = draw()
      assert.equal(statusReads, 1)
      assert.ok(!nodes.some(node => node?.props?.className === 'ofm_prog'))
      assert.equal(nodes.find(node => node?.children?.includes('upgrade.check')).props.disabled, false)
      assert.equal(nodes.find(node => node?.children?.includes('reload.now')).props.disabled, false)
      assert.ok(nodes.includes(succeeds ? 'upgrade.doneRefresh' : 'upgrade.failed'))
    } finally {
      stateHook = undefined
      globalThis.fetch = originalFetch
    }
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
      internal: { loadCache: new Map() },
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
