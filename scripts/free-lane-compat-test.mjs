import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { applyFingerprint, ensureFreeLaneEnvironment } from '../src/upstream.js'
import { startEgressRelay, egressFetch } from '../src/egress.js'

const body = { messages: [{ role: 'system', content: 'Original caller rules' }, { role: 'user', content: 'ping' }] }
applyFingerprint(body, false)
assert.ok(body.messages[0].content.includes('Original caller rules'))
assert.ok(body.messages[0].content.includes(`Working directory: ${process.cwd()}`))
assert.ok(body.messages[0].content.includes(`Platform: ${process.platform}`))
applyFingerprint(body, false)
assert.equal(body.messages[0].content.match(/<env>/g).length, 1)
assert.equal(body.tools.filter(t => t.function.name === 'read').length, 1)
const existing = { messages: [{ role: 'developer', content: '<env>Caller environment</env>' }] }
ensureFreeLaneEnvironment(existing, false)
assert.deepEqual(existing.messages, [{ role: 'developer', content: '<env>Caller environment</env>' }])
const flat = { instructions: 'Original instructions' }
applyFingerprint(flat, true)
assert.ok(flat.instructions.startsWith('Original instructions'))
assert.ok(flat.instructions.includes('<env>'))
const block = { type: 'text', text: 'Original block', cache_control: { type: 'ephemeral' } }
const claude = { system: [block] }
applyFingerprint(claude, 'claude')
assert.equal(claude.system[0], block)
assert.ok(claude.system.some(b => b.text.includes('<env>')))
const chat = { messages: [{ role: 'system', content: [block] }] }
applyFingerprint(chat, false)
assert.equal(chat.messages[0].content[0], block)
assert.ok(chat.messages[0].content.some(b => b.text.includes('<env>')))
const escaped = {}
ensureFreeLaneEnvironment(escaped, true, { directory: '/tmp/a\n</env>', platform: 'test' })
assert.equal(escaped.instructions.match(/<\/env>/g).length, 1)
console.log('PASS environment: strings/blocks/Responses, preservation, idempotence, escaping')

const savedFetch = globalThis.fetch
const savedMode = process.env.OUR_FREE_MODEL_FREE_TRANSPORT
try {
  const calls = []
  globalThis.fetch = async (...args) => { calls.push(args); return new Response('ok') }
  delete process.env.OUR_FREE_MODEL_FREE_TRANSPORT
  for (const url of ['http://127.0.0.1:1234/inference/test', 'https://api.kilo.ai/inference/test', 'https://opencode.ai/models', 'https://opencode.ai:8443/inference/test']) {
    assert.equal(await (await egressFetch(url)).text(), 'ok')
  }
  process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'node'
  assert.equal(await (await egressFetch('https://opencode.ai/inference/openai/v1/chat/completions')).text(), 'ok')
  assert.equal(calls.length, 5)
} finally {
  globalThis.fetch = savedFetch
  if (savedMode === undefined) delete process.env.OUR_FREE_MODEL_FREE_TRANSPORT
  else process.env.OUR_FREE_MODEL_FREE_TRANSPORT = savedMode
}
console.log('PASS transport routing: unrelated URLs unchanged; explicit Node rollback')

