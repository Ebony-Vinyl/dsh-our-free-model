import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { startStandalone } from '../packages/standalone/service.mjs'
import { prepareClientLaunch } from '../packages/standalone/workbench.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-native-client-'))
const executable = process.env.OFM_CODEX_BINARY ?? (process.platform === 'win32'
  ? execFileSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).find(file => /\.exe$/i.test(file))
  : 'codex')
if (!executable) throw new Error('Codex CLI is required for the native integration test')
let service
let calls = 0
let child
const upstream = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(body.model, 'native-test')
  assert.equal(req.headers.authorization, 'Bearer fixture-private-api-key')
  assert.ok(body.messages.some(message => JSON.stringify(message).includes('EAC_NATIVE_OK')))
  calls++
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end([
    `data: ${JSON.stringify({ id: 'native-fixture', model: body.model, choices: [{ index: 0, delta: { content: 'EAC_NATIVE_OK' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''))
})
try {
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const dataDir = path.join(scratch, 'data')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    aggregate: { enabled: true, providers: { deepseek: {
      enabled: true, apiKey: 'fixture-private-api-key',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, models: ['native-test'],
    } } },
  }))
  service = await startStandalone({ dataDir, port: 0, refresh: false, subscriptionOptions: { home: path.join(scratch, 'empty-home') }, logger: { warn() {}, info() {} } })
  await service.ready
  assert.ok(service.runtime.publicModelRows().some(row => row.id === 'deepseek/native-test'))
  const cleanEnv = { ...process.env }
  delete cleanEnv.CODEX_SQLITE_HOME
  const prepared = prepareClientLaunch({
    client: { id: 'codex', executable, cwd: scratch, model: 'deepseek/native-test', mode: 'gateway' },
    profileDir: path.join(scratch, 'profile'),
    baseUrl: service.url, key: JSON.parse(fs.readFileSync(service.keyFile)).forwardKey, env: cleanEnv,
  })
  const configBefore = fs.readFileSync(path.join(prepared.env.CODEX_HOME, 'auth.json'), 'utf8')
  assert.equal(configBefore.includes('"tokens"'), false)
  child = spawn(executable, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
    'Reply with exactly EAC_NATIVE_OK. Do not use tools.'], {
    env: prepared.env, cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  })
  let output = '', diagnostic = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { diagnostic += chunk })
  const timeout = setTimeout(() => child.kill(), 60_000)
  let code
  try { [code] = await once(child, 'exit') } finally { clearTimeout(timeout) }
  assert.equal(code, 0, `native Codex CLI failed: ${diagnostic.slice(-1800)}`)
  assert.match(output, /EAC_NATIVE_OK/)
  assert.ok(calls > 0, 'native client must complete through the real gateway and upstream fixture')
  assert.equal(output.includes('fixture-private-api-key'), false)
  console.log('native Codex CLI: isolated pure API profile -> local Responses gateway -> third-party Chat Completions -> EAC_NATIVE_OK')
  console.log(`native integration passed (${calls} upstream request${calls === 1 ? '' : 's'}; no official auth tokens)`)
} finally {
  if (child?.exitCode === null) child.kill()
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  assert.ok(fs.realpathSync(scratch).startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(scratch, { recursive: true, force: true })
}
