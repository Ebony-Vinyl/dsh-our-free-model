import assert from 'node:assert/strict'

export async function verifyChannelQueueRotation() {
  const { withQueueAccountRotation, reportQueueSlot } = await import('../vendor/channel-pack/src/queue-rotation.ts')
  const { ModelQueuedError, throwIfModelQueued, checkQueuedResponse } = await import('../vendor/channel-pack/src/model-queue.ts')
  const { LlmError } = await import('@deepseek-ai/dsh-llm')
  const collect = async iterable => { const result = []; for await (const chunk of iterable) result.push(chunk); return result }
  const queued = () => new ModelQueuedError('fixture queue', { queueInfo: { isQueued: true }, retryAfterMs: 0 })
  const credential = id => ({ access_token: id, refresh_token: `refresh-${id}`, expires_at: '2099-01-01T00:00:00Z' })
  const makePool = (provider, ids = ['a', 'b']) => {
    const rows = ids.map(id => ({ entry: { id, provider, enabled: true, credentialRef: `ref-${id}`, modelRateLimits: {} }, credential: credential(id) }))
    return {
      rows,
      listAccountsByProvider: id => rows.filter(row => row.entry.provider === id).map(row => row.entry),
      findAccountIdByCredential: async (id, token) => rows.find(row => row.entry.provider === id && row.credential.access_token === token)?.entry.id ?? '',
      findAccountIdByIdentityField: async (id, field, token) => rows.find(row => row.entry.provider === id && row.credential[field] === token)?.entry.id ?? '',
      resolveCredentialForAccount: async id => rows.find(row => row.entry.id === id)?.credential,
      disabledModelsFor: () => new Set(),
      getAvailableAccount: async (id, model, excluded = new Set()) => rows.find(row => row.entry.provider === id && row.entry.enabled
        && !excluded.has(row.entry.id) && !(row.entry.modelRateLimits[model] > Date.now())) ?? null,
    }
  }
  const clock = () => {
    let now = 0
    return { now: () => now, sleep: async ms => { now += ms } }
  }

  for (const body of [{ error: { code: 'AUTH', message: 'not queued' } }, { isQueued: false }, { error: { code: 'rate_limit' } }, 'server busy', { response: '{"isQueued":true}' }]) {
    assert.doesNotThrow(() => throwIfModelQueued(body))
  }
  for (const body of [{ isQueued: true }, { error: { code: 'model_queued', retryAfterSeconds: 2 } }, { data: { message: '{"type":"queued"}' } }]) {
    assert.throws(() => throwIfModelQueued(body), error => error instanceof ModelQueuedError)
  }
  for (const status of [200, 403, 429, 503]) {
    const response = Response.json({ error: { code: 'model_queued' } }, { status, headers: { 'retry-after': '2' } })
    await assert.rejects(checkQueuedResponse(response).then(value => value.text()), error => error instanceof ModelQueuedError && error.retryAfterMs === 2000)
    if (status !== 200) assert.equal(response.bodyUsed, false)
  }
  const ordinary = Response.json({ error: { code: 'AUTH' } }, { status: 403 })
  assert.equal(await checkQueuedResponse(ordinary), ordinary)
  assert.equal(ordinary.bodyUsed, false)

  // 错标为 JSON 的 SSE 必须在连接关闭前交付首块，不能预读整个响应。
  {
    let source
    const first = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
    const response = new Response(new ReadableStream({ start(controller) { source = controller; controller.enqueue(first) } }), {
      headers: { 'content-type': 'application/json' },
    })
    let timer
    try {
      const received = await Promise.race([
        checkQueuedResponse(response).then(value => value.body.getReader().read()),
        new Promise(resolve => { timer = setTimeout(() => resolve('blocked'), 200) }),
      ])
      assert.notEqual(received, 'blocked', '首块不能等待上游 close')
      assert.deepEqual(received.value, first)
    } finally { clearTimeout(timer); source.close() }
  }
  {
    const { consumeOpenAiSse } = await import('../vendor/channel-pack/src/openai-compat.ts')
    let canceled = false
    const response = new Response(new ReadableStream({ cancel() { canceled = true } }), {
      headers: { 'content-type': 'application/json' },
    })
    const checked = await checkQueuedResponse(response)
    await assert.rejects(collect(consumeOpenAiSse(checked, {}, {
      label: 'fixture', firstTokenTimeoutMs: 20, chunkTimeoutMs: 20,
    })), error => error.code === 'TIMEOUT')
    assert.equal(canceled, true, '无数据流仍由原解析器超时并取消上游')
  }

  for (const prepared of [false, true]) {
    const pool = makePool('fixture')
    pool.rows.unshift({ entry: { id: 'disabled', provider: 'fixture', enabled: false, modelRateLimits: {} }, credential: credential('disabled') })
    pool.rows.splice(2, 0, { entry: { id: 'limited', provider: 'fixture', enabled: true, modelRateLimits: { model: Date.now() + 60_000 } }, credential: credential('limited') })
    pool.rows.push({ entry: { id: 'foreign', provider: 'other', enabled: true, modelRateLimits: {} }, credential: credential('foreign') })
    const sent = [], refreshed = []
    const options = {
      accountPool: pool,
      resolveCredential: async () => credential('a'),
      currentAccountId: () => 'a',
      refresh: async id => { refreshed.push(id) },
    }
    class Adapter {
      #options
      constructor(value) { this.#options = value }
      async *stream() {
        const value = await this.#options.resolveCredential('model')
        sent.push(value.access_token)
        if (value.access_token === 'a') throw queued()
        assert.equal(this.#options.currentAccountId(), 'b')
        await this.#options.refresh()
        yield { type: 'text-delta', text: 'ok' }
      }
      async prepareCall() { const raw = this.stream.bind(this); return { model: 'model', stream: raw } }
    }
    const adapter = withQueueAccountRotation('fixture', options, value => new Adapter(value), clock())
    const call = prepared ? await adapter.prepareCall() : adapter
    assert.equal((await collect(call.stream({ model: 'model' })))[0].text, 'ok')
    assert.deepEqual(sent, ['a', 'a', 'a', 'b'])
    assert.deepEqual(refreshed, ['b'])
    assert.equal(options.currentAccountId(), 'a', 'shared default identity is unchanged')
  }

  for (const change of ['disabled', 'limited', 'removed']) {
    for (const backup of [true, false]) {
      const pool = makePool('fixture', backup ? ['a', 'blocked', 'b'] : ['a'])
      if (backup) pool.rows[1].entry.modelRateLimits.model = Date.now() + 60_000
      const sent = []
      const adapter = withQueueAccountRotation('fixture', {
        accountPool: pool, resolveCredential: async () => credential('a'),
      }, options => ({ async *stream() {
        const value = await options.resolveCredential('model')
        sent.push(value.access_token)
        if (value.access_token === 'a') throw queued()
        yield { text: 'ok' }
      } }), { now: () => 0, sleep: async () => {
        const current = pool.rows.find(row => row.entry.id === 'a')
        if (!current) return
        if (change === 'disabled') current.entry.enabled = false
        if (change === 'limited') current.entry.modelRateLimits.model = Date.now() + 60_000
        if (change === 'removed') pool.rows.splice(pool.rows.indexOf(current), 1)
      } })
      const result = collect(adapter.stream({ model: 'model' }))
      if (backup) {
        assert.equal((await result)[0].text, 'ok')
        assert.deepEqual(sent, ['a', 'b'], `${change}: 失效账号不能继续发送，备用号仍按模型过滤`)
      } else {
        await assert.rejects(result, error => error.code === 'QUEUE')
        assert.deepEqual(sent, ['a'], `${change}: 没有合规备用号时停止`)
      }
    }
  }

  {
    const pool = makePool('fixture', ['a', 'b', 'c']), sent = [], refreshed = []
    const adapter = withQueueAccountRotation('fixture', {
      accountPool: pool, resolveCredential: async () => credential('a'), refresh: async id => { refreshed.push(id) },
    }, options => ({
      async *stream(input) {
        let value = await options.resolveCredential(input.model)
        if (value.access_token === 'a') {
          sent.push('a:quota')
          const next = await options.accountPool.getAvailableAccount('fixture', input.model, new Set(['a']))
          value = next.credential
        }
        sent.push(value.access_token)
        if (value.access_token === 'b') throw queued()
        await options.refresh()
        yield { text: 'ok' }
      },
    }), clock())
    assert.equal((await collect(adapter.stream({ model: 'model' })))[0].text, 'ok')
    assert.deepEqual(sent, ['a:quota', 'b', 'b', 'b', 'c'])
    assert.deepEqual(refreshed, ['c'])
  }
  {
    const pool = makePool('fixture'), sent = []
    const adapter = withQueueAccountRotation('fixture', {
      accountPool: pool, resolveCredential: async () => credential('a'),
    }, options => ({
      async *stream(input) {
        const value = await options.resolveCredential(input.model)
        await Promise.resolve()
        sent.push([input.model, value.access_token])
        if (input.model === 'queued' && value.access_token === 'a') throw queued()
        yield { text: value.access_token }
      },
    }), clock())
    const [rotated, ordinary] = await Promise.all([collect(adapter.stream({ model: 'queued' })), collect(adapter.stream({ model: 'ordinary' }))])
    assert.equal(rotated[0].text, 'b'); assert.equal(ordinary[0].text, 'a')
    assert.deepEqual(sent.filter(row => row[0] === 'ordinary'), [['ordinary', 'a']])
  }
  {
    const pool = makePool('fixture'), sent = []
    const adapter = withQueueAccountRotation('fixture', { accountPool: pool, resolveCredential: async () => credential('a') }, options => ({
      async *stream() { sent.push((await options.resolveCredential('model')).access_token); yield { text: 'partial' }; throw queued() },
    }), clock())
    await assert.rejects(collect(adapter.stream({ model: 'model' })), error => error instanceof ModelQueuedError)
    assert.deepEqual(sent, ['a'])
  }
  {
    const pool = makePool('fixture', ['a']), sent = []
    let waits = 0
    const adapter = withQueueAccountRotation('fixture', { accountPool: pool, resolveCredential: async () => credential('a') }, options => ({
      async *stream() { const value = await options.resolveCredential('model'); sent.push(value.access_token); if (value.access_token === 'a') throw queued(); yield { text: 'late' } },
    }), { now: () => waits * 10_000, sleep: async () => {
      if (++waits === 3) pool.rows.push({ entry: { id: 'b', provider: 'fixture', enabled: true, modelRateLimits: {} }, credential: credential('b') })
    } })
    assert.equal((await collect(adapter.stream({ model: 'model' })))[0].text, 'late')
    assert.equal(sent.at(-1), 'b')
    assert.ok(sent.length < 10)
  }
  {
    const controller = new AbortController(), sent = []
    const adapter = withQueueAccountRotation('fixture', {}, () => ({ async *stream() { sent.push(1); throw queued() } }))
    const result = collect(adapter.stream({ model: 'model', signal: controller.signal }))
    setTimeout(() => controller.abort(new Error('fixture stopped')), 0)
    await assert.rejects(result, /fixture stopped/)
    assert.equal(sent.length, 1)
  }
  {
    let now = 0, calls = 0
    const adapter = withQueueAccountRotation('fixture', {}, () => ({ async *stream() { calls++; throw queued() } }), {
      now: () => now, sleep: async () => { now += 30 * 60_000 },
    })
    await assert.rejects(collect(adapter.stream({ model: 'model' })), /排队等待超时/)
    assert.equal(calls, 1)
    const quota = new LlmError('quota fixture', 'QUOTA_EXCEEDED')
    const ordinary = withQueueAccountRotation('fixture', {}, () => ({ async *stream() { throw quota } }), clock())
    await assert.rejects(collect(ordinary.stream({ model: 'model' })), error => error === quota)
  }
  {
    const sent = []
    const slots = ['a', 'b'].map(id => ({ id, kind: 'account', apiKey: id }))
    const adapter = withQueueAccountRotation('opencode', { identitySlots: async model => { assert.equal(model, 'model'); return slots } }, options => ({
      async *stream() {
        const slot = (await options.identitySlots())[0]
        reportQueueSlot(slot); sent.push(slot.id)
        if (slot.id === 'a') throw queued()
        yield { text: 'ok' }
      },
    }), clock())
    assert.equal((await collect(adapter.stream({ model: 'model' })))[0].text, 'ok')
    assert.deepEqual(sent, ['a', 'a', 'a', 'b'])
  }
  const sse = frames => new Response(frames.map(([event, data]) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
  const success = provider => {
    if (provider === 'trae') return sse([['output', { response: 'ok' }], ['done', { finish_reason: 'stop' }]])
    if (provider === 'gemini') return sse([['', { response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }]])
    if (['minimax', 'zcode'].includes(provider)) return sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ])
    return sse([['', { choices: [{ delta: { content: 'ok' }, finish_reason: null }] }], ['', { choices: [{ delta: {}, finish_reason: 'stop' }] }]])
  }
  for (const provider of ['lobsterai', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'gemini', 'zcode', 'opencode']) {
    const module = await import(`../vendor/channel-pack/src/${provider}-adapter.ts`)
    const register = Object.entries(module).find(([name]) => /^register.*Llm$/.test(name))[1]
    for (const transport of ['http', 'sse', 'json', 'json-sse', 'open-sse', 'json-async-cancel', 'json-sse-async-cancel',
      ...provider === 'raccoon' ? ['open-sse-partial', 'json-sse-async-partial', 'json-sse-async-return'] : []]) {
      const pool = makePool(provider), sent = []
      const canceled = []
      let pending = false
      for (const row of pool.rows) {
        const token = `fixture-${row.entry.id}`
        row.credential = { ...credential(token), uid: row.entry.id, userid: row.entry.id, user_id: row.entry.id, phone: '13800000000', device_mid: 'fixture-device', machine_id: 'fixture-machine', device_id: 'fixture-device' }
        if (provider === 'zcode') { row.credential.zcode_jwt = token; delete row.credential.access_token }
      }
      const upstream = async (_url, init) => {
        if (init?.method !== 'POST') return Response.json({ data: [] })
        const open = transport.startsWith('open-sse') || transport.includes('-async-')
        if (open) assert.equal(pending, false, `${provider}: 新请求发出前必须等待旧响应取消完成`)
        const headers = [...new Headers(init?.headers).values()].join(' ')
        const id = headers.includes('fixture-a') ? 'a' : headers.includes('fixture-b') ? 'b' : undefined
        assert.ok(id, `${provider}: actual request carries account credential`)
        sent.push(id)
        if (id === 'b') {
          const response = success(provider)
          if (transport === 'json-sse') response.headers.set('content-type', 'application/json')
          return response
        }
        const error = { error: { code: 'model_queued', retryAfterSeconds: 0 } }
        if (open) {
          pending = true
          const text = transport === 'json-async-cancel' ? JSON.stringify(error)
            : (transport.endsWith('partial') || transport.endsWith('return') ? 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' : '')
              + `event: error\ndata: ${JSON.stringify(error)}\n\n`
          return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode(text)) },
            async cancel() {
              if (transport.includes('-async-')) await new Promise(resolve => setTimeout(resolve, 250))
              pending = false; canceled.push(id)
              if (provider === 'raccoon' && canceled.length === 1) throw new Error('fixture cancel rejected')
            },
          }), { headers: { 'content-type': transport.startsWith('json-') ? 'application/json' : 'text/event-stream' } })
        }
        if (transport === 'http') return Response.json(error, { status: 503 })
        if (transport === 'json') {
          const text = JSON.stringify(error), encoder = new TextEncoder()
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(encoder.encode(text.slice(0, 8)))
            controller.enqueue(encoder.encode(text.slice(8)))
            controller.close()
          } }), { headers: { 'content-type': 'application/json' } })
        }
        const response = sse([['error', error]])
        if (transport === 'json-sse') response.headers.set('content-type', 'application/json')
        return response
      }
      let mounted
      const adapter = register({ llm: { registerAdapter(_ids, value) { mounted = value } } }, {
        credentialRef: 'fixture-ref', accountPool: provider === 'opencode' ? undefined : pool,
        resolveCredential: async () => pool.rows[0].credential,
        refresh: async id => pool.resolveCredentialForAccount(id ?? 'a'),
        currentAccountId: () => 'a', fetchImpl: upstream, project: 'fixture-project',
        resolveClientVersion: async () => 'fixture-version',
        mintCaptcha: async () => 'fixture-captcha', gate: { run: async (_model, send) => send() },
        loadModelsDev: async () => new Map(),
        identitySlots: async () => pool.rows.map(row => ({ id: row.entry.id, kind: 'account', apiKey: `fixture-${row.entry.id}`, userAgent: 'fixture', fingerprint: { projectId: 'fixture-project', generation: 0 } })),
      })
      assert.ok(mounted, `${provider}: registered with host wrappers`)
      const model = adapter.listAllModels()[0].id
      const fetchBefore = globalThis.fetch
      globalThis.fetch = upstream
      try {
        const call = await mounted.prepareCall(provider, model)
        if (transport.endsWith('partial') || transport.endsWith('return')) {
          const chunks = []
          const consume = async () => {
            for await (const chunk of call.stream({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) chunks.push(chunk)
          }
          if (transport.endsWith('return')) {
            for await (const chunk of call.stream({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) { chunks.push(chunk); break }
          } else {
            await assert.rejects(consume, error => error instanceof ModelQueuedError)
            assert.ok(chunks.some(chunk => chunk.text === 'partial'))
          }
          assert.deepEqual(sent, ['a'])
          assert.deepEqual(canceled, ['a'], '输出后也要取消旧响应，但不得重发')
          assert.equal(pending, false, '提前退出或抛错也必须等待原始上游取消完成')
          continue
        }
        const chunks = await collect(call.stream({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))
        assert.deepEqual(sent, ['a', 'a', 'a', 'b'], `${provider} ${transport}: rotates before output`)
        assert.ok(chunks.some(chunk => chunk.text === 'ok' || chunk.delta === 'ok'), `${provider} ${transport}: returns answer`)
        if (transport === 'open-sse' || transport.includes('-async-')) assert.deepEqual(canceled, ['a', 'a', 'a'], `${provider}: 所有排队响应均已完成取消`)
      } finally { globalThis.fetch = fetchBefore }
    }
    console.log(`ok  channel queue registered ${provider}: HTTP + SSE + fragmented JSON 200 + mislabeled SSE`)
  }
  const { loomyBalanceTier, loomyTierUsable } = await import('../vendor/channel-pack/src/loomy-balance-rank.ts')
  for (const scenario of [
    { provider: 'loomy', locked: true }, { provider: 'loomy', locked: false },
    { provider: 'loomy', quotaFirst: true }, { provider: 'raccoon', quotaFirst: true },
  ]) {
    const { provider, locked = false, quotaFirst = false } = scenario
    const module = await import(`../vendor/channel-pack/src/${provider}-adapter.ts`)
    const register = Object.entries(module).find(([name]) => /^register.*Llm$/.test(name))[1]
    const pool = makePool(provider, quotaFirst ? ['a', 'b', 'c'] : ['a', 'b'])
    const sent = [], marked = []
    let nextCalls = 0, bQueues = 0
    pool.updateModelRateLimit = async (id, model, resetAt) => {
      marked.push(id); pool.rows.find(row => row.entry.id === id).entry.modelRateLimits[model] = resetAt
    }
    let mounted
    const adapter = register({ llm: { registerAdapter(_ids, value) { mounted = value } } }, {
      credentialRef: 'fixture-ref', accountPool: pool, resolveCredential: async () => pool.rows[0].credential,
      refresh: async id => pool.resolveCredentialForAccount(id ?? 'a'),
      nextAccount: async (model, tried) => {
        nextCalls++
        const next = await pool.getAvailableAccount(provider, model, tried)
        if (!next) return undefined
        if (!quotaFirst && !loomyTierUsable(loomyBalanceTier({ dailyBalance: next.entry.id === 'a' ? 1 : 0, permanentBalance: 100 }, { allowPermanent: !locked }))) return undefined
        return { accountId: next.entry.id, credential: next.credential }
      },
      fetchImpl: async (_url, init) => {
        const id = new Headers(init.headers).get('authorization').slice(7)
        sent.push(id)
        if (quotaFirst && id === 'a') return Response.json({ code: 402, message: '积分不足' }, { status: 402 })
        const isQueued = quotaFirst ? id === 'b' && ++bQueues <= 3 : id === 'a' && sent.length <= 3
        return isQueued ? Response.json({ error: { code: 'model_queued', retryAfterSeconds: 0 } }, { status: 503 }) : success(provider)
      },
    })
    const model = adapter.listAllModels()[0].id
    const call = await mounted.prepareCall(provider, model)
    await collect(call.stream({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))
    assert.deepEqual(sent, quotaFirst ? ['a', 'b', 'b', 'b', 'c'] : locked ? ['a', 'a', 'a', 'a'] : ['a', 'a', 'a', 'b'], `${provider}: 保留积分锁定及真实换号状态`)
    assert.deepEqual(marked, quotaFirst ? ['a'] : [])
    assert.ok(nextCalls > 0, '排队换号必须沿用渠道选号策略')
    console.log(`ok  channel queue ${provider}: ${quotaFirst ? 'quota → queue keeps actual account' : locked ? 'permanent credits locked' : 'permanent credits allowed'}`)
  }
  const { LoomyAdapter } = await import('../vendor/channel-pack/src/loomy-adapter.ts')
  const { LOOMY } = await import('../vendor/channel-pack/src/loomy-product.ts')
  const { LoomyBalanceSelector } = await import('../vendor/channel-pack/src/loomy-balance-selector.ts')
  for (const scenario of [{ locked: true }, { locked: false }, { locked: true, addBackup: true }, { locked: true, unknown: true }]) {
    const { locked, addBackup = false, unknown = false } = scenario
    const pool = makePool('loomy', ['a']), sent = [], checked = []
    let now = 0
    const selector = new LoomyBalanceSelector({
      product: LOOMY, now: () => now,
      resolveCredential: async ref => pool.rows.find(row => row.entry.credentialRef === ref)?.credential,
      fetcher: async (_url, init) => {
        const id = new Headers(init.headers).get('token')
        checked.push([id, now])
        if (unknown && now >= 60_000) return new Response('fixture unavailable', { status: 503 })
        return Response.json({ code: '000000', data: { balance: 100, dailyBalance: id === 'a' && now >= 60_000 ? 0 : 1 } })
      },
    })
    const select = async (model, excluded = new Set()) => {
      const candidates = pool.listAccountsByProvider('loomy').filter(row => row.enabled && !excluded.has(row.id) && !(row.modelRateLimits[model] > Date.now()))
      const picked = await selector.select(candidates, { allowPermanent: !locked })
      if (!picked.ok) return undefined
      return { accountId: picked.account.id, credential: await pool.resolveCredentialForAccount(picked.account.id) }
    }
    const adapter = withQueueAccountRotation('loomy', {
      credentialRef: 'fixture', accountPool: pool,
      resolveCredential: async model => (await select(model))?.credential,
      refresh: async () => { throw new Error('余额策略失败不能触发认证续期') }, nextAccount: select,
      fetchImpl: async (_url, init) => {
        const id = new Headers(init.headers).get('authorization').slice(7)
        sent.push(id)
        return sent.length <= 6 ? Response.json({ error: { code: 'model_queued', retryAfterSeconds: 10 } }, { status: 503 }) : success('loomy')
      },
    }, options => new LoomyAdapter(options), { now: () => now, sleep: async ms => {
      now += ms
      if (addBackup && now >= 60_000 && pool.rows.length === 1) pool.rows.push({ entry: { id: 'b', provider: 'loomy', enabled: true, credentialRef: 'ref-b', modelRateLimits: {} }, credential: credential('b') })
    } })
    const model = adapter.listAllModels()[0].id
    const stream = collect(adapter.stream({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))
    if (locked && !addBackup) {
      await assert.rejects(stream, error => error.code === 'QUEUE')
      assert.deepEqual(sent, Array(6).fill('a'), '每日额度耗尽后不能发出第七次请求')
    } else {
      await stream
      assert.deepEqual(sent, [...Array(6).fill('a'), addBackup ? 'b' : 'a'])
    }
    assert.ok(checked.some(([id, time]) => id === 'a' && time >= 60_000), '沿用真实余额缓存，并在过期后重查')
    console.log(`ok  Loomy queue after balance TTL: locked=${locked}, backup=${addBackup}, unknown=${unknown}`)
  }
  const { verifyChannelQueuePolicies } = await import('./channel-queue-policy-test.mjs')
  await verifyChannelQueuePolicies({ makePool, collect, success, sse })
  console.log('ok  channel queue: 9 registered adapters HTTP/SSE, direct/prepared calls, account/model scope, refresh, concurrency, late account, partial output, abort, timeout and identity slots')
}
