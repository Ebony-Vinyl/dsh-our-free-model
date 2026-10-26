import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { startStandalone } from '../packages/standalone/service.mjs'
import { prepareClientLaunch } from '../packages/standalone/workbench.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-native-agents-'))
const fixtureRoot = path.resolve('.verify/native-clients/node_modules')
const clients = [
  { id: 'claude', executable: path.join(fixtureRoot, '@anthropic-ai/claude-code/bin/claude.exe'),
    args: ['--print', 'Reply exactly EAC_AGENT_OK. Do not use tools.', '--output-format', 'json', '--no-session-persistence', '--tools', ''] },
  { id: 'gemini', executable: process.execPath,
    args: [path.join(fixtureRoot, '@google/gemini-cli/bundle/gemini.js'), '--prompt', 'Reply exactly EAC_AGENT_OK. Do not use tools.', '--output-format', 'json'] },
]
let service, child
let calls = 0
const seen = []
const gatewayRequests = []
const upstream = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  seen.push({ path: req.url, model: body.model })
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return }
  calls++
  assert.equal(body.model, 'agent-test')
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end('data: {"choices":[{"index":0,"delta":{"content":"EAC_AGENT_OK"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\ndata: [DONE]\n\n')
})
try {
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const dataDir = path.join(scratch, 'data')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    aggregate: { enabled: true, providers: { deepseek: {
      enabled: true, apiKey: 'agent-fixture-key', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, models: ['agent-test'],
    } } },
  }))
  service = await startStandalone({ dataDir, port: 0, refresh: false,
    subscriptionOptions: { home: path.join(scratch, 'empty-home') }, logger: { warn() {}, info() {} } })
  await service.ready
  service.runtime
  const key = JSON.parse(fs.readFileSync(service.keyFile)).forwardKey
  for (const client of clients) {
    assert.ok(fs.existsSync(client.executable), 'Install the isolated native client dependencies before running')
    const env = { ...process.env, GEMINI_CLI_NO_RELAUNCH: '1', GEMINI_CLI_TRUST_WORKSPACE: 'true', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    const plan = prepareClientLaunch({
      client: { ...client, cwd: scratch, mode: 'gateway', model: 'deepseek/agent-test' },
      profileDir: path.join(scratch, client.id), baseUrl: service.url, key, env,
    })
    const before = calls
    const gatewayServer = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      if (buffer.length) {
        try {
          const body = JSON.parse(buffer.toString())
          gatewayRequests.push({ path: req.url, generationConfig: body.generationConfig })
        } catch {}
      }
      const response = await fetch(service.url + req.url, {
        method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([name]) => !['host', 'connection', 'content-length'].includes(name))),
        body: req.method === 'GET' ? undefined : buffer, duplex: 'half',
      })
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' })
      for await (const chunk of response.body) res.write(chunk)
      res.end()
    })
    gatewayServer.listen(0, '127.0.0.1')
    await once(gatewayServer, 'listening')
    if (client.id === 'gemini') plan.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${gatewayServer.address().port}`
    child = spawn(client.executable, [...(client.id === 'gemini' ? client.args.slice(0, 1) : []), ...plan.args,
      ...(client.id === 'gemini' ? client.args.slice(1) : client.args)], {
      env: plan.env, cwd: scratch, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '', diagnostics = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { diagnostics += chunk })
    const timer = setTimeout(() => child.kill(), 55000)
    let code
    try { [code] = await once(child, 'exit') } finally { clearTimeout(timer) }
    gatewayServer.closeAllConnections()
    await new Promise(resolve => gatewayServer.close(resolve))
    fs.mkdirSync('.verify/native-agents', { recursive: true })
    fs.writeFileSync(`.verify/native-agents/${client.id}.json`, JSON.stringify({
      code, output: output.replaceAll(key, '[redacted]'), diagnostics: diagnostics.replaceAll(key, '[redacted]'), calls: calls - before, gatewayRequests,
    }, null, 2))
    assert.equal(code, 0, `${client.id}: ${diagnostics.slice(-2000)} ${output.slice(-500)}`)
    assert.match(output, /EAC_AGENT_OK/, `${client.id}: ${diagnostics.slice(-1000)}`)
    assert.ok(calls > before, `${client.id} must call the real gateway and third-party fixture`)
    console.log(`${client.id}: native CLI used isolated pure API profile, real gateway and third-party fixture; EAC_AGENT_OK`)
  }
} finally {
  if (child?.exitCode === null) child.kill()
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  assert.ok(fs.realpathSync(scratch).startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
