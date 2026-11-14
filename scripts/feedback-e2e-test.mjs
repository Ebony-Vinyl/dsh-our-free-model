/**
 * 浏览器端到端：登录成功 → 提交成功。
 *
 * 起一个假 GitHub + 一个指向它的反馈服务，让页面真的走完 device flow，
 * 这样验证的是「页面 → 管理接口 → 反馈代理 → 反馈服务」整条链路，
 * 而不是各段单独的正确性。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
// 与同目录其它浏览器套件一致：环境变量优先，缺省走本机全局安装，避免 CI 上
// `require(undefined)` 直接抛 ERR_INVALID_ARG_TYPE 而不是"没有浏览器"。
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'D:/Cache/npm-global/node_modules/playwright')

// ── 假 GitHub ───────────────────────────────────────────────────────────────
const gh = http.createServer((req, res) => {
  const send = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
  if (req.url === '/login/device/code') return send(200, { device_code: 'D', user_code: 'TEST-0001', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
  if (req.url === '/login/oauth/access_token') return send(200, { access_token: 'gh', token_type: 'bearer', scope: 'read:user' })
  if (req.url === '/user') return send(200, { id: 7, login: 'e2e-user', avatar_url: 'https://x/a.png' })
  send(404, {})
})
const ghPort = await new Promise(resolve => gh.listen(0, '127.0.0.1', () => resolve(gh.address().port)))

// ── 反馈服务（指向假 GitHub）────────────────────────────────────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-e2e-fb-'))
const source = fs.readFileSync(new URL('../server/feedback/server.mjs', import.meta.url), 'utf8')
  .replace("'https://github.com/login/device/code'", `'http://127.0.0.1:${ghPort}/login/device/code'`)
  .replace("'https://github.com/login/oauth/access_token'", `'http://127.0.0.1:${ghPort}/login/oauth/access_token'`)
  .replace("'https://api.github.com/user'", `'http://127.0.0.1:${ghPort}/user'`)
const serverFile = path.join(dataDir, 'srv.mjs')
fs.writeFileSync(serverFile, source)
const fbPort = 4950
const fb = spawn(process.execPath, [serverFile], {
  env: { ...process.env, PORT: String(fbPort), HOST: '127.0.0.1', FEEDBACK_DATA_DIR: dataDir, GITHUB_CLIENT_ID: 'e2e' },
  stdio: 'ignore',
})
for (let attempt = 0; attempt < 80; attempt++) {
  try { if ((await fetch(`http://127.0.0.1:${fbPort}/api/health`)).ok) break } catch { /* wait */ }
  await new Promise(resolve => setTimeout(resolve, 100))
}

// ── 独立起一个控制台实例，指向这个反馈服务 ──────────────────────────────────
// 不复用正在跑的实例：它的设置在内存里，改磁盘不会生效，而且测试不该动
// 用户自己的数据目录。
const serviceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-e2e-svc-'))
fs.writeFileSync(path.join(serviceDir, 'settings.json'), JSON.stringify({ feedbackUrl: `http://127.0.0.1:${fbPort}` }, null, 2))
const servicePort = 4960
const service = spawn(process.execPath, [
  fileURLToPath(new URL('../packages/standalone/cli.mjs', import.meta.url)),
  '--port', String(servicePort), '--data-dir', serviceDir, '--no-refresh',
], { stdio: ['ignore', 'pipe', 'pipe'] })
let serviceOutput = ''
service.stdout.on('data', chunk => { serviceOutput += chunk })
service.stderr.on('data', chunk => { serviceOutput += chunk })
for (let attempt = 0; attempt < 200; attempt++) {
  try { if ((await fetch(`http://127.0.0.1:${servicePort}/`)).ok) break } catch { /* wait */ }
  await new Promise(resolve => setTimeout(resolve, 100))
}
const key = JSON.parse(fs.readFileSync(path.join(serviceDir, 'settings.json'), 'utf8')).managementKey
if (typeof key !== 'string' || key === '') throw new Error(`service did not write a management key: ${serviceOutput.slice(0, 300)}`)

let browser, failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

