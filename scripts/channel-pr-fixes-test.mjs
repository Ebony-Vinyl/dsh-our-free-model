/** Offline source regressions, run by channel-pack-test.mjs --source. */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

const collect = async iterable => {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
const textMessage = (role, text) => ({ role, content: [{ type: 'text', text }] })
const sse = frame => new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
const answer = text => sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })

async function within(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1000) }),
    ])
  } finally { clearTimeout(timer) }
}

export async function verifyChannelPrFixes() {
  const { verifyChannelStorageCompatibility } = await import('./channel-storage-compat-test.mjs')
  await verifyChannelStorageCompatibility()
  await verifySystemPrompts()
  await verifyGatewayTeardown()
  await verifyGatewayLongLivedConnections()
}

/**
 * 网关要能被「会保留空闲连接的客户端」安全复用，并要把超限请求回成 413。
 *
 * 真实故障：CC Switch 用 reqwest 转发，reqwest 默认保留空闲连接 90 秒，而
 * Node 默认 5 秒就关闭；复用时刻撞上已关闭的 socket，用户看到 502 和
 * `Connection reset by peer`。请求体超过上限时也一样：旧代码直接销毁连接，
 * 客户端同样只看到连接重置，读不到 413 的原因。
 */
async function verifyGatewayLongLivedConnections() {
  const { createOpenAiGateway } = await import('../vendor/channel-pack/src/openai-gateway/server.ts')
  const reserve = net.createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))

  const gateway = createOpenAiGateway({
    env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'fixture-local-key' },
    logger: { info() {}, warn() {}, error() {} },
    llm: {
      listProviders: () => [{ id: 'fixture' }],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      async *stream() { yield { type: 'text-delta', index: 0, text: 'fixture' } },
    },
  })
  try {
    await gateway.start()

    // 服务端声明的空闲上限必须长于 reqwest 的 90 秒，客户端才不会复用已关闭的连接。
    const headers = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port, path: '/v1/models', method: 'GET',
        headers: { authorization: 'Bearer fixture-local-key' },
      }, response => { response.resume(); resolve(response.headers) })
      request.on('error', reject)
      request.end()
    })
    const keepAlive = String(headers['keep-alive'] ?? '')
    const timeoutSeconds = Number.parseInt(/timeout=(\d+)/.exec(keepAlive)?.[1] ?? '', 10)
    assert.ok(timeoutSeconds > 90, `keep-alive timeout must outlast reqwest's 90s: ${keepAlive}`)

    // 超过上限的请求必须得到可读的 413，而不是连接重置。
    const tooLarge = 'x'.repeat(64 * 1024 * 1024 + 1)
    const reply = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port, path: '/v1/responses', method: 'POST',
        headers: {
          authorization: 'Bearer fixture-local-key',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(tooLarge),
        },
      }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body }))
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end(tooLarge)
    })
    assert.equal(reply.status, 413, 'oversized body is refused with 413')
    assert.match(reply.body, /request body is too large/, '413 carries a readable reason')
  } finally {
    await within(gateway.close(), 'gateway long-lived connections: cleanup')
  }
  console.log('ok  gateway keeps idle connections past the client timeout and answers oversized bodies with 413')
}

