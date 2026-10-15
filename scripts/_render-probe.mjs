/**
 * Mini-render probe: mounts the settings section with a stub React that has
 * just enough state to re-render after async data lands, and throws the moment
 * any plain object appears where React expects an element (production error
 * #31). This is the offline reproduction of the "blank settings page" class of
 * bugs — run it against any page by seeding localStorage's active tab.
 *
 * Run: node scripts/_render-probe.mjs [tabName]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const activeTab = process.argv[2] ?? 'gateway'

// ── fake backend: same-origin payloads the pages read ────────────────────────
const summary = {
  catalog: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', availability: 'available', vision: false, route: 'our-free-model', channel: undefined, contextWindow: 1000000, maxOutput: 32768, reasoning: true }],
  settings: { enabled: true, forward: { enabled: false, host: '127.0.0.1', port: 18899, lan: { enabled: false, port: 0 } }, egress: { enabled: false }, probeIntervalMinutes: 15, defaultMaxTokens: 32768, notifyOs: false, autoReloadWatch: false, updateCheckHours: 6, reloadCount: 0, reloadedAt: 0 },
  egress: { country: 'CN' }, outlet: { running: false }, probedAt: Date.now(),
  announcementVersion: 'x', version: '2.0.0', distribution: 'self',
  announcements: { unread: 0, fetchedAt: 0 },
  laneAvailable: true,
  eacAuth: { available: true, authorized: true, login: 'probe', required: true, lastCheck: Date.now() },
  channels: { state: 'ready', error: '' },
  update: { available: false, latest: '', current: '2.0.0', checkedAt: 0, applying: false, managed: false },
}
const routes = {
  '/summary': summary,
  '/stats': { requests: 0, requestFailures: 0, turns: 0, failedTurns: 0, days: [], models: [], samples: [], grand: { input: 0, output: 0, reasoning: 0, calls: 0, failed: 0 } },
  '/meta': { version: '2.0.0', reloadedAt: 0, reloadCount: 0, distribution: 'self', feed: { fetchedAt: 0, source: '', error: '' }, update: { available: false } },
  '/eac/status': summary.eacAuth,
  '/chan-gateway': { relay: { enabled: true, running: true, host: '127.0.0.1', port: 18326, hasKey: true, error: '' }, gateway: { port: 8326, enabledByEnv: true, keyFound: true, keyFromEnv: false, keyPath: 'x' } },
  '/announcement': { version: 'x', acknowledged: true },
  '/announcements': { items: [], unread: 0, fetchedAt: 0, notifyOs: false },
}
globalThis.fetch = url => {
  const path = String(url).replace(/^.*?\/api\/our-free-model/, '').split('?')[0]
  const payload = routes[path] ?? {}
  return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload })
}

// ── window/document stubs ────────────────────────────────────────────────────
globalThis.window = {
  __ModuleLoader__: { load: r => { globalThis.__registered = r } },
  localStorage: { getItem: () => activeTab, setItem: () => {} },
  dispatchEvent: () => {}, addEventListener: () => {}, open: () => {},
  confirm: () => true,
}
globalThis.document = {
  createElement: () => ({ setAttribute() {}, style: {}, remove() {}, appendChild() {}, addEventListener() {} }),
  head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} },
  querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
  execCommand: () => true, documentElement: { lang: 'zh' },
}
globalThis.Notification = undefined
globalThis.EventSource = class { addEventListener() {} close() {} }
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail } }
// `navigator` is a getter-only global in Node 21+; the factory only reads it.
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

// ── the stub React with stateful hooks ───────────────────────────────────────
let seq = 0
let dirty = false
let callKey = ''
let hookIdx = 0
const hookState = new Map()
const isEl = v => v !== null && typeof v === 'object' && v.__el === true

const stubReact = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity).filter(c => c !== undefined && c !== false && c !== true)
    for (const child of kids) {
      if (child !== null && typeof child === 'object' && !Array.isArray(child) && !isEl(child)) {
        throw new Error(`OBJECT CHILD in <${String(type)}>: ${JSON.stringify(child).slice(0, 180)}`)
      }
    }
    return { __el: true, id: seq += 1, type, props: props ?? {}, children: kids }
  },
  Fragment: 'fragment',
  useState(initial) {
    const key = `${callKey}#${hookIdx += 1}`
    if (!hookState.has(key)) hookState.set(key, typeof initial === 'function' ? initial() : initial)
    const set = value => {
      const prev = hookState.get(key)
      const next = typeof value === 'function' ? value(prev) : value
      if (JSON.stringify(next) !== JSON.stringify(prev)) { hookState.set(key, next); dirty = true }
    }
    return [hookState.get(key), set]
  },
  useRef: () => ({ current: null }),
  useMemo: factory => factory(),
  useCallback: fn => fn,
  Fragment: 'fragment',
  useEffect(fn) { void (async () => { try { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) } catch { /* effects must not break the probe */ } })() },
}

const cleanups = []
let renderPass = 0
const hooksPerPass = new Map()

/** Render one element, invoking function components with stable hook keys. */
function visit(el, path, out) {
  if (el === null || el === undefined || typeof el !== 'object' || !isEl(el)) return
  if (typeof el.type === 'function') {
    const key = `${el.type.name ?? 'anon'}@${path}`
    const savedKey = callKey
    const savedIdx = hookIdx
    callKey = key
    hookIdx = 0
    try {
      const inner = el.type({ ...el.props, children: el.children })
      visit(inner, `${path}/${el.type.name ?? 'anon'}`, out)
    } catch (error) {
      out.push(`THREW in ${key}: ${String(error).slice(0, 200)}`)
    }
    callKey = savedKey
    hookIdx = savedIdx
    return
  }
  for (const [index, child] of (el.children ?? []).entries()) visit(child, `${path}/${String(el.type)}[${index}]`, out)
}