try {
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errs = []
  page.on('pageerror', error => errs.push(error.message))
  // 页面会 window.open 授权页；拦掉它，避免真的弹窗。
  await page.addInitScript(() => { window.open = () => null })

  await page.goto(`http://127.0.0.1:${servicePort}/`, { waitUntil: 'networkidle' })
  await page.fill('#login-key', key)
  await page.click('form button[type=submit]')
  await page.waitForSelector('.console-nav', { timeout: 20000 })
  // 全新数据目录会先弹赞助说明与免责声明；等它们出现再关，否则遮罩挡住导航。
  await page.waitForTimeout(3500)
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()))
  await page.waitForTimeout(700)
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()))
  await page.click('.console-nav-item:has-text("反馈与许愿")')
  await page.waitForSelector('.fb-gate', { timeout: 10000 })

  await check('未登录时显示登录门槛', async () => {
    if (!(await page.$('.fb-gate'))) throw new Error('gate missing')
    if (await page.$('.fb-form')) throw new Error('form must stay hidden before sign-in')
  })

  await check('点击登录显示验证码', async () => {
    await page.click('.fb-gate button')
    await page.waitForSelector('.fb-code', { timeout: 15000 })
    const code = await page.textContent('.fb-code strong')
    if (code?.trim() !== 'TEST-0001') throw new Error(`unexpected user code: ${code}`)
  })

  await check('轮询完成后进入已登录状态', async () => {
    await page.waitForSelector('.fb-form', { timeout: 20000 })
    const header = await page.textContent('.wb-heading')
    if (!header.includes('e2e-user')) throw new Error('signed-in login not shown')
    if (await page.$('.fb-gate')) throw new Error('gate must disappear after sign-in')
  })

  await check('表单在未填内容时禁止提交', async () => {
    const disabled = await page.$eval('.fb-actions button', button => button.disabled)
    if (!disabled) throw new Error('submit should be disabled while empty')
  })

  await check('填写后可以提交并拿到单号', async () => {
    await page.click('.fb-form .wb-segments button:nth-child(2)')
    await page.fill('.fb-form input', '希望支持自定义配色')
    await page.fill('.fb-form textarea', '想换成浅灰主题。')
    await page.click('.fb-actions button')
    await page.waitForSelector('.fb-receipt', { timeout: 20000 })
    const receipt = await page.textContent('.fb-receipt')
    if (!/已提交/.test(receipt)) throw new Error(`unexpected receipt: ${receipt}`)
  })

  await check('提交后表单清空、类型保留', async () => {
    const title = await page.inputValue('.fb-form input')
    const detail = await page.inputValue('.fb-form textarea')
    if (title !== '' || detail !== '') throw new Error('form should reset after submit')
    const wishPressed = await page.$eval('.fb-form .wb-segments button:nth-child(2)', b => b.getAttribute('aria-pressed'))
    if (wishPressed !== 'true') throw new Error('kind should stay on wish')
  })

  await check('反馈落盘且不含任何令牌', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const dir = path.join(dataDir, day)
    const files = fs.readdirSync(dir)
    if (files.length !== 1) throw new Error(`expected 1 record, got ${files.length}`)
    const raw = fs.readFileSync(path.join(dir, files[0]), 'utf8')
    const record = JSON.parse(raw)
    if (record.kind !== 'wish') throw new Error('kind not persisted')
    if (record.github.login !== 'e2e-user') throw new Error('identity not persisted')
    if (raw.includes('gh') && /"gh"/.test(raw)) throw new Error('github token leaked into the record')
    if (/local-token|Bearer/.test(raw)) throw new Error('bearer token leaked into the record')
  })

  await check('退出登录回到门槛页', async () => {
    await page.click('.wb-heading button')
    await page.waitForSelector('.fb-gate', { timeout: 15000 })
  })

  await check('无页面错误', async () => {
    if (errs.length) throw new Error(errs.slice(0, 2).join(' | '))
  })

  await page.screenshot({ path: '.verify/feedback-e2e.png', fullPage: true })
} finally {
  await browser?.close()
  service.kill()
  fb.kill()
  gh.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(serviceDir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'feedback e2e: all checks passed' : `feedback e2e: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
