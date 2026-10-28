import assert from 'node:assert/strict'

/** 与实际适配器注册入口组合验证槽位资格和跨重试续期预算。 */
export async function verifyChannelQueuePolicies({ makePool, collect, success, sse }) {
  const { registerOpencodeLlm } = await import('../vendor/channel-pack/src/opencode-adapter.ts')
  const slot = (id, kind) => ({ id, kind, apiKey: kind === 'anonymous' ? 'public' : `fixture-${id}`,
    userAgent: 'fixture', fingerprint: { projectId: `fixture-${id}`, generation: 0 } })
  for (const scenario of [
    { kinds: ['anonymous', 'account'] }, { kinds: ['account', 'anonymous'] },
    { kinds: ['anonymous', 'anonymous'] }, { kinds: ['account', 'account'] },
    { kinds: ['account', 'anonymous', 'account'], paid: true },
    { kinds: ['anonymous', 'anonymous'], paid: true },
  ]) {
    for (const transport of ['http', 'sse']) {
      for (const prepared of [false, true]) {
        const slots = scenario.kinds.map((kind, index) => slot(String.fromCharCode(97 + index), kind))
        const sent = [], marked = [], controller = new AbortController()
        let mounted
        const adapter = registerOpencodeLlm({ llm: { registerAdapter(_ids, value) { mounted = value } } }, {
          identitySlots: async () => slots, markLimited: async (...args) => { marked.push(args) },
        })
        const model = scenario.paid ? 'fixture-paid-model' : 'big-pickle'
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (_url, init) => {
          controller.signal.throwIfAborted()
          const id = new Headers(init.headers).get('x-opencode-project').slice('fixture-'.length)
          sent.push(id)
          if (id !== 'a') return success('opencode')
          if (sent.length >= 4) { controller.abort(new Error('fixture did not rotate')); controller.signal.throwIfAborted() }
          const body = { error: { code: 'model_queued', retryAfterSeconds: 0 } }
          return transport === 'http' ? Response.json(body, { status: 503 }) : sse([['error', body]])
        }
        try {
          const call = prepared ? await mounted.prepareCall('opencode', model) : adapter
          const result = collect(call.stream({ model, signal: controller.signal,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))
          if (scenario.paid && slots.every(value => value.kind === 'anonymous')) {
            await assert.rejects(result, error => error.code === 'MISSING_CREDENTIAL')
            assert.deepEqual(sent, [])
          } else {
            await result
            assert.deepEqual(sent, ['a', 'a', 'a', scenario.paid ? 'c' : 'b'], `${scenario.kinds} ${transport}: 按模型资格排队换槽`)
          }
          assert.deepEqual(marked, [], '排队不应写额度或认证冷却')
        } finally { globalThis.fetch = originalFetch }
      }
    }
  }
  console.log('ok  OpenCode queue policies: anonymous/account cross-rotation, anonymous pairs, paid exclusion, HTTP/SSE, direct/prepared')

  const configure = (row, expired = false) => {
    row.credential = { ...row.credential, access_token: `fixture-${row.entry.id}`,
      expires_at: String(expired ? 1 : Date.now() + 3_600_000), expire_time: expired ? 1 : Date.now() + 3_600_000,
      expiry: new Date(expired ? 1 : Date.now() + 3_600_000).toISOString(),
      uid: row.entry.id, userid: row.entry.id, user_id: row.entry.id, phone: '13800000000', machine_id: 'fixture', device_id: 'fixture' }
  }
  for (const provider of ['lobsterai', 'trae', 'cline', 'loomy', 'raccoon', 'gemini']) {
    const module = await import(`../vendor/channel-pack/src/${provider}-adapter.ts`)
    const register = Object.entries(module).find(([name]) => /^register.*Llm$/.test(name))[1]
    const scenarios = ['auth-queue-auth', 'queue-auth-queue-auth', 'expiry-queue-auth', 'auth-queue-rotate-auth',
      ...provider === 'gemini' ? ['failed-auth-queue-auth'] : []]
    const cases = scenarios.flatMap(scenario => ['http', 'sse'].flatMap(transport =>
      [false, true].map(prepared => ({ scenario, transport, prepared }))))
    for (const { scenario, transport, prepared } of cases) {
      const pool = makePool(provider, scenario === 'auth-queue-rotate-auth' ? ['a', 'b'] : ['a'])
      pool.rows.forEach(row => configure(row, scenario === 'expiry-queue-auth'))
      const sent = [], refreshed = [], counts = new Map()
      pool.updateModelRateLimit = async (id, model, resetAt) => {
        pool.rows.find(row => row.entry.id === id).entry.modelRateLimits[model] = resetAt
      }
      let mounted
      const adapter = register({ llm: { registerAdapter(_ids, value) { mounted = value } } }, {
        credentialRef: 'fixture', accountPool: pool, resolveCredential: async () => pool.rows[0].credential,
        refresh: async (id, reason) => {
          refreshed.push([id, reason])
          if (scenario === 'failed-auth-queue-auth') throw new Error('fixture refresh failure')
          const row = pool.rows.find(value => value.entry.id === id)
          configure(row)
          row.credential.access_token += `-renewed-${refreshed.length}`
          return row.credential
        },
        currentAccountId: () => 'a', project: 'fixture-project', loadModelsDev: async () => new Map(),
        resolveClientVersion: async () => 'fixture',
        fetchImpl: async (_url, init) => {
          if (init?.method !== 'POST') return Response.json({ data: [] })
          const auth = [...new Headers(init.headers).values()].join(' ')
          const id = auth.includes('fixture-a') ? 'a' : 'b'
          sent.push(id)
          const count = (counts.get(id) ?? 0) + 1
          counts.set(id, count)
          let queued = false, denied = false
          if (scenario === 'auth-queue-auth' || scenario === 'failed-auth-queue-auth') { queued = count === 2; denied = count === 1 || count >= 3 }
          if (scenario === 'queue-auth-queue-auth') { queued = count === 1 || count === 3; denied = count === 2 || count >= 4 }
          if (scenario === 'expiry-queue-auth') { queued = count === 1; denied = count === 2 }
          if (scenario === 'auth-queue-rotate-auth') { queued = id === 'a' && count >= 2; denied = count === 1 }
          if (queued) {
            const body = { error: { code: 'model_queued', retryAfterSeconds: 0 } }
            return transport === 'http' ? Response.json(body, { status: 503 }) : sse([['error', body]])
          }
          return denied ? Response.json({ error: { code: 'auth_error', message: 'invalid token' } }, { status: 401 }) : success(provider)
        },
      })
      const model = adapter.listAllModels()[0].id
      const call = prepared ? await mounted.prepareCall(provider, model) : adapter
      const result = collect(call.stream({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))
      if (scenario === 'expiry-queue-auth') {
        await result
        assert.deepEqual(refreshed, [['a', undefined], ['a', 'auth']], `${provider}: 初始过期和服务端认证保留各自预算`)
      } else if (scenario === 'auth-queue-rotate-auth') {
        await result
        assert.deepEqual(refreshed, [['a', 'auth'], ['b', 'auth']], `${provider}: 新账号保留独立预算`)
        assert.deepEqual(sent, ['a', 'a', 'a', 'a', 'b', 'b'])
      } else {
        await assert.rejects(result, error => ['AUTH', 'QUOTA_EXCEEDED'].includes(error.code))
        assert.deepEqual(refreshed, [['a', 'auth']], `${provider}: 排队重启不能重复续期同一账号`)
        assert.ok(sent.length <= 5, `${provider}: 认证失败必须有界退出`)
      }
    }
    console.log(`ok  ${provider} queue refresh budget: auth→queue→auth, queue→auth→queue→auth, expiry budget, per-account budget, HTTP/SSE, direct/prepared`)
  }

  const { registerClineLlm } = await import('../vendor/channel-pack/src/cline-adapter.ts')
  const credential = { access_token: 'fixture-single', expire_time: Date.now() + 3_600_000 }
  const refreshes = [], sends = new Map()
  let mounted
  const adapter = registerClineLlm({ llm: { registerAdapter(_ids, value) { mounted = value } } }, {
    credentialRef: 'fixture', resolveCredential: async () => credential,
    refresh: async (...args) => { refreshes.push(args) }, loadModelsDev: async () => new Map(),
    fetchImpl: async (_url, init) => {
      if (init?.method !== 'POST') return Response.json({ data: [] })
      const name = JSON.parse(init.body).messages[0].content
      const count = (sends.get(name) ?? 0) + 1
      sends.set(name, count)
      if (count === 1) return Response.json({ error: { code: 'auth_error' } }, { status: 401 })
      if (count === 2) return Response.json({ error: { code: 'model_queued', retryAfterSeconds: 0 } }, { status: 503 })
      return success('cline')
    },
  })
  const model = adapter.listAllModels()[0].id
  const call = await mounted.prepareCall('cline', model)
  await Promise.all([adapter, call].map((value, index) => collect(value.stream({ model,
    messages: [{ role: 'user', content: [{ type: 'text', text: `request-${index}` }] }] }))))
  assert.deepEqual(refreshes, [[undefined, 'auth'], [undefined, 'auth']], '无账号池的并发请求拥有独立续期预算')
  assert.deepEqual([...sends.values()], [3, 3])

  // 凭据刷新成功但存储仍返回过期凭据时，排队重启也不能无限刷新。
  credential.expire_time = 1
  const previousRefreshes = refreshes.length
  await assert.rejects(collect(adapter.stream({ model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'expired' }] }] })), error => error.code === 'AUTH')
  assert.deepEqual(refreshes.slice(previousRefreshes), [[undefined, undefined], [undefined, 'auth']])
  assert.equal(sends.get('expired'), 2)
  console.log('ok  queue refresh fallback: no-pool concurrent direct/prepared requests, stale expiry across queue restart')
}
