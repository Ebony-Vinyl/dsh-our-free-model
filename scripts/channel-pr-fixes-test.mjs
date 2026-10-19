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
  await verifySystemPrompts()
  await verifyBuddyRequests()
  await verifyGatewayTeardown()
  await verifyCodeArtsSignedEgress()
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

async function verifyBuddyRequests() {
  const { BuddyAdapter } = await import('../vendor/channel-pack/src/buddy-adapter.ts')
  const { WORKBUDDY, CODEBUDDY } = await import('../vendor/channel-pack/src/product.ts')
  const defaults = {
    credentialRef: 'FIXTURE', resolveCredential: async () => ({ access_token: 'fixture-token' }), refresh: async () => {},
  }
  for (const product of [WORKBUDDY, CODEBUDDY]) {
    for (const [history, system] of [[undefined, undefined], ['history', undefined], [undefined, 'explicit'], ['history', 'explicit']]) {
      const seen = []
      const options = {
        model: 'deepseek-v4-flash', system,
        messages: [...history === undefined ? [] : [textMessage('system', history)], textMessage('user', 'hello')],
      }
      const before = structuredClone(options)
      const adapter = new BuddyAdapter({
        ...defaults, product, sessionId: 'fixture-conversation',
        fetchImpl: async (_url, init) => {
          seen.push({ headers: new Headers(init.headers), body: JSON.parse(init.body), signal: init.signal })
          return answer('ok')
        },
      })
      for (let i = 0; i < 2; i++) await collect(adapter.stream(options))
      const systems = seen[0].body.messages.filter(message => message.role === 'system').map(message => message.content)
      assert.deepEqual(systems, [
        ...system === undefined ? [] : [system],
        ...history === undefined ? [] : [history],
        ...system === undefined && history === undefined && product.id === 'workbuddy' ? ['You are a helpful assistant.'] : [],
      ])
      if (product.id === 'workbuddy') {
        assert.equal(seen[0].body.messages[0].role, 'system')
        for (const request of seen) assert.equal(request.headers.get('x-conversation-id'), 'fixture-conversation')
        for (const header of ['x-conversation-message-id', 'x-conversation-request-id']) {
          assert.match(seen[0].headers.get(header), /^[0-9a-f-]{36}$/)
          assert.notEqual(seen[0].headers.get(header), seen[1].headers.get(header))
        }
      } else {
        for (const request of seen) for (const header of ['x-conversation-id', 'x-conversation-message-id', 'x-conversation-request-id']) {
          assert.equal(request.headers.has(header), false)
        }
        if (system === undefined && history === undefined) assert.equal(seen[0].body.messages[0].role, 'user')
      }
      assert.deepEqual(options, before)
    }
  }
  const retried = []
  let refreshed = false
  const retry = new BuddyAdapter({
    ...defaults, product: WORKBUDDY, sessionId: 'fixture-retry',
    resolveCredential: async () => ({ access_token: refreshed ? 'fixture-new' : 'fixture-old' }),
    refresh: async () => { refreshed = true },
    fetchImpl: async (_url, init) => {
      retried.push(new Headers(init.headers))
      return retried.length === 1 ? new Response('expired', { status: 401 }) : answer('refreshed')
    },
  })
  await collect(retry.stream({ model: 'deepseek-v4-flash', messages: [textMessage('user', 'hello')], system: 'explicit' }))
  assert.equal(retried.length, 2)
  assert.equal(retried[1].get('authorization'), 'Bearer fixture-new')
  assert.equal(retried[0].get('x-conversation-id'), retried[1].get('x-conversation-id'))
  for (const header of ['x-conversation-message-id', 'x-conversation-request-id']) {
    assert.notEqual(retried[0].get(header), retried[1].get(header))
  }
  console.log('ok  source PR #377: WorkBuddy-only headers/system fallback, explicit/history preservation, fresh IDs on requests and auth retry')

  for (const code of [11128, '11128', 11140, '11140']) {
    const marked = []
    let sent = 0
    const body = {
      code, msg: String(code) === '11128' ? 'request illegal' : 'fixture policy rejection',
      displayMsg: { en: 'fixture upstream detail' },
    }
    const adapter = new BuddyAdapter({
      ...defaults, product: WORKBUDDY,
      accountPool: {
        findAccountIdByCredential: async () => 'fixture-account',
        updateModelRateLimit: async (...args) => marked.push(args),
        getAvailableAccount: async () => undefined,
      },
      fetchImpl: async () => { sent++; return sse(body) },
    })
    const options = { model: 'deepseek-v4-flash', messages: [textMessage('user', 'hello')] }
    await assert.rejects(collect(adapter.stream(options)), error => {
      assert.equal(error.code, String(code) === '11128' ? 'INVALID_REQUEST' : 'PERMISSION_DENIED')
      assert.match(error.message, /fixture upstream detail/)
      if (String(code) === '11128') {
        assert.match(error.message, /request illegal/)
        assert.match(error.message, /11128/)
      }
      return true
    })
    assert.equal(marked.length, String(code) === '11128' ? 0 : 1)
    assert.equal(sent, 1, 'SSE errors do not expand rotation')
    if (marked.length) assert.deepEqual(marked[0].slice(0, 2), ['fixture-account', options.model])

    marked.length = 0
    adapter.fetchImpl = async () => new Response(JSON.stringify(body), { status: 403 })
    await assert.rejects(collect(adapter.stream(options)), error => {
      assert.equal(error.code, String(code) === '11128' ? 'AUTH' : 'PERMISSION_DENIED')
      return true
    })
    assert.equal(marked.length, String(code) === '11128' ? 0 : 1, 'HTTP classifier excludes only the exact protocol code')
  }
  for (const frame of [
    { code: 111280, msg: 'unrelated code' },
    { code: 111400, msg: 'unrelated code' },
    { msg: 'The literal code 11128 or 11140 is documentation.' },
    { msg: 'The literal {"code":11128} or {"code":11140} is documentation.' },
    { choices: [{ delta: { content: '{"code":11128} {"code":11140} request illegal safety review' }, finish_reason: 'stop' }] },
    { code: 11128, choices: [{ delta: { content: 'ordinary content' }, finish_reason: 'stop' }] },
  ]) {
    const marked = []
    const adapter = new BuddyAdapter({
      ...defaults, product: WORKBUDDY,
      accountPool: { updateModelRateLimit: async (...args) => marked.push(args) },
    })
    const chunks = await collect(adapter.consumeSse(sse(frame), { model: 'fixture' }, 'fixture-account'))
    assert.equal(marked.length, 0)
    if (frame.choices) {
      assert.equal(chunks.at(-1).reason.kind, 'stop')
      assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === frame.choices[0].delta.content))
    }
  }
  console.log('ok  source PR #418: numeric/string 11128 preserves SSE detail without cooldown; real 11140 stays policy; prose and code prefixes stay ordinary')
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

