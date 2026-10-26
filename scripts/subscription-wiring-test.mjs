/** Plugin/core subscription integration. Only synthetic accounts and local HTTP. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { callRoute, fakeContext, freePort, stubUpstream, until } from './lib/fake-kernel.mjs'

const free = await stubUpstream({
  listing: ['mimo-v2.6-flash-free'],
  answer: () => ({ body: [
    'data: {"choices":[{"delta":{"content":"local free answer"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ].join('') }),
})
process.env.OUR_FREE_MODEL_BASE = free.base
const { createModelRuntime, createRuntimeStores } = await import('../src/core/runtime.js')
const { subscriptionChunks, subscriptionCatalog } = await import('../src/subscription-adapter.js')
const { apply, inject, createApiRoutes } = await import('../index.js')
const { createSubscriptionRuntime } = await import('../src/subscription-completion.js')
const { startForwardServer } = await import('../src/forward.js')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-subscription-wiring-'))
const tick = () => new Promise(resolve => setImmediate(resolve))
const defer = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const bounded = async promise => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('subscription operation stalled')), 1500)
    })])
  } finally { clearTimeout(timer) }
}
const input = model => ({
  provider: 'our-free-model', model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello fixture' }] }],
})
const collect = async stream => {
  const chunks = []
  let result
  while (true) {
    const row = await stream.next()
    if (row.done) { result = row.value; break }
    chunks.push(row.value)
  }
  return { chunks, result }
}
const stores = []
const runtimes = []
let context, upstream
const checks = []
const check = async (name, fn) => { await fn(); checks.push(name); console.log('ok  ' + name) }
const silent = { warn() {}, info() {} }
const setup = (subscriptionRuntime, options = {}) => {
  const store = createRuntimeStores({ dataDir: path.join(scratch, crypto.randomUUID()), logger: silent })
  stores.push(store)
  store.settings.update({ combos: [] })
  const runtime = createModelRuntime({ ...store, subscriptionRuntime, logger: silent, ...options })
  runtimes.push(runtime)
  return { ...store, runtime }
}
const modelId = 'subscription:fake-account/model-one'
const model = { id: modelId, name: 'Fixture subscription', subscriptionId: 'fake-account', subscriptionProvider: 'codex' }
const nativePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=', 'base64')

try {
  await check('optional core contract normalizes public metadata before combos and preserves offline callers', async () => {
    const plain = setup()
    assert.ok(plain.runtime.catalog.length > 0)
    assert.ok(!plain.runtime.catalog.some(row => row.channel === 'subscription'))
    let rows = [
      { ...model, headers: { authorization: 'hidden' }, credentials: { apiKey: 'hidden' } },
      { ...model, id: 'subscription:fake-account/model-two', wire: 'anthropic-messages',
        contextWindow: 64000, maxOutput: 2048, reasoning: true, vision: true },
      { ...model, id: 'ordinary-provider/forged' },
    ]
    const fixture = setup({ catalog: () => rows, complete: async () => {} })
    const entry = fixture.runtime.catalog.find(row => row.id === modelId)
    assert.equal(entry.channel, 'subscription')
    assert.equal(entry.wire, 'responses')
    assert.equal(entry.contextWindow, 131072)
    assert.equal(entry.maxOutput, 8192)
    assert.equal(entry.reasoning, false)
    assert.ok(!JSON.stringify(fixture.runtime.catalog).includes('hidden'))
    assert.ok(!fixture.runtime.catalog.some(row => row.id === 'ordinary-provider/forged'))
    fixture.settings.update({ combos: [{ id: 'combo:subs', name: 'Subscription combo', models: rows.slice(0, 2).map(row => row.id) }] })
    fixture.runtime.syncAggregateCatalog()
    const combo = fixture.runtime.catalog.find(row => row.id === 'combo:subs')
    assert.equal(combo.contextWindow, 64000)
    assert.equal(combo.maxOutput, 2048)
    assert.equal(combo.reasoning, true)
    assert.deepEqual(combo.lanes, ['subscription'])
    assert.ok((await fixture.runtime.adapter.listModels('our-free-model')).some(row => row.id === modelId))
    assert.ok(fixture.runtime.publicModelRows().some(row => row.id === modelId && row.context_window === 131072))
    rows = []
    fixture.runtime.syncAggregateCatalog()
    assert.ok(!fixture.runtime.catalog.some(row => row.channel === 'subscription' || row.channel === 'combo'))
    assert.deepEqual(subscriptionCatalog({ catalog: () => [model] }), [])
  })

  await check('callback bridge streams before completion and aborts hung producers and early consumers', async () => {
    const gate = defer(), seen = []
    const bridge = subscriptionChunks({ complete: async (request, emit) => {
      seen.push(request)
      emit({ type: 'text-delta', index: 0, text: 'live' })
      await gate.promise
      return { text: 'live' }
    } }, { model: modelId })
    assert.equal((await bounded(bridge.next())).value.text, 'live')
    gate.resolve()
    assert.deepEqual(await bounded(bridge.next()), { done: true, value: { text: 'live' } })
    assert.equal(seen[0].signal.aborted, true)
    const caller = new AbortController()
    const entered = defer()
    let producerSignal
    const hung = subscriptionChunks({ complete: async (request) => {
      producerSignal = request.signal; entered.resolve()
      return new Promise(() => {})
    } }, { model: modelId, signal: caller.signal })
    const pending = hung.next()
    await entered.promise
    caller.abort()
    await assert.rejects(bounded(pending), error => error.code === 'ABORTED')
    assert.equal(producerSignal.aborted, true)
    const stop = subscriptionChunks({ complete: async (request, emit) => {
      producerSignal = request.signal
      emit({ type: 'text-delta', text: 'first' })
      return new Promise(() => {})
    } }, { model: modelId })
    await stop.next()
    await bounded(stop.return())
    assert.equal(producerSignal.aborted, true)
    const cancelled = new AbortController()
    cancelled.abort()
    let calls = 0
    await assert.rejects(subscriptionChunks({ complete: () => { calls++ } }, {
      model: modelId, signal: cancelled.signal,
    }).next(), error => error.code === 'ABORTED')
    assert.equal(calls, 0)
    const flooded = subscriptionChunks({ complete: async (_request, emit) => {
      for (let i = 0; i < 5000; i++) emit({ type: 'text-delta', text: 'x' })
    } }, { model: modelId })
    await assert.rejects(bounded(collect(flooded)))
  })

  await check('adapter preserves settings/signal, emits one terminal and delegates usage exclusively to helper', async () => {
    const calls = []
    const fixture = setup({ catalog: () => [model], complete: async (request, emit) => {
      calls.push(request)
      emit({ type: 'text-delta', index: 0, text: 'subscription answer' })
      emit({ type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } })
      emit({ type: 'finish', reason: { kind: 'stop' } })
      return { text: 'subscription answer' }
    } })
    fixture.settings.update({ defaultMaxTokens: 1024 })
    const result = await collect(fixture.runtime.adapter.stream(input(modelId)))
    assert.equal(result.chunks.filter(chunk => chunk.type === 'finish').length, 1)
    assert.equal(result.chunks.at(-1).reason.kind, 'stop')
    assert.equal(calls[0].model, modelId)
    assert.equal(calls[0].maxTokens, 1024)
    assert.deepEqual(calls[0].messages, input(modelId).messages)
    assert.equal(fixture.stats.get().requests, 0, 'adapter must not add helper-owned physical usage')
    assert.equal(fixture.stats.get().logical.turns, 0, 'single turn is helper-owned too')
    fixture.settings.update({ enabled: false })
    const disabled = await collect(fixture.runtime.adapter.stream(input(modelId)))
    assert.equal(disabled.chunks.at(-1).reason.failure.code, 'CONFIG_DISABLED')
    assert.equal(calls.length, 1)
    fixture.settings.update({ enabled: true })
    const signal = AbortSignal.abort()
    const aborted = await collect(fixture.runtime.adapter.stream({ ...input(modelId), signal }))
    assert.equal(aborted.chunks.at(-1).reason.kind, 'aborted')
    assert.equal(calls.length, 1)
    assert.ok(free.requests.every(request => !String(request.body.model).startsWith('subscription:')))
  })

  await check('adapter early return and forwarded cancellation stop a live callback producer', async () => {
    let producerSignal
    const fixture = setup({ catalog: () => [model], complete: async (request, emit) => {
      producerSignal = request.signal
      emit({ type: 'text-delta', index: 0, text: 'live' })
      return new Promise(() => {})
    } })
    const stream = fixture.runtime.adapter.stream(input(modelId))
    assert.equal((await bounded(stream.next())).value.text, 'live')
    await bounded(stream.return())
    assert.equal(producerSignal.aborted, true)
    const controller = new AbortController()
    const chunks = []
    const complete = fixture.runtime.complete({
      model: modelId, messages: input(modelId).messages, signal: controller.signal,
    }, chunk => {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') controller.abort()
    })
    await bounded(complete)
    assert.equal(chunks.at(-1).reason.kind, 'aborted')
    assert.equal(producerSignal.aborted, true)
  })

  await check('helper rejection after finish, missing terminal and returned failure cannot certify success', async () => {
    for (const mode of ['late-rejection', 'missing-terminal', 'returned-failure']) {
      const fixture = setup({ catalog: () => [model], complete: async (_request, emit) => {
        emit({ type: 'text-delta', index: 0, text: 'partial' })
        if (mode !== 'missing-terminal') emit({ type: 'finish', reason: { kind: 'stop' } })
        if (mode === 'late-rejection') throw Object.assign(new Error('late failure'), { code: 'RATE_LIMIT', statusCode: 429 })
        if (mode === 'returned-failure') return { error: 'failed outcome', failure: { code: 'PROVIDER_ERROR' } }
        return { text: 'partial' }
      } })
      const { chunks } = await collect(fixture.runtime.adapter.stream(input(modelId)))
      assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1, mode)
      assert.equal(chunks.at(-1).reason.kind, 'error', mode)
    }
  })

  await check('native attachment resolver and gateway tool choice survive adapter dispatch on all four subscription wires', async () => {
    const received = [], resolved = [], resolutions = [], logs = []
    const secret = 'fixture-only-private-credential'
    const imageBytes = nativePng
    const imageUrl = `data:image/png;base64,${imageBytes.toString('base64')}`
    const attachment = { attachmentId: 'native-image-no-url', mediaType: 'image/png', bytes: imageBytes.length, width: 1, height: 1 }
    assert.equal(Object.hasOwn(attachment, 'url'), false)
    const wireRows = [
      { id: 'account-chat', provider: 'api', format: 'openai-chat', wire: 'chat' },
      { id: 'account-responses', provider: 'codex', wire: 'responses' },
      { id: 'account-claude', provider: 'claude', wire: 'messages' },
      { id: 'account-gemini', provider: 'gemini', wire: 'gemini-code-assist' },
    ]
    const local = http.createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const wire = req.url.slice(1)
      received.push({ wire, body: JSON.parse(raw) })
      const frames = wire === 'responses' ? [
        { type: 'response.output_text.delta', output_index: 0, delta: 'fixture answer' },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } } },
      ] : wire === 'messages' ? [
        { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture answer' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ] : wire === 'gemini-code-assist' ? [
        { response: { candidates: [{ content: { parts: [{ text: 'fixture answer' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } } },
      ] : [
        { choices: [{ delta: { content: 'fixture answer' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
        '[DONE]',
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''))
    })
    let gateway
    try {
      await new Promise(resolve => local.listen(0, '127.0.0.1', resolve))
      const subscriptions = {
        list: () => wireRows.map(row => ({ ...row, enabled: true, models: ['fixture-model'] })),
        async resolve(id) {
          resolutions.push(id)
          const row = wireRows.find(row => id === `subscription:${row.id}/fixture-model`)
          assert.ok(row)
          return {
            ...row, model: 'fixture-model', project: 'synthetic-project',
            endpoint: `http://127.0.0.1:${local.address().port}/${row.wire}`,
            headers: { authorization: `Bearer ${secret}` },
          }
        },
      }
      const logger = { warn: message => logs.push(message), info: message => logs.push(message) }
      const subscriptionRuntime = createSubscriptionRuntime({ subscriptions, logger })
      const fixture = setup(subscriptionRuntime, {
        logger,
        resolveImage(ref) {
          resolved.push(ref)
          assert.deepEqual(ref, attachment)
          return imageUrl
        },
      })
      const tools = [{ name: 'inspect_fixture', description: 'Inspect fixture', parameters: { type: 'object', properties: {} } }]
      for (const row of wireRows) {
        const id = `subscription:${row.id}/fixture-model`
        const beforeResolver = resolved.length
        const result = await collect(fixture.runtime.adapter.stream({
          ...input(id), messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect attachment' }, { type: 'image', attachment }] }],
          tools, toolChoice: { name: 'inspect_fixture' },
        }))
        assert.equal(result.chunks.at(-1).reason.kind, 'stop', row.wire)
        assert.equal(resolved.length, beforeResolver + 1, `${row.wire}: native attachment must use the injected resolver`)
        const body = received.at(-1).body
        if (row.wire === 'chat') assert.equal(body.messages[0].content.find(part => part.type === 'image_url').image_url.url, imageUrl)
        if (row.wire === 'responses') assert.equal(body.input[0].content.find(part => part.type === 'input_image').image_url, imageUrl)
        if (row.wire === 'messages') assert.deepEqual(body.messages[0].content.find(part => part.type === 'image').source,
          { type: 'base64', media_type: 'image/png', data: imageBytes.toString('base64') })
        if (row.wire === 'gemini-code-assist') assert.deepEqual(body.request.contents[0].parts.find(part => part.inlineData).inlineData,
          { mimeType: 'image/png', data: imageBytes.toString('base64') })
      }
      gateway = await startForwardServer({
        config: () => ({ host: '127.0.0.1', port: 0, enabled: true, key: 'fixture-forward-key' }),
        modelRows: fixture.runtime.publicModelRows, complete: fixture.runtime.complete,
        log: message => logs.push(message),
      })
      const post = (pathname, body) => fetch(`http://127.0.0.1:${gateway.port}${pathname}`, {
        method: 'POST', headers: { authorization: 'Bearer fixture-forward-key', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const choiceFor = (wire, choice) => {
        if (wire === 'messages') return choice === 'named' ? { type: 'tool', name: 'inspect_fixture' } : { type: choice === 'required' ? 'any' : 'none' }
        if (wire === 'gemini-code-assist') return { functionCallingConfig: {
          mode: choice === 'none' ? 'NONE' : 'ANY',
          ...(choice === 'named' ? { allowedFunctionNames: ['inspect_fixture'] } : {}),
        } }
        if (choice !== 'named') return choice
        return wire === 'responses' ? { type: 'function', name: 'inspect_fixture' }
          : { type: 'function', function: { name: 'inspect_fixture' } }
      }
      for (const row of wireRows) {
        const id = `subscription:${row.id}/fixture-model`
        for (const endpoint of ['/v1/chat/completions', '/v1/responses']) {
          for (const choice of ['none', 'required', 'named']) {
            const tool_choice = choice === 'named'
              ? endpoint === '/v1/responses' ? { type: 'function', name: 'inspect_fixture' }
                : { type: 'function', function: { name: 'inspect_fixture' } }
              : choice
            const before = received.length
            const response = await post(endpoint, {
              model: id, tools: endpoint === '/v1/responses'
                ? [{ type: 'function', ...tools[0] }] : [{ type: 'function', function: tools[0] }], tool_choice,
              ...(endpoint === '/v1/responses' ? { input: 'Inspect fixture' } : { messages: [{ role: 'user', content: 'Inspect fixture' }] }),
            })
            const body = await response.text()
            assert.equal(response.status, 200, body)
            assert.equal(received.length, before + 1)
            const payload = received.at(-1).body
            assert.deepEqual(row.wire === 'gemini-code-assist' ? payload.request.toolConfig : payload.tool_choice,
              choiceFor(row.wire, choice), `${endpoint}/${row.wire}/${choice}`)
            assert.ok(!body.includes(secret))
          }
        }
        for (const choice of ['none', 'required', 'named']) {
          const nativeChoice = choice === 'named' ? { type: 'tool', name: 'inspect_fixture' }
            : { type: choice === 'required' ? 'any' : 'none' }
          const before = received.length
          const response = await post('/v1/messages', {
            model: id, max_tokens: 128, messages: [{ role: 'user', content: 'Inspect fixture' }],
            tools: [{ name: 'inspect_fixture', input_schema: tools[0].parameters }], tool_choice: nativeChoice,
          })
          assert.equal(response.status, 200, await response.text())
          assert.equal(received.length, before + 1)
          const payload = received.at(-1).body
          assert.deepEqual(row.wire === 'gemini-code-assist' ? payload.request.toolConfig : payload.tool_choice,
            choiceFor(row.wire, choice), `/v1/messages/${row.wire}/${choice}`)
        }
        for (const nativeChoice of [null, { type: 'invalid' }, { type: 'tool', name: 'missing' },
          { type: 'auto', disable_parallel_tool_use: true }]) {
          const before = received.length
          const response = await post('/v1/messages', {
            model: id, max_tokens: 128, messages: [{ role: 'user', content: 'Inspect fixture' }],
            tools: [{ name: 'inspect_fixture', input_schema: tools[0].parameters }], tool_choice: nativeChoice,
          })
          assert.equal(response.status, 400)
          await response.text()
          assert.equal(received.length, before)
        }
        const preferred = await fixture.runtime.complete({
          model: id, messages: input(id).messages, tools, toolChoice: 'none', openAi: { tool_choice: 'required' },
        })
        assert.equal(preferred.error, undefined)
        assert.deepEqual(row.wire === 'gemini-code-assist' ? received.at(-1).body.request.toolConfig : received.at(-1).body.tool_choice,
          choiceFor(row.wire, 'none'), 'explicit request.toolChoice takes precedence')
        for (const tool_choice of ['bogus', null, 42, [], { type: 'function', function: { name: 'missing-tool' } },
          { type: 'function', name: '' }, { type: 'invalid', name: 'inspect_fixture' }]) {
          const before = received.length, beforeResolve = resolutions.length
          const response = await post('/v1/chat/completions', {
            model: id, messages: [{ role: 'user', content: 'Inspect fixture' }],
            tools: [{ type: 'function', function: tools[0] }], tool_choice,
          })
          const body = await response.text()
          assert.equal(response.status, 400, body)
          assert.equal(received.length, before, 'invalid choice cannot spend upstream completion')
          assert.equal(resolutions.length, beforeResolve, 'invalid choice cannot refresh account credentials')
          assert.ok(!body.includes(secret))
        }
      }
      for (const tool_choice of ['required', { type: 'function', name: 'inspect_fixture' }]) {
        const before = received.length
        const response = await post('/v1/responses', { model: 'subscription:account-chat/fixture-model', input: 'Hi', tool_choice })
        assert.equal(response.status, 400)
        await response.text()
        assert.equal(received.length, before, 'required/named restrictions need a declared tool')
      }
      const beforeFree = free.requests.length
      await fixture.runtime.complete({
        model: 'mimo-v2.6-flash-free', messages: input('mimo-v2.6-flash-free').messages, tools, toolChoice: 'none',
      })
      assert.equal(free.requests.length, beforeFree + 1)
      assert.equal(free.requests.at(-1).body.tool_choice, undefined, 'anonymous gate keeps its existing tool policy')
      assert.ok(!JSON.stringify(logs).includes(secret))
      assert.ok(!JSON.stringify(logs).includes(imageBytes.toString('base64')))
    } finally {
      await gateway?.close()
      local.closeAllConnections()
      await new Promise(resolve => local.close(resolve))
    }
  })

  await check('combo advances only before answer, preserves failures and closes partial blocks', async () => {
    for (const mode of ['quota', 'auth', 'disabled', 'output', 'tool', 'invalid', 'abort', 'success']) {
      let calls = 0
      const fixture = setup({ catalog: () => [model], complete: async (_request, emit) => {
        calls++
        if (mode === 'output') {
          emit({ type: 'block-start', index: 0, blockType: 'text' })
          emit({ type: 'text-delta', index: 0, text: 'already answered' })
        } else if (mode === 'tool') {
          emit({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'fixture', argumentsDelta: '{}' })
        } else emit({ type: 'reasoning-delta', index: 0, text: 'private thinking' })
        if (mode === 'success') {
          emit({ type: 'text-delta', index: 1, text: 'subscription winner' })
          emit({ type: 'finish', reason: { kind: 'stop' } })
          return {}
        }
        throw Object.assign(new Error('synthetic subscription refusal'), {
          code: ({ auth: 'AUTH_REQUIRED', disabled: 'DISABLED', invalid: 'INVALID_INPUT', abort: 'ABORTED' })[mode] ?? 'RATE_LIMIT',
          statusCode: mode === 'auth' ? 401 : mode === 'invalid' ? 400 : mode === 'disabled' ? 409 : 429,
        })
      } })
      fixture.settings.update({ combos: [{
        id: `combo:${mode}`, name: mode, models: [modelId, 'mimo-v2.6-flash-free'], strategy: 'fallback',
      }] })
      fixture.runtime.syncAggregateCatalog()
      const before = free.requests.length
      const result = await collect(fixture.runtime.adapter.stream(input(`combo:${mode}`)))
      const advanced = ['quota', 'auth', 'disabled'].includes(mode)
      assert.equal(free.requests.length > before, advanced, mode)
      assert.equal(calls, 1, mode)
      assert.equal(result.chunks.some(chunk => chunk.text === 'private thinking'), !advanced && !['output', 'tool'].includes(mode), mode)
      assert.equal(result.chunks.filter(chunk => chunk.type === 'finish').length, 1, mode)
      assert.equal(result.chunks.at(-1).reason.kind, mode === 'success' || advanced ? 'stop' : mode === 'abort' ? 'aborted' : 'error', mode)
      if (mode === 'output') assert.ok(result.chunks.some(chunk => chunk.type === 'block-end' && chunk.block.text === 'already answered'))
      assert.equal(fixture.stats.get().logical.models[`combo:${mode}`].turns, 1, mode)
    }
  })

  await check('anonymous probes exclude subscription models and never invoke private completion', async () => {
    let calls = 0
    const fixture = setup({ catalog: () => [model], complete: () => { calls++ } })
    const before = free.requests.length
    await fixture.runtime.refreshAvailability(true)
    assert.ok(free.requests.length > before)
    assert.equal(calls, 0)
    assert.ok(free.requests.slice(before).every(row => !String(row.body.model).startsWith('subscription:')))
    assert.equal(fixture.availability.get().results[modelId], undefined)
  })

  await check('management boundary uses trust fence, bounded JSON, sanitized errors and optional dependencies', async () => {
    let synced = 0, localImports = 0, imported = 0, quotaSignal
    const accounts = [{ id: 'account', provider: 'api', enabled: true, models: [] }]
    const subscriptions = {
      list: () => accounts,
      discover: () => [{ id: 'local:codex', provider: 'codex' }],
      import(body) { imported++; if (body.throw) throw new Error('do-not-echo-private-secret') },
      importLocal(body) { assert.equal(body.provider, 'codex'); localImports++ },
      setEnabled(body) { accounts[0].enabled = body.enabled },
      remove() { accounts.length = 0 },
      refreshQuota({ signal }) { quotaSignal = signal },
    }
    const handler = createApiRoutes({ subscriptions, onSubscriptionsChanged: () => { synced++ } })
    const route = (method, suffix, body, headers) => callRoute(handler, method, `/api/our-free-model/subscriptions${suffix}`, body, headers)
    assert.deepEqual((await route('GET', '')).json, { accounts })
    assert.deepEqual((await route('GET', '/discover')).json, { accounts: [{ id: 'local:codex', provider: 'codex' }] })
    assert.equal(imported, 0, 'listing and discovery never import')
    for (const action of ['/import', '/import-local', '/enabled', '/quota', '/remove']) {
      const result = await route('POST', action, action === '/import-local' ? { provider: 'codex' } : { id: 'account', enabled: false })
      assert.equal(result.status, 200, action)
      assert.ok(Array.isArray(result.json.accounts), action)
    }
    assert.equal(localImports, 1)
    assert.equal(synced, 4)
    assert.ok(quotaSignal instanceof AbortSignal)
    assert.equal((await route('POST', '/import', null)).status, 400)
    assert.equal((await route('POST', '/import', [])).status, 400)
    assert.equal((await route('POST', '/import', { token: 'x'.repeat(1024 * 1024) })).status, 413)
    const failed = await route('POST', '/import', { throw: true })
    assert.equal(failed.status, 500)
    assert.ok(!JSON.stringify(failed.json).includes('private-secret'))
    assert.equal((await route('POST', '/resolve', {})).status, 404)
    const prior = imported
    assert.equal((await route('POST', '/import', {}, { host: '127.0.0.1:3000', origin: 'https://evil.invalid' })).status, 403)
    assert.equal(imported, prior)
    const unauthenticated = createApiRoutes({ subscriptions, connection: { admit: () => ({ rejection: 401 }) } })
    assert.equal((await callRoute(unauthenticated, 'GET', '/api/our-free-model/subscriptions')).status, 401)
    assert.equal((await callRoute(createApiRoutes({}), 'GET', '/api/our-free-model/subscriptions')).status, 503)
    const malformedRequest = {
      method: 'POST', url: '/api/our-free-model/subscriptions/import', headers: { host: 'localhost' },
      async * [Symbol.asyncIterator]() { yield Buffer.from('{"credentials": do-not-echo-private-secret') },
    }
    let status, payload
    await handler(malformedRequest, { writeHead(code) { status = code }, end(value) { payload = value } })
    assert.equal(status, 400)
    assert.ok(!payload.includes('private-secret'))
    const response = new EventEmitter()
    response.writeHead = () => assert.fail('disconnected quota request must not write')
    response.end = () => assert.fail('disconnected quota request must not write')
    const started = defer()
    const quotaHandler = createApiRoutes({ subscriptions: {
      ...subscriptions, refreshQuota({ signal }) {
        started.resolve()
        return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
    } })
    const work = quotaHandler({
      method: 'POST', url: '/api/our-free-model/subscriptions/quota', headers: { host: 'localhost' },
      async * [Symbol.asyncIterator]() { yield Buffer.from('{"id":"account"}') },
    }, response)
    await started.promise
    response.emit('close')
    await bounded(work)
  })

  await check('plugin import immediately reaches DSH and gateway with one usage record; toggles/removal update topology', async () => {
    const received = []
    upstream = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      received.push({ path: req.url, headers: req.headers, body: JSON.parse(body) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"private subscription answer"}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":4}}\n\n'
        + 'data: [DONE]\n\n')
    })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamBase = `http://127.0.0.1:${upstream.address().port}`
    const home = path.join(scratch, 'plugin-home')
    process.env.DSH_HOME = home
    const dataDir = path.join(home, 'our-free-model')
    fs.mkdirSync(dataDir, { recursive: true })
    const port = await freePort()
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
      enabled: true, combos: [], forwardKey: 'fixture-gateway-key',
      forward: { enabled: true, host: '127.0.0.1', port }, tokenSaver: { enabled: false },
    }))
    const routes = []
    const nativePath = path.join(scratch, 'plugin-native.png')
    fs.writeFileSync(nativePath, nativePng)
    const nativeRef = { attachmentId: 'plugin-native-image', mediaType: 'image/png', bytes: nativePng.length, width: 1, height: 1 }
    const attachmentReads = []
    context = fakeContext({ inject, mounted: ['llm', 'webServer', 'attachments'], onRegister: route => routes.push(route) })
    context.__services.attachments.imageHostPath = ref => {
      attachmentReads.push(ref)
      assert.deepEqual(ref, nativeRef)
      return nativePath
    }
    apply(context, { distribution: 'managed' })
    await until(() => routes.some(route => route.kind === 'prefix'))
    const handler = routes.find(route => route.kind === 'prefix').handler
    const route = (method, suffix, body) => callRoute(handler, method, `/api/our-free-model${suffix}`, body)
    assert.deepEqual((await route('GET', '/subscriptions')).json, { accounts: [] }, 'boot must not import real native credentials')
    const beforeTopology = context.__captured.registrations.length
    const secret = 'synthetic-private-subscription-key'
    const imported = await route('POST', '/subscriptions/import', {
      provider: 'api', label: 'Fixture', credentials: { apiKey: secret },
      baseUrl: upstreamBase, format: 'openai-chat', models: ['real-model'],
    })
    assert.equal(imported.status, 200)
    assert.equal(imported.json.accounts.length, 1)
    assert.ok(!JSON.stringify(imported.json).includes(secret))
    const account = imported.json.accounts[0]
    const id = `subscription:${account.id}/real-model`
    const adapter = context.__captured.adapters[0].adapter
    assert.ok((await adapter.listModels('our-free-model')).some(row => row.id === id))
    const summary = await route('GET', '/summary')
    const row = summary.json.catalog.find(row => row.id === id)
    assert.equal(row.channel, 'subscription')
    assert.equal(row.availabilitySource, 'listing')
    assert.ok(row.contextWindow > 0 && row.maxOutput > 0)
    assert.ok(!JSON.stringify(summary.json).includes(secret))
    const streamed = await collect(adapter.stream({
      ...input(id),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read native attachment' }, { type: 'image', attachment: nativeRef }] }],
    }))
    assert.ok(streamed.chunks.some(chunk => chunk.text === 'private subscription answer'))
    assert.equal(Object.hasOwn(nativeRef, 'url'), false)
    assert.deepEqual(attachmentReads, [nativeRef], 'plugin must resolve the native attachment through the host service')
    assert.equal(received.at(-1).body.messages[0].content.find(part => part.type === 'image_url').image_url.url,
      `data:image/png;base64,${nativePng.toString('base64')}`)
    const stats = (await route('GET', '/stats')).json
    // Inspect the persisted store through the ordinary stats endpoint where possible;
    // file flush is debounced, so the live API is the source of truth.
    assert.ok(JSON.stringify(stats).includes(id))
    const key = (await route('GET', '/forward/key')).json.key
    await until(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).ok }
      catch { return false }
    }, { what: 'plugin forward listener' })
    const gateway = `http://127.0.0.1:${port}`
    const rows = await fetch(gateway + '/v1/models', { headers: { authorization: `Bearer ${key}` } }).then(response => response.json())
    assert.ok(rows.data.some(row => row.id === id))
    for (const pathname of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
      const response = await fetch(gateway + pathname, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: id, max_tokens: 128,
          ...(pathname === '/v1/responses' ? { input: 'Hello' } : { messages: [{ role: 'user', content: 'Hello' }] }),
        }),
      })
      const body = await response.text()
      assert.equal(response.status, 200, body)
      assert.ok(body.includes('private subscription answer'), pathname)
      assert.ok(!body.includes(secret))
    }
    assert.equal(received.length, 4, 'one upstream dispatch per direct/gateway request')
    assert.ok(received.every(row => row.body.model === 'real-model' && row.headers.authorization === `Bearer ${secret}`))
    const savedCombos = await route('POST', '/combos', {
      combos: [{ id: 'combo:sub-only', name: 'Sub only', models: [id] }],
    })
    assert.equal(savedCombos.status, 200)
    assert.ok((await adapter.listModels('our-free-model')).some(row => row.id === 'combo:sub-only'))
    await route('POST', '/subscriptions/enabled', { id: account.id, enabled: false })
    assert.ok(!(await adapter.listModels('our-free-model')).some(row => row.id === id || row.id === 'combo:sub-only'))
    const hidden = await fetch(gateway + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Hi' }] }),
    })
    assert.equal(hidden.status, 404)
    assert.equal(received.length, 4)
    await route('POST', '/subscriptions/enabled', { id: account.id, enabled: true })
    assert.ok((await adapter.listModels('our-free-model')).some(row => row.id === id))
    await route('POST', '/subscriptions/quota', { id: account.id })
    const removed = await route('POST', '/subscriptions/remove', { id: account.id })
    assert.deepEqual(removed.json, { accounts: [] })
    assert.ok(!(await adapter.listModels('our-free-model')).some(row => row.id === id || row.id === 'combo:sub-only'))
    assert.ok(context.__captured.registrations.length >= beforeTopology + 4)
    assert.ok(!context.__logs.join('\n').includes(secret))
    assert.ok(!context.__logs.join('\n').includes(nativePng.toString('base64')))
    const finalStats = (await route('GET', '/stats')).json
    assert.equal(finalStats.models.find(row => row.model === id)?.calls, 4, 'usage must be recorded exactly once per dispatched request')
    assert.equal(finalStats.models.find(row => row.model === id)?.turns, 4, 'single-model turns must not be double counted')
  })
  await check('invalid private sidecar disables only subscriptions and never logs stored secrets', async () => {
    for (const dispose of context.__disposers.reverse()) { try { dispose() } catch {} }
    context = undefined
    const home = path.join(scratch, 'corrupt-home')
    process.env.DSH_HOME = home
    fs.mkdirSync(path.join(home, 'our-free-model', 'subscriptions'), { recursive: true })
    fs.writeFileSync(path.join(home, 'our-free-model', 'subscriptions', 'credentials.json'),
      '{"private":"do-not-log-broken-credential"}')
    const routes = []
    context = fakeContext({ inject, mounted: ['llm', 'webServer'], onRegister: route => routes.push(route) })
    apply(context, { distribution: 'managed' })
    await until(() => routes.some(route => route.kind === 'prefix'))
    const handler = routes.find(route => route.kind === 'prefix').handler
    assert.equal((await callRoute(handler, 'GET', '/api/our-free-model/subscriptions')).status, 503)
    assert.ok((await context.__captured.adapters[0].adapter.listModels('our-free-model')).length > 0)
    assert.ok(context.__logs.some(line => line.includes('private subscription storage is unavailable')))
    assert.ok(!context.__logs.join('\n').includes('do-not-log-broken-credential'))
  })
  console.log(`subscription-wiring: ${checks.length} integration groups passed`)
} finally {
  for (const runtime of runtimes) runtime.dispose()
  for (const store of stores) store.dispose()
  for (const dispose of context?.__disposers.reverse() ?? []) { try { dispose() } catch {} }
  await tick()
  await free.close()
  upstream?.closeAllConnections()
  if (upstream) await new Promise(resolve => upstream.close(resolve))
}
