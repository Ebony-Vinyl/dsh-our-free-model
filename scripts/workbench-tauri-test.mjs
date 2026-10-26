import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'win32') throw new Error('This native Tauri validation requires Windows')
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'playwright')
const executable = process.env.OFM_DESKTOP_BINARY
if (!executable || !fs.existsSync(executable)) throw new Error('OFM_DESKTOP_BINARY must name the locally built executable')
const root = path.resolve('.verify/workbench-tauri')
fs.mkdirSync(root, { recursive: true })
const dataDir = fs.mkdtempSync(path.join(root, 'run-'))
const listener = net.createServer()
listener.listen(0, '127.0.0.1')
await once(listener, 'listening')
const debugPort = listener.address().port
await new Promise(resolve => listener.close(resolve))
const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url.includes('/pool') ? { ok: true, inflight: 0, pool: 100, active24h: 0 } : { data: [] }))
  })
})
let app, browser
let captured = ''
try {
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const base = `http://127.0.0.1:${upstream.address().port}`
  app = spawn(executable, [], {
    env: { ...process.env, OFM_HOME: dataDir, OFM_TEST_UPSTREAM: base, OUR_FREE_MODEL_BASE: base, OUR_FREE_MODEL_KILO_BASE: base,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1` },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false,
  })
  app.stderr.on('data', chunk => { captured = (captured + chunk).slice(-2000) })
  app.once('error', error => { throw error })
  const deadline = Date.now() + 45000
  let endpoint
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Tauri exited before readiness (${app.exitCode})`)
    try {
      const value = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) })).json()
      if (value.webSocketDebuggerUrl) { endpoint = value.webSocketDebuggerUrl; break }
    } catch {}
    await delay(250)
  }
  assert.ok(endpoint, 'Owned WebView2 did not expose its debugging endpoint')
  browser = await chromium.connectOverCDP(endpoint)
  const context = browser.contexts()[0]
  let page
  const readyUntil = Date.now() + 30000
  while (Date.now() < readyUntil) {
    page = context.pages().find(candidate => /^http:\/\/127\.0\.0\.1:\d+/.test(candidate.url()))
    if (page) break
    await delay(250)
  }
  assert.ok(page, 'Tauri main WebView did not reach the service')
  await page.waitForFunction(() => document.querySelector('nav.console-nav'))
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const sponsor = page.locator('dialog.ofm-sponsor[open]')
  await page.waitForTimeout(1000)
  if (await sponsor.count()) { await sponsor.getByRole('button', { name: /收起/ }).first().click(); await sponsor.waitFor({ state: 'hidden' }) }
  const nav = name => page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name, exact: true }).click()
  await nav('客户端与订阅')
  await page.locator('.wb-client').first().waitFor()
  assert.equal(await page.locator('.wb-client').count(), 6)
  await page.screenshot({ path: path.join(root, 'native-tauri-agents.png') })
  await nav('聚合渠道')
  await page.locator('.pd-row').first().waitFor()
  assert.equal(await page.locator('.pd-row').count(), 76)
  await page.screenshot({ path: path.join(root, 'native-tauri-providers.png') })
  await nav('EAC router')
  await page.getByLabel('搜索渠道').waitFor()
  assert.equal(await page.locator('.channel-directory-row').count(), 10)
  await page.screenshot({ path: path.join(root, 'native-tauri-router.png') })
  assert.deepEqual(errors, [])
  console.log('Native Tauri + bundled Node + actual WebView2: logged in, 6 clients, 76 providers, 10 retained EAC router channels; screenshots .verify/workbench-tauri')
} finally {
  await browser?.close().catch(() => {})
  if (app?.exitCode === null) {
    const exited = once(app, 'exit')
    app.kill()
    await exited
  }
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ dataDir, appExit: app?.exitCode, diagnostics: captured }, null, 2))
}