/**
 * issue #344：CodeArts 的 SDK-HMAC-SHA256 签名覆盖请求体字节，任何替换
 * `globalThis.fetch` 的本地代理插件只要重序列化一次 body，上游就必然验签失败
 * （表现为 401/403，再被适配器读成「API 密钥无效」）。CodeArts 因此走
 * `direct-fetch.ts` 的直发通道，与全局 `fetch` 解耦。
 *
 * 三条断言缺一不可：默认实现不经过 `globalThis.fetch`、注入值仍然优先、
 * 测试缝在直发通道上真的生效（否则离线套件的「禁止外网」守门对签名的流量失效）。
 */
async function verifyCodeArtsSignedEgress() {
  const { CodeArtsAdapter } = await import('../vendor/channel-pack/src/llm-adapter.ts')
  const { directFetch, directLane } = await import('../vendor/channel-pack/src/direct-fetch.ts')
  const credential = {
    access_key_id: 'FIXTUREAK', secret_access_key: 'FIXTURESECRET', security_token: 'FIXTURETOKEN',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  }
  const options = { model: 'deepseek-v4.1-flash', messages: [textMessage('user', 'hello')] }

  // ① 默认实现（未注入 fetchImpl）不得落到 globalThis.fetch。
  const savedFetch = globalThis.fetch
  // 挂载套件已在直发车道上装了「禁止外网」守门，这里必须原样还回去。
  const laneOriginal = directLane.fetch
  let globalCalls = 0
  globalThis.fetch = async () => { globalCalls++; throw new Error('globalThis.fetch must not be used') }
  const seen = []
  try {
    directLane.fetch = async (url, init) => {
      seen.push({ url: String(url), init })
      return answer('ok')
    }
    const adapter = new CodeArtsAdapter({
      credentialRef: 'FIXTURE', resolveCredential: async () => credential, refresh: async () => {},
    })
    await collect(adapter.stream(options))
  } finally {
    directLane.fetch = laneOriginal
    globalThis.fetch = savedFetch
  }
  assert.equal(globalCalls, 0, 'CodeArts signs its own egress: globalThis.fetch is never consulted')
  assert.equal(seen.length, 1)
  assert.match(seen[0].url, /^https:\/\/snap-access\.cn-north-4\.myhuaweicloud\.com\/api\/v2\/chat\/completions$/)
  // 签名头必须真的生成且覆盖本次 body —— 只断言「有 Authorization」不够，
  // 重签/改写会同时改变这两个头里的哈希。
  const signed = new Headers(seen[0].init.headers)
  assert.match(signed.get('authorization') ?? '', /^SDK-HMAC-SHA256 Access=FIXTUREAK,SignedHeaders=/)
  assert.match(signed.get('x-sdk-content-sha256') ?? '', /^[0-9a-f]{64}$/)
  assert.equal(signed.get('x-security-token'), 'FIXTURETOKEN')
  console.log('ok  source issue #344: CodeArts chat egress bypasses globalThis.fetch and carries a fresh HMAC signature')

  // ② 显式注入的 fetchImpl 仍然优先（离线测试与既有调用方依赖这一点）。
  const injected = []
  const injectedAdapter = new CodeArtsAdapter({
    credentialRef: 'FIXTURE', resolveCredential: async () => credential, refresh: async () => {},
    fetchImpl: async (url, init) => { injected.push(String(url)); return answer('ok') },
  })
  await collect(injectedAdapter.stream(options))
  assert.equal(injected.length, 1, 'an injected fetchImpl still wins over the direct lane')
  assert.equal(directLane.fetch, laneOriginal, 'an injected fetchImpl leaves the shared direct lane untouched')

  // ③ directFetch 本身遵守测试缝，未设缝时用打包内联的 undici（此处只验优先级，
  //    不发起真实网络请求）。
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('directFetch must not read globalThis.fetch') }
  try {
    directLane.fetch = async () => new Response('seam', { status: 200 })
    const response = await directFetch('https://example.invalid/')
    assert.equal(await response.text(), 'seam')
  } finally {
    directLane.fetch = laneOriginal
    globalThis.fetch = original
  }
  console.log('ok  source issue #344: direct lane honours the offline test seam and never falls back to globalThis.fetch')
}
