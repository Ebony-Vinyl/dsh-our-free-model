/** 使用真实 React、插件组件与独立端构建验证广告交互；只访问本机接口。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createManagement } from '../packages/standalone/management.mjs'
import { buildStats } from '../src/core/stats.js'
import { SPONSOR, SPONSOR_DAY_KEY } from '../src/sponsor.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const standaloneRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
const require = createRequire(import.meta.url)
const { build } = standaloneRequire('esbuild')
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'playwright')
const output = process.env.OFM_SPONSOR_OUTPUT ?? path.join(root, '.verify/sponsor')
fs.mkdirSync(output, { recursive: true })
const reactBundle = await build({ stdin: { contents: `import * as React from 'react'; import {createRoot} from 'react-dom/client'; import {createPortal} from 'react-dom'; window.testReact=React; window.testDOM={createRoot,createPortal};`, resolveDir: path.join(root, 'packages/standalone') }, bundle: true, write: false, format: 'iife', minify: true, define: { 'process.env.NODE_ENV': '"production"' } })
const plugin = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const pluginHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root { --dsw-alias-label-primary:#283445;--dsw-alias-label-secondary:#566576;--dsw-alias-label-tertiary:#718091;--dsw-alias-bg-base:#f4f7fb;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#f4f7fb;--dsw-alias-bg-layer-3:#eaf0f7;--dsw-alias-border-l1:#e1e7ef;--dsw-alias-border-l2:#ccd7e4;--dsw-alias-accent-primary:#4264a2;--dsw-alias-state-business-primary:#4264a2;--dsw-alias-state-success-primary:#28785b;--dsw-alias-state-error-primary:#ae4354 }
body{margin:0;background:#f4f7fb;font:14px 'Segoe UI','Microsoft YaHei',sans-serif}#root{max-width:1120px;margin:auto;padding:24px;}
</style></head><body><div id="plugin-settings" role="dialog" aria-modal="true"><div id="root"></div></div><script src="/test-react.js"></script><script>
window.__ModuleLoader__={load:r=>window.plugin=r.factory(name=>name==='react'?window.testReact:window.testDOM)};
</script><script src="/test-client.js"></script><script>
const React=window.testReact,h=React.createElement,{CSS,Shell,DICT}=window.plugin.__test;
const sheet=document.createElement('style');sheet.textContent=CSS;document.head.append(sheet);
localStorage.setItem('ofm.tab','sponsor');const t=key=>DICT.zh[key]??key;t.locale='zh-CN';
window.testPluginRoot=window.testDOM.createRoot(document.getElementById('root'));
window.testPluginRoot.render(h(Shell,{t,data:{catalog:[],settings:{}},counts:{},summary:{reload(){}},stats:{reload(){}},eacAuth:{},setEacAuth(){},eacLogin:{},busy:false,setBusy(){},apply(){},bench(){},benches:{},ctx:{}}));
// 对齐宿主 SettingsPanel 的 document 级 Esc 关闭行为。
document.addEventListener('keydown',event=>{if(event.key==='Escape'){window.testPluginRoot.unmount();document.getElementById('plugin-settings').remove()}});
</script></body></html>`
const management = createManagement({ stores: { settings: { get: () => ({ forwardKey: 'isolated' }) } }, info: () => ({}) })
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/plugin')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pluginHtml) }
  if (req.url === '/test-react.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(reactBundle.outputFiles[0].contents) }
  if (req.url === '/test-client.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(plugin) }
  void management.handleRequest(req, res)
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
management.setPort(server.address().port)
const browser = await chromium.launch({ headless: true, ...(process.env.OFM_BROWSER_PATH ? { executablePath: process.env.OFM_BROWSER_PATH } : {}) })
const errors = [], checks = []
const check = (label, value) => { assert.ok(value, label); checks.push(label) }
const summary = { version: '2.5.3', baseUrl: origin, dataDir: 'isolated', networkMode: 'fixture', automaticRefresh: false,
  catalogSyncedAt: 0, settings: { enabled: true }, channels: { state: 'ready' }, eacAuth: { local: false }, catalog: [] }
const attach = async (context, theme = 'light') => {
  await context.addInitScript(({ key, theme }) => { localStorage.setItem('ofm-theme', theme); }, { key: SPONSOR_DAY_KEY, theme })
  await context.route('**/api/management/**', route => {
    const endpoint = new URL(route.request().url()).pathname.split('/api/management')[1]
    return route.fulfill({ json: endpoint === '/summary' ? summary : endpoint === '/stats' ? buildStats({}, []) : { ok: true } })
  })
}
const observe = page => page.on('pageerror', error => errors.push(error.message))
const stable = async page => { await page.locator('.ofm-sponsor-dialog[open]').waitFor(); await page.waitForTimeout(360) }
const shot = (page, name) => process.argv.includes('--no-screenshots') ? Promise.resolve() : page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false, animations: 'disabled' })
try {
  for (const variant of [
    { name: 'plugin', route: '/plugin', theme: 'light', width: 1400, height: 980 },
    { name: 'desktop-light', route: '/', theme: 'light', width: 1440, height: 1000 },
    { name: 'desktop-dark', route: '/', theme: 'dark', width: 1440, height: 1000 },
    { name: 'mobile-light', route: '/', theme: 'light', width: 390, height: 844 },
    { name: 'mobile-dark', route: '/', theme: 'dark', width: 390, height: 844 },
    { name: 'plugin-narrow', route: '/plugin', theme: 'light', width: 440, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, permissions: ['clipboard-read', 'clipboard-write'] })
    await attach(context, variant.theme)
    const page = await context.newPage(); observe(page)
    await page.goto(origin + variant.route); await stable(page)
    const dialog = page.locator('.ofm-sponsor-dialog')
    check(`${variant.name}: 原文全部进入可滚动公告`, (await dialog.locator('.ofm-sponsor-letter').innerText()).includes(SPONSOR.paragraphs[5]))
    check(`${variant.name}: 正文可独立滚动`, await dialog.locator('.ofm-sponsor-scroll').evaluate(e => e.scrollHeight > e.clientHeight))
    check(`${variant.name}: 没有横向溢出`, await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1))
    await shot(page, `${variant.name}-notice`)
    await page.keyboard.press('Tab')
    check(`${variant.name}: 键盘焦点留在当前公告内`, await dialog.evaluate(e => e.contains(document.activeElement)))
    await dialog.locator('.ofm-sponsor-scroll').evaluate(e => { e.scrollTop = e.scrollHeight })
    const image = dialog.locator('.ofm-sponsor-evidence img'); await image.scrollIntoViewIfNeeded()
    await image.evaluate(e => e.decode())
    check(`${variant.name}: 附图可正常显示`, await image.evaluate(e => e.naturalWidth === 1227))
    await shot(page, `${variant.name}-evidence`)
    check(`${variant.name}: 两个外链均带正确邀请码`, (await dialog.locator('a').evaluateAll(links => links.map(link => link.href))).every(url => url === SPONSOR.url))
    const close = dialog.getByRole('button', { name: '收起至菜单', exact: true })
    check(`${variant.name}: 阅读到底后收起按钮始终在视口内`, await close.evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }))
    await close.click()
    // Inspect the actual Web Animation end state: its destination is the sponsor menu.
    const motion = await dialog.evaluate(e => e.getAnimations().filter(a => a.playState === 'running').map(a => a.effect.getKeyframes()))
    check(`${variant.name}: 收起存在指向菜单的位移动画`, motion.some(frames => frames.some(frame => /translate\([^)]*px/.test(frame.transform ?? ''))))
    check(`${variant.name}: 动画目标菜单已进入可见范围`, await page.locator(variant.route === '/plugin' ? '#ofm-sponsor-menu-plugin' : '#ofm-sponsor-menu-desktop').evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 }))
    await page.waitForSelector('.ofm-sponsor-dialog[open]', { state: 'hidden' })
    check(`${variant.name}: 关闭后滚动锁已恢复`, await page.evaluate(() => document.body.style.overflow !== 'hidden'))
    await page.evaluate(key => { localStorage.setItem(key, '1900-01-01'); document.dispatchEvent(new Event('visibilitychange')) }, SPONSOR_DAY_KEY)
    await stable(page)
    check(`${variant.name}: 同一界面跨日再次弹出保持可见`, await dialog.evaluate(e => getComputedStyle(e).opacity === '1' && e.getAnimations().every(a => a.playState !== 'running')))
    await dialog.getByRole('button', { name: '收起至菜单', exact: true }).click()
    await page.waitForSelector('.ofm-sponsor-dialog[open]', { state: 'hidden' })
    const menu = page.locator(variant.route === '/plugin' ? '#ofm-sponsor-menu-plugin' : '#ofm-sponsor-menu-desktop')
    await menu.click(); await page.locator('.ofm-sponsor-page').waitFor()
    await page.waitForTimeout(320)
    check(`${variant.name}: 菜单标明广告并可重新阅读全文`, (await menu.innerText()).includes(SPONSOR.title) && await page.locator('.ofm-sponsor-page').isVisible())
    await shot(page, `${variant.name}-page`)
    await page.reload(); await page.waitForTimeout(1000)
    check(`${variant.name}: 同日刷新不再弹`, await page.locator('.ofm-sponsor-dialog[open]').count() === 0)
    await context.close()
  }
  // Real same-origin multi-window lock and next-day behavior, including Esc and reduced motion.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  await attach(context)
  const pages = await Promise.all([context.newPage(), context.newPage()]); pages.forEach(observe)
  await Promise.all(pages.map(page => page.goto(origin)))
  await pages[1].bringToFront(); await pages[1].waitForTimeout(1100)
  const openCounts = await Promise.all(pages.map(page => page.locator('.ofm-sponsor-dialog[open]').count()))
  check('同源两个窗口只有一个展示公告', openCounts.reduce((a, b) => a + b, 0) === 1)
  const opened = pages[openCounts.indexOf(1)]
  await opened.bringToFront(); await opened.keyboard.press('Escape')
  await opened.waitForSelector('.ofm-sponsor-dialog[open]', { state: 'hidden' })
  check('Esc 关闭并在减少动效模式下恢复菜单焦点', await opened.evaluate(() => document.activeElement.id === 'ofm-sponsor-menu-desktop'))
  await opened.evaluate(key => { const date = new Date(); date.setDate(date.getDate() - 1); localStorage.setItem(key, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`) }, SPONSOR_DAY_KEY)
  await opened.reload(); await stable(opened)
  check('下一本地日期首次进入再次展示', await opened.locator('.ofm-sponsor-dialog[open]').count() === 1)
  await context.close()
  const waiting = await browser.newContext()
  await attach(waiting)
  await waiting.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const d = document.createElement('dialog'); d.id = 'other-dialog'; d.textContent = 'Existing application dialog'; document.body.append(d); d.showModal() }) })
  const waitingPage = await waiting.newPage(); observe(waitingPage)
  await waitingPage.goto(origin); await waitingPage.waitForTimeout(1000)
  check('已有公告或登录窗口时不叠加广告', await waitingPage.locator('.ofm-sponsor-dialog[open]').count() === 0)
  await waitingPage.locator('#other-dialog').evaluate(e => e.close())
  await stable(waitingPage)
  check('已有窗口关闭后再正常展示当天公告', await waitingPage.locator('.ofm-sponsor-dialog[open]').count() === 1)
  await waiting.close()
  const pluginHost = await browser.newContext({ reducedMotion: 'reduce' })
  await attach(pluginHost)
  const pluginPage = await pluginHost.newPage(); observe(pluginPage)
  await pluginPage.goto(origin + '/plugin'); await stable(pluginPage)
  check('宿主设置弹窗内仍会展示插件每日公告', await pluginPage.locator('#plugin-settings[role="dialog"][aria-modal="true"]').isVisible())
  await pluginPage.keyboard.press('Escape')
  await pluginPage.waitForSelector('.ofm-sponsor-dialog[open]', { state: 'hidden' })
  check('Esc 只收起公告，保留宿主设置页与广告菜单焦点', await pluginPage.locator('#plugin-settings').isVisible() && await pluginPage.evaluate(() => document.activeElement.id === 'ofm-sponsor-menu-plugin'))
  await pluginPage.keyboard.press('Escape')
  check('公告关闭后 Esc 仍可关闭宿主设置页', await pluginPage.locator('#plugin-settings').count() === 0)
  check('设置页卸载后滚动锁已恢复', await pluginPage.evaluate(() => document.body.style.overflow !== 'hidden'))
  await pluginHost.close()
  const pluginWaiting = await browser.newContext()
  await attach(pluginWaiting)
  await pluginWaiting.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => {
    const other = document.createElement('div'); other.id = 'plugin-other-dialog'; other.setAttribute('role', 'dialog'); other.setAttribute('aria-modal', 'true'); other.textContent = '其他业务弹窗'
    document.getElementById('plugin-settings').append(other)
  }) })
  const pluginWaitingPage = await pluginWaiting.newPage(); observe(pluginWaitingPage)
  await pluginWaitingPage.goto(origin + '/plugin'); await pluginWaitingPage.waitForTimeout(1100)
  check('设置页中另有业务弹窗时继续避让', await pluginWaitingPage.locator('.ofm-sponsor-dialog[open]').count() === 0)
  check('避让业务弹窗时不消耗当天展示记录', await pluginWaitingPage.evaluate(key => localStorage.getItem(key) === null, SPONSOR_DAY_KEY))
  await pluginWaitingPage.locator('#plugin-other-dialog').evaluate(e => e.remove())
  await stable(pluginWaitingPage)
  check('业务弹窗关闭后在保留设置页的情况下展示公告', await pluginWaitingPage.locator('#plugin-settings').isVisible() && await pluginWaitingPage.locator('.ofm-sponsor-dialog[open]').count() === 1)
  await pluginWaiting.close()
  const blocked = await browser.newContext()
  await attach(blocked)
  await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError') } }))
  const privatePage = await blocked.newPage(); observe(privatePage)
  await privatePage.goto(origin); await privatePage.waitForTimeout(1100)
  check('存储不可用仍可正常使用，且不会反复弹广告', await privatePage.locator('.console-nav').isVisible() && await privatePage.locator('.ofm-sponsor-dialog[open]').count() === 0)
  await blocked.close()
  assert.deepEqual(errors, [], '前端不得出现未捕获错误')
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2))
  console.log(`sponsor-ui: ${checks.length} 项真实浏览器检查通过；截图：${output}`)
} finally { await browser.close(); management.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
