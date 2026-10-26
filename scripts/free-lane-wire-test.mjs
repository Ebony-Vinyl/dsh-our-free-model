/**
 * The free lane's wire facts, re-measured against the live gateway on 2026-10-14,
 * re-checked against the **v2** client fingerprint on 2026-10-16, and re-checked
 * against the session-encoding gate on 2026-10-17.
 *
 * These are the things that changed and that a future edit can silently break:
 * the lane's base path, the four session headers, the shape *and encoding* of
 * the session id, the User-Agent (now the canonical v2 token and nothing else),
 * and the absence of the v1-only `x-opencode-request` header. The tool gate's
 * own contract lives in `fingerprint-test.mjs`.
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

console.log('=== 1. the lane lives under /inference/v1 ===')
{
  check('chat model', up.endpointFor('cat-jam-free'), '/inference/v1/chat/completions')
  check('responses model', up.endpointFor('muse-spark-1.3-contributor-free'), '/inference/v1/responses')
  check('messages model', up.endpointFor('union-alpha'), '/inference/v1/messages')
  check('wire for chat', up.wireFor('cat-jam-free'), 'chat')
  check('wire for responses', up.wireFor('muse-spark-1.3-contributor-free'), 'responses')
  check('wire for messages', up.wireFor('union-alpha'), 'messages')
}

console.log('\n=== 2. the four v2 session headers, and no v1-only request header ===')
{
  const session = 'ses_0123456789abABCDEFGHIJKLMN'
  const headers = up.gatewayHeaders({ session, stream: true })
  check('pooled credential', headers.authorization, 'Bearer public')
  check('reported as the cli client', headers['x-opencode-client'], 'cli')
  check('session header', headers['x-opencode-session'], session)
  check('session-id header repeats it', headers['x-opencode-session-id'], session)
  check('session affinity repeats it', headers['x-session-affinity'], session)
  check('session id repeats it', headers['x-session-id'], session)
  // v1 sent `x-opencode-request`; v2 answers that header with 403 FreeTierError.
  check('no x-opencode-request', 'x-opencode-request' in headers, false)
  check('the User-Agent is the canonical v2 token', headers['user-agent'], 'opencode/latest/2.0.26/cli')
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

console.log('\n=== 4. the v2 tool gate: read + shell, official definitions, no tool_choice none ===')
{
  const empty = { tool_choice: 'none' }
  up.applyFingerprint(empty, false)
  check('read is declared', declared(empty, 'read') !== undefined, true)
  check('shell is declared', declared(empty, 'shell') !== undefined, true)
  check('the read schema is the official one', declared(empty, 'read').function.parameters.required, ['path'])
  check('the shell schema is the official one', declared(empty, 'shell').function.parameters.required, ['command'])
  check('a caller tool_choice none is dropped', empty.tool_choice, undefined)

  const claude = {}
  up.applyFingerprint(claude, 'claude')
  check('Messages shape uses input_schema', declared(claude, 'read').input_schema.required, ['path'])

  // A caller tool that reuses a gate name with another definition moves aside,
  // and the response side still restores the caller's own spelling.
  const caller = { tools: [{ type: 'function', function: { name: 'read', description: 'the caller read', parameters: { type: 'object', properties: {} } } }] }
  const map = up.applyFingerprint(caller, false)
  check('only one declaration carries the gate name', caller.tools.filter(tool => tool.function.name === 'read').length, 1)
  check('…and it is the official definition', declared(caller, 'read').function.parameters.required, ['path'])
  check('the caller declaration survived under an alias', caller.tools.find(tool => tool.function.name === 'read_client').function.description, 'the caller read')
  check('…and the alias restores the caller name', up.restoreToolName('read_client', map), 'read')
}

console.log('\n=== 5. the User-Agent is the canonical v2 token, whatever the host attributes ===')
{
  // v2 matches the whole string against `opencode/<channel>/<version>/<client>`,
  // so the harness attribution cannot ride along any more: a v1 token is refused
  // by name, and a prefixed/suffixed string is no longer a v2 client.
  await postStreamed({
    path: up.endpointFor('cat-jam-free'),
    body: { model: 'cat-jam-free', messages: [{ role: 'user', content: 'ping' }], stream: true },
    session: up.sessionForConversation('wire:ua'),
    attributionUserAgent: 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)',
    onData: () => {},
    timeoutMs: 5000,
  })
  const sent = seen[seen.length - 1]
  check('the request reached the chat path', sent.url, '/inference/v1/chat/completions')
  check('the refused token is gone', /deepseek[-_]harness/i.test(sent.headers['user-agent'] ?? ''), false)
  check('the UA is the canonical v2 token', sent.headers['user-agent'], up.CLIENT_UA)
  check('…and carries no attribution suffix', sent.headers['user-agent'].includes(' '), false)
  check('session-id went out', typeof sent.headers['x-opencode-session-id'] === 'string', true)
  check('the four session headers agree', [
    sent.headers['x-opencode-session'],
    sent.headers['x-session-affinity'],
    sent.headers['x-session-id'],
  ].every(value => value === sent.headers['x-opencode-session-id']), true)
  check('no v1 request header went out', 'x-opencode-request' in sent.headers, false)
}

console.log('\n=== 6. 目录请求与推理请求使用同一串 v2 UA ===')
{
  // The host still passes an attribution UA (its API is unchanged); the v2
  // fingerprint means this lane cannot put it on the wire.
  const attributionUserAgent = 'our-free-model-standalone/2.3.0'
  await getJson('/inference/v1/models', { attributionUserAgent })
  check('目录请求使用 v2 指纹 UA', seen.at(-1).headers['user-agent'], up.CLIENT_UA)
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
  await getJson('/inference/v1/models', { attributionUserAgent: unrelated })
  check('任何归属串都不再改变线上 UA', seen.at(-1).headers['user-agent'], up.CLIENT_UA)
}

server.close()
fs.rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nall wire checks passed' : `\n${failures} wire check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
