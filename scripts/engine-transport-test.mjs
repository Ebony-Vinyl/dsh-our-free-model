/** Private engine startup and inference survive a replaced host fetch. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { loopbackFetch } from '../src/loopback-fetch.js'
import { createMagpieEngine } from '../src/magpie-engine.js'
import { createMagpieModels } from '../src/magpie-models.js'
import { skipWithoutEngineBinary } from './lib/engine-binary.mjs'

// The real engine is a per-platform build; a runner without one has nothing to start.
if (skipWithoutEngineBinary('engine-transport')) process.exit(0)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-engine-transport-'))
const engine = createMagpieEngine({ dataDir: path.join(scratch, 'data') })
const originalFetch = globalThis.fetch
let intercepted = 0, cancelled = 0
globalThis.fetch = async () => { intercepted++; throw new Error('Host fetch intercepted the request') }
const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ data: [{ id: 'fixture/model', vision: true }] }))
  }
  if (req.url === '/v1/chat/completions') {
    for await (const _ of req) { /* Drain the fixture request. */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({
      id: 'fixture', choices: [{ index: 0, delta: { content: 'direct loopback' }, finish_reason: null }],
    }) + '\n\n')
    res.write('data: ' + JSON.stringify({
      id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }) + '\n\n')
    return res.end('data: [DONE]\n\n')
  }
  if (req.url === '/upload') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), contentType: req.headers['content-type'] }))
  }
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    const timer = setInterval(() => res.write('data: next\n\n'), 20)
    res.once('close', () => { clearInterval(timer); cancelled++ })
    return
  }
  if (req.url === '/buffered') return res.end('fully buffered response')
  if (req.url === '/redirect') { res.writeHead(302, { location: 'https://example.invalid/' }); return res.end() }
  res.writeHead(204)
  res.end()
})
let models
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await engine.start()).state, 'ready')
  assert.equal((await engine.request('GET', '/api/settings')).status, 200)
  console.log('ok real engine starts and authenticated management works with host fetch replaced')

  models = createMagpieModels({
    engine: { status: () => ({ state: 'ready' }), gateway: () => ({ url: base, key: 'fixture-only-key' }) },
  })
  await models.refresh()
  assert.equal(models.catalog()[0].id, 'subscription:magpie/fixture/model')
  const emitted = []
  await models.complete({
    model: 'subscription:magpie/fixture/model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  }, chunk => emitted.push(chunk))
  assert.ok(JSON.stringify(emitted).includes('direct loopback'))
  console.log('ok catalog and streaming model inference bypass the replaced host fetch')

  const form = new FormData()
  form.set('file', new Blob(['fixture upload']), 'fixture.txt')
  const upload = await (await loopbackFetch(base + '/upload', { method: 'POST', body: form })).json()
  assert.match(upload.contentType, /^multipart\/form-data; boundary=/)
  assert.match(upload.body, /fixture upload/)
  assert.equal((await loopbackFetch(base + '/empty')).status, 204)
  assert.equal((await loopbackFetch(base + '/empty', { method: 'HEAD' })).body, null)
  await assert.rejects(loopbackFetch(base + '/redirect', { redirect: 'error' }), /redirect/)
  assert.equal((await loopbackFetch(base + '/redirect', { redirect: 'manual' })).status, 302)
  await assert.rejects(loopbackFetch('https://example.invalid/'), /loopback/)
  await assert.rejects(loopbackFetch('http://user:secret@127.0.0.1/'), /loopback/)
  const controller = new AbortController()
  const response = await loopbackFetch(base + '/stream', { signal: controller.signal })
  const reader = response.body.getReader()
  assert.equal((await reader.read()).done, false)
  await new Promise(resolve => setTimeout(resolve, 60))
  controller.abort()
  await assert.rejects(reader.read())
  const deadline = Date.now() + 2000
  while (!cancelled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(cancelled, 1)
  const bufferedController = new AbortController()
  const buffered = await loopbackFetch(base + '/buffered', { signal: bufferedController.signal })
  await new Promise(resolve => setTimeout(resolve, 40))
  bufferedController.abort()
  await assert.rejects(buffered.text(), error => error.name === 'AbortError')
  assert.equal(intercepted, 0, 'no private engine requests reach the host fetch')
  console.log('ok multipart, empty responses, redirect rejection and streaming cancellation retain fetch behavior')
} finally {
  globalThis.fetch = originalFetch
  models?.close()
  await engine.close()
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
  assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir()))
  fs.rmSync(scratch, { recursive: true, force: true })
}
