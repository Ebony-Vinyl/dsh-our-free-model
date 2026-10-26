import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import vm from 'node:vm'
import { openLoginTerminal } from '../packages/standalone/login-terminal.mjs'

const runFile = promisify(execFile)
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`

export async function verifyLoginLaunchers() {
  const calls = []
  const exec = async (...args) => { calls.push(args) }
  const dataDir = '/tmp/测试目录/空格 \' " $HOME $(exit 99) `exit 99`\n独立服务'
  const execPath = "/tmp/Node runtime's/bin/node"
  await openLoginTerminal(dataDir, { platform: 'darwin', exec, execPath })
  assert.equal(calls.length, 1)
  const [file, args, options] = calls[0]
  assert.equal(file, '/usr/bin/osascript')
  assert.equal(options.timeout, 10000)
  assert.equal(args[0], '-e')
  assert.match(args[1], /do script \(item 1 of argv\)/)
  assert.match(args[1], /tell application "Terminal"/)
  assert.ok(!args[1].includes(dataDir))
  // 用 printf 替代 Node，只验收真实 shell 参数分词，不打开终端或修改剪贴板。
  const unquote = value => value.slice(1, -1).replaceAll("'\\''", "'")
  const command = unquote(args[2].slice('/bin/sh -c '.length))
  const keyFile = path.posix.join(dataDir, 'settings.json')
  const prefix = `if ${shellQuote(execPath)} -e `
  const suffix = ` ${shellQuote(keyFile)} 2>/dev/null; then`
  assert.ok(command.startsWith(prefix))
  assert.ok(command.includes(suffix))
  const source = unquote(command.slice(prefix.length, command.indexOf(suffix)))
  if (process.platform !== 'win32') {
    const inspection = command.replace(shellQuote(execPath), "/usr/bin/printf '%s\\0'")
    const { stdout } = await runFile('/bin/sh', ['-c', inspection])
    const [flag, receivedSource, receivedFile] = stdout.split('\0')
    assert.equal(flag, '-e')
    assert.equal(receivedSource, source)
    assert.equal(receivedFile, keyFile)
  }
  const key = 'ofm-private-test-key'
  let copied = 0
  let settings = { forwardKey: key }
  const require = name => {
    if (name === 'node:fs') return { readFileSync: (received, encoding) => {
      assert.equal(received, keyFile)
      assert.equal(encoding, 'utf8')
      return JSON.stringify(settings)
    } }
    assert.equal(name, 'node:child_process')
    return { execFileSync: (received, argv, config) => {
      assert.equal(received, '/usr/bin/pbcopy')
      assert.deepEqual([...argv], [])
      assert.equal(config.input, key)
      assert.equal(config.timeout, 5000)
      assert.deepEqual([...config.stdio], ['pipe', 'ignore', 'ignore'])
      copied++
    } }
  }
  const evaluate = () => vm.runInNewContext(source, { require, process: { argv: ['node', keyFile] } })
  evaluate()
  assert.equal(copied, 1)
  for (const invalid of ['', '  ', null, 123, undefined]) {
    settings = { forwardKey: invalid }
    assert.throws(evaluate, /missing login token/)
  }
  assert.equal(copied, 1)
  assert.ok(!JSON.stringify(calls).includes(key))
  await assert.rejects(openLoginTerminal(dataDir, { platform: 'darwin', exec: async () => {
    throw new Error('automation denied')
  } }), /automation denied/)
  calls.length = 0
  const windowsDir = "F:\\测试目录\\带空格与单引号'\\独立服务"
  await openLoginTerminal(windowsDir, { platform: 'win32', exec, systemRoot: 'C:\\Windows' })
  assert.equal(calls.length, 1)
  const [powershell, windowsArgs, windowsOptions] = calls[0]
  assert.equal(powershell, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(windowsOptions.windowsHide, true)
  const launch = Buffer.from(windowsArgs.at(-1), 'base64').toString('utf16le')
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(launch)[1]
  const windowsCommand = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.ok(windowsCommand.includes(path.win32.join(windowsDir, 'settings.json').replaceAll("'", "''")))
  assert.match(windowsCommand, /Set-Clipboard -Value \$ofmLoginKey/)
  await assert.rejects(openLoginTerminal(dataDir, { platform: 'linux', exec }), { statusCode: 400 })
  assert.equal(calls.length, 1)
}

/** 使用替身启动器验收登录前入口，回归测试不弹窗口或接触用户剪贴板。 */
export async function verifyLoginTerminal() {
  const { createManagement } = await import('../packages/standalone/management.mjs')
  let baseUrl
  let attempts = 0
  let rejectLaunch = true
  let holdLaunch = true
  let finishLaunch
  let launchStarted
  const started = new Promise(resolve => { launchStarted = resolve })
  const dataDir = 'F:\\测试目录\\带空格与单引号\'\\独立服务'
  const key = 'ofm-test-private-key'
  const management = createManagement({
    stores: { settings: { get: () => ({ forwardKey: key }) } },
    info: () => ({ baseUrl, dataDir }),
    loginTerminal: async received => {
      assert.equal(received, dataDir)
      attempts++
      if (rejectLaunch) throw new Error('测试启动失败')
      if (!holdLaunch) return
      const finished = new Promise(resolve => { finishLaunch = resolve })
      launchStarted()
      await finished
    },
  })
  const server = http.createServer((req, res) => { void management.handleRequest(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  baseUrl = `http://127.0.0.1:${port}`
  management.setPort(port)
  const source = { origin: baseUrl, 'sec-fetch-site': 'same-origin' }
  const request = (body = {}, headers = source, route = '/login/terminal', method = 'POST', url = baseUrl) => fetch(`${url}/api/management${route}`, {
    method, headers: { 'content-type': 'application/json', connection: 'close', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  })
  try {
    assert.equal((await request({}, {})).status, 403)
    assert.equal((await request({}, { origin: baseUrl })).status, 403)
    assert.equal((await request({}, { ...source, origin: 'https://evil.example' })).status, 403)
    assert.equal((await request({}, { ...source, 'sec-fetch-site': 'cross-site' })).status, 403)
    assert.equal((await request({}, { ...source, referer: 'http://evil.example/' })).status, 403)
    assert.equal((await request({}, source, '/login/terminal', 'GET')).status, 401)
    for (const body of [{ command: 'whoami' }, { dataDir: 'C:\\Windows' }, { key }]) {
      assert.equal((await request(body)).status, 400)
    }
    assert.equal(attempts, 0)
    const aliasUrl = `http://localhost:${port}`
    assert.equal((await request({}, source, '/login/terminal', 'POST', aliasUrl)).status, 403)
    const failure = await request({}, { origin: aliasUrl, 'sec-fetch-site': 'same-origin' }, '/login/terminal', 'POST', aliasUrl)
    assert.equal(failure.status, 500)
    assert.ok(!(await failure.text()).includes(dataDir))
    assert.equal(attempts, 1)
    rejectLaunch = false
    const pending = request()
    await Promise.race([started, pending.then(response => {
      throw new Error(`启动器未执行，请求提前结束：${response.status}`)
    })])
    assert.equal((await request()).status, 429)
    assert.equal(attempts, 2)
    finishLaunch()
    const opened = await pending
    assert.equal(opened.status, 200)
    assert.deepEqual(await opened.json(), { ok: true })
    assert.equal((await request()).status, 429)
    assert.equal(attempts, 2)
    holdLaunch = false
    const nativeNow = Date.now
    const afterCooldown = nativeNow() + 31_000
    try {
      Date.now = () => afterCooldown
      assert.equal((await request()).status, 200)
      assert.equal(attempts, 3)
    } finally { Date.now = nativeNow }
    // 打开本机窗口不创建管理会话，网页仍须粘贴令牌登录。
    assert.equal((await request({}, source, '/key', 'GET')).status, 401)
  } finally {
    finishLaunch?.()
    management.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