// ── boot the bundle and mount the section ────────────────────────────────────
new Function('window', 'document', 'navigator', source)(globalThis.window, globalThis.document, globalThis.navigator)
const registered = globalThis.__registered
const exports = registered.factory(name => {
  if (name === 'react') return stubReact
  if (name === 'react-dom') return { createPortal: (children, container) => ({ __el: true, type: 'portal', props: { container }, children: [children] }) }
  throw new Error(`asked for ${name}`)
})

const sections = []
// The shell-side connection service, serving the channel-pack RPC with the same
// shapes the real host answers (structured address/apiKey, ledger trees...).
const rpcMethods = {
  'gateway.getEnabled': {
    enabled: true, running: true, blockedByEnv: false,
    address: { host: '127.0.0.1', port: 8326 },
    apiKey: { value: 'gw-key-abcdef', fromEnv: false, path: 'C:/x/api-key' },
    models: [{ provider: 'buddy', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
    modelsSource: 'catalog',
  },
  'provider.status': { statuses: { codearts: { models: { total: 9, disabled: 0 }, accounts: { total: 1, enabled: 1 }, closed: false } } },
  'account.list': { accounts: [{ id: 'codearts-1', provider: 'codearts', nickname: 'probe', enabled: true, refreshable: true, expiresAt: Date.now() + 86400000 }] },
  'model.list': { models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', disabled: false, dead: false }] },
  'usage.tokenLedger': {
    snapshot: {
      channels: [{ channel: 'direct', providers: [{ provider: 'codearts', accounts: [{ accountId: 'codearts-1', models: [{ model: 'deepseek-v4.1-flash', requests: 12, reportedRequests: 12, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 300, cacheWriteTokens: 0, reasoningTokens: 400, errors: 1, avgTtftMs: 320, avgTps: 41.5 }], totals: { requests: 12, reportedRequests: 12, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 300, cacheWriteTokens: 0, reasoningTokens: 400, errors: 1, avgTtftMs: 320, avgTps: 41.5 } }] }] }],
      totals: { requests: 12, reportedRequests: 12, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 300, cacheWriteTokens: 0, reasoningTokens: 400, errors: 1, avgTtftMs: 320, avgTps: 41.5 },
      entries: [
        { ts: Date.now() - 60000, channel: 'direct', provider: 'codearts', model: 'deepseek-v4.1-flash', accountId: 'codearts-1', usageReported: true, inputTokens: 120, outputTokens: 300, cacheReadTokens: 40, reasoningTokens: 50, ttftMs: 310, tps: 40.2, durationMs: 4200 },
        { ts: Date.now() - 120000, channel: 'gateway', provider: 'buddy', model: 'kimi-k3', accountId: '', usageReported: false, inputTokens: 0, outputTokens: 0, durationMs: 88, error: 'insufficient quota' },
      ],
    },
  },
  'usage.autoCheckin': { autoCheckin: { enabled: true, lastDate: '2026-10-06', ranToday: true, running: false, lastResult: 'ok', lastAt: Date.now(), channels: [{ provider: 'buddy', text: 'ok' }], dismissed: false } },
  'usage.tokenLedgerHistory': { history: [], totals: { requests: 120, reportedRequests: 118, inputTokens: 9000, outputTokens: 21000, cacheReadTokens: 4200, cacheWriteTokens: 0, reasoningTokens: 5000, errors: 3, avgTtftMs: 300, avgTps: 44 } },
}
const ctx = {
  locale: { register: () => {}, bind: () => key => (typeof key === 'string' ? key : String(key)) },
  effect: fn => { try { fn() } catch { /* degrade */ } return { [Symbol.dispose]() {} } },
  get: () => undefined,
  connection: {
    rpc: {
      call: (mount, endpoint, payload) => {
        if (mount !== '/api' || endpoint !== 'channel-pack') return Promise.resolve({ ok: false, error: { message: 'unknown endpoint' } })
        const value = rpcMethods[payload?.method]
        return value === undefined
          ? Promise.resolve({ ok: false, error: { code: 'no-handler', message: `probe has no stub for ${payload?.method}` } })
          : Promise.resolve({ ok: true, value })
      },
    },
  },
  slots: {
    inject: (name, register) => { if (name === 'settings.section') register() },
    register: (options, render) => sections.push({ options, render }),
  },
}
exports.apply(ctx)

const section = sections[0]
if (section === undefined) {
  console.log('PROBE: settings.section was never registered')
  process.exit(1)
}

const problems = []
;(async () => {
  for (renderPass = 0; renderPass < 6; renderPass += 1) {
    const out = []
    visit(section.render({ locale: 'zh', ctx, t: key => (typeof key === 'string' ? key : String(key)) }), 'root', out)
    problems.push(...out)
    await new Promise(resolve => setTimeout(resolve, 30))
    if (!dirty && renderPass >= 2) { renderPass += 1; break }
    dirty = false
  }
  if (problems.length === 0) console.log(`PROBE: ${renderPass} pass(es), no object children, no throws (tab=${activeTab})`)
  else for (const line of [...new Set(problems)].slice(0, 10)) console.log(`PROBE ${line}`)
  process.exit(problems.length === 0 ? 0 : 1)
})()
