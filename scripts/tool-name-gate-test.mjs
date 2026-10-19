/**
 * End-to-end check: a request whose tool names the gate would refuse must still
 * reach the upstream in a shape it accepts.
 *
 * The free lane answers a declaration named `mcp:rea:read_file` with HTTP 400
 * and an *empty* body (measured 2026-10-19), which the gateway could only report
 * as "upstream HTTP 400". `applyFingerprint` now rewrites such names before the
 * request leaves and restores them on the response.
 *
 * This test does not touch the network: it starts a stub upstream that refuses
 * any declaration outside `[A-Za-z0-9_-]` with the same empty 400, runs a second
 * standalone gateway against it (a copy of the real data directory, so the
 * roster and settings are the ones the user actually has), and sends a Zed-like
 * request carrying `mcp:rea:*` tools. Passing means the stub saw only accepted
 * names and the client still got its text back.
 *
 * Run: node scripts/tool-name-gate-test.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataHome = path.join(os.homedir(), '.our-free-model')
const SAFE = /^[A-Za-z0-9_-]{1,128}$/

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = http.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

const seen = []
const stub = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body
    try { body = JSON.parse(raw) } catch {
      res.writeHead(400).end()
      return
    }
    const names = (Array.isArray(body.tools) ? body.tools : [])
      .map(tool => tool?.function?.name ?? tool?.name)
      .filter(name => typeof name === 'string' && name !== '')
    seen.push(names)
    const bad = names.filter(name => !SAFE.test(name))
    if (bad.length > 0) {
      // The lane's real behaviour: 400 with an empty body.
      res.writeHead(400, { 'content-type': 'application/json' }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const wantsTool = JSON.stringify(body.messages ?? []).includes('pakai tool')
    if (wantsTool) {
      const target = names.find(name => name.startsWith('mcp_rea_')) ?? names[0]
      res.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: 1, model: 'stub', choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: target, arguments: '' } }] } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: 1, model: 'stub', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"README.md"}' } }] } }] })}\n\n`)
      res.write('data: {"id":"stub","object":"chat.completion.chunk","created":1,"model":"stub","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n')
      res.end('data: [DONE]\n\n')
      return
    }
    res.write('data: {"id":"stub","object":"chat.completion.chunk","created":1,"model":"stub","choices":[{"index":0,"delta":{"role":"assistant","content":"siap"}}]}\n\n')
    res.write('data: {"id":"stub","object":"chat.completion.chunk","created":1,"model":"stub","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
})

const stubPort = await freePort()
await new Promise(resolve => stub.listen(stubPort, '127.0.0.1', resolve))

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-tool-name-'))
const dataDir = path.join(temp, 'data')
fs.cpSync(dataHome, dataDir, { recursive: true })
for (const stale of ['service.lock']) {
  const file = path.join(dataDir, stale)
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })
}

const gatewayPort = await freePort()
const child = spawn(process.execPath, ['packages/standalone/cli.mjs', '--port', String(gatewayPort), '--data-dir', dataDir], {
  cwd: repo,
  env: { ...process.env, OUR_FREE_MODEL_BASE: `http://127.0.0.1:${stubPort}`, OFM_TEST_UPSTREAM: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let gatewayLog = ''
child.stdout.on('data', chunk => { gatewayLog += chunk })
child.stderr.on('data', chunk => { gatewayLog += chunk })

const stop = async () => {
  child.kill()
  stub.close()
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch { /* best effort */ }
}

const base = `http://127.0.0.1:${gatewayPort}`
const deadline = Date.now() + 45000
let ready = false
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${base}/health`)
    if (response.ok) { ready = true; break }
  } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 400))
}
check('the gateway under test starts', ready, true)

if (!ready) {
  console.log(gatewayLog.slice(-2000))
  await stop()
  process.exit(1)
}

const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
const key = settings.forwardKey
const model = 'deepseek-v4.1-flash-free'

const tools = [
  ['mcp:rea:read_file', 'Reads the content of the given file in the project.'],
  ['mcp:rea:inspect_artifact', 'Inspect an active archive in one call.'],
  ['mcp:rea:analyze_function', 'Build a dossier for one native function.'],
  ['read_file', 'A caller tool that was already valid.'],
].map(([name, description]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
}))

const response = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Sebutkan satu kata saja.' },
    ],
    tools,
    tool_choice: 'auto',
    stream: true,
    max_tokens: 512,
  }),
})
const text = await response.text()

check('the request is not refused with the empty 400', response.status, 200)
check('the stub received exactly one request', seen.length, 1)
const sent = seen[0] ?? []
check('the colon names were rewritten', sent.filter(name => name.startsWith('mcp_rea_')), ['mcp_rea_read_file', 'mcp_rea_inspect_artifact', 'mcp_rea_analyze_function'])
check('no name is outside the gate alphabet', sent.filter(name => !SAFE.test(name)), [])
check('the already-valid name kept its spelling', sent.includes('read_file'), true)
check('the gate stubs are still declared', ['bash', 'edit', 'glob', 'grep', 'read'].every(name => sent.includes(name)), true)
check('the client still received the answer', /siap/.test(text), true)

// The other direction: a tool call must come back under the caller's spelling,
// or Zed would receive `mcp_rea_read_file` and have no such tool to run.
const toolResponse = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'pakai tool untuk membaca README' },
    ],
    tools,
    tool_choice: 'auto',
    stream: true,
    max_tokens: 512,
  }),
})
const toolText = await toolResponse.text()
check('the tool-call turn is served', toolResponse.status, 200)
check('the upstream name is restored to the caller spelling', /"name":"mcp:rea:read_file"/.test(toolText), true)
check('the sanitized name never reaches the client', /mcp_rea_read_file/.test(toolText), false)

await stop()
console.log(failures === 0 ? '\ntool-name gate: the gateway speaks only accepted names end to end' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
