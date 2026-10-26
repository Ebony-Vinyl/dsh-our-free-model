/** Shared transport and all three forwarding protocols, using loopback-only providers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

await test('classified stream failures survive every local forwarding protocol', async t => {
  const originalBase = process.env.OUR_FREE_MODEL_BASE
  const originalKilo = process.env.OUR_FREE_MODEL_KILO_BASE
  let reply = ': heartbeat\n\n'
  const upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(reply) })
  })
  t.after(async () => {
    if (originalBase === undefined) delete process.env.OUR_FREE_MODEL_BASE
    else process.env.OUR_FREE_MODEL_BASE = originalBase
    if (originalKilo === undefined) delete process.env.OUR_FREE_MODEL_KILO_BASE
    else process.env.OUR_FREE_MODEL_KILO_BASE = originalKilo
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${upstream.address().port}`
  process.env.OUR_FREE_MODEL_BASE = base
  process.env.OUR_FREE_MODEL_KILO_BASE = base
  const { readSse, postStreamed, classifyFailure } = await import('../src/http.js')
  const { postSealedStreamed } = await import('../src/eac.js')
  const { postKiloStreamed } = await import('../src/kilo.js')
  const { postAggregateStreamed } = await import('../src/aggregate.js')
  const { foldForwardOutcome } = await import('../src/core/completion.js')
  const { startForwardServer } = await import('../src/forward.js')
  const { readStream } = await import('../src/stream.js')
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'OK' }], stream: true }
  const gate = { error: { type: 'permission_error', code: 'insufficient_quota', message: 'OpenCode free tier rejected this request' } }
  const options = { body, onData: () => {}, timeoutMs: 2000 }
  const posters = {
    anonymous: () => postStreamed({ ...options, path: '/chat/completions', session: 'fixture' }),
    EAC: () => postSealedStreamed({ ...options, credential: { mode: 'direct', base, apiKey: 'fixture' } }),
    Kilo: () => postKiloStreamed(options),
    aggregate: () => postAggregateStreamed({ ...options, config: { enabled: true, providers: { openai_api: { enabled: true, apiKey: 'fixture', baseUrl: base } } }, providerId: 'openai_api', modelId: 'fixture' }),
  }
  for (const [name, post] of Object.entries(posters)) {
    for (const formatted of [false, true]) await t.test(`${name}: heartbeat followed by ${formatted ? 'multiline' : 'compact'} JSON refusal`, async () => {
      reply = ': heartbeat\r\n\r\n' + JSON.stringify(gate, null, formatted ? 2 : undefined)
      await assert.rejects(post, error => error.code === 'PERMISSION_DENIED')
    })
  }
  await t.test('permission, exhausted quota, and temporary rate limit remain distinct', () => {
    assert.equal(classifyFailure(undefined, gate).code, 'PERMISSION_DENIED')
    assert.equal(classifyFailure(undefined, { error: { type: 'insufficient_quota', message: 'budget exhausted' } }).code, 'QUOTA_EXHAUSTED')
    assert.equal(classifyFailure(429, { error: { message: 'try later' } }, 2300).providerRetryAfterMs, 2300)
  })
  await t.test('fragmented UTF-8, BOM, CRLF and multiline data retain complete payloads', async () => {
    const frames = []
    const payload = '\uFEFF: heartbeat\r\n\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: [DONE]\r\n\r\n'
    const bytes = new TextEncoder().encode(payload)
    async function* source() { for (const byte of bytes) yield Uint8Array.of(byte) }
    await readSse(source(), value => frames.push(JSON.parse(value)))
    assert.deepEqual(frames, [{ text: '你好' }])
  })
  await t.test('DONE cancels a real ReadableStream without waiting for EOF or leaking following frames', async () => {
    let cancelled = false
    const source = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"text":"OK"}\n\ndata: [DONE]\n\ndata: {"text":"late"}\n\n')) },
      cancel() { cancelled = true },
    })
    const output = []
    await readSse(source, value => output.push(JSON.parse(value)), undefined, 2000)
    assert.deepEqual(output, [{ text: 'OK' }])
    assert.equal(cancelled, true)
  })
  await t.test('a held read observes its idle deadline and cancels the reader', async () => {
    let cancelled = false
    const source = new ReadableStream({ cancel() { cancelled = true } })
    await assert.rejects(() => readSse(source, () => {}, undefined, 25), error => error.code === 'TIMEOUT')
    assert.equal(cancelled, true)
  })
  await t.test('caller abort is preserved while the next read is pending', async () => {
    let start
    const reading = new Promise(resolve => { start = resolve })
    let cancelled = false
    const source = new ReadableStream({ pull() { start() }, cancel() { cancelled = true } })
    const controller = new AbortController()
    const result = readSse(source, () => {}, controller.signal, 2000)
    await reading
    controller.abort()
    await assert.rejects(result, error => error.code === 'ABORTED')
    assert.equal(cancelled, true)
  })
  for (const wire of ['chat', 'messages', 'responses']) await t.test(`${wire}: named tool metadata reports progress once without argument deltas`, async () => {
    const event = name => wire === 'chat'
      ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_progress', function: { ...(name ? { name } : {}) } }] } }] }
      : wire === 'messages'
        ? { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_progress', ...(name ? { name } : {}) } }
        : { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_progress', ...(name ? { name } : {}) } }
    let progress = 0
    const output = []
    async function* frames() { for (const name of ['', 'test_tool', 'test_tool']) yield JSON.stringify(event(name)) }
    for await (const chunk of readStream(frames(), wire, new Map(), undefined, { onProgress: () => progress++ })) output.push(chunk)
    assert.equal(progress, 1, 'incomplete and repeated metadata must not keep an idle call alive')
    assert.equal(output.some(chunk => chunk.type === 'tool-call-delta'), false)
    assert.ok(output.some(chunk => chunk.type === 'block-end' && chunk.block?.name === 'test_tool'))
  })
  let chunks = []
  let thrown
  const forward = await startForwardServer({
    config: () => ({ host: '127.0.0.1', port: 0, enabled: true, key: 'fixture' }),
    modelRows: () => [],
    complete: async (_request, onChunk = () => {}) => {
      const outcome = { text: '', toolCalls: [] }
      for (const chunk of chunks) { onChunk(chunk); foldForwardOutcome(outcome, chunk) }
      if (thrown) throw thrown
      return outcome
    },
  })
  t.after(() => forward.close())
  const protocols = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages' }
  const cases = [
    ['LANE_LOCKED', 403], ['PERMISSION_DENIED', 403], ['INVALID_CREDENTIAL', 401],
    ['QUOTA_EXHAUSTED', 429], ['RATE_LIMIT', 429], ['TIMEOUT', 504], ['ABORTED', 400], ['EAC_UPSTREAM_FAILED', 502], ['NO_PROGRESS', 504],
  ]
  for (const [protocol, path] of Object.entries(protocols)) for (const stream of [false, true]) {
    await t.test(`${protocol} stream=${stream}: a thrown permission refusal is not an empty answer`, async () => {
      chunks = []
      thrown = Object.assign(new Error('refused'), { code: 'PERMISSION_DENIED' })
      try {
        const response = await fetch(`http://127.0.0.1:${forward.port}${path}`, {
          method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', origin: 'https://client.example.invalid' },
          body: JSON.stringify({ ...body, input: 'OK', max_tokens: 100, stream }),
        })
        assert.equal(response.status, 403)
        assert.equal(response.headers.get('access-control-allow-origin'), '*')
        assert.equal((await response.json()).error.code, 'PERMISSION_DENIED')
      } finally { thrown = undefined }
    })
    for (const [code, status] of cases) await t.test(`${protocol} stream=${stream}: ${code} keeps its HTTP status and code`, async () => {
      const failure = { message: 'classified fixture', code, ...(code === 'RATE_LIMIT' ? { providerRetryAfterMs: 2300 } : {}), privateField: 'must-not-leak' }
      chunks = [{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }, { type: 'finish', reason: { kind: code === 'ABORTED' ? 'aborted' : 'error', failure } }]
      const response = await fetch(`http://127.0.0.1:${forward.port}${path}`, {
        method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', origin: 'https://client.example.invalid' },
        body: JSON.stringify({ ...body, input: 'OK', max_tokens: 100, stream }),
      })
      assert.equal(response.status, status)
      assert.equal(response.headers.get('access-control-allow-origin'), '*', 'browser callers can read classified failures')
      const value = await response.json()
      assert.equal(value.error.code, code)
      assert.equal(value.error.privateField, undefined)
      if (code === 'RATE_LIMIT') assert.equal(response.headers.get('retry-after'), '3')
      if (['LANE_LOCKED', 'QUOTA_EXHAUSTED', 'EAC_UPSTREAM_FAILED', 'NO_PROGRESS'].includes(code)) assert.equal(response.headers.get('x-should-retry'), 'false')
    })
    if (stream) await t.test(`${protocol}: a failure after content stays an error event`, async () => {
      chunks = [{ type: 'text-delta', text: 'partial', index: 0 }, { type: 'finish', reason: { kind: 'error', failure: { code: 'LANE_LOCKED', message: 'rejected' } } }]
      const response = await fetch(`http://127.0.0.1:${forward.port}${path}`, {
        method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, input: 'OK', max_tokens: 100, stream: true }),
      })
      assert.equal(response.status, 200)
      const text = await response.text()
      assert.ok(text.includes('LANE_LOCKED'))
      const payloads = text.split('\n').filter(row => row.startsWith('data: ')).map(row => row.slice(6)).filter(row => row !== '[DONE]')
      async function* frames() { yield* payloads }
      await assert.rejects(async () => { for await (const _ of readStream(frames(), protocol === 'messages' ? 'messages' : protocol === 'responses' ? 'responses' : 'chat', new Map())) {} })
    })
  }
})