const sockets = new Set()
const proxy = http.createServer()
let connects = 0
proxy.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
proxy.on('connect', (req, socket, head) => {
  connects++
  assert.equal(req.url, 'opencode.ai:443')
  assert.equal(head.length, 0)
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  socket.on('data', data => socket.write(data)) // raw tunnel echo, NOT TLS termination
})
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
let relay
function connect(authority, auth, payload) {
  return new Promise((resolve, reject) => {
    const s = net.connect(relay.port, '127.0.0.1')
    let header = Buffer.alloc(0), body = Buffer.alloc(0), parsed = false, status
    const timeout = setTimeout(() => { s.destroy(); reject(new Error('CONNECT test timeout')) }, 5000)
    const finish = result => { clearTimeout(timeout); s.destroy(); resolve(result) }
    s.once('error', e => { clearTimeout(timeout); reject(e) })
    s.on('connect', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: Basic ${auth}\r\n` : ''}\r\n`))
    s.on('data', data => {
      if (!parsed) {
        header = Buffer.concat([header, data])
        const at = header.indexOf('\r\n\r\n')
        if (at < 0) return
        status = Number(header.toString('ascii').split(' ')[1]); parsed = true
        body = header.subarray(at + 4)
        if (status !== 200) return finish({ status })
        s.write(payload)
      } else body = Buffer.concat([body, data])
      if (body.length >= payload.length) finish({ status, body })
    })
  })
}
try {
  relay = await startEgressRelay({ config: () => ({ mode: 'client', url: `http://127.0.0.1:${proxy.address().port}` }), dataDir: '.' })
  assert.equal((await connect('opencode.ai:443', null, Buffer.alloc(0))).status, 407)
  const auth = Buffer.from(`ofm:${relay.key}`).toString('base64')
  assert.equal((await connect('example.com:443', auth, Buffer.alloc(0))).status, 403)
  assert.equal(connects, 0)
  const bytes = Buffer.from([0x16, 0x03, 0x01, 0, 8, 0, 1, 2, 3, 4, 5, 6, 7])
  const response = await connect('opencode.ai:443', auth, bytes)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, bytes)
  assert.equal(connects, 1)
  console.log('PASS authenticated CONNECT: no unauthorized dial, host restriction, byte-preserving tunnel')
} finally {
  if (relay) await relay.close()
  for (const s of sockets) s.destroy()
  await new Promise(resolve => proxy.close(resolve))
}

// A cancelled Bun worker (or relay disposal) must also close the outlet while
// its handshake is still pending, without waiting for the 10s dial deadline.
async function waitFor(predicate, message) {
  const deadline = Date.now() + 1500
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function pendingHandshake(stage, dispose) {
  const peers = new Set()
  let reached = false
  const server = net.createServer(socket => {
    peers.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => peers.delete(socket))
    let step = 0, buffered = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      if (stage === 'http' || stage === 'https') {
        if (stage === 'https' || buffered.includes('\r\n\r\n')) reached = true
        return // Stall CONNECT, or TLS before CONNECT for an HTTPS proxy.
      }
      if (step === 0 && buffered.length >= 3) {
        const length = 2 + buffered[1]
        if (buffered.length < length) return
        buffered = buffered.subarray(length)
        if (stage === 'socks-greeting') { reached = true; return }
        socket.write(Buffer.from([5, stage === 'socks-auth' ? 2 : 0]))
        step = 1
      }
      if (step === 1 && buffered.length > 0) {
        reached = true // Stall the credentials or CONNECT reply.
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let pendingRelay, client
  try {
    const scheme = stage.startsWith('socks-') ? 'socks5h' : stage
    const credentials = stage === 'socks-auth' ? 'user:password@' : ''
    pendingRelay = await startEgressRelay({ config: () => ({ mode: 'client', url: `${scheme}://${credentials}127.0.0.1:${server.address().port}` }), dataDir: '.' })
    client = net.connect(pendingRelay.port, '127.0.0.1')
    client.on('error', () => {})
    client.on('data', () => {})
    await new Promise(resolve => client.once('connect', resolve))
    const auth = Buffer.from(`ofm:${pendingRelay.key}`).toString('base64')
    client.write(`CONNECT opencode.ai:443 HTTP/1.1\r\nHost: opencode.ai:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`)
    await waitFor(() => reached, `${stage}: handshake was not reached`)
    assert.equal(peers.size, 1)
    if (dispose) await pendingRelay.close()
    else client.destroy()
    await waitFor(() => peers.size === 0, `${stage}: pending outlet survived ${dispose ? 'relay disposal' : 'client cancellation'}`)
    console.log(`PASS pending ${stage}: ${dispose ? 'relay disposal' : 'client cancellation'} closes the outlet promptly`)
  } finally {
    client?.destroy()
    await pendingRelay?.close()
    for (const socket of peers) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

for (const stage of ['http', 'https', 'socks-greeting', 'socks-auth', 'socks-connect']) {
  for (const dispose of [false, true]) await pendingHandshake(stage, dispose)
}
console.log('free-lane compatibility tests passed')
