/**
 * The free lane's wire facts, re-measured against the live gateway on
 * 2026-10-18 after `/inference/v1` started answering 403 FreeTierError for every
 * free id.
 *
 * The lane is back on the legacy `/zen/v1` origin with the v1.3.7 request
 * shape: the `opencode/1.18.31 (<os> <arch>; <runtime>)` User-Agent,
 * `x-opencode-request`, a `prj_<24hex>` project id, the session headers, and
 * lightweight `bash`/`edit`/`glob`/`grep`/`read` stubs. The tool gate's own
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
const { postStreamed, getJson } = await import('../src/http.js')

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}
const declared = (body, name) => (body.tools ?? []).find(tool => (tool.function?.name ?? tool.name) === name)

console.log('=== 1. the lane lives under /zen/v1 ===')
{
  check('chat model', up.endpointFor('cat-jam-free'), '/zen/v1/chat/completions')
  check('responses model', up.endpointFor('muse-spark-1.3-contributor-free'), '/zen/v1/responses')
  check('messages model', up.endpointFor('union-alpha'), '/zen/v1/messages')
  check('wire for chat', up.wireFor('cat-jam-free'), 'chat')
  check('wire for responses', up.wireFor('muse-spark-1.3-contributor-free'), 'responses')
  check('wire for messages', up.wireFor('union-alpha'), 'messages')
}

console.log('\n=== 2. the v1.3.7 headers, including x-opencode-request ===')
{
  const session = 'ses_0123456789abABCDEFGHIJKLMN'
  const headers = up.gatewayHeaders({ session, stream: true })
  check('pooled credential', headers.authorization, 'Bearer public')
  check('reported as the cli client', headers['x-opencode-client'], 'cli')
  check('session header', headers['x-opencode-session'], session)
  check('session affinity repeats it', headers['x-session-affinity'], session)
  check('session id repeats it', headers['x-session-id'], session)
  // The legacy gate expects the v1 correlation header again.
  check('x-opencode-request is present', typeof headers['x-opencode-request'], 'string')
  check('…and carries the msg_ shape', headers['x-opencode-request'].startsWith('msg_'), true)
  check('the project id is canonical prj_<24hex>', /^prj_[0-9a-f]{24}$/.test(headers['x-opencode-project']), true)
  check('the User-Agent is the v1.3.7 shape', /^opencode\/1\.18\.31 \([^)]+; [^)]+\)$/.test(headers['user-agent']), true)
  check('streaming accept', headers.accept, 'text/event-stream')
}

console.log('\n=== 3. the session id must carry the descending encoding the gate accepts ===')
{
  const id = up.sessionForConversation('wire:conversation')
  check('canonical shape', up.SESSION_RE.test(id), true)
  // The gate validates the encoding, not only the `ses_…` shape (measured
  // 2026-10-17). The twelve hex digits are the 48-bit complement of
  // `ts_ms << 12 | counter`, so the counter reads as `0xfff - counter` and has
  // to land in 1–63 — low 12 bits inside 0xfc0–0xfff.
  const encoded = BigInt(`0x${id.slice(4, 16)}`)
  const counter = Number((~encoded) & 0xfffn)
  check('the encoding is descending', up.SESSION_DESCENDING_RE.test(id.slice(4, 16)), true)
  check('the counter stays in the accepted 1-63 window', counter > 0 && counter <= 63, true)
  check('one conversation, one session', up.sessionForConversation('wire:conversation'), id)
  check('another conversation, another session', up.sessionForConversation('wire:other') !== id, true)
  const saved = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'session-map.json'), 'utf8'))
  check('session mapping is persisted outside the user directory', saved.sessions['wire:conversation'], id)
  const caller = 'ses_ffffffffffffABCDEFGHIJKLMN'
  check('a canonical caller id passes through', up.sessionForConversation(caller), caller)
  // A caller id with the right shape but the wrong encoding is a 403 upstream,
  // so it must be re-encoded rather than forwarded (probed live 2026-10-17).
  const ascending = 'ses_123456789abcABCDEFGHIJKLMN'
  const reencoded = up.sessionForConversation(ascending)
  check('an ascending caller id is re-encoded', reencoded === ascending, false)
  check('and the re-encoded id is canonical', up.isCanonicalSession(reencoded), true)
  check('and it stays stable per conversation', up.sessionForConversation(ascending), reencoded)
}

console.log('\n=== 4. the legacy tool gate: bash + read stubs, caller tools untouched ===')
{
  const empty = {}
  up.applyFingerprint(empty, false)
  check('bash is declared', declared(empty, 'bash') !== undefined, true)
  check('read is declared', declared(empty, 'read') !== undefined, true)
  check('the stub schema is empty', declared(empty, 'read').function.parameters, { type: 'object', properties: {} })

  const claude = {}
  up.applyFingerprint(claude, 'claude')
  check('Messages shape uses input_schema', declared(claude, 'read').input_schema.type, 'object')

  // The legacy gate does not compare definitions, so a caller tool that reuses
  // a gate name keeps its own schema and is never renamed.
  const caller = { tools: [{ type: 'function', function: { name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }] }
  const map = up.applyFingerprint(caller, false)
  check('only one declaration carries the gate name', caller.tools.filter(tool => tool.function.name === 'read').length, 1)
  check('…and it is still the caller definition', declared(caller, 'read').function.description, 'the caller read')
  check('nothing was aliased', map.size, 0)
}

console.log('\n=== 5. the User-Agent is the legacy token, whatever the host attributes ===')
{
  await postStreamed({
    path: up.endpointFor('cat-jam-free'),
    body: { model: 'cat-jam-free', messages: [{ role: 'user', content: 'ping' }], stream: true },
    session: up.sessionForConversation('wire:ua'),
    attributionUserAgent: 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)',
    onData: () => {},
    timeoutMs: 5000,
  })
  const sent = seen[seen.length - 1]
  check('the request reached the chat path', sent.url, '/zen/v1/chat/completions')
  check('the refused token is gone', /deepseek[-_]harness/i.test(sent.headers['user-agent'] ?? ''), false)
  check('the UA is the legacy token', sent.headers['user-agent'], up.CLIENT_UA)
  check('session headers agree', [
    sent.headers['x-opencode-session'],
    sent.headers['x-session-affinity'],
    sent.headers['x-session-id'],
  ].every(value => value === sent.headers['x-opencode-session']), true)
  check('the v1 request header went out', typeof sent.headers['x-opencode-request'], 'string')
}

console.log('\n=== 6. 目录请求与推理请求使用同一串 legacy UA ===')
{
  const attributionUserAgent = 'our-free-model-standalone/2.5.2'
  await getJson('/zen/v1/models', { attributionUserAgent })
  check('目录请求使用 legacy 指纹 UA', seen.at(-1).headers['user-agent'], up.CLIENT_UA)
  await postStreamed({
    path: up.endpointFor('mimo-v2.6-flash-free'),
    body: { model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'ping' }], stream: true },
    session: up.sessionForConversation('wire:standalone'),
    attributionUserAgent,
    onData: () => {},
    timeoutMs: 5000,
  })
  check('推理请求使用同一串', seen.at(-1).headers['user-agent'], up.CLIENT_UA)
  const unrelated = 'other-client/3.0 (+https://example.com/our-free-model-standalone)'
  await getJson('/zen/v1/models', { attributionUserAgent: unrelated })
  check('任何归属串都不再改变线上 UA', seen.at(-1).headers['user-agent'], up.CLIENT_UA)
}

server.close()
fs.rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nall wire checks passed' : `\n${failures} wire check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
