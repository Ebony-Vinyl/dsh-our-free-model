/**
 * Renders the browser half in a real headless Chromium and photographs it.
 *
 * Every other suite in this repository reads `client.js` as text (client-lint) or
 * as a stub-React tree (the __test seams). Neither can see what a user sees: a
 * page that throws while rendering, a switch that is not reachable, a label
 * clipped by its own card, a long model id running off the panel, an animation
 * that leaves the element at `opacity: 0`. Those are only visible in a browser
 * with a layout engine, so this script boots the plugin exactly the way
 * `scripts/aggregate-wiring-test.mjs` does — fake kernel, scratch DSH_HOME, stub
 * free lane, a configured aggregate provider, two combos, the savers on, the
 * forward listener up — then serves the real `client.js` to Chromium behind a
 * minimal shell and takes one screenshot per tab.
 *
 * The shell is not a re-implementation of the app. It provides the four services
 * the bundle's `apply(ctx)` and its pages actually read — `slots`, `locale`,
 * `effect` and `connection.rpc` — over the plugin's own HTTP routes, which are
 * proxied straight into the captured `(req, res)` handler. The theme tokens come
 * from the installed `@deepseek-ai/dsh-client-ui-theme` package, so the preview is
 * painted with the same palette the real shell paints.
 *
 * React is the real thing: `react` + `react-dom/client` are bundled out of a
 * local install (see `moduleDirs`), not stubbed. When no install is present the
 * script says so and exits rather than photographing a fake tree.
 *
 * Screenshots land in `.verify/ui-preview/` (gitignored). The exit code is
 * non-zero when a tab throws, renders nothing, or paints a crash banner — a
 * silently blank page must never look like a pass.
 *
 * Local network only. Run: node scripts/ui-preview.mjs
 * Environment: OFM_PREVIEW_BROWSER (msedge|chrome), OFM_PREVIEW_MODULES (a
 * node_modules directory to resolve react/playwright from).
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { callRoute, chatFrames, fakeContext, freePort, stubUpstream, until } from './lib/fake-kernel.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = path.join(ROOT, '.verify', 'ui-preview')
const say = (...parts) => console.log('ui-preview:', ...parts)

/** A big, obviously-compressible tool result: a real `git diff` shape. */
const BIG_DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,40 +1,40 @@',
  ...Array.from({ length: 60 }, (_, i) => `-const removed${i} = ${i}`),
  ...Array.from({ length: 60 }, (_, i) => `+const added${i} = ${i}`),
  '',
].join('\n')

const TABS = ['free', 'eac', 'channels', 'aggregate', 'saver', 'routing', 'ledger', 'logs', 'gateway', 'upgrade', 'picks']

// ── module resolution ────────────────────────────────────────────────────────
/**
 * The `node_modules` directories a lookup may use, in the order they are tried.
 *
 * The preview needs two packages the plugin itself does not depend on: the real
 * React, and Playwright. Neither belongs in package.json — the first is provided
 * by the shell in production, the second is test tooling — so both are looked up
 * where a machine that can run this script already keeps them.
 */
function moduleDirs() {
  const dirs = [
    process.env.OFM_PREVIEW_MODULES,
    path.join(ROOT, 'node_modules'),
    path.join(ROOT, '..', 'node_modules'),
    path.join(ROOT, '..', '..', 'node_modules'),
  ].filter(value => typeof value === 'string' && value !== '')
  try {
    const global = execSync('npm root -g', { encoding: 'utf8', timeout: 20000 }).trim()
    if (global !== '') {
      dirs.push(global, path.join(global, '9router', 'node_modules'), path.join(global, '9router', 'app', 'node_modules'))
    }
  } catch { /* no npm on PATH; the explicit directories above still apply */ }
  return [...new Set(dirs)]
}

/** `require` rooted so that it resolves inside `dir` itself. */
function requireFrom(dirs, spec) {
  for (const dir of dirs) {
    try { return createRequire(path.join(dir, '..', 'preview-resolver.js'))(spec) } catch { /* keep looking */ }
  }
  return null
}

