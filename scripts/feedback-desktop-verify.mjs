/**
 * 实机验收：在**真实的桌面宿主**里跑通「反馈与许愿」。
 *
 * 前面的套件用 esbuild 自己搭了一个 React 页面，那验证的是组件；这一支验证的是
 * 装在这台机器上的 Electron 宿主能不能把页面画出来、标签页点不点得动、路由答不
 * 答得上来、登录与提交整条链路在真宿主里通不通。
 *
 * 宿主用**独立 profile** 启动，绝不碰用户自己的 ~/.dsh/profiles/desktop：
 *  - `DSH_HOME` 指到临时目录（宿主从这里找 `profiles/<name>`）；
 *  - `DSH_PROFILE` / `DSH_PROFILE_DIR` 指定 profile 名与目录（宿主认这两个）；
 *  - profile 里只声明本插件一个 bundle，其它插件与本页无关，少装少干扰；
 *  - 反馈地址指向本地桩，所以这一支不依赖公网，也不往真实收集端写任何东西。
 *
 * Run: node scripts/feedback-desktop-verify.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'D:/Cache/npm-global/node_modules/playwright')

const executable = process.env.OFM_DESKTOP_EXE ?? 'D:/deepseek官方桌面端/DeepSeek Harness.exe'
assert.ok(fs.existsSync(executable), `桌面宿主不存在：${executable}`)
assert.equal(process.platform, 'win32', '这一支只能在 Windows 桌面宿主上跑')

const output = path.join(root, '.verify', 'feedback-desktop')
fs.mkdirSync(output, { recursive: true })
const scratch = fs.mkdtempSync(path.join(output, 'run-'))

// ── 收集端桩 ────────────────────────────────────────────────────────────────
// 与线上同形：反代把 `/feedback/*` 剥成 `/*` 再转给反馈服务。
const submissions = []
const collector = http.createServer((req, res) => {
  const send = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = raw === '' ? {} : JSON.parse(raw)
    const route = req.url.startsWith('/feedback/') ? req.url.slice('/feedback'.length) : req.url
    if (route === '/api/auth/start') {
      return send(200, { session: 'desk-s', userCode: 'DESK-1234', verifyUrl: 'https://github.com/login/device', expiresIn: 900 })
    }
    if (route === '/api/auth/poll') return send(200, { status: 'ok', token: 'desk-token', login: 'desk-user' })
    if (route === '/api/feedback') {
      if (!/^Bearer desk-token$/.test(String(req.headers.authorization ?? ''))) return send(401, { error: 'unauthorized' })
      submissions.push(body)
      return send(200, { id: 'desk-rec-1' })
    }
    send(404, {})
  })
})
const collectorPort = await new Promise(resolve => collector.listen(0, '127.0.0.1', () => resolve(collector.address().port)))

const freePort = async () => {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

let native
let browser
try {
  // ── 独立 profile ──────────────────────────────────────────────────────────
  const dshHome = path.join(scratch, 'dsh')
  const profile = path.join(dshHome, 'profiles', 'desktop')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-feedback-verify', private: true,
    dependencies: { 'dsh-our-free-model': 'link:D:/ofm-dev' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-our-free-model'] } },
  }, null, 2))
  fs.symlinkSync('D:/ofm-dev', path.join(profile, 'node_modules', 'dsh-our-free-model'), 'junction')
  // 插件自己的设置文件：把反馈地址指到桩上，这样不碰公网也不写真实收集端。
  // 数据目录是 `$DSH_HOME/our-free-model`（宿主自己解析出来的位置，见 /meta 的 dataDir）。
  const dataDir = path.join(dshHome, 'our-free-model')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    feedbackUrl: `http://127.0.0.1:${collectorPort}/feedback`,
  }, null, 2))

  const debugPort = await freePort()
  const home = path.join(scratch, 'home')
  for (const dir of [home, path.join(home, 'APPDATA'), path.join(home, 'LOCALAPPDATA')]) fs.mkdirSync(dir, { recursive: true })
  const env = {
    ...process.env,
    DSH_HOME: dshHome, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: profile,
    USERPROFILE: home, HOME: home,
    APPDATA: path.join(home, 'APPDATA'), LOCALAPPDATA: path.join(home, 'LOCALAPPDATA'),
    DSH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    NODE_OPTIONS: '', NODE_PATH: '',
  }
  delete env.ELECTRON_RUN_AS_NODE

  native = spawn(executable, [
    `--user-data-dir=${path.join(scratch, 'electron')}`,
    `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1',
  ], { cwd: scratch, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let hostOutput = ''
  native.stdout.on('data', chunk => { hostOutput = (hostOutput + String(chunk)).slice(-30000) })
  native.stderr.on('data', chunk => { hostOutput = (hostOutput + String(chunk)).slice(-30000) })

  let ready = false
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break } } catch { /* wait */ }
    await delay(500)
  }
  assert.ok(ready, `宿主未在 60s 内开好调试端口\n${hostOutput.slice(-1500)}`)

  // 宿主会打印自己的 web 入口（带一次性 token）。等它出现，再拿它换 cookie。
  let webUrl
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const match = hostOutput.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)
    if (match !== null) { webUrl = match[1]; break }
    await delay(500)
  }
  assert.ok(webUrl !== undefined, `宿主未打印 web 入口\n${hostOutput.slice(-2000)}`)

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  // 授权页会 window.open；拦掉，避免真的弹窗。
  await page.addInitScript(() => { window.open = () => null })
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' })
  await delay(7000)

  // 关掉宿主自己的「预览版说明」与插件首启公告的遮罩 —— 两者都会挡住点击。
  const clearOverlays = async () => {
    for (let round = 0; round < 6; round += 1) {
      await page.evaluate(() => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close())
        document.querySelectorAll('.ofm_scrim').forEach(scrim => scrim.remove())
      })
      const cont = page.getByRole('button', { name: '继续' })
      if (await cont.count()) await cont.click().catch(() => {})
      await delay(600)
    }
  }
  await clearOverlays()

  // 设置页的快捷键是 Ctrl+Alt+,（账户菜单里写的那一条）。用它比按坐标点「…」稳。
  await page.keyboard.press('Control+Alt+Comma')
  await delay(4000)
  await clearOverlays()

  await check('宿主设置页里出现本插件的分区', async () => {
    const sections = await page.evaluate(() => [...document.querySelectorAll('[role=tab],nav button')]
      .map(node => (node.textContent ?? '').trim()).filter(Boolean))
    assert.ok(sections.includes('Our Free Model'), `设置分区里没有本插件：${sections.join(' / ')}`)
  })

  await page.getByText('Our Free Model', { exact: true }).first().click({ timeout: 15000 })
  await delay(6000)
  await clearOverlays()

  await check('插件页里出现「反馈与许愿」标签页', async () => {
    const tabs = await page.evaluate(() => [...document.querySelectorAll('[role=tab]')]
      .map(node => ({ label: (node.textContent ?? '').trim(), id: node.id })))
    assert.ok(tabs.some(tab => tab.id === 'ofm-tab-feedback'), `标签页里没有反馈页：${tabs.map(t => t.id).join(', ')}`)
  })

  await page.locator('#ofm-tab-feedback').click({ force: true })
  await delay(3000)
  await clearOverlays()

  await check('反馈页真的画出来了：标题、副标题与登录门槛都在', async () => {
    const hero = (await page.locator('.ofm_hero').textContent() ?? '').replace(/\s+/g, ' ')
    assert.ok(hero.includes('反馈与许愿'), `标题缺失：${hero.slice(0, 80)}`)
    assert.ok(hero.includes('报告一个问题'), `副标题缺失：${hero.slice(0, 120)}`)
    assert.equal(await page.locator('.ofm_fbgate').count(), 1, '未登录时应显示登录门槛')
    assert.equal(await page.locator('.ofm_fbform').count(), 0, '未登录时不应显示表单')
  })

  await check('刷新后仍停在反馈页（标签页记住了选择）', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delay(6000)
    await clearOverlays()
    const selected = await page.evaluate(() => window.localStorage.getItem('ofm.tab'))
    assert.equal(selected, 'feedback', `刷新后记录的标签页是 ${selected}`)
  })

  await check('宿主里的插件路由是活的（GET /feedback 有答案）', async () => {
    const value = await page.evaluate(async () => {
      const response = await fetch('/api/our-free-model/feedback', { cache: 'no-store', signal: AbortSignal.timeout(20000) })
      return { status: response.status, body: await response.json().catch(() => null) }
    })
    assert.equal(value.status, 200, `路由回了 ${value.status}`)
    assert.equal(value.body.signedIn, false)
  })

  await check('宿主里能发起登录并拿到设备码', async () => {
    const value = await page.evaluate(async () => {
      const response = await fetch('/api/our-free-model/feedback/start', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(20000) })
      return { status: response.status, body: await response.json().catch(() => null) }
    })
    assert.equal(value.status, 200, `start 回了 ${value.status}: ${JSON.stringify(value.body)}`)
    assert.equal(value.body.userCode, 'DESK-1234')
  })

  await check('宿主里能走完登录并提交一条反馈', async () => {
    const value = await page.evaluate(async () => {
      const post = async (path, body) => {
        const response = await fetch(`/api/our-free-model${path}`, {
          method: 'POST', cache: 'no-store',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        })
        return { status: response.status, body: await response.json().catch(() => null) }
      }
      const polled = await post('/feedback/poll', { session: 'desk-s' })
      const submitted = await post('/feedback/submit', { kind: 'bug', title: '实机验收', detail: '来自真实桌面宿主' })
      return { polled, submitted }
    })
    assert.equal(value.polled.body.status, 'ok')
    assert.equal(value.submitted.status, 200, `submit 回了 ${value.submitted.status}: ${JSON.stringify(value.submitted.body)}`)
    assert.equal(value.submitted.body.id, 'desk-rec-1')
  })

  await check('收集端确实收到了这条反馈，且版本号由宿主盖章', async () => {
    assert.equal(submissions.length, 1)
    assert.equal(submissions[0].title, '实机验收')
    assert.equal(submissions[0].version, '2.8.4')
  })

  await check('令牌没有回到页面', async () => {
    const leaked = await page.evaluate(() => document.documentElement.outerHTML.includes('desk-token'))
    assert.equal(leaked, false)
  })

  await check('页面渲染没有抛错', async () => {
    assert.deepEqual(pageErrors, [])
  })

  await page.screenshot({ path: path.join(output, 'desktop.png') }).catch(() => {})
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ submissions, pageErrors, webUrl: webUrl.split('?')[0] }, null, 2))
} finally {
  await browser?.close().catch(() => {})
  if (native !== undefined && native.exitCode === null) native.kill()
  collector.close()
  await delay(3000)
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* 宿主可能仍握着句柄，下次运行会清 */ }
}

console.log(failures === 0 ? 'feedback desktop verify: all checks passed' : `feedback desktop verify: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
