/** Real React + built standalone assets; APIs are isolated local fixtures, no account or external request. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createManagement } from '../packages/standalone/management.mjs'
import { buildStats } from '../src/core/stats.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const uiRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'playwright')
const { build } = uiRequire('esbuild')
const output = process.env.OFM_UI_SCREENSHOT_DIR ?? path.join(root, '.verify/managed-upgrade-ui')
fs.mkdirSync(output, { recursive: true })
const react = await build({ stdin: { contents: "import * as React from 'react';import{createRoot}from'react-dom/client';import{createPortal}from'react-dom';window.testReact=React;window.testDOM={createRoot,createPortal};", resolveDir: path.join(root, 'packages/standalone') }, bundle: true, write: false, format: 'iife', minify: true, define: { 'process.env.NODE_ENV': '"production"' } })
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--dsw-alias-label-primary:#283445;--dsw-alias-label-secondary:#566576;--dsw-alias-label-tertiary:#647488;--dsw-alias-bg-base:#f4f7fb;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f4f7fb;--dsw-alias-bg-layer-3:#eaf0f7;--dsw-alias-border-l1:#e1e7ef;--dsw-alias-border-l2:#ccd7e4;--dsw-alias-accent-primary:#4264a2;--dsw-alias-state-business-primary:#4264a2;--dsw-alias-state-success-primary:#28785b;--dsw-alias-state-error-primary:#ae4354}
body{margin:0;background:#f4f7fb;font:14px 'Segoe UI','Microsoft YaHei',sans-serif}#plugin-root{max-width:1120px;margin:auto;padding:16px;box-sizing:border-box}#other-plugin{position:fixed;bottom:0;left:0;font-size:10px;filter:blur(1px);animation:other-move 2s infinite alternate}@keyframes other-move{to{transform:translateX(2px)}}
[data-theme=dark]{--dsw-alias-label-primary:#e9edf5;--dsw-alias-label-secondary:#b2bed0;--dsw-alias-label-tertiary:#9aa8be;--dsw-alias-bg-base:#121724;--dsw-alias-bg-layer-1:#171d2d;--dsw-alias-bg-layer-2:#1b2333;--dsw-alias-bg-layer-3:#253149;--dsw-alias-border-l1:#334056;--dsw-alias-border-l2:#43516c}html[data-theme=dark] body{background:#121724}
</style></head><body><div id="plugin-root"></div><div id="other-plugin">other plugin fixture</div><script src="/test-react.js"></script><script>window.__ModuleLoader__={load:r=>window.plugin=r.factory(n=>n==='react'?window.testReact:window.testDOM)};</script><script src="/test-client.js"></script><script>
const {CSS,Shell,DICT}=window.plugin.__test;const style=document.createElement('style');style.textContent=CSS;document.head.append(style);const locale=new URLSearchParams(location.search).get('locale')==='en'?'en':'zh';const t=k=>DICT[locale][k]??k;t.locale=locale==='en'?'en-US':'zh-CN';document.documentElement.lang=t.locale;window.fixturePatches=[];window.testDOM.createRoot(document.getElementById('plugin-root')).render(window.testReact.createElement(Shell,{t,data:{catalog:[],settings:{}},counts:{},summary:{reload(){}},stats:{reload(){}},eacAuth:{},setEacAuth(){},eacLogin:{},busy:false,setBusy(){},apply(patch){window.fixturePatches.push(patch)},bench(){},benches:{},ctx:{}}));</script></body></html>`
const management = createManagement({ stores: { settings: { get: () => ({ forwardKey: 'fixture' }) } }, info: () => ({}) })
const report = {
  startedAt: new Date().toISOString(), fixtureOnly: true, realReact: true,
  servedAssets: 'current packages/standalone/web; no build performed',
  limitations: ['Local API fixtures; no real host installation or vendor account.', 'No GPU, frame time, power or real device performance measurement.', 'Standalone has no upgrade page; managed/self is the plugin UpgradePanel scope.', 'Plugin Shell mounts with host token fixtures, not the complete DSH application.'],
  scenarios: [], checks: [], pageErrors: [], externalRequestsBlocked: [], unexpectedApiRequests: [], screenshots: [],
}
const tracked = ['client.js', 'packages/standalone/frontend/settings.tsx', 'packages/standalone/frontend/app.tsx', 'packages/standalone/frontend/app.css', 'packages/standalone/frontend/components/shell.tsx', 'packages/standalone/web/app.js', 'packages/standalone/web/app.css', 'packages/standalone/web/assets.json', 'scripts/managed-upgrade-ui-test.mjs']
const fingerprints = () => Object.fromEntries(tracked.map(file => { const contents = fs.readFileSync(path.join(root, file)); return [file, { sha256: crypto.createHash('sha256').update(contents).digest('hex'), bytes: contents.length, modified: fs.statSync(path.join(root, file)).mtime.toISOString() }] }))
report.filesAtStart = fingerprints()
const server = http.createServer((req, res) => {
  const serve = (value, type) => { res.writeHead(200, { 'content-type': type }); res.end(value) }
  if (req.url.startsWith('/plugin')) return serve(html, 'text/html; charset=utf-8')
  if (req.url === '/test-react.js') return serve(react.outputFiles[0].contents, 'application/javascript')
  if (req.url === '/test-client.js') return serve(client, 'application/javascript')
  // Only public local static files reach management; account/API operations are fixtures below.
  if (req.url === '/' || req.url.startsWith('/assets/')) return void management.handleRequest(req, res)
  res.writeHead(404); res.end('fixture: unknown path')
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = 'http://127.0.0.1:' + server.address().port
management.setPort(server.address().port)
report.origin = origin
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const browser = await chromium.launch({ headless: true, ...(fs.existsSync(edge) ? { executablePath: edge } : {}) })
report.browser = { version: browser.version(), executable: fs.existsSync(edge) ? edge : 'playwright bundled Chromium', headless: true, profile: 'fresh isolated browser contexts' }
const variants = [
  { name: 'desktop-light', width: 1280, height: 900, theme: 'light' },
  { name: 'desktop-dark', width: 1280, height: 900, theme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, theme: 'light', mobile: true },
  { name: 'mobile-dark', width: 390, height: 844, theme: 'dark', mobile: true },
]
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const baseStatus = { managed: true, current: '2.5.6', installedVersion: '2.5.6', latest: '2.5.7', available: true, checkedAt: 0, applying: false, recoveryRequired: false }
let currentScenario
function verify(label, condition, actual) {
  const row = { scenario: currentScenario.name, label, status: condition ? 'passed' : 'failed', ...(actual === undefined ? {} : { actual }) }
  report.checks.push(row)
  if (!condition) console.error('FAIL ' + currentScenario.name + ': ' + label)
}
async function capture(page, name) {
  // Let finite entrance transitions finish naturally. Keep infinite decoration/loading
  // running so screenshots reflect normal loading behavior.
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))
    await Promise.race([Promise.allSettled(finite.map(animation => animation.finished)), new Promise(resolve => setTimeout(resolve, 1800))])
  })
  const file = path.join(output, name + '.png')
  await page.screenshot({ path: file, fullPage: true, animations: 'allow' })
  const state = await page.evaluate(() => ({ url: location.href, theme: document.documentElement.dataset.theme, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, roots: [...document.querySelectorAll('.ofm_root,.ofm_toasts,[data-ofm-announcement-root],.ofm_scrim[data-ofm-urgent]')].map(el => ({ className: el.className })), switches: [...document.querySelectorAll('[role=switch]')].map(el => ({ text: el.textContent, label: el.labels ? [...el.labels].map(label => label.textContent).join(' ') : null, checked: el.getAttribute('aria-checked') ?? String(el.checked), disabled: el.disabled })), buttons: [...document.querySelectorAll('button')].filter(el => el.offsetWidth || el.offsetHeight).map(el => ({ text: el.textContent, disabled: el.disabled })), status: [...document.querySelectorAll('[role=status],[role=alert]')].map(el => el.textContent) }))
  await fs.promises.writeFile(path.join(output, name + '.state.json'), JSON.stringify(state, null, 2) + '\n')
  await fs.promises.writeFile(path.join(output, name + '.aria.txt'), await page.locator('body').ariaSnapshot())
  report.screenshots.push({ scenario: currentScenario.name, path: file, theme: state.theme, width: state.width, scrollWidth: state.scrollWidth })
}
async function setup(variant, options = {}) {
  const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, colorScheme: variant.theme, ...(variant.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}) })
  context.setDefaultTimeout(8000)
  context.setDefaultNavigationTimeout(15000)
  await context.addInitScript(({ theme }) => {
    try {
      localStorage.setItem('ofm-theme', theme); localStorage.setItem('ofm.tab', 'upgrade')
      const date = new Date(); localStorage.setItem('ofm.sponsor.last-shown.v1', date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'))
    } catch {}
    window.fixtureTransitionCalls = 0
    const transition = document.startViewTransition?.bind(document)
    if (transition) document.startViewTransition = (...args) => { window.fixtureTransitionCalls++; return transition(...args) }
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = theme })
  }, { theme: variant.theme })
  const state = { status: { ...baseStatus }, statusGate: options.statusGate, summaryGate: options.summaryGate, statusError: false, actions: [], requests: [], actionGate: null }
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { report.externalRequestsBlocked.push({ scenario: currentScenario.name, url: url.href }); return route.abort() }
    const endpoint = url.pathname
    const json = (value, status = 200) => route.fulfill({ status, json: value })
    if (endpoint.startsWith('/api/our-free-model/')) {
      const part = endpoint.slice('/api/our-free-model'.length)
      state.requests.push({ endpoint: part, method: route.request().method() })
      if (part === '/update/status') { if (state.statusGate) await state.statusGate.promise; return state.statusError ? json({ error: 'fixture update status unavailable' }, 503) : json(state.status) }
      if (['/update/check', '/update/apply', '/reload'].includes(part)) {
        state.actions.push(part)
        if (state.actionGate) await state.actionGate.promise
        return json({ ok: true, version: '2.5.7', reloaded: true })
      }
      if (part === '/meta') return json({ version: '2.5.6', distribution: state.status.managed ? 'managed' : 'self' })
      if (part === '/announcements' || part === '/announcement') return json({ items: [], unread: 0 })
      // Denied storage makes Shell start on its default page, whose read-only panels also mount.
      if (part === '/forward/lan/addresses') return json({ addresses: [] })
      if (part === '/outlet') return json({ enabled: false, active: false, mode: 'client' })
      report.unexpectedApiRequests.push({ scenario: currentScenario.name, endpoint }); return json({ error: 'unimplemented fixture endpoint' }, 501)
    }
    if (endpoint.startsWith('/api/management/')) {
      const part = endpoint.slice('/api/management'.length)
      state.requests.push({ endpoint, method: route.request().method() })
      const settings = { enabled: true, exposeRegionModels: true, streamRecovery: true, standaloneProbe: false, defaultMaxTokens: 32768, probeIntervalMinutes: 15, hiddenModelIds: [] }
      const summary = { version: 'fixture', baseUrl: origin, dataDir: 'isolated-fixture', networkMode: 'fixture', automaticRefresh: false, settings, channels: { state: 'ready' }, eacAuth: { local: false }, catalog: [] }
      if (part === '/summary') { if (state.summaryGate) await state.summaryGate.promise; return json(summary) }
      if (part === '/stats') return json(buildStats({}, []))
      if (part === '/eac/status') return json({ available: true, authorized: false, local: false })
      report.unexpectedApiRequests.push({ scenario: currentScenario.name, endpoint }); return json({ error: 'unimplemented fixture endpoint' }, 501)
    }
    return route.continue()
  })
  context.on('page', page => page.on('pageerror', error => report.pageErrors.push({ scenario: currentScenario?.name, message: error.message, stack: error.stack })))
  return { context, state }
}
async function openPlugin(page, locale = 'zh') {
  await page.goto(origin + '/plugin?locale=' + locale)
  await page.getByRole('button', { name: names(locale).check, exact: true }).waitFor()
}
const names = locale => locale === 'en' ? { check: 'Check for updates', apply: 'Upgrade now', reload: 'Hot-reload plugin', watch: 'Hot-reload on file change', tab: 'Upgrade' } : { check: '检查更新', apply: '立即升级', reload: '热重载插件', watch: '文件变化自动热重载', tab: '升级' }
const managedText = locale => locale === 'en' ? 'This installation is managed by the host that installed it. Update through the original installation method; in-plugin checks, upgrades and hot reload are unavailable.' : '此安装由安装它的宿主管理，请通过原安装方式更新；插件内检查、升级和热重载不可用。'
async function ownerEvent(page) { await page.evaluate(() => window.dispatchEvent(new CustomEvent('ofm:upgraded', { detail: {} }))) }
async function allOwnerDisabled(page, locale = 'zh') {
  const n = names(locale)
  return (await Promise.all([page.getByRole('button', { name: n.check, exact: true }).isDisabled(), page.getByRole('button', { name: n.apply, exact: true }).isDisabled(), page.getByRole('button', { name: n.reload, exact: true }).isDisabled(), page.getByRole('switch', { name: n.watch, exact: true }).isDisabled()])).every(Boolean)
}
async function scenario(name, variant, options, run) {
  currentScenario = { name, variant: variant.name, startedAt: new Date().toISOString(), status: 'running' }
  report.scenarios.push(currentScenario)
  const { context, state } = await setup(variant, options)
  const page = await context.newPage()
  try { await run({ page, context, state }); currentScenario.status = report.checks.some(row => row.scenario === name && row.status === 'failed') ? 'failed' : 'passed' }
  catch (error) {
    currentScenario.status = 'failed'; currentScenario.error = { message: error.message, stack: error.stack }
    try { await capture(page, name + '-FAILURE'); await fs.promises.writeFile(path.join(output, name + '-FAILURE.html'), await page.content()) } catch (captureError) { currentScenario.captureError = captureError.message }
    console.error(name + ': ' + error.message)
  } finally {
    state.statusGate?.resolve(); state.summaryGate?.resolve(); state.actionGate?.resolve()
    currentScenario.finishedAt = new Date().toISOString(); currentScenario.requests = state.requests; currentScenario.actions = state.actions
    await context.close()
    fs.writeFileSync(path.join(output, 'results.partial.json'), JSON.stringify(report, null, 2) + '\n')
  }
}
try {
  for (const locale of ['zh', 'en']) {
    const variant = variants[locale === 'en' ? 2 : 1]
    const statusGate = defer()
    await scenario('plugin-upgrade-states-' + locale, variant, { statusGate }, async ({ page, state }) => {
      await openPlugin(page, locale)
      const n = names(locale)
      verify('unknown owner keeps check/reload/watch disabled', await page.getByRole('button', { name: n.check, exact: true }).isDisabled() && await page.getByRole('button', { name: n.reload, exact: true }).isDisabled() && await page.getByRole('switch', { name: n.watch, exact: true }).isDisabled())
      await capture(page, 'plugin-upgrade-' + locale + '-loading')
      state.statusError = true; statusGate.resolve()
      await page.getByText(/fixture update status unavailable/).waitFor()
      verify('status error keeps controls disabled', await page.getByRole('button', { name: n.check, exact: true }).isDisabled() && await page.getByRole('button', { name: n.reload, exact: true }).isDisabled())
      await capture(page, 'plugin-upgrade-' + locale + '-error')
      state.statusGate = null; state.statusError = false; await ownerEvent(page)
      await page.getByText(managedText(locale), { exact: true }).waitFor()
      verify('localized managed guidance recovers after error', await allOwnerDisabled(page, locale))
      await capture(page, 'plugin-upgrade-' + locale + '-managed')
      state.status.managed = false; await ownerEvent(page)
      await page.waitForFunction(label => [...document.querySelectorAll('button')].find(el => el.textContent === label)?.disabled === false, n.apply)
      state.actionGate = defer()
      await page.getByRole('button', { name: n.apply, exact: true }).click()
      await page.getByRole('progressbar').waitFor()
      verify('self upgrade shows live progress during application', await page.getByRole('progressbar').isVisible())
      verify('loading progress keeps its essential animation', await page.locator('.ofm_prog i').evaluate(el => getComputedStyle(el).animationName === 'ofm-prog-slide'))
      await capture(page, 'plugin-upgrade-' + locale + '-self-applying')
      state.status.managed = true; await ownerEvent(page)
      await page.getByText(managedText(locale), { exact: true }).waitFor()
      verify('managed transition removes stale progress', await page.getByRole('progressbar').count() === 0 && await allOwnerDisabled(page, locale))
      const actionResponse = page.waitForResponse(response => response.url().endsWith('/api/our-free-model/update/apply'))
      state.actionGate.resolve(); await (await actionResponse).finished()
      verify('upgrade action stayed within local fixture', state.actions.includes('/update/apply'))
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      verify('late self action cannot revive managed controls', await allOwnerDisabled(page, locale))
      await capture(page, 'plugin-upgrade-' + locale + '-managed-after-late-action')
    })
  }
} finally {
  report.filesAtEnd = fingerprints(); report.finishedAt = new Date().toISOString()
  report.fileChangesDuringRun = tracked.filter(file => report.filesAtStart[file].sha256 !== report.filesAtEnd[file].sha256)
  report.summary = { scenarios: report.scenarios.length, passedScenarios: report.scenarios.filter(s => s.status === 'passed').length, failedScenarios: report.scenarios.filter(s => s.status !== 'passed').length, checks: report.checks.length, failedChecks: report.checks.filter(c => c.status === 'failed').length, pageErrors: report.pageErrors.length, screenshots: report.screenshots.length, unexpectedApiRequests: report.unexpectedApiRequests.length }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report.summary))
  await browser.close(); management.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  if (report.summary.failedScenarios || report.summary.failedChecks || report.summary.pageErrors || report.summary.unexpectedApiRequests) process.exitCode = 1
}