/** The first `dir` that really holds `file` under `pkg`. */
function findPackageFile(dirs, pkg, file) {
  for (const dir of dirs) {
    const candidate = path.join(dir, pkg, file)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The theme package, so the preview is painted with the shell's own palette.
 * Absent, a compact hand-written token set is used instead — the preview then
 * still renders, but with an approximation of the shell's colours.
 */
function themeCss(dirs) {
  const bundle = findPackageFile(dirs, path.join('@deepseek-ai', 'dsh-client-ui-theme', 'lib'), 'client.js')
    ?? findPackageFile(dirs, path.join('@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib'), 'client.js')
  if (bundle === null) return { css: FALLBACK_THEME, from: 'built-in fallback tokens (the theme package is not installed)' }
  const source = fs.readFileSync(bundle, 'utf8')
  const QUOTE = String.fromCharCode(34)
  const BACKSLASH = String.fromCharCode(92)
  /** Pull one `var <name> = "<js string literal>"` out of the theme bundle. */
  const grab = name => {
    const at = source.indexOf(`var ${name} = `)
    if (at < 0) return ''
    let index = source.indexOf(QUOTE, at) + 1
    let out = ''
    for (; index < source.length; index++) {
      const char = source[index]
      if (char === BACKSLASH) { out += char + source[index + 1]; index++; continue }
      if (char === QUOTE) break
      out += char
    }
    try { return JSON.parse(QUOTE + out + QUOTE) } catch { return '' }
  }
  const css = ['base_css_default', 'design_platform_css_default', 'corner_shape_css_default', 'scrollbar_css_default', 'focus_css_default']
    .map(grab).filter(part => part !== '').join('\n')
  if (css === '') return { css: FALLBACK_THEME, from: 'built-in fallback tokens (the theme bundle had no css block)' }
  return { css, from: bundle }
}

/** Palette + type scale, used only when the theme package is not installed. */
const FALLBACK_THEME = `
:root{--dsw-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-layer-3:#fff;--dsw-alias-bg-mask-1:#0000003d;--dsw-mask-blur:blur(2px);--dsw-alias-border-l1:#0000000a;--dsw-alias-border-l2:#0000001a;--dsw-alias-label-primary:#1b1b1c;--dsw-alias-label-secondary:#61666b;--dsw-alias-label-tertiary:#979da6;--dsw-alias-label-on-accent:#fff;--dsw-alias-state-business-primary:#4176e6;--dsw-alias-state-success-primary:#22c55e;--dsw-alias-state-warning-primary:#f0a441;--dsw-alias-state-error-primary:#ec1313}
body[data-ds-dark-theme]{--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#1b1b1c;--dsw-alias-bg-layer-2:#232324;--dsw-alias-bg-layer-3:#2c2c2e;--dsw-alias-border-l1:#ffffff14;--dsw-alias-border-l2:#ffffff24;--dsw-alias-label-primary:#f5f5f5;--dsw-alias-label-secondary:#adb2b8;--dsw-alias-label-tertiary:#81858c}
`

// ── the plugin, booted exactly as the wiring suite boots it ───────────────────
say('booting the host half through scripts/lib/fake-kernel.mjs')

const freeLane = await stubUpstream({
  listing: ['deepseek-v4-flash-free', 'mimo-v2.6-flash-free', 'kimi-k3-free'],
  answer: () => ({ body: chatFrames('answered by the free lane') }),
})
process.env.OUR_FREE_MODEL_BASE = freeLane.base
say(`free lane stub at ${freeLane.base}`)

// The aggregate providers' endpoint. Their keys are seeded, so their models reach
// the catalog without a call — but the settings still name a base URL, and an
// aggregate lane that pings it must not reach the internet from a preview run. A
// local listing stands in, which also makes 「测试」 and 「发现模型」 safe to click.
const aggregateRequests = []
const aggregateServer = http.createServer((req, res) => {
  const url = String(req.url ?? '')
  if (req.method === 'GET' && url.endsWith('/models')) {
    aggregateRequests.push({ path: url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'alpha-model' }, { id: 'beta-model' }] }))
    return
  }
  req.resume()
  req.on('end', () => {
    aggregateRequests.push({ path: url })
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }))
  })
})
await new Promise(resolve => aggregateServer.listen(0, '127.0.0.1', resolve))
aggregateServer.unref()
const aggregateBase = `http://127.0.0.1:${aggregateServer.address().port}`
say(`aggregate provider stub at ${aggregateBase}`)

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ui-preview-'))
process.env.DSH_HOME = home
const forwardPort = await freePort()
// The plugin fires a first announcement-feed poll 12 s after boot. Its shipped
// sources are GitHub URLs, and a `feedUrl` override is tried *before* them rather
// than instead of them — so pointing it at a dead port would still fall through to
// the internet. A local feed that answers on the first try is what keeps this run
// on the machine; the news section then renders two real cards in every pass.
const feedItems = [
  { id: 'ui-preview-1', title: '预览用公告：本机 feed', level: 'info', createdAt: new Date(Date.now() - 86_400_000).toISOString(), html: '<p>这一条来自 ui-preview 起的本地 feed，用来把「公告中心」渲染成有内容的状态。</p>' },
  { id: 'ui-preview-2', title: '预览用公告：更新提示', level: 'update', createdAt: new Date(Date.now() - 3_600_000).toISOString(), html: '<p>第二条，用来验证 <code>update</code> 级别的徽章与排版。</p>', link: { url: 'https://example.invalid/notes', label: '说明' } },
]
let feedRequests = 0
const feedServer = http.createServer((req, res) => {
  if (String(req.url ?? '').startsWith('/feed.json')) {
    feedRequests += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ fetchedAt: Date.now(), source: 'ui-preview', announcements: feedItems }))
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise(resolve => feedServer.listen(0, '127.0.0.1', resolve))
feedServer.unref()
const feedPort = feedServer.address().port
const dataDir = path.join(home, 'our-free-model')
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  enabled: true,
  probeIntervalMinutes: 15,
  // Nothing in this run may leave the machine: the release check is off outright,
  // and the feed is pointed at a dead loopback port (see `feedPort` above).
  updateCheckHours: 0,
  feedUrl: `http://127.0.0.1:${feedPort}/feed.json`,
  forward: { enabled: true, host: '127.0.0.1', port: forwardPort, lan: { enabled: false, port: 0 } },
  // Both savers on, at levels that are not the shipped default ('off' for the
  // prompt families) — the segmented picker has to show a real selection.
  tokenSaver: { enabled: true, rtk: true, prompts: { caveman: 'wenyan', ponytail: 'lite' } },
  aggregate: {
    enabled: true,
    providers: {
      // The headline case: a key (masked to its last four), an override base URL,
      // several models, a persisted listing probe and discovered ids.
      open_router: {
        enabled: true,
        apiKey: 'sk-or-v1-0000000000000000000000000000000000000000000000000000f1a2',
        baseUrl: aggregateBase,
        models: ['deepseek/deepseek-v4-pro', 'qwen/qwen3-coder-480b-a35b-instruct', 'meta-llama/llama-3.3-70b-instruct:free'],
        discovered: ['deepseek/deepseek-v4-pro', 'qwen/qwen3-coder-480b-a35b-instruct', 'meta-llama/llama-3.3-70b-instruct:free', 'google/gemini-3.0-flash-exp:free'],
        lastTest: { at: Date.now() - 95_000, ok: true, status: 200, message: 'listing answered: 4 models' },
        addedAt: Date.now() - 86_400_000,
      },
      // Disabled, keyed, and holding a rejected probe: the failed verdict and the
      // disabled badge, in one card.
      cerebras: {
        enabled: false,
        apiKey: 'csk-ui-preview-0000000000000000000000000000000000000000000000000000b7e4',
        baseUrl: aggregateBase,
        models: ['gpt-oss-120b'],
        lastTest: { at: Date.now() - 3_600_000, ok: false, status: 401, message: 'invalid api key' },
        addedAt: Date.now() - 172_800_000,
      },
      // A local provider: no key, a base URL of its own, and no probe yet.
      ollama: {
        enabled: true,
        apiKey: '',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: ['qwen3-coder:30b'],
        lastTest: null,
        addedAt: Date.now() - 600_000,
      },
    },
  },
  combos: [
    {
      id: 'combo:never-fails',
      name: 'Never Fails',
      models: ['open_router/deepseek/deepseek-v4-pro', 'deepseek-v4-flash-free'],
      strategy: 'fallback',
      stickyLimit: 1,
      enabled: true,
    },
    {
      // Every link names a model this host has no lane for, which is the state the
      // card must show as *kept, not broken*.
      id: 'combo:night-shift',
      name: 'Night Shift (EAC ladder, closed today)',
      models: ['eac/gpt-5.4-codex', 'kilo/qwen3-coder-480b-a35b-instruct'],
      strategy: 'round-robin',
      stickyLimit: 2,
      enabled: true,
    },
  ],
}, null, 2))

