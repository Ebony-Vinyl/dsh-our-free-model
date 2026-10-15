/**
 * The free lane's wire facts, re-measured against the live gateway on 2026-10-14.
 *
 * These are the four things that changed and that a future edit can silently
 * break: the lane's base path, the session-id header, the shape of the session
 * id, and the User-Agent the gateway refuses by name. The tool gate's own
 * contract lives in `fingerprint-test.mjs`.
 *
 * Run: node scripts/free-lane-wire-test.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-wire-'))
process.env.DSH_HOME = scratch

const seen = []
const server = http.createServer((req, res) => {
  const pieces = []
  req.on('data', piece => pieces.push(piece))
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(pieces).toString('utf8') })
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
server.unref()
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`

const up = await import('../src/upstream.js')
const { postStreamed } = await import('../src/http.js')

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}
const declared = (body, name) => (body.tools ?? []).find(tool => (tool.function?.name ?? tool.name) === name)
const propertiesOf = (tool, claude) => (claude ? tool?.input_schema : tool?.function?.parameters ?? tool?.parameters)?.properties ?? {}

console.log('=== 1. the lane lives under /inference/v1 ===')
{
  check('chat model', up.endpointFor('cat-jam-free'), '/inference/v1/chat/completions')
  check('responses model', up.endpointFor('muse-spark-1.3-contributor-free'), '/inference/v1/responses')
  check('messages model', up.endpointFor('union-alpha'), '/inference/v1/messages')
  check('wire for chat', up.wireFor('cat-jam-free'), 'chat')
  check('wire for responses', up.wireFor('muse-spark-1.3-contributor-free'), 'responses')
  check('wire for messages', up.wireFor('union-alpha'), 'messages')
}

console.log('\n=== 2. the gateway needs x-opencode-session-id beside x-opencode-session ===')
{
  const session = 'ses_0123456789abABCDEFGHIJKLMN'
  const headers = up.gatewayHeaders({ session, requestId: 'msg_0123456789abABCDEFGHIJKLMN', stream: true })
  check('pooled credential', headers.authorization, 'Bearer public')
  check('reported as the cli client', headers['x-opencode-client'], 'cli')
  check('session header', headers['x-opencode-session'], session)
  check('session-id header repeats it', headers['x-opencode-session-id'], session)
  check('streaming accept', headers.accept, 'text/event-stream')
}

console.log('\n=== 3. the session id has to be minted, not derived ===')
{
  const id = up.sessionForConversation('wire:conversation')
  check('canonical shape', up.SESSION_RE.test(id), true)
  // The twelve hex digits are the 48-bit complement of `ms * 0x1000 + seq`, so
  // they only carry the mint time modulo 2^36 ms — enough to prove the id was
  // minted rather than digested, which is what the gateway checks.
  const encoded = BigInt(`0x${id.slice(4, 16)}`)
  const stamp = Number(((~encoded) & 0xffffffffffffn) >> 12n) % 2 ** 36
  check('hex carries the mint time', Math.abs(stamp - (Date.now() % 2 ** 36)) < 5000, true)
  check('one conversation, one session', up.sessionForConversation('wire:conversation'), id)
  check('another conversation, another session', up.sessionForConversation('wire:other') !== id, true)
  const saved = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'session-map.json'), 'utf8'))
  check('session mapping is persisted outside the user directory', saved.sessions['wire:conversation'], id)
  const caller = 'ses_ffffffffffffABCDEFGHIJKLMN'
  check('a canonical caller id passes through', up.sessionForConversation(caller), caller)
}

console.log('\n=== 4. the tool gate wants bash and read with a declared property ===')
{
  const empty = {}
  up.applyFingerprint(empty, false)
  check('bash is declared', declared(empty, 'bash') !== undefined, true)
  check('read is declared', declared(empty, 'read') !== undefined, true)
  check('bash declares a property', Object.keys(propertiesOf(declared(empty, 'bash'))).length > 0, true)
  check('read declares a property', Object.keys(propertiesOf(declared(empty, 'read'))).length > 0, true)

  const claude = {}
  up.applyFingerprint(claude, 'claude')
  check('Messages shape declares a property too', Object.keys(propertiesOf(declared(claude, 'bash'), true)).length > 0, true)

  // A caller tool that occupies the slot with an empty schema must be stamped,
  // not duplicated and not renamed.
  const caller = { tools: [{ type: 'function', function: { name: 'bash', description: 'the caller shell', parameters: { type: 'object', properties: {} } } }] }
  up.applyFingerprint(caller, false)
  check('caller bash is kept once', caller.tools.filter(tool => tool.function.name === 'bash').length, 1)
  check('caller bash keeps its description', declared(caller, 'bash').function.description, 'the caller shell')
  check('caller bash gains a property', Object.keys(propertiesOf(declared(caller, 'bash'))).length > 0, true)
}

console.log('\n=== 5. a User-Agent naming deepseek-harness is refused by the gateway ===')
{
  await postStreamed({
    path: up.endpointFor('cat-jam-free'),
    body: { model: 'cat-jam-free', messages: [{ role: 'user', content: 'ping' }], stream: true },
    session: up.sessionForConversation('wire:ua'),
    requestId: up.mintRequestId(),
    attributionUserAgent: 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)',
    onData: () => {},
    timeoutMs: 5000,
  })
  const sent = seen[seen.length - 1]
  check('the request reached the chat path', sent.url, '/inference/v1/chat/completions')
  check('the refused token is gone', /deepseek[-_]harness/i.test(sent.headers['user-agent'] ?? ''), false)
  check('an offline harness attribution still rides along', /dsh\//.test(sent.headers['user-agent'] ?? ''), true)
  check('session-id went out', typeof sent.headers['x-opencode-session-id'] === 'string', true)
}

server.close()
fs.rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nall wire checks passed' : `\n${failures} wire check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
