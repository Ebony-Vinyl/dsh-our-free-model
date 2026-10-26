/** Real plugin shell and embedded engine: navigation, accounts, themes and layout. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createMagpieEngine } from '../src/magpie-engine.js'
import { createApiRoutes } from '../index.js'
import { structuralRejection } from '../src/trust.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, '.verify/workspace-appearance')
fs.mkdirSync(output, { recursive: true })
const scratch = fs.mkdtempSync(path.join(output, 'run-'))
const require = createRequire(import.meta.url)
const uiRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'D:/Cache/npm-global/node_modules/playwright')
const { build } = uiRequire('esbuild')
const react = await build({
  stdin: {
    contents: "import * as React from 'react';import * as ReactDOM from 'react-dom';import{createRoot}from'react-dom/client';window.testReact=React;window.testReactDOM=ReactDOM;window.createRoot=createRoot;",
    resolveDir: path.join(root, 'packages/standalone'),
  },
  bundle: true, write: false, format: 'iife', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
const engine = createMagpieEngine({ dataDir: path.join(scratch, 'data') })
const handler = createApiRoutes({
  magpieEngine: engine,
  connection: { admit: req => {
    const rejection = structuralRejection(req)
    return rejection ? { rejection } : undefined
  } },
})
const html = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--dsw-alias-label-primary:#24262c;--dsw-alias-label-secondary:#666975;--dsw-alias-label-tertiary:#8a8d98;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f7f8fa;--dsw-alias-bg-layer-3:#eef1f6;--dsw-alias-border-l1:#e5e7ed;--dsw-alias-border-l2:#d5d9e2;--dsw-alias-state-business-primary:#416fe8;--dsw-alias-state-success-primary:#249972;--dsw-alias-state-error-primary:#d94e62;color-scheme:light}
[data-theme=dark]{--dsw-alias-label-primary:#ebebee;--dsw-alias-label-secondary:#b5b5be;--dsw-alias-label-tertiary:#91919d;--dsw-alias-bg-layer-1:#1c1c20;--dsw-alias-bg-layer-2:#25252a;--dsw-alias-bg-layer-3:#33333a;--dsw-alias-border-l1:#393940;--dsw-alias-border-l2:#4e4e59;--dsw-alias-state-business-primary:#94b4ff;color-scheme:dark}
body{margin:0;padding:20px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);font:14px 'Segoe UI','Microsoft YaHei',sans-serif}#root{max-width:1080px;margin:auto;min-width:0}button{font-family:inherit}
@media(max-width:420px){body{padding:10px}}
</style></head><body><div id="root"></div><script src="/react.js"></script><script>window.__ModuleLoader__={load:r=>window.plugin=r.factory(name=>name==='react-dom'?window.testReactDOM:window.testReact)};</script><script src="/client.js"></script><script>
const {CSS,DICT,Shell}=plugin.__test;
document.head.append(Object.assign(document.createElement('style'),{textContent:CSS}));
const t=key=>DICT.zh[key]??key;t.locale='zh-CN';
const data={settings:{},catalog:[]};
window.summaryReloads=0;
window.createRoot(document.getElementById('root')).render(window.testReact.createElement(Shell,{
  t,data,summary:{data,reload(){window.summaryReloads++}},counts:{},stats:{reload(){}},ctx:{},eacLogin:{}
}));
</script></body></html>`
const server = http.createServer((req, res) => {
  const send = (value, type) => { res.writeHead(200, { 'content-type': type }); res.end(value) }
  if (req.url === '/') return send(html, 'text/html; charset=utf-8')
  if (req.url === '/react.js') return send(react.outputFiles[0].text, 'application/javascript')
  if (req.url === '/client.js') return send(fs.readFileSync(path.join(root, 'client.js')), 'application/javascript')
  if (req.url === '/favicon.ico') return send('', 'image/x-icon')
  if (req.url === '/api/our-free-model/subscriptions') return send('{"accounts":[]}', 'application/json')
  if (req.url === '/api/our-free-model/subscriptions/discover') return send('{"accounts":[]}', 'application/json')
  void handler(req, res).catch(error => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  })
})
let browser
const errors = [], failures = [], screenshots = []
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(edge) ? { executablePath: edge } : {}) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400 && ['script', 'stylesheet', 'image'].includes(response.request().resourceType())) {
      failures.push({ url: response.url(), status: response.status() })
    }
  })
  await page.addInitScript(() => localStorage.setItem('ofm.tab', 'subscriptions'))
  await page.goto(origin)
  await page.locator('#ofm-workspace-tab-accounts[aria-selected=true]').waitFor()
  assert.equal(await page.locator('.ofm_nav select').count(), 0)
  assert.equal(await page.locator('#ofm-tab-subscriptions').count(), 0)
  assert.equal(await page.locator('#ofm-tab-workspace').getAttribute('aria-selected'), 'true')
  assert.equal(await page.evaluate(() => localStorage.getItem('ofm.tab')), 'workspace')
  await page.getByText('尚未导入订阅账号。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '导入账号', exact: true }).click()
  const editor = page.locator('form')
  await editor.waitFor()
  await page.locator('#ofm-workspace-tab-tools').click()
  const frame = page.frameLocator('iframe.ofm_engineframe')
  await frame.locator('#nav').waitFor({ timeout: 120000 })
  await frame.locator('#nav button[data-view=providers]').click()
  await frame.locator('#view-providers').waitFor({ state: 'visible' })
  await frame.locator('#view-providers[aria-busy=true]').waitFor({ state: 'hidden' })
  await page.locator('#ofm-workspace-tab-accounts').click()
  await editor.waitFor({ state: 'visible' })
  await page.locator('#ofm-workspace-tab-tools').click()
  await frame.locator('#view-providers').waitFor({ state: 'visible' })
  console.log('ok unified workspace migrates old selection and preserves account editor and engine view')

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await page.waitForFunction(() => {
      const doc = document.querySelector('iframe')?.contentDocument
      return doc && getComputedStyle(doc.documentElement).getPropertyValue('--dsw-alias-label-primary').trim()
        === getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-label-primary').trim()
    })
    for (const width of [1280, 714, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.equal(await page.locator('.ofm_engineoverlay').count(), 0, 'narrow layout must remain in the unified workspace')
      await page.locator('#ofm-tab-workspace').focus()
      await page.keyboard.press('End')
      assert.equal(await page.locator('#ofm-tab-picks').getAttribute('aria-selected'), 'true')
      await page.locator('#ofm-tab-workspace').click()
      await page.locator('#ofm-workspace-tab-tools').click()
      await frame.locator('#nav').waitFor()
      for (const view of ['providers', 'agents', 'routing', 'settings']) {
        if (view === 'settings') await page.getByRole('button', { name: '工作台设置', exact: true }).click()
        else await frame.locator(`#nav button[data-view=${view}]`).click()
        await frame.locator(`#view-${view}`).waitFor({ state: 'visible' })
        await frame.locator(`#view-${view}[aria-busy=true]`).waitFor({ state: 'hidden' })
        if (view === 'routing') {
          await frame.locator('.rt-hub > b').filter({ hasText: 'Our Free Model' }).waitFor()
          assert.equal(await frame.locator('.rt-hub > svg.rt-bird').count(), 0)
          assert.equal(await frame.locator('.rt-hub > img.ofm-brand-icon').count(), 1)
        }
        if (view === 'providers') {
          await frame.locator('#addSheet input.find').waitFor({ state: 'visible' })
          await frame.locator('#providerDiscovery').evaluate(notice => {
            notice.hidden = false
            notice.querySelector('#providerDiscoveryCount').textContent = '发现 1 项本地供应商配置'
            notice.querySelector('#providerDiscoverySources').textContent = 'CC Switch (layout fixture)'
          })
          await frame.locator('.after-list.away').waitFor({ state: 'attached' })
          const compact = await frame.locator('body').evaluate(() => {
            const box = selector => document.querySelector(selector).getBoundingClientRect()
            const notice = box('#providerDiscovery')
            return { headerHeight: box('.top').height, gap: box('#addSheet').top - notice.bottom }
          })
          assert.ok(compact.headerHeight <= 80, `${width}: compact engine header: ${JSON.stringify(compact)}`)
          assert.ok(compact.gap <= 16, `${width}: discovery and add controls stay adjacent: ${JSON.stringify(compact)}`)
          const order = await page.locator('.ofm_enginetools').getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
          assert.deepEqual(order, ['展开工作台', '刷新模型', '工作台设置'], 'refresh and settings belong to the right of fullscreen')
        }
        const visibleBrand = await frame.locator('body').evaluate(body => {
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
          const matches = []
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const element = node.parentElement
            if (/magpie/i.test(node.textContent) && element.checkVisibility()
              && !element.closest('script,style,textarea,code,pre')) matches.push(node.textContent.trim())
          }
          return matches
        })
        assert.deepEqual(visibleBrand, [], `${theme}/${width}/${view}: no upstream product branding`)
        const overflow = await page.evaluate(() => ({
          outer: document.documentElement.scrollWidth > innerWidth + 2,
          inner: document.querySelector('iframe').contentDocument.documentElement.scrollWidth
            > document.querySelector('iframe').clientWidth + 2,
          nav: [...document.querySelectorAll('.ofm_tab')].filter(el => {
            const rect = el.getBoundingClientRect()
            return rect.left < 0 || rect.right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 2
          }).map(el => el.textContent),
        }))
        assert.deepEqual(overflow, { outer: false, inner: false, nav: [] }, `${theme}/${width}/${view}`)
        const file = path.join(scratch, `${theme}-${width}-${view}.png`)
        await page.screenshot({ path: file, fullPage: true })
        screenshots.push(file)
      }
    }
  }
  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  await page.locator('.ofm_engineoverlay').waitFor()
  await frame.locator('#nav').waitFor()
  await frame.locator('#nav button[data-view=providers]').press('Escape')
  assert.equal(await page.locator('.ofm_engineoverlay').count(), 1, 'engine Escape stays with its own editor and confirmation flow')
  await page.getByRole('button', { name: '收起工作台', exact: true }).click()
  await page.locator('.ofm_engineoverlay').waitFor({ state: 'detached' })
  assert.deepEqual(errors, [], 'no browser exceptions')
  assert.deepEqual(failures, [], 'all assets load')
  fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify({ passed: true, screenshots }, null, 2) + '\n')
  console.log(`ok horizontal navigation, embedded themes, branding and layout across 8 width/theme combinations; screenshots: ${scratch}`)
} finally {
  await browser?.close()
  await engine.close()
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
}
