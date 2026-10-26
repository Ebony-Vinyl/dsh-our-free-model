/**
 * Opt-in Windows desktop test. Uses only an owned profile and fixture upstream.
 * Run: node scripts/workbench-native-desktop-test.mjs --run
 * Evidence stays under .verify/workbench-desktop; native profiles are never read.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { startStandalone } from '../packages/standalone/service.mjs'
import { prepareClientLaunch } from '../packages/standalone/workbench.mjs'

assert.equal(process.platform, 'win32', 'This test requires Windows')
assert.ok(process.argv.includes('--run'), 'Explicit --run is required')
const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, '.verify', 'workbench-desktop')
fs.mkdirSync(output, { recursive: true })
const runDir = fs.mkdtempSync(path.join(output, 'direct-'))
const profileDir = path.join(runDir, 'profile')
const workspace = path.join(runDir, 'workspace')
const reuseArgument = process.argv.find(value => value.startsWith('--reuse-owned-runtime='))
let fakeHome = path.join(runDir, 'home')
if (reuseArgument) {
  const previousName = reuseArgument.slice('--reuse-owned-runtime='.length)
  assert.match(previousName, /^direct-[A-Za-z0-9]+$/, 'Only a previous owned evidence directory can be reused')
  const previousRoot = fs.realpathSync(path.join(output, previousName))
  assert.ok(previousRoot.startsWith(fs.realpathSync(output) + path.sep), 'Reused runtime must stay inside the evidence workspace')
  const previous = JSON.parse(fs.readFileSync(path.join(previousRoot, 'result.json'), 'utf8'))
  assert.deepEqual(previous.cleanup.ownedSurvivors, [], 'Previous owned processes must be gone')
  fakeHome = path.join(previousRoot, 'home')
}
for (const dir of [workspace, fakeHome]) fs.mkdirSync(dir, { recursive: true })
const executable = 'C:/Program Files/WindowsApps/OpenAI.Codex_26.1016.8622.0_x64__2p2nqsd0c76g0/app/ChatGPT.exe'
assert.ok(fs.statSync(executable).isFile(), 'Expected installed desktop executable')
const runFile = promisify(execFile)
const powershell = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const quote = value => `'${String(value).replaceAll("'", "''")}'`
async function ps(source, timeout = 12000) {
  const result = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop'\n" + source, 'utf16le').toString('base64')],
  { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
  return result.stdout.trim()
}
async function processes() {
  const query = `@(Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; name=$_.Name;
      born=$_.CreationDate.ToUniversalTime().ToString('o'); executable=$_.ExecutablePath}
  }) | ConvertTo-Json -Compress`
  let text
  try { text = await ps(query, 25000) }
  catch { text = await ps(query, 25000) }
  const value = JSON.parse(text)
  return Array.isArray(value) ? value : [value]
}
const identity = process => `${process.pid}|${process.born}`
const baseline = await processes()
const protectedIds = new Set(baseline.map(process => process.pid))
protectedIds.add(26752)
const protectedHost = baseline.find(process => process.pid === 26752)
assert.ok(protectedHost, 'Protected user Codex host must be present before testing')
const owned = new Map()
let child
let browser
let service
let upstream
let tracking
let trackingBusy = false
let stopTracking = false
let childError
let childExit
let rawOut = ''
let rawErr = ''
let fixtureCalls = 0
let fixturePromptSeen = false
let inferenceAllowed = false
const fixtureKey = 'desktop-fixture-' + crypto.randomBytes(12).toString('hex')
let gatewayKey = ''
const marker = 'OFM_DESKTOP_FIXTURE_OK'
const waitArgument = process.argv.find(value => value.startsWith('--wait-ms='))
const waitMs = waitArgument ? Number(waitArgument.slice('--wait-ms='.length)) : 45000
assert.ok(Number.isInteger(waitMs) && waitMs >= 5000 && waitMs <= 180000, 'Wait must be between 5 and 180 seconds')
const report = {
  startedAt: new Date().toISOString(), mode: 'direct-packaged-executable', executable,
  runDir, waitMs, runtimeHome: fakeHome, protectedHost: { pid: protectedHost.pid, parent: protectedHost.parent, born: protectedHost.born },
  baselineDesktop: baseline.filter(process => /^(ChatGPT|codex)\.exe$/i.test(process.name)),
  config: {}, child: {}, cdp: {}, ui: {}, requests: [], cleanup: {},
}
function redact(text) {
  let value = String(text ?? '')
  for (const secret of [fixtureKey, gatewayKey].filter(Boolean)) value = value.replaceAll(secret, '[fixture-key]')
  return value
}
function saveReport() {
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2) + '\n')
}
async function track() {
  if (!child?.pid || trackingBusy) return
  trackingBusy = true
  try {
    const current = await processes()
    let added = true
    while (added) {
      added = false
      for (const process of current) {
        if (protectedIds.has(process.pid) || owned.has(identity(process))) continue
        const parent = current.find(candidate => candidate.pid === process.parent)
        if (process.pid === child.pid || (parent && owned.has(identity(parent)))) {
          owned.set(identity(process), process)
          added = true
        }
      }
    }
  } finally { trackingBusy = false }
}
async function portOwners(port) {
  const text = await ps(`@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress`)
  if (!text) return []
  const value = JSON.parse(text)
  return Array.isArray(value) ? value : [value]
}
async function unusedPort() {
  const socket = net.createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}
async function readCdp(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1800 }, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.on('timeout', () => request.destroy(new Error('CDP HTTP timeout')))
    request.on('error', reject)
  })
}
async function processPackage(pid) {
  return JSON.parse(await ps(`
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OwnedPackageProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
    $handle=[OwnedPackageProbe]::OpenProcess(0x1000,$false,${pid})
    if ($handle -eq [IntPtr]::Zero) { throw 'Cannot open owned process for package query' }
    try {
      [uint32]$length=0
      $first=[OwnedPackageProbe]::GetPackageFullName($handle,[ref]$length,$null)
      $package=''
      $code=$first
      if ($first -eq 122) {
        $name=New-Object System.Text.StringBuilder ([int]$length)
        $code=[OwnedPackageProbe]::GetPackageFullName($handle,[ref]$length,$name)
        $package=$name.ToString()
      }
      [pscustomobject]@{pid=${pid};code=$code;package=$package} | ConvertTo-Json -Compress
    } finally { [void][OwnedPackageProbe]::CloseHandle($handle) }
  `, 18000))
}
async function inspectPage(page, label) {
  const current = await page.evaluate(() => ({
    url: location.href, title: document.title,
    body: document.body?.innerText?.slice(0, 14000) ?? '',
    inputs: [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].map(element => ({
      tag: element.tagName, role: element.getAttribute('role'), type: element.getAttribute('type'),
      placeholder: element.getAttribute('placeholder'), label: element.getAttribute('aria-label'),
    })),
    buttons: [...document.querySelectorAll('button')].map(element => ({
      text: element.innerText?.slice(0, 140), label: element.getAttribute('aria-label'),
    })).slice(0, 80),
  }))
  report.ui[label] = current
  fs.writeFileSync(path.join(runDir, `${label}.json`), redact(JSON.stringify(current, null, 2)) + '\n')
  await page.screenshot({ path: path.join(runDir, `${label}.png`), timeout: 10000 })
}

try {
  upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return }
    const parsed = JSON.parse(body)
    fixtureCalls++
    const authorized = req.headers.authorization === `Bearer ${fixtureKey}`
    const modelMatches = parsed.model === 'desktop-fixture'
    fixturePromptSeen ||= JSON.stringify(parsed.messages).includes(marker)
    report.requests.push({ route: req.url, authorized, modelMatches, streaming: parsed.stream === true, marker: fixturePromptSeen })
    if (!authorized || !modelMatches || !inferenceAllowed) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Only the controlled desktop fixture is allowed' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      `data: ${JSON.stringify({ id: 'desktop-fixture', model: 'desktop-fixture', choices: [{ index: 0, delta: { content: marker } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const dataDir = path.join(runDir, 'gateway')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    aggregate: { enabled: true, providers: { deepseek: {
      enabled: true, apiKey: fixtureKey,
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, models: ['desktop-fixture'],
    } } },
  }))
  service = await startStandalone({
    dataDir, port: 0, refresh: false, subscriptionOptions: { home: fakeHome },
    logger: { warn(message) { report.gatewayWarning = redact(message).slice(0, 800) }, info() {} },
  })
  await service.ready
  assert.ok(service.runtime.publicModelRows().some(row => row.id === 'deepseek/desktop-fixture'))
  gatewayKey = JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
  const cleanEnv = {}
  const inherited = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'systemdrive', 'programfiles', 'programfiles(x86)', 'programdata', 'number_of_processors', 'processor_architecture', 'processor_identifier', 'os'])
  for (const [name, value] of Object.entries(process.env)) if (inherited.has(name.toLowerCase())) cleanEnv[name] = value
  Object.assign(cleanEnv, {
    USERPROFILE: fakeHome, HOME: fakeHome, APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'), TEMP: path.join(runDir, 'temp'), TMP: path.join(runDir, 'temp'),
    CODEX_SQLITE_HOME: path.join(profileDir, 'sqlite'), ELECTRON_ENABLE_LOGGING: '1',
  })
  for (const name of ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'CODEX_SQLITE_HOME']) fs.mkdirSync(cleanEnv[name], { recursive: true })
  const prepared = prepareClientLaunch({
    client: { id: 'codex-desktop', executable, cwd: workspace, model: 'deepseek/desktop-fixture', mode: 'gateway' },
    profileDir, baseUrl: service.url, key: gatewayKey, env: cleanEnv,
  })
  // Scope client trust to the disposable directory; do not reuse personal state.
  fs.appendFileSync(path.join(profileDir, 'config.toml'),
    `\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`)
  const config = fs.readFileSync(path.join(profileDir, 'config.toml'), 'utf8')
  assert.ok(config.includes(`experimental_bearer_token = "${gatewayKey}"`))
  report.config = {
    codexHome: prepared.env.CODEX_HOME, sqliteHome: prepared.env.CODEX_SQLITE_HOME,
    userDataDir: path.join(profileDir, 'app'), home: prepared.env.HOME,
    explicitBearer: true, requiresOpenaiAuth: false, hasOfficialTokens: false,
    model: 'deepseek/desktop-fixture', baseUrl: service.url,
  }
  const debugPort = await unusedPort()
  report.cdp.port = debugPort
  report.cdp.testRunnerPackage = await processPackage(process.pid)
  const args = [...prepared.args, `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1']
  report.child.args = args
  console.log(`Launching owned isolated desktop; evidence ${runDir}`)
  child = spawn(executable, args, { cwd: workspace, env: prepared.env, shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('error', error => { childError = { code: error.code, message: redact(error.message) } })
  child.on('exit', (code, signal) => { childExit = { code, signal, at: new Date().toISOString() } })
  child.stdout.on('data', chunk => { rawOut = (rawOut + chunk).slice(-48000) })
  child.stderr.on('data', chunk => { rawErr = (rawErr + chunk).slice(-48000) })
  report.child.pid = child.pid
  await track()
  tracking = (async () => {
    while (!stopTracking) {
      await delay(1500)
      if (!stopTracking) await track().catch(error => { report.trackingError = redact(error.message) })
    }
  })()
  const until = Date.now() + waitMs
  let lastProgress = 0
  let endpoint
  while (Date.now() < until && !childError) {
    await track()
    try {
      const owners = await portOwners(debugPort)
      if (owners.length) {
        assert.ok(owners.every(pid => !protectedIds.has(pid) && [...owned.values()].some(process => process.pid === pid)),
          'CDP listener must belong exclusively to a newly owned process')
        report.cdp.owners = owners
        report.cdp.packageIdentity ??= await processPackage(owners[0])
        const response = await readCdp(debugPort)
        report.cdp.http = { status: response.status, body: response.body.slice(0, 3000) }
        if (response.status === 200) { endpoint = JSON.parse(response.body); break }
      }
    } catch (error) {
      if (/exclusively/.test(error.message)) throw error
      report.cdp.lastProbeError = redact(error.message)
    }
    if (Date.now() - lastProgress > 15000) {
      lastProgress = Date.now()
      const runtime = path.join(fakeHome, 'AppData', 'Local', 'OpenAI', 'Codex', 'runtimes')
      const files = fs.existsSync(runtime) ? fs.readdirSync(runtime, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length : 0
      ;(report.startupProgress ??= []).push({ at: new Date().toISOString(), stagedRuntimeFiles: files })
      report.child.stdout = redact(rawOut)
      report.child.stderr = redact(rawErr)
      saveReport()
      console.log(`Waiting for actual CDP page; runtime materialization files=${files}`)
    }
    if (childExit && ![...owned.values()].some(process => process.pid !== child.pid)) break
    await delay(1000)
  }
  if (!endpoint) {
    report.verdict = childError ? 'spawn-error' : 'no-owned-cdp-endpoint'
    report.child.error = childError
    report.child.exit = childExit
  } else {
    report.cdp.browser = endpoint.Browser
    const require = createRequire(import.meta.url)
    const { chromium } = require('D:/Cache/npm-global/node_modules/playwright')
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 10000 })
    let pages = browser.contexts().flatMap(context => context.pages())
    const pageDeadline = Date.now() + 35000
    while (!pages.length && Date.now() < pageDeadline) {
      await delay(500)
      pages = browser.contexts().flatMap(context => context.pages())
    }
    report.cdp.pages = pages.map(page => page.url())
    const page = pages.find(page => page.url().startsWith('app://')) ?? pages[0]
    assert.ok(page, 'Owned desktop exposed no page within 35 seconds after CDP connected')
    await page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {})
    page.on('pageerror', error => { (report.ui.pageErrors ??= []).push(redact(error.message).slice(0, 1000)) })
    await page.waitForFunction(() => {
      const text = document.body?.innerText?.trim() ?? ''
      return text.length > 100 || Boolean(document.querySelector('input[type="radio"],[contenteditable="true"][role="textbox"],textarea'))
    }, undefined, { timeout: 45000 }).catch(() => { report.ui.contentWaitTimedOut = true })
    await delay(1000)
    await inspectPage(page, 'initial-ui')
    console.log(JSON.stringify({ phase: 'owned-ui-ready', port: debugPort, url: page.url(), text: report.ui['initial-ui'].body.slice(0, 1600) }))
    report.verdict = 'owned-ui-loaded-needs-inspection'
    saveReport()
    for (let step = 0; step < 4; step++) {
      const text = await page.locator('body').innerText()
      if (!/选择您的工作类型|哪一项最能描述你的工作|你希望|您希望|个性化设置|How do you|What.*work/i.test(text)) break
      const optionalRecommendations = page.getByRole('checkbox', { name: /推荐个性化任务|personalized/i })
      if (await optionalRecommendations.count()) await optionalRecommendations.first().uncheck({ timeout: 3000 }).catch(() => {})
      const engineering = page.getByText(/^(工程|Engineering)$/)
      if (await engineering.count()) await engineering.first().click({ timeout: 3000 })
      else {
        const radios = page.locator('label').filter({ has: page.locator('input[type="radio"]') })
        if (await radios.count()) await radios.first().click({ timeout: 3000 })
      }
      const advance = page.getByRole('button', { name: /^(继续|下一步|跳过|开始使用|Continue|Next|Skip|Get started)$/i }).first()
      if (!await advance.isEnabled().catch(() => false)) break
      await advance.click({ timeout: 4000 })
      await delay(1800)
      await inspectPage(page, `onboarding-${step + 1}`)
      console.log(JSON.stringify({ phase: 'onboarding', step: step + 1, text: report.ui[`onboarding-${step + 1}`].body.slice(0, 1300) }))
      saveReport()
    }
    // Only submit through a visible composer after confirming API mode and the
    // fixture provider. Never click sign-in or create an official account.
    const composer = page.locator('[contenteditable="true"][role="textbox"],textarea').first()
    const body = await page.locator('body').innerText()
    if (await composer.isVisible().catch(() => false) && /desktop-fixture|EAC router|API key/i.test(body)) {
      inferenceAllowed = true
      await composer.fill(`Reply exactly ${marker}. Do not use tools or read files.`)
      await composer.press('Enter')
      const responseDeadline = Date.now() + 18000
      while (Date.now() < responseDeadline && !fixturePromptSeen) await delay(500)
      await delay(2000)
      await inspectPage(page, 'after-fixture')
      report.verdict = fixturePromptSeen && report.ui['after-fixture'].body.includes(marker)
        ? 'desktop-fixture-request-and-visible-response' : 'ui-loaded-fixture-inference-unproven'
    }
  }
} catch (error) {
  report.error = { name: error.name, message: redact(error.message), stack: redact(error.stack).slice(0, 4000) }
  report.verdict ??= 'test-error'
  process.exitCode = 1
} finally {
  stopTracking = true
  await tracking?.catch(() => {})
  await track().catch(() => {})
  report.child.error = childError
  report.child.exit = childExit
  report.child.stdout = redact(rawOut)
  report.child.stderr = redact(rawErr)
  report.ownedProcesses = [...owned.values()]
  saveReport()
  // browser.close() on a CDP-attached Playwright client disconnects its transport.
  // Actual cleanup below independently checks PID + creation time + baseline.
  await browser?.close().catch(() => {})
  const current = await processes().catch(error => {
    report.cleanup.snapshotError = redact(error.message).slice(0, 1000)
    saveReport()
    return []
  })
  const alive = current.filter(process => owned.has(identity(process)) && !protectedIds.has(process.pid))
  const parentFirst = [...alive].sort((a, b) => (a.pid === child?.pid ? -1 : 0) - (b.pid === child?.pid ? -1 : 0))
  report.cleanup.attempted = parentFirst.map(process => ({ pid: process.pid, born: process.born }))
  saveReport()
  if (parentFirst.length) {
    await ps(parentFirst.map(process => `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}' -ErrorAction SilentlyContinue
      if ($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq ${quote(process.born)}) {
        Stop-Process -Id ${process.pid} -ErrorAction SilentlyContinue
      }`).join('\n'), 25000).catch(error => {
      (report.cleanup.errors ??= []).push({ error: redact(error.message).slice(0, 500) })
    })
  }
  await delay(1000)
  const after = await processes().catch(error => {
    report.cleanup.finalSnapshotError = redact(error.message).slice(0, 1000)
    return []
  })
  report.cleanup.ownedSurvivors = after.filter(process => owned.has(identity(process))).map(process => process.pid)
  report.cleanup.protectedHostUnchanged = after.some(process => identity(process) === identity(protectedHost))
  report.cleanup.protectedDesktopUnchanged = report.baselineDesktop.every(process => after.some(candidate => identity(candidate) === identity(process)))
  report.fixture = { calls: fixtureCalls, promptSeen: fixturePromptSeen }
  await service?.close().catch(error => { report.cleanup.serviceError = redact(error.message) })
  if (upstream) {
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  }
  report.finishedAt = new Date().toISOString()
  saveReport()
  console.log(JSON.stringify({ verdict: report.verdict, childPid: report.child.pid, exit: report.child.exit,
    cdp: Boolean(report.cdp.browser), fixture: report.fixture, cleanup: report.cleanup, result: path.join(runDir, 'result.json') }, null, 2))
  if (!report.cleanup.protectedHostUnchanged || report.cleanup.ownedSurvivors.length || report.cleanup.snapshotError) process.exitCode = 1
  else if (!process.exitCode && report.verdict !== 'desktop-fixture-request-and-visible-response') process.exitCode = 2
}