// The recommendation page asks GitHub for star counts. Point that at a local
// stub, for the same reason the feed is pointed at one: a screenshot run reads
// nothing from the internet, and the page still gets numbers to render.
const pickStub = http.createServer((req, res) => {
  const repo = String(req.url ?? '').replace(/^\/repos\//, '')
  const counts = {
    'Ebony-Vinyl/EAC-Desktop': { stargazers_count: 2036, forks_count: 74, pushed_at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    'Ebony-Vinyl/EAC-Pack': { stargazers_count: 47, forks_count: 1, pushed_at: new Date(Date.now() - 7 * 86_400_000).toISOString() },
  }
  res.writeHead(counts[repo] === undefined ? 404 : 200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(counts[repo] ?? { message: 'Not Found' }))
})
await new Promise(resolve => pickStub.listen(0, '127.0.0.1', resolve))
pickStub.unref()
process.env.OFM_PICKS_API_BASE = `http://127.0.0.1:${pickStub.address().port}`
say(`pick-stats stub at ${process.env.OFM_PICKS_API_BASE}`)

const { apply, inject } = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'timer', 'connection', 'attachments'], onRegister: route => routes.push(route) })
apply(ctx, {})
const api = () => routes.find(route => route.kind === 'prefix')?.handler
await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
say(`plugin booted; DSH_HOME ${home}`)

// ── one real turn, so /stats carries a non-zero savings measurement ───────────
{
  // The boot probe round has to land first: the adapter resolves a model id
  // through the catalog the probe builds, so a turn sent before it lands fails to
  // resolve rather than answering.
  await until(async () => (await callRoute(api(), 'GET', '/api/our-free-model/summary')).json?.catalog?.some(row => row.id === 'deepseek-v4-flash-free'),
    { what: 'the boot listing round', timeoutMs: 30000 })
  const adapter = ctx.__captured.adapters[0]?.adapter
  const options = {
    provider: 'our-free-model',
    model: 'deepseek-v4-flash-free',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'what changed?' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"git diff"}' }] },
      { role: 'tool', content: [{ type: 'text', text: BIG_DIFF }], toolCallId: 'call_1', source: { kind: 'tool', callId: 'call_1' } },
    ],
    sessionId: 'ui-preview:saver',
  }
  const chunks = []
  for await (const chunk of adapter.stream(options, null, undefined)) chunks.push(chunk)
  const answer = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  if (!answer.includes('answered by the free lane')) {
    throw new Error(`the adapter turn did not answer through the stub free lane — ${JSON.stringify(chunks).slice(0, 600)}`)
  }
  await until(() => freeLane.requests.length > 0, { what: 'the upstream request', timeoutMs: 5000 })
}
await until(async () => {
  const stats = (await callRoute(api(), 'GET', '/api/our-free-model/stats')).json
  return Number(stats?.savings?.saved) > 0
}, { what: 'a non-zero savings measurement', timeoutMs: 15000 })

const statsView = (await callRoute(api(), 'GET', '/api/our-free-model/stats')).json
say(`savings: ${JSON.stringify(statsView.savings)}`)
await until(async () => (await callRoute(api(), 'GET', '/api/our-free-model/clients')).json?.running === true,
  { what: 'the forward listener to be up', timeoutMs: 30000 })
// The first feed poll lands 12 s after boot. Waiting for it here is what makes the
// news section identical in every pass, and the report below is what proves the run
// read the local copy instead of falling through to the shipped GitHub sources.
await until(async () => (await callRoute(api(), 'GET', '/api/our-free-model/announcements')).json?.fetchedAt > 0,
  { what: 'the first feed poll', timeoutMs: 30000 })
const feedView = (await callRoute(api(), 'GET', '/api/our-free-model/announcements')).json
say(`feed: ${(feedView.items ?? []).length} item(s) from "${feedView.source}" — local feed server answered ${feedRequests} request(s)${feedView.error ? `, error ${feedView.error}` : ''}`)
const summaryView = (await callRoute(api(), 'GET', '/api/our-free-model/summary')).json
say(`forward listener: running=${summaryView.settings.forward.running} port=${summaryView.settings.forward.actualPort}`)
say(`catalog: ${summaryView.catalog.length} rows (free ${summaryView.catalog.filter(row => row.channel === undefined || row.channel === null).length}, aggregate ${summaryView.catalog.filter(row => row.channel === 'aggregate').length}, combo ${summaryView.catalog.filter(row => row.channel === 'combo').length})`)

