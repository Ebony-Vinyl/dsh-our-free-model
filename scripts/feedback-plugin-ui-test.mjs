/**
 * 插件端「反馈与许愿」页面的真浏览器验收。
 *
 * 起一个假 GitHub + 一个指向它的反馈服务桩，再挂上真实的插件外壳，
 * 让页面真的走完 device flow 并提交一条反馈。这样验证的是
 * 「页面 → 插件路由 → 反馈客户端 → 收集端」整条链路，而不是各段单独正确。
 *
 * 复用 `scripts/workspace-appearance-ui-test.mjs` 的做法：esbuild 打一份 React
 * 进页面，`client.js` 原样加载，`Shell` 用真实的 `createApiRoutes` 供货。
 *
 * Run: node scripts/feedback-plugin-ui-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createApiRoutes } from '../index.js'
import { createFeedback } from '../src/feed.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const uiRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
import { loadChromium } from './lib/playwright.mjs'

const chromium = loadChromium()
if (chromium === null) {
  console.log('skip feedback-plugin-ui: playwright or its browser is not installed')
  process.exit(0)
}
const { build } = uiRequire('esbuild')

const react = await build({
  stdin: {
    contents: "import * as React from 'react';import * as ReactDOM from 'react-dom';import{createRoot}from'react-dom/client';window.testReact=React;window.testReactDOM=ReactDOM;window.createRoot=createRoot;",
    resolveDir: path.join(root, 'packages/standalone'),
  },
  bundle: true, write: false, format: 'iife', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})

// ── 收集端桩 ────────────────────────────────────────────────────────────────
// 与线上同形：反向代理把 `/feedback/*` 剥成 `/*` 再转给反馈服务。
const submissions = []
let pollStatus = 'pending'
const collector = http.createServer((req, res) => {
  const send = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = raw === '' ? {} : JSON.parse(raw)
    const route = req.url.startsWith('/feedback/') ? req.url.slice('/feedback'.length) : req.url
    if (route === '/api/auth/start') {
      return send(200, { session: 'sess-ui', userCode: 'UIUI-4242', verifyUrl: 'https://github.com/login/device', expiresIn: 900 })
    }
    if (route === '/api/auth/poll') return send(200, pollStatus === 'pending' ? { status: 'pending' } : { status: 'ok', token: 'ui-token', login: 'ui-user' })
    if (route === '/api/feedback') {
      if (!/^Bearer ui-token$/.test(String(req.headers.authorization ?? ''))) return send(401, { error: 'unauthorized' })
      submissions.push(body)
      return send(200, { id: `rec-${submissions.length}` })
    }
    send(404, { error: 'not-found' })
  })
})
const collectorPort = await new Promise(resolve => collector.listen(0, '127.0.0.1', () => resolve(collector.address().port)))

// ── 插件外壳 ────────────────────────────────────────────────────────────────
let settings = { feedbackUrl: `http://127.0.0.1:${collectorPort}/feedback`, feedbackAuth: null }
const handler = createApiRoutes({
  feedback: createFeedback({ settings: () => settings, persist: patch => Object.assign(settings, patch) }),
  meta: () => ({ version: '2.8.4' }),
})

const html = `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--dsw-alias-label-primary:#24262c;--dsw-alias-label-secondary:#666975;--dsw-alias-label-tertiary:#8a8d98;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f7f8fa;--dsw-alias-bg-layer-3:#eef1f6;--dsw-alias-border-l1:#e5e7ed;--dsw-alias-border-l2:#d5d9e2;--dsw-alias-state-business-primary:#416fe8;--dsw-alias-state-success-primary:#249972;--dsw-alias-state-error-primary:#d94e62;color-scheme:light}
[data-theme=dark]{--dsw-alias-label-primary:#ebebee;--dsw-alias-label-secondary:#b5b5be;--dsw-alias-label-tertiary:#91919d;--dsw-alias-bg-layer-1:#1c1c20;--dsw-alias-bg-layer-2:#25252a;--dsw-alias-bg-layer-3:#33333a;--dsw-alias-border-l1:#393940;--dsw-alias-border-l2:#4e4e59;--dsw-alias-state-business-primary:#94b4ff;color-scheme:dark}
body{margin:0;padding:20px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);font:14px 'Segoe UI','Microsoft YaHei',sans-serif}#root{max-width:1080px;margin:auto;min-width:0}button,input,textarea{font-family:inherit}
</style></head><body><div id="root"></div><script src="/react.js"></script><script>window.__ModuleLoader__={load:r=>window.plugin=r.factory(name=>name==='react-dom'?window.testReactDOM:window.testReact)};</script><script src="/client.js"></script><script>
const {CSS,DICT,Shell}=plugin.__test;
document.head.append(Object.assign(document.createElement('style'),{textContent:CSS}));
const t=key=>DICT.zh[key]??key;t.locale='zh-CN';
const data={settings:{},catalog:[],version:'2.8.4'};
window.createRoot(document.getElementById('root')).render(window.testReact.createElement(Shell,{
  t,data,summary:{data,reload(){}},counts:{},stats:{reload(){}},ctx:{},eacLogin:{}
}));
</script></body></html>`

const server = http.createServer((req, res) => {
  const send = (value, type) => { res.writeHead(200, { 'content-type': type }); res.end(value) }
  if (req.url === '/') return send(html, 'text/html; charset=utf-8')
  if (req.url === '/react.js') return send(react.outputFiles[0].text, 'application/javascript')
  if (req.url === '/client.js') return send(fs.readFileSync(path.join(root, 'client.js')), 'application/javascript')
  if (req.url === '/favicon.ico') return send('', 'image/x-icon')
  void handler(req, res).catch(error => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  })
})

let browser
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(edge) ? { executablePath: edge } : {}) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  page.setDefaultTimeout(30_000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  // 授权页会在新标签打开；拦掉它，避免真的弹窗。
  await page.addInitScript(() => { window.open = () => null })
  await page.addInitScript(() => localStorage.setItem('ofm.tab', 'feedback'))

  await page.goto(origin)
  await page.locator('#ofm-tab-feedback[aria-selected=true]').waitFor()

  await check('导航里出现「反馈与许愿」并可直接选中', async () => {
    assert.equal(await page.locator('#ofm-tab-feedback').textContent().then(v => v.includes('反馈与许愿')), true)
  })

  await check('未登录时只显示登录门槛，没有表单', async () => {
    await page.locator('.ofm_fbgate').waitFor()
    assert.equal(await page.locator('.ofm_fbform').count(), 0)
  })

  await check('点击登录显示设备码与授权链接', async () => {
    await page.locator('.ofm_fbgate button').click()
    await page.locator('.ofm_fbcode').waitFor()
    assert.equal((await page.locator('.ofm_fbcodeval').textContent()).trim(), 'UIUI-4242')
    const href = await page.locator('.ofm_fbcode a').getAttribute('href')
    assert.equal(href, 'https://github.com/login/device')
  })

  await check('授权完成后进入表单，门槛消失', async () => {
    pollStatus = 'ok'
    await page.locator('.ofm_fbform').waitFor({ timeout: 20_000 })
    assert.equal(await page.locator('.ofm_fbgate').count(), 0)
    const hero = await page.locator('.ofm_hero').textContent()
    assert.ok(hero.includes('ui-user'), `登录名未显示：${hero}`)
  })

  await check('未填内容时提交按钮禁用', async () => {
    const disabled = await page.locator('.ofm_fbform .ofm_btn').isDisabled()
    assert.equal(disabled, true)
  })

  await check('切换到许愿，占位文案随之变化', async () => {
    const before = await page.locator('.ofm_fbform input').getAttribute('placeholder')
    await page.locator('.ofm_fbseg').nth(1).click()
    const after = await page.locator('.ofm_fbform input').getAttribute('placeholder')
    assert.notEqual(before, after)
    assert.equal(await page.locator('.ofm_fbseg').nth(1).getAttribute('aria-pressed'), 'true')
  })

  await check('填写后提交成功并显示单号', async () => {
    await page.locator('.ofm_fbform input').fill('希望支持自定义配色')
    await page.locator('.ofm_fbform textarea').fill('想换成浅灰主题。')
    await page.locator('.ofm_fbform .ofm_btn').click()
    await page.locator('.ofm_fbreceipt').waitFor({ timeout: 20_000 })
    const receipt = await page.locator('.ofm_fbreceipt').textContent()
    assert.ok(receipt.includes('rec-1'), `单号未显示：${receipt}`)
  })

  await check('提交后表单清空、类型保留', async () => {
    assert.equal(await page.locator('.ofm_fbform input').inputValue(), '')
    assert.equal(await page.locator('.ofm_fbform textarea').inputValue(), '')
    assert.equal(await page.locator('.ofm_fbseg').nth(1).getAttribute('aria-pressed'), 'true')
  })

  await check('收集端收到的是许愿、带版本与平台', async () => {
    assert.equal(submissions.length, 1)
    assert.equal(submissions[0].kind, 'wish')
    assert.equal(submissions[0].title, '希望支持自定义配色')
    assert.equal(submissions[0].version, '2.8.4')
    assert.equal(typeof submissions[0].platform, 'string')
  })

  await check('令牌从未出现在页面里', async () => {
    const leaked = await page.evaluate(() => document.documentElement.outerHTML.includes('ui-token'))
    assert.equal(leaked, false, '页面源码里出现了反馈令牌')
  })

  await check('退出登录回到门槛页', async () => {
    await page.locator('.ofm_hero .ofm_btn').click()
    await page.locator('.ofm_fbgate').waitFor({ timeout: 15_000 })
    assert.equal(await page.locator('.ofm_fbform').count(), 0)
  })

  await check('没有页面错误', async () => {
    assert.deepEqual(pageErrors, [])
  })

  // 主题切换后设备码与表单仍可读：反馈页是深色主题下最容易看不见字的地方。
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    const contrast = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.className = 'ofm_fbcodeval'
      probe.textContent = 'ABCD-1234'
      document.body.appendChild(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    await check(`${theme} 主题下设备码有可见前景色`, async () => {
      assert.notEqual(contrast, 'rgba(0, 0, 0, 0)')
      assert.ok(contrast !== '', 'foreground colour is empty')
    })
  }
} finally {
  await browser?.close()
  server.close()
  collector.close()
}

console.log(failures === 0 ? 'feedback plugin ui: all checks passed' : `feedback plugin ui: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
