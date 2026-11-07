/**
 * Browser-E2E fixture: a signed marketplace with one page plugin and one
 * channel plugin, plus the real standalone service pointed at it.
 *
 * Prints one JSON line with `managementUrl`, then waits for `close` on stdin.
 * Test-only; not part of the shipped package.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-plugin-e2e-'))
const files = new Map()
let registryPort = 0

const pageHtml = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="./style.css"></head><body><h1 id="title">Demo</h1><p id="visits"></p><script src="./app.js"></script></body></html>'
const pageScript = `const title = document.getElementById('title')
const visits = document.getElementById('visits')
window.ofm.config.get().then(config => { title.textContent = config.title || 'Demo' })
window.ofm.storage.get('visits').then(value => {
  const next = Number(value || 0) + 1
  window.ofm.storage.set('visits', next)
  visits.textContent = 'visits=' + next
})
window.ofm.notify('page-ready')
window.ofm.resize(520)
`
const pageStyle = 'body { margin: 0; padding: 24px; background: var(--ofm-bg); color: var(--ofm-text); font-family: system-ui, sans-serif; }'

const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'e2e-ok' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'))
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/registry.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(registry))
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

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const register = (id, filePath, body) => {
  const bytes = Buffer.from(body)
  files.set(`${id}/${filePath}`, bytes)
  return {
    path: filePath,
    url: `http://127.0.0.1:${registryPort}/packages/${id}/${filePath}`,
    size: bytes.length,
    sha256: digest(bytes),
  }
}

const pageManifest = {
  schemaVersion: 2,
  id: 'fixture-page',
  version: '1.0.0',
  kind: 'page',
  apiVersion: '^2',
  name: 'Fixture Page',
  description: '浏览器验收用的沙箱页面',
  author: 'test',
  license: 'MIT',
  permissions: { network: [], secrets: [], storage: true },
  config: [{ key: 'title', type: 'text', label: '标题', default: 'Hello' }],
  files: ['ui/index.html', 'ui/app.js', 'ui/style.css'],
  contributes: {
    pages: [{ id: 'demo', title: 'Demo Page', entry: 'ui/index.html', group: '工具', order: 10, icon: 'sparkles' }],
  },
}
const channelManifest = {
  schemaVersion: 1,
  id: 'fixture-channel',
  version: '1.0.0',
  type: 'channel',
  name: 'Fixture Channel',
  permissions: { network: [upstreamOrigin], secrets: [], storage: false },
}
const channelSource = `import { sdk } from 'ofm:sdk'
export default {
  async listModels() { return [{ id: 'demo-model', name: 'Demo Model', contextWindow: 8192, maxOutput: 1024 }] },
  async prepareChat() { return { url: '${upstreamOrigin}/v1/chat/completions', headers: {}, wire: 'chat' } },
}
`

const pageFiles = [
  register('fixture-page', 'ui/index.html', pageHtml),
  register('fixture-page', 'ui/app.js', pageScript),
  register('fixture-page', 'ui/style.css', pageStyle),
]
const mainFile = register('fixture-channel', 'main.mjs', channelSource)

const registry = {
  schemaVersion: 2,
  generatedAt: '2026-11-07T00:00:00.000Z',
  plugins: [
    {
      ...pageManifest,
      main: null,
      ui: { entry: 'ui/index.html', files: pageFiles },
      summary: '沙箱页面：读取配置、计数存储、通知与主题跟随。',
      tags: ['fixture', 'page'],
      publishedAt: '2026-11-07T00:00:00.000Z',
    },
    {
      ...channelManifest,
      files: ['main.mjs'],
      main: mainFile,
      summary: '一个循环回环渠道。',
      tags: ['fixture', 'channel'],
      publishedAt: '2026-11-07T00:00:00.000Z',
    },
  ],
}
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const { stableStringify } = await import('../../src/updater.js')
const signature = crypto.sign(null, Buffer.from(stableStringify(registry)), privateKey).toString('base64')

process.env.OFM_EXTENSIONS_REGISTRY = `http://127.0.0.1:${registryPort}/registry.json`
process.env.OFM_EXTENSIONS_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
process.env.OFM_TEST_UPSTREAM = '1'

const { startStandalone } = await import('../../packages/standalone/service.mjs')
const service = await startStandalone({ dataDir, refresh: false, port: 0, logger: { warn: () => {}, info: () => {} } })

process.stdout.write(JSON.stringify({
  managementUrl: service.managementUrl,
  port: service.port,
  dataDir,
  registryPort,
  upstreamOrigin,
}) + '\n')

let closed = false
const close = async () => {
  if (closed) return
  closed = true
  await service.close()
  await new Promise(resolve => server.close(resolve))
  await new Promise(resolve => upstream.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(0)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { if (String(chunk).includes('close')) void close() })
process.stdin.resume()
process.on('SIGTERM', () => { void close() })