// ── the preview server ───────────────────────────────────────────────────────
const dirs = moduleDirs()
const reactFile = findPackageFile(dirs, 'react', path.join('cjs', 'react.production.js'))
const reactDomFile = findPackageFile(dirs, 'react-dom', path.join('cjs', 'react-dom-client.production.js'))
const reactDomLegacyFile = findPackageFile(dirs, 'react-dom', path.join('cjs', 'react-dom.production.js'))
const schedulerFile = findPackageFile(dirs, 'scheduler', path.join('cjs', 'scheduler.production.js'))
if (reactFile === null || reactDomFile === null || reactDomLegacyFile === null || schedulerFile === null) {
  say('FAIL: no local react/react-dom/scheduler install was found.')
  say(`  looked in: ${dirs.join(', ')}`)
  say('  point OFM_PREVIEW_MODULES at a node_modules directory that holds all three, then re-run.')
  process.exit(2)
}
const reactVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(reactFile)), 'package.json'), 'utf8')).version
say(`react ${reactVersion} + react-dom/client, bundled from ${path.dirname(path.dirname(reactFile))}`)

/**
 * Wrap the four CommonJS builds the browser needs into one bundle.
 *
 * `react-dom-client.production.js` requires `scheduler`, `react` and `react-dom`
 * at its top level, so all four are bundled and the tiny `require` here resolves
 * exactly those ids — an unknown one is a hard error rather than an empty object
 * that would fail later, somewhere less obvious.
 */
function bundleReact() {
  const parts = ['(function(){', 'var __m={};var __c={};']
  const modules = [
    ['react', reactFile],
    ['react-dom', reactDomLegacyFile],
    ['react-dom/client', reactDomFile],
    ['scheduler', schedulerFile],
  ]
  for (const [id, file] of modules) {
    parts.push(`__m[${JSON.stringify(id)}]=function(module,exports,require,process,global){`)
    parts.push(fs.readFileSync(file, 'utf8'))
    parts.push('\n};')
  }
  parts.push('function __r(id){if(__m[id]===undefined)throw new Error("the preview react bundle has no module \\""+id+"\\"");if(__c[id])return __c[id].exports;var m={exports:{}};__c[id]=m;__m[id].call(m.exports,m,m.exports,__r,{env:{NODE_ENV:"production"}},globalThis);return m.exports}')
  parts.push('window.__previewReact=__r("react");window.__previewReactDOMClient=__r("react-dom/client");')
  parts.push('})();')
  return parts.join('\n')
}

const theme = themeCss(dirs)
say(`theme: ${theme.from}`)

const previewPort = await freePort()
const shell = shellHtml({ theme: theme.css })

const server = http.createServer((req, res) => {
  void handle(req, res).catch(error => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`preview server: ${String(error?.message ?? error)}`)
  })
})

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${previewPort}`)
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }
  if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', shell)
  if (url.pathname === '/vendor/react.js') return send(200, 'text/javascript; charset=utf-8', bundleReact())
  // The plugin's own bundle, read per request so an edit shows up on reload.
  if (url.pathname === '/client.js') return send(200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'))
  // The push stream. The plugin registers it as its own exact route (not part of
  // the prefix handler below), so the shell answers it: an EventSource that never
  // opens would leave the bundle reconnecting in the background for the whole run.
  if (url.pathname === '/api/our-free-model/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(`event: hello\ndata: ${JSON.stringify({ version: 'preview', announcements: { unread: 0 }, update: { available: false }, reloadedAt: 0 })}\n\n`)
    req.on('close', () => res.end())
    return
  }
  if (url.pathname.startsWith('/api/our-free-model')) {
    const handler = api()
    if (handler === undefined) return send(503, 'application/json; charset=utf-8', '{"error":"the plugin route is not up yet"}')
    // Adapt the real request into the (req, res) pair the handler was written
    // against: an async-iterable body, `writeHead` and `end`.
    const body = await readBody(req)
    const fakeReq = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      [Symbol.asyncIterator]: async function * iterate() { if (body.length > 0) yield body },
    }
    let ended = false
    const fakeRes = {
      writeHead(code, headers) { res.writeHead(code, headers); return fakeRes },
      write(chunk) { return res.write(chunk) },
      end(text) { ended = true; res.end(text) },
      get headersSent() { return res.headersSent },
      get writableEnded() { return ended },
    }
    await handler(fakeReq, fakeRes)
    return
  }
  return send(404, 'text/plain; charset=utf-8', 'not found')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

await new Promise(resolve => server.listen(previewPort, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${previewPort}`
say(`preview server on ${origin}`)

// ── the browser ──────────────────────────────────────────────────────────────
const playwright = requireFrom(dirs, 'playwright')
if (playwright === null) {
  say('FAIL: playwright was not found in any of the directories above; cannot drive a browser.')
  server.close()
  process.exit(2)
}

async function launch(pw) {
  const wanted = process.env.OFM_PREVIEW_BROWSER
  const channels = wanted === undefined ? ['msedge', 'chrome'] : [wanted]
  const failures = []
  for (const channel of channels) {
    try { return await pw.chromium.launch({ channel, headless: true }) } catch (error) { failures.push(`${channel}: ${error?.message ?? error}`) }
  }
  try { return await pw.chromium.launch({ headless: true }) } catch (error) { failures.push(`bundled: ${error?.message ?? error}`) }
  throw new Error(`no chromium could be launched —\n  ${failures.join('\n  ')}`)
}

const browser = await launch(playwright)
say(`chromium: ${browser.browserType().name()} ${browser.version()}`)

fs.mkdirSync(OUT_DIR, { recursive: true })
const report = []
const problems = []

/**
 * One page: load the shell, wait for the tab strip, then click through the shots.
 * The variant carries the width, the palette and the language, so the wide, the
 * narrow, the dark and the English passes share one implementation.
 */
