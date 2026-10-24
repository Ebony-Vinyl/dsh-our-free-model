import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import test from 'node:test'
import { directFetch, lane } from '../src/eac.js'
import { CODE, UpstreamError } from '../src/http.js'

const aborted = error => error instanceof UpstreamError && error.code === CODE.aborted

await test('a pre-aborted request never invokes the injected EAC transport', async () => {
  const saved = lane.fetch
  let calls = 0
  try {
    lane.fetch = async () => { calls++; return new Response('unexpected') }
    const controller = new AbortController()
    controller.abort(new Error('synthetic cancellation'))
    await assert.rejects(directFetch('https://fixture.invalid', { signal: controller.signal }), aborted)
    assert.equal(calls, 0)
  } finally {
    lane.fetch = saved
  }
})

await test('pre-abort prevents URL parsing and native HTTP or HTTPS allocation', async () => {
  const saved = { fetch: lane.fetch, http: http.request, https: https.request }
  let calls = 0
  try {
    lane.fetch = null
    http.request = https.request = () => { calls++; throw new Error('unexpected socket allocation') }
    for (const url of ['http://fixture.invalid', 'https://fixture.invalid', 'not a URL']) {
      await assert.rejects(directFetch(url, { signal: AbortSignal.abort() }), aborted)
    }
    assert.equal(calls, 0)
  } finally {
    lane.fetch = saved.fetch
    http.request = saved.http
    https.request = saved.https
  }
})

await test('a live signal preserves the existing transport arguments and result', async () => {
  const saved = lane.fetch
  const signal = new AbortController().signal
  const headers = { 'content-type': 'application/json', 'x-synthetic-signature': 'unchanged' }
  const body = '{"synthetic":true}'
  const response = new Response('ok')
  try {
    lane.fetch = async (url, init) => {
      assert.equal(url, 'https://fixture.invalid')
      assert.deepEqual(init, { method: 'POST', headers, body, signal })
      assert.equal(init.headers, headers)
      return response
    }
    assert.equal(await directFetch('https://fixture.invalid', { method: 'POST', headers, body, signal }), response)
  } finally {
    lane.fetch = saved
  }
})

await test('the EAC transport preserves signed bytes through a selected HTTP proxy', async () => {
  const saved = { fetch: lane.fetch, proxy: lane.proxy }
  const proxy = http.createServer((req, res) => {
    assert.equal(req.url, 'http://unreachable.invalid/eac/auth/status')
    assert.equal(req.headers['x-synthetic-signature'], 'unchanged')
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      assert.equal(Buffer.concat(chunks).toString('utf8'), '{"signed":true}')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  try {
    lane.fetch = null
    lane.proxy = `http://127.0.0.1:${proxy.address().port}`
    const response = await directFetch('http://unreachable.invalid/eac/auth/status', {
      method: 'POST', headers: { 'x-synthetic-signature': 'unchanged' }, body: '{"signed":true}',
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  } finally {
    lane.fetch = saved.fetch
    lane.proxy = saved.proxy
    await new Promise(resolve => proxy.close(resolve))
  }
})
