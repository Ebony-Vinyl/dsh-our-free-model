/** 使用真实构建资源和隔离接口，验证 React 应用的跨页面状态及会话边界。 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { createManagement } from '../packages/standalone/management.mjs'
import { buildStats } from '../src/core/stats.js'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'playwright')
const management = createManagement({ stores: { settings: { get: () => ({ forwardKey: 'isolated' }) } }, info: () => ({}) })
const server = http.createServer((req, res) => { void management.handleRequest(req, res) })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const baseUrl = `http://127.0.0.1:${server.address().port}`
management.setPort(server.address().port)
const browser = await chromium.launch({ headless: true })
const settings = { enabled: true, exposeRegionModels: true, streamRecovery: true, standaloneProbe: false, defaultMaxTokens: 32768, probeIntervalMinutes: 15 }
let loggedIn = false, key = 'ofm-ui-isolated-key', summaryReads = 0
const summary = () => ({ version: 'test', baseUrl, dataDir: 'isolated', networkMode: 'fixture', automaticRefresh: false,
  catalogSyncedAt: 0, settings: { ...settings }, channels: { state: 'ready' }, eacAuth: { local: false },
  catalog: [{ id: 'fixture/model', name: '测试模型', channel: 'anonymous', routable: true, availability: 'available' }] })
const errors = []
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/management/**', async route => {
    const request = route.request(), endpoint = new URL(request.url()).pathname.replace('/api/management', '')
    const body = request.postDataJSON()
    const answer = (value, status = 200) => route.fulfill({ status, json: value })
    if (endpoint === '/session') { loggedIn = body.key === key || body.bootstrapToken === 'test'; return answer(loggedIn ? { ok: true } : { error: '登录令牌无效' }, loggedIn ? 200 : 401) }
    if (!loggedIn) return answer({ error: '管理会话已失效，请重新登录' }, 401)
    if (endpoint === '/summary') { summaryReads++; return answer(summary()) }
    if (endpoint === '/stats') return answer(buildStats({}, []))
    if (endpoint === '/settings') { Object.assign(settings, body); return answer({ settings }) }
    if (endpoint === '/key') return answer({ key })
    if (endpoint === '/key/rotate') { key = 'ofm-ui-rotated-key'; return answer({ key }) }
    if (endpoint === '/logout') { loggedIn = false; return answer({ ok: true }) }
    if (endpoint === '/eac/status') return answer({ available: true, authorized: false, local: false, login: '' })
    if (endpoint === '/eac/pool') return answer({ inflight: 0, pool: 100, active24h: 0 })
    if (endpoint === '/channels/rpc') {
      const value = body.method === 'provider.status' ? { statuses: Object.fromEntries(body.payload.providers.map(id => [id, { accounts: { total: 0, enabled: 0 } }])) }
        : body.method === 'usage.autoCheckin' ? { autoCheckin: { enabled: false } }
          : body.method === 'usage.tokenLedger' ? { entries: [] } : {}
      return answer({ ok: true, value })
    }
    return answer({ ok: true })
  })
  const nav = async name => { await page.locator('.console-nav-item').filter({ hasText: name }).click() }
  await page.goto(baseUrl)
  await page.locator('#login-key').fill('bad-key')
  await page.getByRole('button', { name: '进入控制台' }).click()
  await page.getByText('登录令牌无效', { exact: true }).waitFor()
  await page.locator('#login-key').fill(key)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await page.getByTestId('overview-ready').waitFor()
  await nav('模型清单'); await page.getByTestId('models-ready').waitFor()
  await nav('用量统计'); await page.getByTestId('usage-ready').waitFor()
  await nav('服务设置'); await page.getByTestId('settings-ready').waitFor()
  await page.locator('#setting-defaultMaxTokens').fill('8192')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByText('设置已保存并生效', { exact: true }).waitFor()
  assert.equal(settings.defaultMaxTokens, 8192)
  await nav('概览'); await nav('服务设置')
  assert.equal(await page.locator('#setting-defaultMaxTokens').inputValue(), '8192', '保存后的设置应在切页后保持')
  await nav('API 接入'); await page.getByTestId('connection-ready').waitFor()
  await page.getByRole('button', { name: '查看密钥', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('connection-key').value.length > 0)
  assert.equal(await page.locator('#connection-key').inputValue(), key)
  await page.getByRole('button', { name: '隐藏密钥', exact: true }).click()
  assert.equal(await page.locator('#connection-key').inputValue(), '')
  await page.getByRole('button', { name: '复制地址', exact: true }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${baseUrl}/v1`)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '轮换密钥', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('connection-key').value === 'ofm-ui-rotated-key')
  await nav('免费账号渠道'); await page.getByLabel('搜索渠道').waitFor()
  await page.getByRole('tab', { name: '请求日志', exact: true }).click()
  // 等待轮询真实执行；刷新不应重置渠道子页。
  const previousReads = summaryReads
  await page.waitForFunction(() => true)
  const deadline = Date.now() + 20000
  while (summaryReads === previousReads && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(summaryReads > previousReads, '15 秒自动轮询应执行')
  assert.equal(await page.getByRole('tab', { name: '请求日志', exact: true }).getAttribute('aria-selected'), 'true', '刷新不得重置渠道子页')
  await nav('EAC 协付渠道'); await page.getByRole('heading', { name: 'EAC 协付渠道', exact: true }).waitFor()
  await nav('API 接入')
  const imageDir = process.env.OFM_UI_SCREENSHOT_DIR
  if (imageDir) fs.mkdirSync(imageDir, { recursive: true })
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }]]) {
    await page.setViewportSize(viewport)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 不应溢出视口`)
    if (imageDir) await page.screenshot({ path: path.join(imageDir, `react-connection-${name}.png`), fullPage: true })
  }
  await page.getByRole('button', { name: '退出管理', exact: true }).click()
  await page.getByTestId('login-screen').waitFor()
  assert.deepEqual(errors, [])
  console.log('react UI: 登录失败/成功、七页面导航、草稿保留/保存、密钥显隐/复制/轮换、轮询保持子页、三种视口、退出通过')
} finally {
  await browser.close(); management.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