async function shoot({ variant, width, height, scale, dark = false, locale = 'zh', shots }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: dark ? 'dark' : 'light' })
  const page = await context.newPage()
  let pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error?.message ?? error)))
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`) })
  await page.goto(`${origin}/?locale=${locale}${dark ? '&theme=dark' : ''}`, { waitUntil: 'load' })
  try {
    await page.waitForSelector('.ofm_tabs .ofm_tab', { timeout: 15000 })
  } catch (error) {
    // A shell that never mounts is the one failure a screenshot cannot explain, so
    // say what the page actually holds before giving up.
    const diagnostic = await page.evaluate(() => ({
      crash: document.getElementById('crash')?.textContent ?? '',
      root: document.getElementById('root')?.innerHTML.slice(0, 800) ?? '',
    }))
    await page.screenshot({ path: path.join(OUT_DIR, '00-shell.png'), fullPage: true })
    say(`the shell never rendered a tab strip (${variant}) — crash banner: ${diagnostic.crash.slice(0, 500) || '(empty)'}`)
    say(`#root holds: ${diagnostic.root.slice(0, 500) || '(nothing)'}`)
    throw error
  }
  const labels = await page.$$eval('.ofm_tabs .ofm_tab', nodes => nodes.map(node => node.textContent.replace(/\s+/g, ' ').trim()))
  if (labels.length !== TABS.length) problems.push(`${variant}: the tab strip has ${labels.length} tabs, expected ${TABS.length} (${labels.join(' | ')})`)

  for (const entry of shots) {
    // One shot failing (a control that never appeared, a selector that matches
    // nothing) must not cost the rest of the run its screenshots.
    try {
      if (entry.tab !== undefined) {
        await page.click(`.ofm_tabs .ofm_tab >> nth=${TABS.indexOf(entry.tab)}`)
        await waitForSettled(page)
      }
      if (entry.before !== undefined) {
        await entry.before(page)
        await waitForSettled(page)
      }
      // Past the 220 ms card rise and the 550 ms meter, so the screenshot shows the
      // state the page settles in rather than a frame in the middle of an animation.
      await page.waitForTimeout(900)
    } catch (error) {
      problems.push(`${variant}/${entry.file}: the shot could not be driven — ${String(error?.message ?? error).split('\n')[0]}`)
      say(`[${variant}] ${entry.tab ?? entry.label} — could not be driven: ${String(error?.message ?? error).split('\n')[0]}`)
      continue
    }
    const measured = await measure(page)
    if (entry.selector === undefined) await page.screenshot({ path: path.join(OUT_DIR, entry.file), fullPage: true })
    else await page.locator(entry.selector).first().screenshot({ path: path.join(OUT_DIR, entry.file) })
    const line = {
      variant, file: entry.file, tab: entry.tab ?? entry.label ?? '—',
      crashed: measured.crashed, pageChars: measured.pageChars, rootChars: measured.rootChars,
      horizontalScroll: measured.horizontalScroll, escapes: measured.escapes, ellipsis: measured.ellipsis,
      invisible: measured.invisible, skeletons: measured.skeletons, meterWidth: measured.meterWidth,
      gliderWidth: measured.gliderWidth, truncated: measured.truncated, invisibleText: measured.invisibleText,
      escapeList: measured.escapeList, pageErrors: pageErrors.slice(), crashText: measured.crashText,
    }
    report.push(line)
    printLine(line)
    if (process.env.OFM_PREVIEW_AUDIT === '1') await audit(page, `${variant}/${entry.file}`)
    if (measured.crashed) problems.push(`${variant}/${entry.file}: the page painted a crash banner — ${measured.crashText}`)
    if (entry.tab !== undefined && measured.pageChars === 0) problems.push(`${variant}/${entry.file}: the tab rendered no visible text at all`)
    if (measured.horizontalScroll) problems.push(`${variant}/${entry.file}: the document scrolls horizontally (${measured.scrollWidth} > ${measured.viewportWidth})`)
    pageErrors = []
  }
  await context.close()
  return labels
}

/** Wait until the page stops growing and no skeleton is left, or give up. */
async function waitForSettled(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  let last = -1
  let stable = 0
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => {
      const root = document.querySelector('.ofm_root')
      const body = document.querySelector('.ofm_page')
      return {
        page: body === null ? -1 : body.innerText.replace(/\s+/g, ' ').trim().length,
        skeletons: document.querySelectorAll('.ofm_skel').length,
        crashed: document.querySelector('#crash[data-on]') !== null,
      }
    })
    if (snapshot.crashed) return
    if (snapshot.page > 0 && snapshot.page === last && snapshot.skeletons === 0) {
      stable += 1
      if (stable >= 3) return
    } else stable = 0
    last = snapshot.page
    await page.waitForTimeout(160)
  }
}

/**
 * What the screenshot cannot be trusted to tell me by eye: whether the page is
 * blank, whether anything escapes its box, whether a label is cut off, whether an
 * animation left an element invisible, and whether the tab glider and the savings
 * meter actually moved.
 */
async function measure(page) {
  return await page.evaluate(() => {
    const root = document.querySelector('.ofm_root')
    const body = document.querySelector('.ofm_page')
    const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()
    const truncated = []
    const invisibleText = []
    const escapeList = []
    let ellipsis = 0
    if (root !== null) {
      for (const node of root.querySelectorAll('*')) {
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const own = [...node.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent.trim()).join(' ')
        const cls = String(node.getAttribute('class') ?? '')
        if (own !== '' && Number(style.opacity) === 0) invisibleText.push({ cls, text: clean(own).slice(0, 40) })
        if (own !== '' && style.textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth + 1) {
          ellipsis += 1
          truncated.push({ cls, text: clean(own).slice(0, 60) })
        }
        if (style.overflowX === 'visible' && node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) {
          escapeList.push({ cls, text: clean(node.textContent).slice(0, 50) })
        }
      }
    }
    const meter = root === null ? null : root.querySelector('.ofm_meter i')
    const glider = root === null ? null : root.querySelector('.ofm_tabglider')
    const crash = document.getElementById('crash')
    return {
      pageChars: body === null ? 0 : clean(body.innerText).length,
      rootChars: root === null ? 0 : clean(root.innerText).length,
      skeletons: document.querySelectorAll('.ofm_skel').length,
      crashed: crash !== null && crash.dataset.on === '1',
      crashText: crash === null ? '' : clean(crash.textContent).slice(0, 300),
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      escapes: escapeList.length,
      escapeList: escapeList.slice(0, 6),
      ellipsis,
      truncated: truncated.slice(0, 8),
      invisible: invisibleText.length,
      invisibleText: invisibleText.slice(0, 8),
      meterWidth: meter === null ? null : Math.round(meter.getBoundingClientRect().width * 10) / 10,
      gliderWidth: glider === null ? null : Math.round(glider.getBoundingClientRect().width * 10) / 10,
    }
  })
}