async function verifySystemPrompts() {
  const { translateGeminiRequest } = await import('../vendor/channel-pack/src/gemini-messages.ts')
  const { buildMinimaxMessagesPayload } = await import('../vendor/channel-pack/src/minimax-messages.ts')
  const { collectHarnessSystem } = await import('../vendor/channel-pack/src/message-shape.ts')
  assert.equal(collectHarnessSystem([
    null, { role: 'system' }, { role: 'system', content: 'bare' },
    { role: 'system', content: [{ type: 'image' }, { type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
    textMessage('developer', 'metadata'),
  ]), 'bare\n\none\ntwo')
  const user = textMessage('user', 'hello')
  for (const [name, messages, system, expected] of [
    ['message only', [textMessage('system', 'sentinel'), user], undefined, 'sentinel'],
    ['field only', [user], 'sentinel', 'sentinel'],
    ['identical carriers', [textMessage('system', 'sentinel'), user], 'sentinel', 'sentinel'],
    ['distinct carriers', [textMessage('system', 'history'), user], 'field', 'field\n\nhistory'],
    ['multiple systems', [textMessage('system', 'one'), textMessage('system', 'two'), user], undefined, 'one\n\ntwo'],
    ['identical aggregate', [textMessage('system', 'one'), textMessage('system', 'two'), user], 'one\n\ntwo', 'one\n\ntwo'],
    ['empty carriers', [textMessage('system', ''), user], '', undefined],
    ['absent carriers', [user], undefined, undefined],
  ]) {
    const before = structuredClone(messages)
    const gemini = translateGeminiRequest({
      modelId: 'fixture', spec: { upstream: 'fixture', includeThoughts: false, thinkingBudget: -1 },
      messages, system, requestId: 'fixture-request',
    }).request
    const minimax = buildMinimaxMessagesPayload({ model: 'fixture', messages, system })
    assert.equal(gemini.systemInstruction?.parts.map(part => part.text).join('\n'), expected, `Gemini ${name}`)
    assert.equal(minimax.system, expected, `MiniMax ${name}`)
    assert.deepEqual(gemini.contents, [{ role: 'user', parts: [{ text: 'hello' }] }], `Gemini ${name}: conversation`)
    assert.deepEqual(minimax.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], `MiniMax ${name}: conversation`)
    assert.deepEqual(messages, before, `${name}: input is preserved`)
    if (expected === undefined) {
      assert.equal('systemInstruction' in gemini, false)
      assert.equal('system' in minimax, false)
    }
  }
  console.log('ok  source PR #401: message/field/multiple/empty system prompts, identical-carrier deduplication, unchanged conversation')
}

async function verifyGatewayTeardown() {
  const { createOpenAiGateway } = await import('../vendor/channel-pack/src/openai-gateway/server.ts')
  for (const kind of ['idle', 'active-model-list', 'incomplete-headers', 'active-stream']) {
    const reserve = net.createServer()
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
    const port = reserve.address().port
    await new Promise(resolve => reserve.close(resolve))
    let entered, ended, streamSignal
    const started = new Promise(resolve => { entered = resolve })
    const streamEnded = new Promise(resolve => { ended = resolve })
    const gateway = createOpenAiGateway({
      env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'fixture-local-key' },
      logger: { info() {}, warn() {}, error() {} },
      llm: {
        listProviders: () => [{ id: 'fixture' }],
        listModels: async () => { entered(); return kind === 'active-model-list' ? new Promise(() => {}) : [] },
        resolveModelInfo: async () => ({}),
        async *stream(options) {
          streamSignal = options.signal
          try {
            yield { type: 'text-delta', index: 0, text: 'fixture-stream' }
            await new Promise(resolve => {
              if (streamSignal.aborted) resolve()
              else streamSignal.addEventListener('abort', resolve, { once: true })
              entered()
            })
          } finally { ended() }
        },
      },
    })
    let request, socket, closing
    const agent = new http.Agent({ keepAlive: true })
    try {
      await gateway.start()
      if (kind === 'incomplete-headers') {
        socket = net.connect(port, '127.0.0.1')
        socket.on('error', () => {})
        await within(new Promise(resolve => socket.once('connect', resolve)), `${kind}: connect`)
        socket.write('GET /v1/models HTTP/1.1\r\nHost: localhost\r\n')
        await new Promise(resolve => setTimeout(resolve, 20))
      } else {
        const complete = new Promise((resolve, reject) => {
          request = http.request({
            host: '127.0.0.1', port, agent,
            path: kind === 'active-stream' ? '/v1/chat/completions' : '/v1/models',
            method: kind === 'active-stream' ? 'POST' : 'GET',
            headers: { authorization: 'Bearer fixture-local-key', 'content-type': 'application/json' },
          }, response => {
            response.on('error', () => {})
            response.resume()
            response.once('end', resolve)
          })
          request.on('error', reject)
          request.end(kind === 'active-stream' ? JSON.stringify({
            model: 'fixture/model', messages: [{ role: 'user', content: 'hello' }], stream: true,
          }) : undefined)
        })
        void complete.catch(() => {})
        await within(kind === 'idle' ? complete : started, `${kind}: request`)
      }
      closing = gateway.close()
      await within(closing, `${kind}: close`)
      if (kind === 'active-stream') {
        assert.equal(streamSignal.aborted, true, 'gateway shutdown aborts upstream inference')
        await within(streamEnded, 'stream cancellation')
      }
      await gateway.close()
    } finally {
      request?.destroy()
      socket?.destroy()
      agent.destroy()
      await within(closing ?? gateway.close(), `${kind}: cleanup`)
    }
  }
  console.log('ok  source PR #405: idle/active/incomplete HTTP connections close within 1s, upstream stream aborted, repeated close safe')
}
