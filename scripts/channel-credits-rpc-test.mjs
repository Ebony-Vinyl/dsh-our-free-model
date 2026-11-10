import assert from 'node:assert/strict'

/** 使用实际已打包 RPC，只提供账号池 ref，禁止真实网络与旧单凭据回退。 */
export async function verifyChannelCreditsRpc({ ctx, call, creds, adapters, outletState }) {
  const originalFetch = globalThis.fetch
  const providers = ['qoder', 'qodercn', 'loomy', 'minimax', 'lobsterai', 'zcode', 'gemini']
  let quotaRequests = 0, quotaFailed = true
  const originalResolve = ctx.credentials.resolve
  const resolvedRefs = []
  ctx.credentials.resolve = async ref => { resolvedRefs.push(ref); return originalResolve(ref) }
  try {
    for (const provider of providers) {
      const ref = `FIXTURE_CREDITS_${provider.toUpperCase()}`
      creds.set(ref, { value: JSON.stringify({
        access_token: 'fixture-credits-token', token_type: 'Bearer', user_id: 'fixture-user',
        zcode_jwt: 'fixture-credits-jwt', device_mid: 'fixture-device', account_label: '隔离账号',
      }) })
      await ctx.accountPool.addAccount({
        id: `fixture-credits-${provider}`, provider, nickname: '隔离账号',
        credentialRef: ref, enabled: true, refreshable: false, createdAt: 1,
      })
    }
    globalThis.fetch = async input => {
      const pathname = new URL(String(input)).pathname
      let body
      if (pathname.includes('get-user-resource')) {
        body = { code: 0, data: { Response: { Data: { Accounts: [{
          PackageName: 'fixture', CycleCapacityRemain: 123, Status: 1,
        }] } } } }
      } else if (pathname.includes('/me/usage')) {
        body = { qoderUsage: { userQuota: { total: 123, remaining: 123, used: 0, unit: 'credits' } } }
      } else if (pathname.includes('/points/records')) {
        body = { code: '000000', data: { balance: 123, dailyBalance: 0, availableBalance: 123 } }
      } else if (pathname.includes('/credit/details')) {
        body = { base_resp: { status_code: 0 }, total_count: 1, details: [{ remaining_amount: '123.00' }] }
      } else if (pathname.includes('/profile-summary')) {
        body = { code: 0, success: true, data: { totalCreditsRemaining: 123, creditItems: [] } }
      } else if (pathname.endsWith(':retrieveUserQuotaSummary')) {
        quotaRequests++
        if (quotaFailed) return new Response('本机配额查询失败', { status: 502 })
        body = { groups: [{ buckets: [
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: new Date(Date.now() + 3600000).toISOString() },
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: new Date(Date.now() + 86400000).toISOString() },
        ] }] }
      } else throw new Error(`未预期的替身端点：${pathname}`)
      return Response.json(body)
    }
    for (const provider of providers.filter(id => id !== 'zcode' && id !== 'gemini')) {
      resolvedRefs.length = 0
      const result = await call('credits.balances', { provider })
      assert.equal(result.ok, true)
      assert.equal(result.value.accounts[0].balance?.total, 123, `${provider} 的账号池凭据应能查询余额`)
      assert.ok(resolvedRefs.includes(`FIXTURE_CREDITS_${provider.toUpperCase()}`))
    }
    assert.equal((await ctx.zcodeAuth.current()).zcode_jwt, 'fixture-credits-jwt')
    assert.equal((await ctx.zcodeAuth.status()).configured, true)
    creds.delete('FIXTURE_CREDITS_QODER')
    const missing = await call('credits.balances', { provider: 'qoder' })
    assert.equal(missing.value.accounts[0].balance, null)
    assert.equal(missing.value.accounts[0].error, '凭据未配置', '缺失凭据必须返回原因，不能伪造零余额')
    const unavailableQuota = await call('credits.balances', { provider: 'gemini' })
    assert.equal(unavailableQuota.value.accounts[0].balance, null)
    quotaFailed = false
    const cachedQuota = await call('credits.balances', { provider: 'gemini' })
    assert.equal(cachedQuota.value.accounts[0].balance, null)
    assert.equal(quotaRequests, 1, '自动查询保留原有缓存')
    const freshQuota = await call('credits.balances', { provider: 'gemini', force: true })
    assert.equal(quotaRequests, 2, '手动重试必须真正查询上游替身')
    assert.equal(freshQuota.value.accounts[0].balance.total, 60)
    await verifyGeminiQuotaUsesChannelFetcher({ call, outletState })
    await verifyRefreshDispatch({ ctx, call })
    for (const provider of ['qoder', 'qodercn']) {
      const service = ctx[`${provider}Auth`], saved = service.refreshAccountCredential, calls = []
      const ref = `FIXTURE_CREDITS_${provider.toUpperCase()}`
      // 默认账号之外的 B 必须由实际注册接线按 id 刷新，不能重新选默认 ref。
      const otherId = `fixture-auth-${provider}-b`, otherRef = `FIXTURE_AUTH_${provider.toUpperCase()}_B`
      try {
        creds.set(otherRef, { value: '{"access_token":"fixture-b"}' })
        await ctx.accountPool.addAccount({ id: otherId, provider, nickname: 'B', credentialRef: otherRef, enabled: true, refreshable: true, createdAt: 1 })
        // qoder 的缺凭据测试刚删除了默认 ref，这里恢复为有效 A，确保错误实现会选中它。
        creds.set(ref, { value: '{"access_token":"fixture-a"}' })
        service.refreshAccountCredential = async (...args) => { calls.push(args) }
        await adapters.get(provider).options.refresh(otherId)
        assert.deepEqual(calls, [[otherRef, ctx.accountPool, otherId]], `${provider}: 实际认证续期绑定 B`)
        const lookup = ctx.accountPool.findAccountIdByCredential
        try {
          assert.equal(await adapters.get(provider).options.queueAccountIdForCredential({ access_token: 'fixture-b' }), otherId)
          ctx.accountPool.findAccountIdByCredential = async () => { throw new Error('fixture strict lookup failed') }
          await assert.rejects(adapters.get(provider).options.queueAccountIdForCredential({ access_token: 'fixture-b' }), /strict lookup failed/)
        } finally { ctx.accountPool.findAccountIdByCredential = lookup }
        await assert.rejects(adapters.get(provider).options.refresh('missing-account'), /当前请求的账号已移除/)
        assert.equal(calls.length, 1, '账号删除后不得退回 A 续期')
      } finally {
        service.refreshAccountCredential = saved
        await ctx.accountPool.removeAccount(otherId)
        creds.delete(otherRef)
      }
    }
  } finally {
    ctx.credentials.resolve = originalResolve
    globalThis.fetch = originalFetch
    for (const provider of providers) {
      await ctx.accountPool.removeAccount(`fixture-credits-${provider}`)
      creds.delete(`FIXTURE_CREDITS_${provider.toUpperCase()}`)
    }
  }
}

