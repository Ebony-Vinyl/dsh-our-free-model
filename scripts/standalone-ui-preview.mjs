/** 界面视觉验收：隔离数据目录和替身上游，不读取真实账号。 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createCredentials } from '../packages/standalone/channels/credentials.mjs'

const modelCount = Number(process.env.OFM_PREVIEW_MODELS ?? 0)
const usageFixture = process.env.OFM_PREVIEW_USAGE === '1'
const settingsFixture = process.env.OFM_PREVIEW_SETTINGS === '1'
const creditsFixture = process.env.OFM_PREVIEW_CREDITS === '1'
const creditFailureFlag = path.resolve('.verify/ui-credits-data/fail-balance')
const usageDaysAgo = Number(process.env.OFM_PREVIEW_USAGE_DAYS_AGO ?? 0)
if (!Number.isInteger(usageDaysAgo) || usageDaysAgo < 0 || usageDaysAgo > 90) throw new Error('用量替身日期偏移必须为 0–90 天')
if (!Number.isInteger(modelCount) || modelCount < 0 || modelCount > 1000) throw new Error('替身模型数量必须为 0–1000')
const testDelay = Number(process.env.OFM_PREVIEW_TEST_DELAY_MS ?? 0)
if (!Number.isInteger(testDelay) || testDelay < 0 || testDelay > 60000) throw new Error('替身测试延迟必须为 0–60000 毫秒')
const testRequests = { started: 0, completed: 0, cancelled: 0 }
const recordRequests = () => {
  if (testDelay) fs.writeFileSync('.verify/ui-model-test-requests.json', JSON.stringify(testRequests))
}
const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const upstream = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname.endsWith('/auth/status')) {
    json(res, { configured: true, required: true, authorized: false, repo: 'Ebony-Vinyl/dsh-our-free-model' })
  } else if (pathname.endsWith('/pool')) {
    json(res, { ok: true, inflight: 3, pool: 100, active24h: 5, poolSource: 'configured' })
  } else if (pathname.endsWith('/models')) {
    json(res, { data: [{ id: 'mimo-v2.6-flash-free' }, ...Array.from({ length: modelCount }, (_, index) => ({
      id: `fixture/model-${index}:free`, name: `替身模型 ${index}`, isFree: true,
    }))] })
  } else if (pathname.includes('/console/enterprises/') || pathname.endsWith('/v3/config')) {
    json(res, { data: {
      models: [{ id: 'fixture-free', name: '本机替身模型', credits: 'x0', maxInputTokens: 128000, maxOutputTokens: 4096, supportsImages: true }],
      agents: [{ name: 'craft', models: ['fixture-free'] }],
    } })
  } else if (creditsFixture && pathname.endsWith('/v2/billing/meter/get-user-resource')) {
    if (fs.existsSync(creditFailureFlag) || req.headers.authorization === 'Bearer fixture-expired') {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('本机替身：余额查询暂时失败')
    } else {
      json(res, { code: 0, data: { Response: { Data: { Accounts: [{
        PackageName: '本机测试积分', Status: 1, CycleCapacityRemain: 123, CycleCapacity: 200,
      }] } } } })
    }
  } else if (creditsFixture && pathname.endsWith(':retrieveUserQuotaSummary')) {
    json(res, { groups: [{ buckets: [
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() },
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: new Date(Date.now() + 7 * 86400000).toISOString() },
    ] }] })
  } else if (creditsFixture && pathname.endsWith('/zcode-plan/billing/balance')) {
    json(res, { code: 0, data: { balances: [{
      show_name: '本机测试模型', unit_type: 'token', meter: 'model_usage',
      total_units: 200000, remaining_units: 123000, available_units: 123000, used_units: 77000,
    }] } })
  } else if (creditsFixture && pathname.endsWith('/zcode-plan/billing/preview')) {
    json(res, { code: 0, data: { plans: [] } })
  } else if (pathname.endsWith('/chat/completions')) {
    testRequests.started++
    recordRequests()
    res.once('close', () => {
      if (!res.writableEnded) { testRequests.cancelled++; recordRequests() }
    })
    // 仅长清单替身中的指定模型模拟失败，不改变正式渠道或 API。
    if (modelCount === 1000 && Buffer.concat(chunks).toString('utf8').includes('fixture/model-998:free')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '本机替身：模拟测试失败' } }))
      testRequests.completed++
      recordRequests()
      return
    }
    if (testDelay) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); res.off('close', finish); resolve() }
      const timer = setTimeout(finish, testDelay)
      res.once('close', finish)
    })
    if (res.destroyed) return
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK · 本机替身请求已完成' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`)
    testRequests.completed++
    recordRequests()
  } else json(res, { data: { Response: { Data: { Accounts: [] } } } })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${upstream.address().port}`
process.env.OFM_TEST_UPSTREAM = base
process.env.OUR_FREE_MODEL_BASE = base
process.env.OUR_FREE_MODEL_KILO_BASE = base
const fixture = new URL('./lib/standalone-channel-fixture.mjs', import.meta.url).href
process.execArgv.push('--import', fixture)
await import(fixture)
const prefix = creditsFixture ? 'ui-credits' : settingsFixture ? 'ui-settings' : usageFixture ? usageDaysAgo ? 'ui-usage-history' : 'ui-usage' : modelCount ? 'ui-phase1-load' : 'ui-phase1'
const dataDir = path.resolve(`.verify/${prefix}-data`)
fs.mkdirSync(path.join(dataDir, 'channel-pack'), { recursive: true })
const state = path.join(dataDir, 'channel-pack/state.json')
if (!fs.existsSync(state)) {
  fs.writeFileSync(state, JSON.stringify({ accounts: [{
    id: 'buddy-preview', provider: 'buddy', nickname: '本机替身账号', enabled: true, refreshable: false,
    createdAt: Date.now(), expiresAt: Date.now() + 86400000, credentialRef: 'BUDDY_ACCOUNT_PREVIEW',
  }], disabledModels: {} }))
  const credentials = createCredentials(dataDir)
  await credentials.set('BUDDY_ACCOUNT_PREVIEW', JSON.stringify({
    access_token: 'fixture-preview', refresh_token: 'fixture-refresh', domain: 'copilot.tencent.com',
    expires_at: String(Date.now() + 86400000), refresh_expires_at: String(Date.now() + 7 * 86400000),
    user_id: 'fixture-user', nickname: '本机替身账号', account_type: 'personal',
  }))
  credentials.dispose()
}
if (creditsFixture) {
  const fixtureAccounts = [
    { id: 'buddy-preview', provider: 'buddy', nickname: '余额正常的替身账号', token: 'fixture-preview' },
    { id: 'buddy-preview-error', provider: 'buddy', nickname: '查询失败的替身账号', token: 'fixture-expired' },
    { id: 'zcode-preview', provider: 'zcode', nickname: 'ZCode 替身账号', token: 'fixture-zcode' },
    { id: 'gemini-preview', provider: 'gemini', nickname: 'Gemini 替身账号', token: 'fixture-gemini' },
  ]
  const credentials = createCredentials(dataDir)
  for (const account of fixtureAccounts) {
    await credentials.set(`PREVIEW_${account.id.replaceAll('-', '_').toUpperCase()}`, JSON.stringify({
      access_token: account.token, zcode_jwt: account.token, device_mid: 'fixture-device',
      expires_at: Date.now() + 86400000, project_id: 'fixture-project', account_label: account.nickname,
    }))
  }
  credentials.dispose()
  fs.writeFileSync(state, JSON.stringify({ accounts: fixtureAccounts.map(account => ({
    id: account.id, provider: account.provider, nickname: account.nickname,
    credentialRef: `PREVIEW_${account.id.replaceAll('-', '_').toUpperCase()}`,
    enabled: true, refreshable: false, createdAt: Date.now(), expiresAt: Date.now() + 86400000,
  })), disabledModels: {} }))
  fs.writeFileSync(path.join(dataDir, 'channel-pack/auto-checkin.json'), JSON.stringify({ enabled: false }))
}
// 仅独立用量验收目录初始化模拟统计；正式 CLI 不加载这个脚本。
const usageFile = path.join(dataDir, 'stats.json')
if (usageFixture && !fs.existsSync(usageFile)) {
  const models = Object.fromEntries(Array.from({ length: 47 }, (_, index) => [
    `fixture/usage-${index}`, {
      input: (index + 1) * 720, output: (index + 1) * 280, reasoning: index * 35,
      cacheRead: 0, calls: (index + 1) * 3, failed: index % 5,
    },
  ]))
  const logicalModels = Object.fromEntries(Object.keys(models).map((id, index) => [
    id, { turns: (index + 1) * 2, failed: index % 3, recovered: index % 4 },
  ]))
  const days = Object.fromEntries(Array.from({ length: 21 }, (_, index) => {
    const at = new Date()
    at.setDate(at.getDate() - 20 + index - usageDaysAgo)
    const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    const model = `fixture/usage-${index}`
    const input = 720 * (index + 1), output = 280 * (index + 1)
    return [day, { total: input + output, models: { [model]: { input, output, reasoning: 35 * index, cacheRead: 0,
      calls: 3, failed: 0, ttftMs: 300 + index * 10, ttftSamples: 1, decodeMs: 2000, decodeTokens: 100 + index } } }]
  }))
  const sum = (values, key) => Object.values(values).reduce((total, row) => total + row[key], 0)
  fs.writeFileSync(usageFile, JSON.stringify({
    version: 3, days, models, samples: [], requests: sum(models, 'calls'), failedRequests: sum(models, 'failed'),
    failedRequestsEstimated: true,
    logical: { turns: sum(logicalModels, 'turns'), failed: sum(logicalModels, 'failed'),
      recovered: sum(logicalModels, 'recovered'), estimated: true, models: logicalModels },
  }))
}
const { startStandalone } = await import('../packages/standalone/service.mjs')
const service = await startStandalone({
  dataDir, port: creditsFixture ? 18906 : settingsFixture ? 18905 : usageFixture ? usageDaysAgo ? 18904 : 18903 : modelCount ? 18902 : 18901,
  refresh: process.env.OFM_PREVIEW_NO_REFRESH !== '1',
})
await service.ready
fs.writeFileSync(`.verify/${prefix}-url.txt`, service.managementUrl)
console.log(`界面预览：${service.url}（本机替身，非真实账号与上游）`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void service.close().then(() => { upstream.closeAllConnections(); upstream.close() })
})