/**
 * On demand (`OFM_PREVIEW_AUDIT=1`): name the elements that escape their parent's
 * content box, deepest first.
 *
 * `scrollWidth > clientWidth` on a wrapper says only that *something* inside it is
 * too wide; it does not say what. This walks the tree and reports the element
 * whose own right edge passes its parent's padding box, which is the one to fix.
 */
async function audit(page, label) {
  const rows = await page.evaluate(() => {
    const root = document.querySelector('.ofm_root')
    if (root === null) return []
    const out = []
    for (const node of root.querySelectorAll('*')) {
      const parent = node.parentElement
      if (parent === null) continue
      const rect = node.getBoundingClientRect()
      if (rect.width === 0) continue
      const parentStyle = getComputedStyle(parent)
      const parentRect = parent.getBoundingClientRect()
      const limit = parentRect.right - Number.parseFloat(parentStyle.paddingRight || '0')
      const over = rect.right - limit
      if (over > 1) {
        out.push({
          cls: String(node.getAttribute('class') ?? node.tagName.toLowerCase()),
          over: Math.round(over * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          parentCls: String(parent.getAttribute('class') ?? parent.tagName.toLowerCase()),
          parentWidth: Math.round(parentRect.width * 10) / 10,
          text: String(node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
        })
      }
    }
    return out.sort((a, b) => b.over - a.over).slice(0, 10)
  })
  if (rows.length === 0) return
  say(`  audit ${label}: ${rows.length} element(s) pass their parent's right edge`)
  for (const row of rows) {
    say(`    +${row.over}px  .${row.cls} (${row.width}px) inside .${row.parentCls} (${row.parentWidth}px) “${row.text}”`)
  }
}

function printLine(line) {  const parts = [
    `[${line.variant}] ${String(line.tab).padEnd(10)}`,
    `render=${line.crashed ? 'CRASH' : 'ok'}`,
    `chars=${String(line.pageChars).padStart(5)}`,
    `hscroll=${line.horizontalScroll ? 'YES' : 'no'}`,
    `escapes=${line.escapes}`,
    `ellipsis=${line.ellipsis}`,
    `invisible=${line.invisible}`,
    `skel=${line.skeletons}`,
    line.meterWidth === null ? '' : `meter=${line.meterWidth}px`,
    line.gliderWidth === null || line.gliderWidth === 0 ? '' : `glider=${line.gliderWidth}px`,
    `→ ${line.file}`,
  ]
  say(parts.filter(part => part !== '').join(' '))
  for (const row of line.truncated) say(`        ellipsis: .${row.cls} “${row.text}”`)
  for (const row of line.invisibleText) say(`        opacity:0: .${row.cls} “${row.text}”`)
  for (const row of line.escapeList) say(`        escapes:  .${row.cls} “${row.text}”`)
  for (const error of line.pageErrors) say(`        page error: ${error.slice(0, 200)}`)
  if (line.crashed) say(`        crash: ${line.crashText}`)
}

// The eleven tabs, in tab order, at a desktop width.
const numbered = TABS.map((tab, index) => ({ tab, file: `${String(index + 1).padStart(2, '0')}-${tab}.png` }))
const labels = await shoot({ variant: 'wide', width: 1280, height: 900, scale: 1, shots: numbered })
say(`tab strip: ${labels.join(' | ')}`)

// The real settings panel is ~420 px wide, so the three new pages get that width
// on their own — a wide shot cannot show a control that only breaks when it has
// to wrap.
await shoot({
  variant: 'narrow', width: 420, height: 820, scale: 2,
  shots: [
    { tab: 'aggregate', file: 'aggregate-narrow.png' },
    { tab: 'saver', file: 'saver-narrow.png' },
    { tab: 'routing', file: 'routing-narrow.png' },
    { tab: 'gateway', file: 'gateway-narrow.png' },
  ],
})

// The two overlays the new pages open, and the sections they live in, close up.
await shoot({
  variant: 'open', width: 1280, height: 900, scale: 2,
  shots: [
    {
      tab: 'aggregate', label: 'aggregate+picker', file: 'aggregate-picker.png',
      before: async page => { await page.getByRole('button', { name: '添加提供商', exact: true }).click() },
    },
    {
      tab: 'routing', label: 'routing+editor', file: 'routing-editor.png',
      before: async page => { await page.getByRole('button', { name: '编辑', exact: true }).first().click() },
    },
    {
      tab: 'routing', label: 'routing+editor+picker', file: 'routing-editor-picker.png',
      before: async page => {
        await page.getByRole('button', { name: '编辑', exact: true }).first().click()
        await page.getByRole('button', { name: '添加成员', exact: true }).first().click()
      },
    },
  ],
})

// Close-ups of the sections that carry the new controls.
await shoot({
  variant: 'detail', width: 1280, height: 900, scale: 2,
  shots: [
    { tab: 'aggregate', label: 'aggregate cards', file: 'aggregate-cards.png', selector: '.ofm_sec >> nth=0' },
    { tab: 'saver', label: 'saver prompt savers', file: 'saver-savers.png', selector: '.ofm_sec >> nth=1' },
    { tab: 'routing', label: 'routing chains', file: 'routing-cards.png', selector: '.ofm_sec >> nth=0' },
    { tab: 'gateway', label: 'gateway clients', file: 'gateway-clients.png', selector: '.ofm_sec >> nth=2' },
  ],
})

// The palette switch: the stylesheet promises the page survives it. The free tab
// is here because its switches are the same component the new pages use — a
// scheme problem in one is a scheme problem in all of them.
await shoot({
  variant: 'dark', width: 1280, height: 900, scale: 1, dark: true,
  shots: [
    { tab: 'free', file: 'free-dark.png' },
    { tab: 'aggregate', file: 'aggregate-dark.png' },
    { tab: 'saver', file: 'saver-dark.png' },
    { tab: 'routing', file: 'routing-dark.png' },
    { tab: 'picks', file: 'picks-dark.png' },
  ],
})

// The English copy is longer than the Chinese on nearly every label, which is
// where a nowrap or a fixed-width box gives itself away.
await shoot({
  variant: 'en', width: 420, height: 820, scale: 2, locale: 'en',
  shots: [
    { tab: 'aggregate', file: 'en-aggregate-narrow.png' },
    { tab: 'saver', file: 'en-saver-narrow.png' },
    { tab: 'routing', file: 'en-routing-narrow.png' },
    { tab: 'picks', file: 'en-picks-narrow.png' },
  ],
})

// A control that writes: the saver's RTK switch POSTs, and the page must show the
// answer the host stored rather than the click. It is clicked back afterwards, so
// the run leaves the settings file as it found them.
await interactionPass()

/** Click one switch, look at what it becomes, and put it back. */
async function interactionPass() {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error?.message ?? error)))
  await page.goto(`${origin}/?locale=zh`, { waitUntil: 'load' })
  await page.waitForSelector('.ofm_tabs .ofm_tab', { timeout: 15000 })
  await page.click(`.ofm_tabs .ofm_tab >> nth=${TABS.indexOf('saver')}`)
  await waitForSettled(page)
  const rtk = page.locator('.ofm_sec').nth(2).locator('.ofm_switch').first()
  const read = async () => await rtk.getAttribute('aria-checked')
  const before = await read()
  await rtk.click()
  await until(async () => await read() !== before, { what: 'the switch to take the host\'s answer', timeoutMs: 15000 })
  await page.waitForTimeout(700)
  const after = await read()
  await page.locator('.ofm_sec').nth(2).screenshot({ path: path.join(OUT_DIR, 'saver-switch-toggled.png') })
  say(`[interaction] saver RTK switch: aria-checked ${before} → ${after} after one click (POST /token-saver answered and re-rendered)`)
  await rtk.click()
  await until(async () => await read() === before, { what: 'the switch to return', timeoutMs: 15000 })
  say(`[interaction] restored to ${before}`)
  if (after === before) problems.push('interaction: the RTK switch did not change state after a click')
  for (const error of errors) problems.push(`interaction: page error — ${error.slice(0, 160)}`)
  await context.close()
}