/**
 * issue #762：Gemini 配额查询必须复用注入的渠道出口 fetcher。
 *
 * 做法：把出口替身打开，同时把 `globalThis.fetch` 换成**只记录并抛错**的毒药。
 * 旧实现没有把 fetcher 传进 `fetchGeminiCreditBalance`，会回落到裸 fetch，
 * 配额结果立刻变成「配额查询网络失败」；修复后两个 Gemini 端点都必须经过出口。
 */
async function verifyGeminiQuotaUsesChannelFetcher({ call, outletState }) {
  const originalFetch = globalThis.fetch
  const seen = []
  let bareFetchCalls = 0
  outletState.active = true
  outletState.requests.length = 0
  outletState.respond = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    seen.push(url.pathname)
    if (url.pathname.endsWith(':retrieveUserQuotaSummary')) {
      return Response.json({ groups: [{ buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: new Date(Date.now() + 3600000).toISOString() },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: new Date(Date.now() + 86400000).toISOString() },
      ] }] })
    }
    if (url.pathname.endsWith(':loadCodeAssist')) {
      return Response.json({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } })
    }
    throw new Error(`fixture outlet 收到未预期请求：${url.pathname}`)
  }
  // 任何绕过出口的调用都会撞到这个毒药，并让配额结果变成网络失败。
  globalThis.fetch = async input => {
    bareFetchCalls++
    throw new Error(`Gemini 配额查询不得使用裸 fetch：${String(input)}`)
  }
  try {
    const result = await call('credits.balances', { provider: 'gemini', force: true })
    assert.equal(result.ok, true)
    assert.equal(result.value.accounts[0].balance?.total, 60)
    assert.equal(result.value.accounts[0].extra?.accountTier?.label, 'Pro')
    assert.equal(bareFetchCalls, 0, 'Gemini 配额查询不得调用裸 fetch')
    assert.ok(seen.some(path => path.endsWith(':retrieveUserQuotaSummary')), '配额请求必须经过出口')
    assert.ok(seen.some(path => path.endsWith(':loadCodeAssist')), '档位请求也必须经过出口')
    console.log('ok  Gemini 配额查询复用注入的出口 fetcher，裸 fetch 零调用')
  } finally {
    outletState.active = false
    outletState.respond = undefined
    outletState.requests.length = 0
    globalThis.fetch = originalFetch
  }
}

async function verifyRefreshDispatch({ ctx, call }) {
  const providers = [
    'lobsterai', 'qoder', 'qodercn', 'trae',
    'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
  ]
  for (const provider of providers) {
    const service = ctx[`${provider}Auth`]
    assert.ok(service, `${provider} auth service is mounted`)
    const saved = service.refreshAccountCredential
    const accountId = `fixture-refresh-${provider}`, ref = `FIXTURE_REFRESH_${provider.toUpperCase()}`
    const calls = []
    try {
      await ctx.accountPool.addAccount({
        id: accountId, provider, nickname: 'offline-refresh', credentialRef: ref,
        enabled: false, refreshable: true, createdAt: 1,
      })
      service.refreshAccountCredential = async (...args) => { calls.push(args) }
      const result = await call('account.refresh', { accountId })
      assert.deepEqual(result, { ok: true, value: { success: true } }, provider)
      assert.equal(calls.length, 1, provider)
      assert.deepEqual(calls[0], [ref, ctx.accountPool, accountId], `${provider}: exact ref, pool and id`)
      service.refreshAccountCredential = async () => { throw new Error('offline refresh rejected') }
      const rejected = await call('account.refresh', { accountId })
      assert.equal(rejected.ok, false, `${provider}: refresh failure is not success`)
      assert.match(rejected.error.message, /offline refresh rejected/)
    } finally {
      service.refreshAccountCredential = saved
      await ctx.accountPool.removeAccount(accountId)
    }
  }
  console.log('ok  refresh RPC: all 10 providers pass exact ref/pool/id; disabled accounts refresh; failures return ok:false')
}
