/** Real sandboxed extension assets behind the DSH authentication boundary. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { createMagpieEngine } from '../src/magpie-engine.js'
import { createApiRoutes } from '../index.js'
import { structuralRejection } from '../src/trust.js'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'D:/Cache/npm-global/node_modules/playwright')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-magpie-sandbox-'))
const plugin = path.join(scratch, 'fixture-plugin')
const config = path.join(scratch, 'data', 'magpie', 'config', 'magpie')
fs.mkdirSync(path.join(plugin, 'page'), { recursive: true })
fs.mkdirSync(config, { recursive: true })
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
  name: 'ofm-sandbox-fixture', version: '1.0.0',
  magpie: { page: { title: 'Sandbox fixture', file: 'page/index.html' } },
}))
fs.writeFileSync(path.join(plugin, 'page', 'index.html'),
  '<!doctype html><html><head><script src="app.js" defer></script></head><body><output id="result">loading</output></body></html>')
fs.writeFileSync(path.join(plugin, 'page', 'app.js'),
  'document.querySelector("#result").textContent="SANDBOX_SCRIPT_OK";try{parent.document.body;document.body.dataset.isolated="no"}catch{document.body.dataset.isolated="yes"}')
fs.writeFileSync(path.join(config, 'plugins.json'), JSON.stringify({ plugins: [{ spec: plugin }] }))
const engine = createMagpieEngine({ dataDir: path.join(scratch, 'data') })
const connection = { admit(req) {
  const rejected = structuralRejection(req) ?? (req.headers.cookie?.includes('host-test=trusted') ? undefined : 401)
  return rejected ? { rejection: rejected } : undefined
} }
const handler = createApiRoutes({ magpieEngine: engine, connection })
let server, browser
try {
  await engine.start()
  const pages = await (await engine.request('GET', '/api/plugin-pages')).json()
  const extension = pages.find(row => row.title === 'Sandbox fixture')
  assert.ok(extension, 'engine must discover the local page-only extension')
  const asset = '/api/our-free-model/engine/ui' + extension.url
  assert.match(asset, /\/_magpie\/plugin\/[a-f0-9]{32}\//)
  server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'host-test=trusted; Path=/; HttpOnly; SameSite=Strict' })
      res.end(`<!doctype html><iframe id="plugin" sandbox="allow-scripts" src="${asset}"></iframe>`)
    } else void handler(req, res).catch(() => { res.writeHead(500); res.end() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(edge) ? { executablePath: edge } : {}) })
  const page = await browser.newPage()
  const failures = []
  page.on('response', response => {
    if (response.url().includes('/_magpie/plugin/') && response.status() >= 400) {
      failures.push({ status: response.status(), type: response.request().resourceType() })
    }
  })
  await page.goto(origin)
  const frame = page.frameLocator('#plugin')
  await frame.getByText('SANDBOX_SCRIPT_OK', { exact: true }).waitFor()
  assert.equal(await frame.locator('body').getAttribute('data-isolated'), 'yes')
  assert.deepEqual(failures, [], 'opaque-origin HTML and scripts must load without ambient host credentials')
  assert.equal((await fetch(origin + asset, {
    headers: { 'sec-fetch-site': 'cross-site', origin: 'null' },
  })).status, 200)
  const fake = asset.replace(/(\/_magpie\/plugin\/)[a-f0-9]{32}/, '$1' + '0'.repeat(32))
  assert.equal((await fetch(origin + fake, { headers: { 'sec-fetch-site': 'cross-site', origin: 'null' } })).status, 404)
  for (const endpoint of ['/engine/status', '/engine/ui/api/settings', '/engine/ui/api/caller-keys']) {
    const result = await fetch(origin + '/api/our-free-model' + endpoint, {
      headers: { 'sec-fetch-site': 'cross-site', origin: 'null' },
    })
    assert.ok([401, 403].includes(result.status), endpoint)
  }
  assert.ok([401, 403].includes((await fetch(origin + asset, {
    method: 'POST', headers: { 'sec-fetch-site': 'cross-site', origin: 'null' },
  })).status))
  console.log('magpie-sandbox: real plugin HTML and scripts load; opaque origin stays isolated; forged tokens and API access remain rejected')
} finally {
  await browser?.close()
  await engine.close()
  server?.closeAllConnections()
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir()))
  fs.rmSync(scratch, { recursive: true, force: true })
}