// ── wrap up ──────────────────────────────────────────────────────────────────
await browser.close()
server.close()
for (const dispose of ctx.__disposers ?? []) { try { dispose() } catch { /* teardown is best effort */ } }
freeLane.close()
feedServer.close()
aggregateServer.close()
fs.rmSync(home, { recursive: true, force: true })

say('')
say(`${report.length} screenshots in ${OUT_DIR}`)
if (problems.length === 0) {
  say('no blank pages, no crash banners, no horizontal scrolling.')
} else {
  say(`${problems.length} problem(s) a user would notice:`)
  for (const problem of problems) say(`  - ${problem}`)
}
process.exit(problems.length === 0 ? 0 : 1)

// ── the shell page ───────────────────────────────────────────────────────────
/**
 * The page Chromium loads. It is a shell, not a stand-in for the app: it defines
 * `window.__ModuleLoader__`, hands the bundle a real React and a `require` that
 * only knows `react`, calls `apply(ctx)` with the services the bundle reads, and
 * mounts the `settings.section` component the bundle registered. Anything the
 * bundle throws on the way lands in the red banner at the top of the page.
 */
function shellHtml({ theme }) {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Our Free Model — browser preview</title>
<style>
${theme}
html,body{min-height:100%}
body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px}
#root{padding:16px 18px 40px;max-width:1200px;margin:0 auto}
#crash{position:sticky;top:0;z-index:9999;margin:0;padding:12px 16px;font:600 12.5px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;background:#7f1d1d;color:#fff}
#crash[hidden]{display:none}
</style>
</head>
<body>
<pre id="crash" hidden></pre>
<div id="root"></div>
<script>
window.__crash = message => {
  const box = document.getElementById('crash')
  box.hidden = false
  box.dataset.on = '1'
  box.textContent = String(message).slice(0, 4000)
}
window.addEventListener('error', event => window.__crash('window error: ' + (event.message ?? '')))
window.addEventListener('unhandledrejection', event => window.__crash('unhandled rejection: ' + (event.reason?.message ?? event.reason)))
window.__ModuleLoader__ = {
  load: record => {
    try {
      window.__plugin = record.factory(name => {
        if (name === 'react') return window.__previewReact
        if (name === 'react-dom') return window.__previewReactDOMClient
        if (name === 'react-dom/client') return window.__previewReactDOMClient
        throw new Error('the preview shell provides no module "' + name + '"')
      })
    } catch (error) { window.__crash('factory: ' + (error && error.message)) }
  },
}
</script>
<script src="/vendor/react.js"></script>
<script src="/client.js"></script>
<script>
(() => {
  const React = window.__previewReact
  const ReactDOM = window.__previewReactDOMClient
  if (React === undefined || ReactDOM === undefined) { window.__crash('the react bundle did not load'); return }

  const params = new URLSearchParams(location.search)
  let active = params.get('locale') === 'en' ? 'en' : 'zh'
  if (params.get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
  document.documentElement.lang = active

  // ── locale: real lookups against the dictionaries the bundle registers ──────
  const dictionaries = {}
  const locale = {
    bind: ns => {
      const t = key => {
        const table = dictionaries[ns] ?? {}
        const dict = table[active] ?? table.zh ?? {}
        // The shell shows the raw key when a lookup misses, which is how a missing
        // translation becomes visible instead of silently blank.
        return dict[key] ?? key
      }
      Object.defineProperty(t, 'locale', { get: () => active })
      return t
    },
    register: (ns, table) => { dictionaries[ns] = table; return () => { delete dictionaries[ns] } },
    getLocale: () => ({ active }),
    getSnapshot: () => ({ active }),
  }

  // ── slots: record both registrations, render the section one ───────────────
  const registrations = { section: [], onboarding: [] }
  const slots = {
    inject: (name, callback) => { callback(); return { [Symbol.dispose]() {} } },
    register: (options, component) => {
      const bucket = options.name === 'settings.onboarding' ? registrations.onboarding : registrations.section
      bucket.push({ options, component })
      return () => {}
    },
  }

  // ── connection.rpc: the pack's methods, answered well-formed and empty ─────
  // This preview runs the plugin's own host half, not the absorbed channel pack,
  // so every \`channel-pack\` method answers the shape its page expects with no
  // rows in it — the pages then render their real empty states instead of the
  // "no connection" callout.
  // The pack's ledger, in the tree the three console pages read
  // (channel → provider → account → models, plus a ring of individual requests
  // keyed by \`ts\`). Small, but the same shape the real pack serves.
  const accountTotals = { requests: 12, reportedRequests: 12, inputTokens: 18400, outputTokens: 2100, reasoningTokens: 640, cacheReadTokens: 4800, cacheWriteTokens: 0, errors: 0, ttftMs: 410, tps: 62.4 }
  const modelTotals = { model: 'deepseek-v4-flash-free', requests: 12, inputTokens: 18400, outputTokens: 2100, reasoningTokens: 640, cacheReadTokens: 4800, cacheWriteTokens: 0, errors: 0, ttftMs: 410, tps: 62.4 }
  const ledgerSnapshot = {
    channels: [{
      channel: 'deepseek',
      providers: [{
        provider: 'deepseek',
        accounts: [{ accountId: 'preview@example.com', totals: accountTotals, models: [modelTotals] }],
      }],
    }],
    totals: accountTotals,
    entries: [
      { ts: Date.now() - 240000, channel: 'direct', provider: 'deepseek', model: 'deepseek-v4-flash-free', accountId: 'preview@example.com', durationMs: 1820, ttftMs: 380, tps: 71.2, inputTokens: 1240, outputTokens: 180, reasoningTokens: 96, cacheReadTokens: 640, cacheWriteTokens: 0 },
      { ts: Date.now() - 610000, channel: 'direct', provider: 'deepseek', model: 'deepseek-v4-flash-free', accountId: 'preview@example.com', durationMs: 1540, ttftMs: 420, tps: 58.9, inputTokens: 980, outputTokens: 140, reasoningTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
  }
  const rpcAnswers = {
    'usage.autoCheckin': { autoCheckin: null },
    'provider.status': { statuses: {} },
    'account.list': { accounts: [] },
    'model.list': { models: [] },
    'credits.status': { accounts: [] },
    'credits.balances': { accounts: [] },
    'usage.tokenLedger': { snapshot: ledgerSnapshot },
    'usage.tokenLedgerHistory': { history: [], totals: {} },
    // The pack's gateway is not running in this composition; a stopped, keyless
    // reading is the honest answer and still exercises the whole panel.
    'gateway.getEnabled': { enabled: false, running: false, blockedByEnv: false, address: null, apiKey: null, models: [] },
    'gateway.setEnabled': { enabled: false, running: false, blockedByEnv: false, address: null, apiKey: null, models: [] },
  }
  const connection = {
    rpc: {
      call: async (target, method, args) => {
        const name = String(args?.method ?? '')
        return { ok: true, value: Object.prototype.hasOwnProperty.call(rpcAnswers, name) ? rpcAnswers[name] : {} }
      },
    },
  }

  // ── the plugin's context ───────────────────────────────────────────────────
  // \`connection\` is deliberately *not* a readable property: the kernel withholds
  // a service a plugin never injected, and the bundle reads it through
  // \`ctx.get('connection')\` for exactly that reason. Withholding it here keeps the
  // fallback on the path this preview exercises.
  const disposers = []
  const ctx = {
    effect(fn) {
      try {
        const disposer = fn()
        if (typeof disposer === 'function') disposers.push(disposer)
      } catch (error) { window.__crash('effect: ' + (error && error.message)) }
      return { [Symbol.dispose]() {} }
    },
    get: name => name === 'connection' ? connection : name === 'slots' ? slots : name === 'locale' ? locale : undefined,
    slots,
    locale,
    __disposers: disposers,
  }
  Object.defineProperty(ctx, 'connection', {
    get() { throw new Error('our-free-model read ctx.connection without inject (cordis withholds it)') },
  })

  let root = null
  const mount = () => {
    const entry = registrations.section.find(row => row.options.id === 'our-free-model') ?? registrations.section[0]
    if (entry === undefined) { window.__crash('the bundle registered no settings.section component'); return }
    const t = locale.bind(entry.options.locale ?? 'settings.ourFreeModel')
    if (root === null) root = ReactDOM.createRoot(document.getElementById('root'))
    root.render(React.createElement(entry.component, { t }))
  }

  window.__preview = {
    ctx,
    registrations,
    mount,
    setLocale: next => { active = next === 'en' ? 'en' : 'zh'; document.documentElement.lang = active; mount() },
  }

  if (window.__plugin === undefined) { window.__crash('the bundle never registered itself with the module loader'); return }
  try { window.__plugin.apply(ctx) } catch (error) { window.__crash('apply(): ' + (error && error.message)) }
  mount()
})()
</script>
</body>
</html>`
}
