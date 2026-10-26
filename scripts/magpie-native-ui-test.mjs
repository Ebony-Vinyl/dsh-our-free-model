/**
 * Native DSH acceptance of the packaged plugin and integrated workbench UI.
 * Run: node scripts/magpie-native-ui-test.mjs [--prepare-only]
 * All mutable state and package copies stay under .verify/magpie-native-ui.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const runFile = promisify(execFile)
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const executable = path.resolve(option('--dsh', process.env.OFM_DSH_BINARY ?? 'D:/deepseek官方桌面端/DeepSeek Harness.exe'))
const activeHome = path.resolve(process.env.OFM_DSH_ACTIVE_HOME ?? 'C:/Users/HUAWEI/.dsh')
const output = path.join(repository, '.verify', 'magpie-native-ui')
fs.mkdirSync(output, { recursive: true })
const scratch = fs.mkdtempSync(path.join(output, 'run-'))
const isolatedHome = path.join(scratch, 'home')
const dshHome = path.join(scratch, 'dsh-home')
const profile = path.join(dshHome, 'profiles', 'desktop')
const packageRoot = path.join(profile, 'node_modules', 'dsh-our-free-model')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const digest = file => fs.existsSync(file) ? hash(fs.readFileSync(file)) : null
const json = value => JSON.stringify(value, null, 2) + '\n'
const scrub = value => String(value)
  .replace(/([?&](?:token|k|key)=)[^&\s"']+/gi, '$1[redacted]')
  .replace(/\b(?:Bearer\s+|sk-magpie-key-)[\w.-]+/gi, '[redacted]')
const report = {
  schema: 'ofm-magpie-native-ui/v1', startedAt: new Date().toISOString(),
  scratch, executable, dshHome, profile, packageRoot,
  checks: [], screenshots: [], errors: [], assetFailures: [], layoutFailures: [],
  limits: {
    installedNativeDsh: true, integratedEngineUi: true, fixtureProviderOnly: true,
    realAccountInference: false, existingAppsNavigated: false,
    existingPluginOverwritten: false,
  },
}
const protectedFiles = [
  'profiles/desktop/package.json', 'profiles/desktop/cordis.patch.yml',
  'our-free-model/settings.json', '.credentials.yaml',
].map(file => ({ file: path.join(activeHome, file), before: digest(path.join(activeHome, file)) }))
const owned = []
let native, browser, inspector, page, frame, fixture, captureSession
let fixtureBase = ''
let hostOutput = ''
let deadlineTimer

function save() {
  fs.writeFileSync(path.join(scratch, 'result.json'), json(report))
  fs.writeFileSync(path.join(output, 'latest.json'), json(report))
}
function check(name, condition, details) {
  report.checks.push({ name, passed: Boolean(condition), ...(details === undefined ? {} : { details }) })
  console.log(`${condition ? 'ok' : 'FAIL'} ${name}`)
  save()
  return condition
}
function insideScratch(file) {
  const relative = path.relative(scratch, path.resolve(file))
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'Mutable test path must remain inside its run directory')
  return file
}
function write(file, value) {
  insideScratch(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function until(action, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await action()
    if (result) return result
    if (native && native.exitCode !== null) throw new Error(`Owned DSH exited during ${description}`)
    await delay(200)
  }
  throw new Error(`Timed out: ${description}`)
}
async function processes() {
  const script = "Get-Process -Name 'DeepSeek Harness','ChatGPT','Codex' -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path | ConvertTo-Json -Compress"
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000 })
  const data = JSON.parse(stdout || '[]')
  return (Array.isArray(data) ? data : [data]).map(row => ({
    pid: row.Id, born: row.StartTime, executable: row.Path,
  }))
}
async function packagePlugin() {
  const npm = process.env.OFM_NPM_CLI ?? 'D:/nodejs/node_modules/npm/bin/npm-cli.js'
  const { stdout } = await runFile(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', scratch], {
    cwd: repository, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_update_notifier: 'false' },
  })
  const packed = JSON.parse(stdout)[0]
  const archive = path.join(scratch, packed.filename)
  const extraction = path.join(scratch, 'extracted')
  fs.mkdirSync(extraction)
  await runFile('tar.exe', ['-xf', archive, '-C', extraction], { windowsHide: true, timeout: 30000 })
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true })
  fs.renameSync(insideScratch(path.join(extraction, 'package')), insideScratch(packageRoot))
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  const client = fs.readFileSync(path.join(packageRoot, 'client.js'), 'utf8')
  report.package = {
    version: manifest.version, archive, archiveSha256: digest(archive),
    clientSha256: hash(client), indexSha256: digest(path.join(packageRoot, 'index.js')),
    engineSha256: digest(path.join(packageRoot, 'src', 'magpie-engine.js')),
    transportSha256: digest(path.join(packageRoot, 'src', 'loopback-fetch.js')),
    engineModelsSha256: digest(path.join(packageRoot, 'src', 'magpie-models.js')),
    workspacePresent: /function ModelWorkspace\b/.test(client),
    engineMetadata: fs.existsSync(path.join(packageRoot, 'vendor/magpie/engine.json'))
      ? JSON.parse(fs.readFileSync(path.join(packageRoot, 'vendor/magpie/engine.json'), 'utf8')) : null,
  }
  assert.equal(hash(client), digest(path.join(repository, 'client.js')), 'Packed client must match the source snapshot')
  assert.ok(report.package.workspacePresent, 'Packaged client has no native model workspace')
  assert.ok(fs.existsSync(path.join(packageRoot, 'vendor/magpie/bin/magpie-win32-x64.exe')), 'Packaged engine binary is unavailable')
  write(path.join(profile, 'package.json'), json({
    name: 'ofm-magpie-native-acceptance', private: true,
    dependencies: { 'dsh-our-free-model': `file:${archive.replaceAll('\\', '/')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-our-free-model'] } },
  }))
  write(path.join(profile, 'cordis.yml'), '[]\n')
  write(path.join(profile, 'cordis.patch.yml'), [
    '- id: ui-settings-account', '  config:', '    version: 1', '    step: done',
    '    usage: detailed', '    developerTools: true', '    process: standard', '    completion: api-key',
    '- id: ui-theme', '  config:', '    preference: system',
    '- id: locale', '  config:', '    preference: en',
  ].join('\n') + '\n')
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    fs.mkdirSync(path.join(isolatedHome, name), { recursive: true })
  }
  const engineConfig = path.join(dshHome, 'our-free-model', 'magpie', 'config', 'magpie')
  write(path.join(engineConfig, 'settings.json'), json({
    noAccountDiscovery: true, noStats: true, noUsageStats: true, noWSLAgents: true,
    noAutoUpdate: true, noAutoDownload: true, autoRestart: false, lang: 'en', theme: 'light',
  }))
  write(path.join(dshHome, 'our-free-model', 'settings.json'), json({
    enabled: true, probeIntervalMinutes: 0, announcementAck: '2026-10-17.3',
    announcementsAcked: ['2026-10-17.3'],
    forward: { enabled: false, host: '127.0.0.1', port: 0, lan: { enabled: false, port: 0 } },
  }))
  check('new real plugin directory contains packaged source and engine', true)
}
function debuggerClient(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  const handlers = new Map()
  let sequence = 0
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const target = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(target?.timer)
      if (message.error) target?.reject(new Error(message.error.message))
      else target?.resolve(message.result)
    } else {
      handlers.get(message.method)?.(message.params)
    }
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return {
    ready, socket, on(name, handler) { handlers.set(name, handler) },
    async send(method, params = {}) {
      await ready
      return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)) }, 10000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      for (const target of pending.values()) { clearTimeout(target.timer); target.reject(new Error('Inspector disconnected')) }
      pending.clear()
      socket.close()
    },
  }
}
async function startNative() {
  const debugPort = await freePort()
  const inspectPort = await freePort()
  report.cdp = `http://127.0.0.1:${debugPort}`
  const environment = {
    ...process.env, DSH_HOME: dshHome,
    USERPROFILE: isolatedHome, HOME: isolatedHome,
    APPDATA: path.join(isolatedHome, 'APPDATA'), LOCALAPPDATA: path.join(isolatedHome, 'LOCALAPPDATA'),
    OUR_FREE_MODEL_BASE: fixtureBase, OUR_FREE_MODEL_KILO_BASE: fixtureBase,
    DSH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', MAGPIE_NO_STATS: '1',
    DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_DESKTOP_DIAGNOSTIC_FILE: path.join(scratch, 'native-diagnostic.log'),
    NODE_OPTIONS: '', NODE_PATH: '',
  }
  delete environment.ELECTRON_RUN_AS_NODE
  native = spawn(executable, [
    `--user-data-dir=${path.join(scratch, 'electron')}`,
    `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1',
    `--inspect-brk=127.0.0.1:${inspectPort}`,
    '--force-device-scale-factor=1', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
  ], { cwd: scratch, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  owned.push(native)
  const collect = chunk => { hostOutput = (hostOutput + scrub(chunk)).slice(-30000) }
  native.stdout.on('data', collect)
  native.stderr.on('data', collect)
  native.on('error', error => { report.errors.push(scrub(error.message)) })
  report.nativePid = native.pid
  const targets = await until(async () => {
    try { return await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json() } catch {}
  }, 20000, 'isolated native main inspector')
  inspector = debuggerClient(targets[0].webSocketDebuggerUrl)
  await inspector.send('Debugger.enable')
  let paused
  const waiting = new Promise(resolve => { paused = resolve })
  inspector.on('Debugger.paused', paused)
  await inspector.send('Runtime.runIfWaitingForDebugger')
  await Promise.race([waiting, delay(5000).then(() => { throw new Error('Native main did not pause before startup') })])
  // Hide only this owned native instance and suppress its global protocol registration.
  const hidden = await inspector.send('Runtime.evaluate', { expression: `(() => {
    const electron = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    electron.app.setPath('userData', ${JSON.stringify(path.join(scratch, 'electron'))});
    electron.app.setAsDefaultProtocolClient = () => false;
    globalThis.__ofmNativeAcceptance = {showInactive: electron.BrowserWindow.prototype.showInactive};
    electron.BrowserWindow.prototype.show = function() {};
    electron.BrowserWindow.prototype.showInactive = function() {};
    electron.BrowserWindow.prototype.focus = function() {};
    electron.app.on('browser-window-created', (_, window) => window.webContents.setBackgroundThrottling(false));
    return {pid: process.pid, electron: process.versions.electron};
  })()`, returnByValue: true })
  assert.ok(!hidden.exceptionDetails, 'Unable to isolate/hide the owned native DSH instance')
  report.native = hidden.result?.value
  await inspector.send('Debugger.resume')
  await until(async () => {
    try { return (await fetch(`${report.cdp}/json/version`, { signal: AbortSignal.timeout(1000) })).ok } catch {}
  }, 45000, 'native renderer CDP')
  const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'D:/Cache/npm-global/node_modules/playwright')
  browser = await chromium.connectOverCDP(report.cdp)
  const context = browser.contexts()[0]
  context.on('page', observe)
  for (const current of context.pages()) observe(current)
  page = await until(async () => context.pages().find(item => item.url().startsWith('dsh-app://app/')), 60000, 'native DSH application page')
  await page.waitForLoadState('domcontentloaded')
  captureSession = await context.newCDPSession(page)
  report.applicationUrl = page.url().split('?')[0]
  check('actual installed Electron renders the actual DSH application', true, report.native)
}
function observe(target) {
  target.on('pageerror', error => { report.errors.push(scrub(error.stack ?? error.message)) })
  target.on('response', response => {
    const request = response.request()
    if (response.status() >= 400 && ['script', 'stylesheet', 'font', 'image', 'document'].includes(request.resourceType())) {
      report.assetFailures.push({ url: scrub(response.url()), status: response.status(), type: request.resourceType() })
    }
  })
  target.on('requestfailed', request => {
    if (['script', 'stylesheet', 'font', 'image'].includes(request.resourceType()) && request.failure()?.errorText !== 'net::ERR_ABORTED') {
      report.assetFailures.push({ url: scrub(request.url()), failure: request.failure()?.errorText, type: request.resourceType() })
    }
  })
}
async function pluginApi(endpoint, body) {
  return page.evaluate(async ({ endpoint, body }) => {
    const response = await fetch('/api/our-free-model' + endpoint, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    const raw = await response.text()
    let data
    try { data = JSON.parse(raw) } catch {}
    return { status: response.status, data }
  }, { endpoint, body })
}
async function workspace() {
  const summary = await until(async () => {
    try { const response = await pluginApi('/summary'); return response.status === 200 && response.data } catch {}
  }, 60000, 'installed plugin API')
  check('installed plugin API reports packaged version', summary.version === report.package.version)
  await until(async () => {
    for (const candidate of browser.contexts()[0].pages()) {
      if (candidate === page) continue
      const skip = candidate.getByRole('button', { name: /^(Skip|Skip for now|Set up later|跳过|暂时跳过)$/ })
      if (await skip.first().isVisible().catch(() => false)) await skip.first().click()
      else if (candidate.url().includes('welcome.html')) {
        const api = candidate.getByRole('button', { name: 'Add API Key', exact: true })
        for (const button of await api.all()) if (await button.isVisible()) { await button.click(); break }
      }
    }
    const later = page.locator('.ofm_ann').getByRole('button', { name: /^(Later|稍后)$/ })
    if (await later.isVisible().catch(() => false)) await later.click()
    return await page.getByRole('button', { name: /Settings|设置/i }).count() ||
      await page.locator('.ofm_root').count() ||
      await page.getByRole('button', { name: 'Account menu', exact: true }).count()
  }, 60000, 'DSH plugin loading and first-run welcome')
  const announcement = page.locator('.ofm_ann')
  if (await announcement.isVisible().catch(() => false)) {
    await announcement.getByRole('button', { name: /^(Later|稍后再说)$/ }).click()
    await announcement.waitFor({ state: 'hidden' })
  }
  const opened = await page.locator('.ofm_root').count()
  if (!opened) {
    const account = page.getByRole('button', { name: 'Account menu', exact: true })
    if (await account.count()) await account.click()
    const menuSettings = page.getByRole('menuitem', { name: /Settings|设置/i })
    const settings = page.getByRole('button', { name: /Settings|设置/i })
    if (await menuSettings.count()) await menuSettings.first().click()
    else if (await settings.count()) await settings.first().click()
    else {
      const fallback = page.locator('[data-testid*=settings],button[title="Settings"],button[aria-label="设置"]')
      assert.ok(await fallback.count(), 'Could not locate the actual DSH settings entry')
      await fallback.first().click()
    }
    const plugin = page.getByText(/^(Our Free Model|我们的免费模型|免费模型)$/)
    await plugin.first().waitFor()
    await plugin.first().click()
  }
  await page.locator('.ofm_root').first().waitFor({ timeout: 30000 })
  const workspaceTab = page.locator('#ofm-tab-workspace')
  await workspaceTab.waitFor({ state: 'visible', timeout: 60000 })
  if (await workspaceTab.getAttribute('aria-selected') !== 'true') {
    await workspaceTab.click()
  }
  await page.locator('iframe.ofm_engineframe').waitFor({ timeout: 120000 })
  frame = await page.locator('iframe.ofm_engineframe').contentFrame()
  await frame.locator('#nav').waitFor({ timeout: 60000 })
  await frame.locator('#addProvider').waitFor({ state: 'attached' })
  await until(async () => frame.locator('#nav button[data-view="providers"]').evaluate(button =>
    typeof button.onclick === 'function').catch(() => false), 30000, 'initial engine navigation handlers')
  check('native plugin restores horizontal tabs without a navigation select',
    await page.locator('.ofm_nav select').count() === 0 && await page.locator('.ofm_nav .ofm_tabs').isVisible())
  check('native plugin merges subscriptions into the workspace',
    await page.locator('#ofm-tab-subscriptions').count() === 0
      && await page.locator('#ofm-workspace-tab-accounts').isVisible())
  await page.getByRole('button', { name: 'Expand workspace', exact: true }).click()
  await page.locator('.ofm_engineoverlay').waitFor({ state: 'visible' })
  await frame.locator('#nav').waitFor()
  await until(async () => frame.locator('#nav button[data-view="providers"]').evaluate(button =>
    typeof button.onclick === 'function').catch(() => false), 30000, 'engine navigation after expansion')
  const engine = await pluginApi('/engine/status')
  check('packaged engine reaches ready state through plugin', engine.status === 200 && engine.data?.state === 'ready', engine.data)
  const engineSettings = await engineApi('settings')
  const engineDirectory = engineSettings.data?.dir
  const relative = typeof engineDirectory === 'string' ? path.relative(dshHome, path.resolve(engineDirectory)) : '..'
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'The real engine must keep its state under the isolated DSH_HOME before any mutation')
  report.engineDirectory = engineDirectory
  check('actual engine state is confined to the isolated DSH_HOME', true, { directory: engineDirectory })
  const loadedSource = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map(entry => entry.name)
    const candidates = urls.filter(url => /our-free-model/.test(url) && /client(?:\.js|[/?])/.test(url))
    for (const url of candidates) {
      const response = await fetch(url)
      const text = await response.text()
      if (text.includes('function ModelWorkspace')) return { url: url.split('?')[0], text }
    }
    return { candidates }
  })
  if (loadedSource.text) {
    report.clientResource = { url: loadedSource.url, sha256: hash(loadedSource.text) }
    check('native renderer loaded the exact packaged client bytes', hash(loadedSource.text) === report.package.clientSha256)
  } else {
    const session = await browser.contexts()[0].newCDPSession(page)
    const scripts = []
    session.on('Debugger.scriptParsed', script => scripts.push(script))
    await session.send('Debugger.enable')
    const expected = fs.readFileSync(path.join(packageRoot, 'client.js'), 'utf8')
    let found
    for (const script of scripts.filter(item => /our-free-model/.test(item.url) ||
      item.length >= expected.length && item.length <= expected.length + 10000)) {
      const source = (await session.send('Debugger.getScriptSource', { scriptId: script.scriptId })).scriptSource
      if (source.includes(expected)) {
        found = { url: scrub(script.url), sha256: hash(expected), executedBytes: source.length, exactPackageSourceContained: true }
        break
      }
    }
    await session.detach()
    report.clientResource = found ?? { candidates: scripts.map(item => ({ url: scrub(item.url), length: item.length })).filter(item => item.length > 100000) }
    check('native renderer executes the exact packaged client source', Boolean(found), found)
  }
}
async function engineApi(endpoint, body) {
  return frame.locator('body').evaluate(async (_, { endpoint, body }) => {
    const response = await fetch('api/' + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    })
    return { status: response.status, data: await response.json() }
  }, { endpoint, body })
}
async function navigate(view) {
  if (view === 'settings') await page.getByRole('button', { name: 'Workspace settings', exact: true }).click()
  else await frame.locator(`button[data-view="${view}"]`).click()
  await frame.locator(`#view-${view}`).waitFor({ state: 'visible', timeout: 30000 })
}
async function openAddSheet() {
  const state = await engineApi('providers')
  if (state.data?.providers?.length === 0) {
    await frame.locator('#addSheet').waitFor({ state: 'visible', timeout: 30000 })
  } else if (!await frame.locator('#addSheet').isVisible()) {
    await frame.locator('#addProvider').click()
    await frame.locator('#addSheet').waitFor({ state: 'visible', timeout: 30000 })
  }
}
async function measurements(target) {
  return target.locator('body').evaluate(body => {
    const scope = body.querySelector('.ofm_engineoverlay') || body.querySelector('.ofm_root') || body
    const visible = element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' &&
        !element.closest('[hidden],[inert]')
    }
    const issues = []
    for (const element of scope.querySelectorAll('button,input,select,textarea,iframe.ofm_engineframe,.nm .n,.who .name,.pv-name,.lib-name')) {
      if (!visible(element)) continue
      const box = element.getBoundingClientRect(), style = getComputedStyle(element)
      const horizontal = element.scrollWidth > element.clientWidth + 2
      const vertical = element.scrollHeight > element.clientHeight + 2
      const clipsX = ['hidden', 'clip'].includes(style.overflowX)
      const clipsY = ['hidden', 'clip'].includes(style.overflowY)
      const clipped = horizontal && clipsX || vertical && clipsY
      const outside = box.left < -2 || box.right > innerWidth + 2
      const navigation = element.closest('nav,.seg,.segs,.tabs,.lib-tabs,[role=tablist]')
      let scrollable = false
      for (let parent = element.parentElement; parent && parent !== body; parent = parent.parentElement) {
        if (!navigation || parent === navigation.parentElement) break
        if (parent.scrollWidth > parent.clientWidth + 2 && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(parent).overflowX)) {
          scrollable = true
          break
        }
      }
      let visibleLeft = Math.max(0, box.left), visibleRight = Math.min(innerWidth, box.right)
      const clippingAncestors = []
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (!['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowX)) continue
        const bounds = parent.getBoundingClientRect()
        const left = bounds.left + parent.clientLeft, right = left + parent.clientWidth
        if (left > visibleLeft + 2 || right < visibleRight - 2) {
          clippingAncestors.push({ tag: parent.tagName, class: String(parent.className), id: parent.id,
            left: Math.round(left), right: Math.round(right), overflow: getComputedStyle(parent).overflowX })
        }
        visibleLeft = Math.max(visibleLeft, left)
        visibleRight = Math.min(visibleRight, right)
      }
      const ancestorClipped = visibleRight - visibleLeft < box.width - 2
      if (clipped || (outside || ancestorClipped) && !scrollable) {
        issues.push({
          tag: element.tagName, class: element.className,
          text: (element.getAttribute('aria-label') || element.textContent || element.getAttribute('placeholder') || '').trim().slice(0, 100),
          left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width),
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
          horizontal, vertical, ellipsis: style.textOverflow === 'ellipsis',
          visibleWidth: Math.max(0, Math.round(visibleRight - visibleLeft)), clippingAncestors,
        })
      }
    }
    return { scope: scope === body ? 'engine body' : '.ofm_root', width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      bodyWidth: body.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2, issues }
  })
}
async function warmCompositor() {
  const displayed = await inspector.send('Runtime.evaluate', {
    expression: `(() => {
      const electron = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
      const window = electron.BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('dsh-app://app/'));
      const right = Math.max(...electron.screen.getAllDisplays().map(display => display.bounds.x + display.bounds.width));
      window.setPosition(right + 2048, 0, false);
      window.webContents.setBackgroundThrottling(false);
      globalThis.__ofmNativeAcceptance.showInactive.call(window);
      return {visible:window.isVisible(),focused:window.isFocused()};
    })()`, returnByValue: true,
  })
  assert.ok(!displayed.exceptionDetails, 'Owned native test window could not warm its compositor')
  return displayed.result.value
}
async function capture(name, width, theme) {
  const displayed = await warmCompositor()
  if (name === 'routing') {
    await frame.locator('.rt-hub > b').filter({ hasText: 'Our Free Model' }).waitFor()
    assert.equal(await frame.locator('.rt-hub > svg.rt-bird').count(), 0)
    await until(async () => frame.locator('.rt-hub > img.ofm-brand-icon').evaluate(image =>
      image.complete && image.naturalWidth > 0).catch(() => false), 10000, 'routing host brand image')
  }
  const painted = await frame.locator('body').evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      view: document.querySelector('#prefs[aria-current=page]') ? 'settings'
        : document.querySelector('#nav button[aria-current=page]')?.dataset.view,
      title: document.querySelector('#pageTitle')?.textContent,
      theme: document.documentElement.dataset.theme,
      visibleText: [...document.querySelectorAll('main.view:not([hidden])')].map(element => element.innerText).join('\n').slice(0, 1000),
    })))
  }))
  assert.equal(painted.view, name === 'add-presets' ? 'providers' : name,
    'The native iframe must select the requested view before pixel capture')
  const file = path.join(scratch, `${theme}-${width}-${name}.png`)
  const captured = await inspector.send('Runtime.evaluate', {
    expression: `(async () => {
      const electron = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
      const window = electron.BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('dsh-app://app/'));
      const rect = {x:0,y:0,width:${width},height:1000};
      const warm = await window.webContents.capturePage(rect, {stayHidden:true,stayAwake:true});
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const image = await window.webContents.capturePage(rect, {stayHidden:true,stayAwake:true});
      const pixels = image.toBitmap(), colors = new Set();
      const step = Math.max(4, Math.floor(pixels.length / 12000 / 4) * 4);
      for (let i=0; i+3<pixels.length; i+=step) colors.add(pixels.readUInt32LE(i));
      return {data:image.toPNG().toString('base64'),size:image.getSize(),sampledColors:colors.size,
        warmChanged:!warm.toPNG().equals(image.toPNG())};
    })()`, awaitPromise: true, returnByValue: true,
  })
  assert.ok(!captured.exceptionDetails, `Native capture failed: ${name}/${width}/${theme}`)
  const image = captured.result.value
  fs.writeFileSync(file, Buffer.from(image.data, 'base64'))
  const outer = await measurements(page), inner = await measurements(frame)
  const result = { name, width, theme, file, painted, compositor: displayed,
    warmChanged: image.warmChanged, imageSize: image.size, sampledColors: image.sampledColors, outer, inner }
  assert.equal(image.size.width, width, 'Native screenshot must have the requested physical width')
  assert.ok(image.sampledColors > 20, 'Native screenshot is blank or has not rendered the UI')
  report.screenshots.push(result)
  if (outer.horizontalOverflow || inner.horizontalOverflow || outer.issues.length || inner.issues.length) {
    report.layoutFailures.push(result)
  }
  save()
}
async function verifyPresets() {
  const search = frame.locator('#addSheet input.find')
  const results = []
  for (const preset of report.engineInventory.presets.filter(item =>
    ['vendor', 'relay', 'local', 'remote'].includes(item.kind))) {
    await search.fill(preset.id)
    const rows = await frame.locator('#addSheet .tiles .tile').allTextContents()
    results.push({ id: preset.id, reachable: rows.length > 0, rows: rows.map(value => value.trim()) })
  }
  await search.fill('')
  report.engineInventory.presetSearch = results
  check('every engine vendor/relay/local/remote preset is reachable in the original Add UI',
    results.length > 0 && results.every(item => item.reachable),
    { count: results.length, missing: results.filter(item => !item.reachable).map(item => item.id) })
}
async function providerCrud() {
  await navigate('providers')
  await openAddSheet()
  await frame.locator('#addSheet input.find').fill('ofm-native-custom-fixture')
  await frame.getByRole('button', { name: 'Add it as a custom provider', exact: true }).click()
  const editor = frame.locator('.editor').last()
  await editor.waitFor()
  const name = `OFM native fixture ${Date.now()}`
  await editor.locator('input[placeholder="e.g. My Relay"]').fill(name)
  await editor.locator('input.base-url').fill(fixtureBase + '/v1')
  const key = editor.locator('input[type=password]').first()
  if (await key.count()) await key.fill('native-ui-fixture-key')
  await editor.getByRole('button', { name: 'Add', exact: true }).click()
  await until(async () => {
    const response = await engineApi('providers')
    return response.data?.providers?.some(row => row.name === name)
  }, 20000, 'provider added through original UI')
  let state = await engineApi('providers')
  const row = state.data.providers.find(item => item.name === name)
  assert.ok(row && JSON.stringify(row).includes('127.0.0.1'), 'Only the loopback fixture provider may be edited')
  report.fixtureProvider = { id: row.id, name }
  check('original engine UI adds and saves a loopback provider', true)
  await frame.locator(`#providers .provider[data-id="${row.id}"]`).click()
  const edit = frame.locator('.editor').last()
  await edit.waitFor()
  await edit.locator('input[placeholder="e.g. My Relay"]').fill(name + ' edited')
  await edit.getByRole('button', { name: 'Save', exact: true }).click()
  await until(async () => (await engineApi('providers')).data?.providers?.some(item => item.id === row.id && item.name === name + ' edited'),
    20000, 'provider edited through original UI')
  check('original engine UI edits the loopback provider', true)
  await frame.locator(`#providers .provider[data-id="${row.id}"]`).click()
  const remove = frame.locator('.editor').last().getByRole('button', { name: /^(Remove|Delete)( provider)?(…|\.\.\.)?$/ })
  await remove.first().click()
  const confirmation = frame.getByRole('alertdialog')
  await confirmation.waitFor({ state: 'visible' })
  await confirmation.getByRole('button', { name: /^(Remove|Delete)$/ }).click()
  await until(async () => !(await engineApi('providers')).data?.providers?.some(item => item.id === row.id),
    20000, 'provider deleted through original UI')
  check('original engine UI deletes only the loopback provider', true)
}
async function views() {
  await warmCompositor()
  const providers = await engineApi('providers')
  report.engineInventory = {
    status: providers.status, presets: providers.data?.presets?.map(row => ({ id: row.id, name: row.name, kind: row.kind })),
  }
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme })
    await until(async () => {
      try { return await frame.locator('html').getAttribute('data-ofm-engine-theme') === theme } catch {}
    }, 30000, 'embedded engine follows the host theme')
    check(`native workbench follows the host ${theme} theme`, true)
    for (const width of [1280, 714, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      for (const view of ['providers', 'agents', 'library', 'sessions', 'routing', 'plugins', 'settings']) {
        await navigate(view)
        if (view === 'plugins') {
          assert.equal(await frame.locator('#nav button[data-view=plugins] > .nav-ic').isVisible(), true,
            `Plugin navigation icon must stay visible (${width}/${theme})`)
          assert.equal(await frame.locator('#view-plugins .pm-intro:visible,#view-plugins .pm-sechead:visible').count(), 0)
        }
        await capture(view, width, theme)
        if (view === 'providers') {
          await openAddSheet()
          const listed = await frame.locator('#addSheet [data-pick]').evaluateAll(rows => rows.map(row => ({
            id: row.getAttribute('data-pick'), text: row.textContent.trim(),
          })))
          report.engineInventory[`listed-${width}-${theme}`] = listed
          check(`original Add sheet exposes preset directory (${width}/${theme})`, listed.length >= 20, { rows: listed.length })
          await capture('add-presets', width, theme)
          if (width === 1280 && theme === 'light') await verifyPresets()
          await frame.locator('button[data-view="agents"]').click()
        }
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 1000 })
  await providerCrud()
  if (await page.locator('.ofm_engineoverlay').isVisible()) {
    await page.getByRole('button', { name: 'Collapse workspace', exact: true }).click()
    await page.locator('.ofm_engineoverlay').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Expand workspace', exact: true }).click()
    await page.locator('.ofm_engineoverlay').waitFor({ state: 'visible' })
    await until(async () => frame.locator('#nav button[data-view="providers"]').evaluate(button =>
      typeof button.onclick === 'function').catch(() => false), 30000, 'engine navigation after re-expansion')
    await navigate('providers')
    assert.equal((await engineApi('providers')).status, 200)
    check('workspace expansion and collapse preserve the working engine and navigation', true)
  }
  check('all requested widths/themes/views captured', report.screenshots.length === 64, { count: report.screenshots.length })
  check('no document overflow or clipped controls', report.layoutFailures.length === 0, { count: report.layoutFailures.length })
  check('no browser JavaScript exceptions', report.errors.length === 0, report.errors)
  check('no missing or failed UI assets', report.assetFailures.length === 0, report.assetFailures)
}
async function stop() {
  if (inspector) {
    try {
      await inspector.send('Runtime.evaluate', { expression: "process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit()" })
    } catch {}
    inspector.close()
    inspector = null
  }
  await browser?.close().catch(() => {})
  browser = null
  if (native?.exitCode === null) {
    await Promise.race([new Promise(resolve => native.once('exit', resolve)), delay(7000)])
    if (native.exitCode === null) {
      assert.ok(owned.includes(native), 'Only an owned native process may be stopped')
      await runFile('taskkill.exe', ['/PID', String(native.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch(() => {})
    }
  }
  if (fixture) {
    fixture.closeAllConnections()
    await new Promise(resolve => fixture.close(resolve))
  }
}
try {
  assert.equal(process.platform, 'win32', 'Native DSH acceptance currently requires Windows')
  assert.ok(fs.existsSync(executable), 'Installed DSH executable is required')
  report.protectedProcesses = await processes()
  await packagePlugin()
  save()
  if (!args.includes('--prepare-only')) {
    fixture = http.createServer((request, response) => {
      request.resume()
      request.once('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(json({ object: 'list', data: [{ id: 'ofm-native-fixture', object: 'model', owned_by: 'fixture' }] }))
      })
    })
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
    fixtureBase = `http://127.0.0.1:${fixture.address().port}`
    deadlineTimer = setTimeout(() => {
      report.errors.push('Acceptance exceeded its 12 minute budget')
      void stop().finally(() => { save(); process.exit(1) })
    }, 12 * 60 * 1000)
    await startNative()
    await workspace()
    await views()
  }
} catch (error) {
  report.failure = scrub(error.stack ?? error)
  console.error(scrub(error.message))
  if (page) {
    if (captureSession) {
      await Promise.race([
        captureSession.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
          .then(image => fs.writeFileSync(path.join(scratch, 'failure.png'), Buffer.from(image.data, 'base64'))),
        delay(5000),
      ]).catch(error => { report.failureScreenshotError = scrub(error.message) })
    }
    report.failureDom = await page.evaluate(() => ({
      text: document.body.innerText.slice(0, 6000),
      buttons: [...document.querySelectorAll('button')].slice(0, 80).map(element => ({
        text: element.textContent?.trim(), label: element.getAttribute('aria-label'), title: element.title,
      })),
    })).catch(() => null)
    report.pages = browser.contexts()[0].pages().map(item => ({ url: scrub(item.url()) }))
  }
  process.exitCode = 1
} finally {
  clearTimeout(deadlineTimer)
  await stop()
  report.hostDiagnostics = hostOutput
  report.protectedFiles = protectedFiles.map(item => ({ ...item, after: digest(item.file), unchanged: digest(item.file) === item.before }))
  if (report.protectedProcesses) {
    const after = await processes()
    report.protectedProcessesUnchanged = report.protectedProcesses.every(before =>
      after.some(item => item.pid === before.pid && item.born === before.born))
    check('pre-existing DSH and Codex processes remain running', report.protectedProcessesUnchanged)
  }
  const runtimeSettings = path.join(activeHome, 'our-free-model', 'settings.json')
  report.liveRuntimeSettingsChanged = report.protectedFiles.find(item => item.file === runtimeSettings)?.unchanged === false
  // The existing user process can update its live catalog timestamp during a run.
  // Installation bindings and credentials stay protected; our writes are jailed.
  check('active DSH installation bindings and credentials unchanged',
    report.protectedFiles.filter(item => item.file !== runtimeSettings).every(item => item.unchanged))
  report.finishedAt = new Date().toISOString()
  report.passed = !report.failure && report.checks.every(item => item.passed)
  save()
  if (!report.passed) process.exitCode = 1
  console.log(`Native UI report: ${path.join(scratch, 'result.json')}`)
}
