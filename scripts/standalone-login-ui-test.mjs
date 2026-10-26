import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createManagement } from '../packages/standalone/management.mjs'
import { openLoginTerminal } from '../packages/standalone/login-terminal.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'playwright')
const runFile = promisify(execFile)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-login-ui-'))
const dataDir = path.join(scratch, process.platform === 'win32'
  ? "测试目录 带空格 ' $HOME $(exit 99) 独立服务"
  : '测试目录 带空格 \' " $HOME $(exit 99)\n独立服务')
const key = 'ofm-isolated-macos-ui-test-key'
fs.mkdirSync(dataDir, { mode: 0o700 })
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ forwardKey: key }), { mode: 0o600 })
const nativeTerminal = process.env.OFM_VERIFY_MAC_TERMINAL === '1'
if (nativeTerminal) assert.equal(process.platform, 'darwin')
let baseUrl
let launches = 0
const management = createManagement({
  stores: { settings: { get: () => ({ forwardKey: key }) } },
  info: () => ({ baseUrl, dataDir }),
  loginTerminal: async received => {
    assert.equal(received, dataDir)
    launches++
    if (nativeTerminal) await openLoginTerminal(received)
  },
})
const server = http.createServer((req, res) => { void management.handleRequest(req, res) })
server.listen(0, '127.0.0.1')
await once(server, 'listening')
baseUrl = `http://127.0.0.1:${server.address().port}`
management.setPort(server.address().port)
const browser = await chromium.launch({
  headless: true,
  ...process.env.OFM_BROWSER_EXECUTABLE ? { executablePath: process.env.OFM_BROWSER_EXECUTABLE } : {},
})
const imageDir = process.env.OFM_UI_SCREENSHOT_DIR
if (imageDir) fs.mkdirSync(imageDir, { recursive: true })
let previousClipboard
let previousWindows = []
const windowIds = async () => {
  const { stdout } = await runFile('/usr/bin/osascript', ['-e', 'tell application "Terminal" to get id of windows'])
  return stdout.split(',').map(value => value.trim()).filter(value => /^\d+$/.test(value))
}
try {
  if (nativeTerminal) {
    previousClipboard = (await runFile('/usr/bin/pbpaste', [])).stdout
    previousWindows = await windowIds()
  }
  const errors = []
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(baseUrl)
  await page.locator('#login-screen').waitFor({ state: 'visible' })
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported'
  assert.equal(await page.locator('#login-terminal').getAttribute('data-login-platform'), platform)
  const terminalName = platform === 'windows' ? 'PowerShell' : '终端'
  const manual = page.locator('.login-help details')
  await manual.locator('summary').click()
  const command = await page.locator('#login-command').inputValue()
  if (platform === 'macos') {
    assert.match(command, /pbcopy/)
    assert.ok(!(await page.locator('#login-screen').innerText()).includes('PowerShell'))
  }
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
    ['narrow', { width: 320, height: 740 }],
  ]) {
    await page.setViewportSize(viewport)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    const controls = await page.locator('#login-screen input, #login-screen button, #login-screen textarea').evaluateAll(nodes =>
      nodes.map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })))
    assert.ok(controls.every(box => box.left >= 0 && box.right <= viewport.width))
    if (imageDir) await page.screenshot({ path: path.join(imageDir, `macos-login-${name}.png`), fullPage: true })
  }
  await page.locator('#copy-login-command').click()
  await page.getByText('命令已复制。', { exact: false }).waitFor()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command)
  // 后续验证还原剪贴板，不把隔离令牌留给用户的实际客户端。
  if (platform !== 'unsupported') {
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/login/terminal'))
    await page.getByRole('button', { name: `打开${platform === 'windows' ? ' PowerShell ' : '终端'}获取令牌 ↗` }).click()
    const response = await responsePromise
    assert.equal(response.status(), 200)
    assert.deepEqual(await response.json(), { ok: true })
    await page.getByText(`已请求打开${terminalName}。`, { exact: false }).waitFor()
    assert.equal(launches, 1)
    assert.equal(await page.evaluate(() => document.activeElement.id), 'login-key')
    assert.equal((await context.request.get(`${baseUrl}/api/management/key`)).status(), 401)
    await page.locator('#login-terminal').click()
    await page.getByText('30 秒后可重试', { exact: false }).waitFor()
    assert.equal(launches, 1)
    if (nativeTerminal) {
      let copied = false
      for (let attempt = 0; attempt < 50; attempt++) {
        copied = (await runFile('/usr/bin/pbpaste', [])).stdout === key
        if (copied) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      assert.ok(copied, 'native terminal did not copy the isolated token')
      const windows = (await windowIds()).filter(id => !previousWindows.includes(id))
      assert.ok(windows.length > 0, 'native terminal did not open a visible window')
      const contents = (await runFile('/usr/bin/osascript', ['-e',
        `tell application "Terminal" to get contents of selected tab of window id ${windows[0]}`,
      ])).stdout
      assert.ok(contents.includes('登录令牌已复制'))
      assert.ok(!contents.includes(key))
    }
  } else assert.equal(await page.locator('#login-terminal').isDisabled(), true)
  assert.deepEqual(errors, [])
  console.log(`login UI: ${platform}, three viewports, manual copy, ${nativeTerminal ? 'native Terminal and clipboard' : 'stub launcher'}, cooldown and no session grant passed`)
} finally {
  if (nativeTerminal && previousClipboard !== undefined) {
    const clipboard = (await runFile('/usr/bin/pbpaste', [])).stdout
    if (clipboard === key || clipboard.startsWith("node -e 'const fs = require")) {
      execFileSync('/usr/bin/pbcopy', [], { input: previousClipboard, timeout: 5000 })
    }
    for (const id of (await windowIds()).filter(id => !previousWindows.includes(id))) {
      const contents = (await runFile('/usr/bin/osascript', ['-e',
        `tell application "Terminal" to get contents of selected tab of window id ${id}`,
      ])).stdout
      if (contents.includes(dataDir) || contents.includes('登录令牌已复制')) {
        await runFile('/usr/bin/osascript', ['-e',
          `tell application "Terminal" to close window id ${id} saving no`,
        ]).catch(() => {})
      }
    }
  }
  await browser.close()
  management.dispose()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(scratch, { recursive: true, force: true })
}
