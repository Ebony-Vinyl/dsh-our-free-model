import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { openSeal } from '../src/vault.js'
import { signSealedRequest, lane } from '../src/eac.js'
import { createStandaloneEac } from '../packages/standalone/eac.mjs'
import { createCredentials } from '../packages/standalone/channels/credentials.mjs'
import { attachments } from '../packages/standalone/channels/images.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-channels-'))
const dataDir = path.join(scratch, 'app')
const dshHome = path.join(scratch, 'dsh')
const otherDir = path.join(scratch, 'other')
const warnings = []
const requests = []
let service, other
let checks = 0, failures = 0
let hold
let cancelled = false
let loginReady = true
const check = async (name, body) => {
  checks++
  try { await body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`) }
}
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const frames = (text, tool = false) => {
  const parts = [{ choices: [{ delta: { content: text } }] }]
  if (tool) {
    parts.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] } }] })
    parts.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] } }] })
  }
  parts.push({ choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
  return parts.map(part => `data: ${JSON.stringify(part)}\n\n`).join('') + 'data: [DONE]\n\n'
}
const token = domain => ({
  access_token: `fixture-${domain}`, refresh_token: 'fixture-refresh', domain,
  expires_at: String(Date.now() + 86400000), refresh_expires_at: String(Date.now() + 7 * 86400000),
  user_id: 'fixture-user', nickname: '替身账号', account_type: 'personal',
})
const upstream = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const pathname = new URL(req.url, 'http://localhost').pathname
  const raw = Buffer.concat(chunks).toString()
  const body = raw ? req.headers['content-type']?.includes('application/x-www-form-urlencoded')
    ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw) : {}
  requests.push({ pathname, body, headers: req.headers })
  const signed = typeof req.headers['x-ofm-signature'] === 'string'
  if (signed) {
    const expected = signSealedRequest(openSeal().signingSecret, { method: req.method, path: pathname.replace(/^\/remote/, ''), body: raw }, Number(req.headers['x-ofm-timestamp']))
    if (expected['x-ofm-signature'] !== req.headers['x-ofm-signature']) { json(res, { error: 'bad-signature' }, 401); return }
  }
  if (pathname.endsWith('/auth/status')) {
    json(res, { configured: true, required: true, authorized: req.headers['x-ofm-user'] === 'fixture-eac-user', starred: true, login: 'fixture-github', repo: 'Ebony-Vinyl/dsh-our-free-model' })
  } else if (pathname.endsWith('/auth/github/start')) {
    res.writeHead(302, { location: 'https://github.com/login/oauth/authorize' }); res.end()
  } else if (pathname.endsWith('/auth/poll')) {
    json(res, { status: 'ok', token: 'fixture-eac-user', login: 'fixture-github', avatar: '', ackRequired: true })
  } else if (pathname.endsWith('/auth/logout') || pathname.endsWith('/auth/ack')) {
    json(res, { ok: true })
  } else if (pathname.endsWith('/pool')) {
    json(res, { ok: true, inflight: 3, pool: 100, active24h: 5, poolSource: 'configured' })
  } else if (pathname.endsWith('/user_management/authorize/device')) {
    json(res, { device_code: 'fixture-device', user_code: 'FIXTURE', verification_uri: `${fixture}/login`, verification_uri_complete: `${fixture}/login?code=FIXTURE`, expires_in: 300, interval: 1 })
  } else if (pathname.endsWith('/user_management/authenticate')) {
    assert.equal(body.device_code, 'fixture-device')
    assert.equal(body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code')
    if (!loginReady) { json(res, { error: 'authorization_pending' }, 400); return }
    json(res, { access_token: 'fixture-workos', refresh_token: 'fixture-workos-refresh' })
  } else if (pathname.endsWith('/api/v1/auth/register')) {
    assert.equal(body.accessToken, 'fixture-workos')
    assert.equal(body.refreshToken, 'fixture-workos-refresh')
    json(res, { success: true, data: { accessToken: 'fixture-new', refreshToken: 'fixture-refresh', expiresAt: new Date(Date.now() + 86400000).toISOString(), userInfo: { clineUserId: 'fixture-user', email: 'fixture@example.invalid' } } })
  } else if (pathname.endsWith('/recommended-models')) {
    json(res, { free: [{ id: 'cline-free/mimo-v2.6-flash', name: '本机 Cline 模型' }], recommended: [], clinePass: [] })
  } else if (pathname.endsWith('/api.json')) {
    json(res, {})
  } else if (pathname.endsWith('/points/records')) {
    json(res, { code: '000000', data: { balance: 500, dailyBalance: 0, availableBalance: 500 } })
  } else if (pathname.endsWith('/models')) {
    if (signed) json(res, { data: [{ id: 'fixture-eac-model' }] })
    else if (req.headers['x-ofm-fixture-host'] === 'api.cline.bot') json(res, { data: [{ id: 'cline-free/mimo-v2.6-flash' }] })
    else if (req.headers['x-ofm-fixture-host'] === 'loomyad.xunfei.cn') {
      assert.equal(req.headers.token, 'fixture-loomy')
      json(res, { data: [{ id: 'fixture-free', name: '本机 Loomy 模型', type: 'chat', context_length: 128000, capabilities: { input_modalities: ['text', 'image'], reasoning: true }, reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'high' }] })
    } else json(res, { data: [] })
  } else if (pathname.endsWith('/chat/completions')) {
    if (req.headers['x-ofm-fixture-host'] === 'api.cline.bot') {
      assert.match(req.headers.authorization ?? '', /^Bearer workos:fixture-/)
      assert.equal(body.model, 'cline-free/mimo-v2.6-flash')
    }
    if (req.headers['x-ofm-fixture-host'] === 'loomyad.xunfei.cn') {
      assert.equal(req.headers.authorization, 'Bearer fixture-loomy')
      assert.equal(req.headers.token, 'fixture-loomy')
      assert.equal(body.model, 'fixture-free')
    }
    if (signed && req.headers['x-ofm-user'] !== 'fixture-eac-user') { json(res, { error: { message: 'AuthorizationRequired' } }, 401); return }
    if (JSON.stringify(body.messages).includes('cancel-fixture')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`)
      hold?.()
      res.on('close', () => { cancelled = true })
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(frames(signed ? 'eac-ok' : 'account-ok', Array.isArray(body.tools) && body.tools.length > 0))
  } else json(res, { data: { Response: { Data: { Accounts: [] } } } })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const fixture = `http://127.0.0.1:${upstream.address().port}`
process.env.OFM_TEST_UPSTREAM = fixture
process.env.OUR_FREE_MODEL_BASE = fixture
process.env.OUR_FREE_MODEL_KILO_BASE = fixture
process.env.DSH_HOME = dshHome
fs.mkdirSync(path.join(dshHome, 'our-free-model'), { recursive: true })
fs.writeFileSync(path.join(dshHome, 'our-free-model', 'eac-user.json'), JSON.stringify({ token: 'dsh-sentinel', login: 'dsh-user' }))
fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'SENTINEL_DO_NOT_READ')
const fixtureImport = new URL('./lib/standalone-channel-fixture.mjs', import.meta.url).href
process.execArgv.push('--import', fixtureImport)
await import('./lib/standalone-channel-fixture.mjs')
const { startStandalone } = await import('../packages/standalone/service.mjs')
fs.mkdirSync(path.join(dataDir, 'channel-pack'), { recursive: true })
const unsupportedProviders = ['unsupported-alpha', 'unsupported-beta']
const unsupportedAccounts = unsupportedProviders.map(provider => ({
  id: `${provider}-fixture`, provider, nickname: '历史账号保留', enabled: true, refreshable: false,
  createdAt: Date.now(), expiresAt: Date.now() + 86400000, credentialRef: `${provider.toUpperCase()}_ACCOUNT_FIXTURE`,
}))
const activeAccounts = ['cline', 'loomy'].map(provider => ({
  id: `${provider}-fixture`, provider, nickname: '本机替身账号', enabled: true, refreshable: false,
  createdAt: Date.now(), expiresAt: Date.now() + 86400000, credentialRef: `${provider.toUpperCase()}_ACCOUNT_FIXTURE`,
}))
fs.writeFileSync(path.join(dataDir, 'channel-pack', 'state.json'), JSON.stringify({
  accounts: [...unsupportedAccounts, ...activeAccounts], disabledModels: {},
}))
const unsupportedCredentials = Object.fromEntries(unsupportedAccounts.map(account => [account.credentialRef,
  JSON.stringify(token(account.provider === 'unsupported-alpha' ? 'unsupported.invalid' : 'unsupported-beta.invalid'))]))
const seed = createCredentials(dataDir)
for (const [ref, value] of Object.entries(unsupportedCredentials)) await seed.set(ref, value)
await seed.set('CLINE_ACCOUNT_FIXTURE', JSON.stringify({ access_token: 'workos:fixture-cline', expire_time: Date.now() + 86400000, account_id: 'fixture-user' }))
await seed.set('LOOMY_ACCOUNT_FIXTURE', JSON.stringify({ access_token: 'fixture-loomy', userid: 'fixture-user', phone: '13000000000', expires_at: String(Date.now() + 86400000) }))
seed.dispose()
const assertUnsupportedDataPreserved = () => {
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'channel-pack/state.json'), 'utf8'))
  const credentials = JSON.parse(fs.readFileSync(path.join(dataDir, 'channel-credentials.json'), 'utf8'))
  for (const account of unsupportedAccounts) assert.deepEqual(state.accounts.find(row => row.id === account.id), account)
  for (const [ref, value] of Object.entries(unsupportedCredentials)) assert.equal(credentials[ref], value)
}

let key
const api = async (suffix, body, extra = {}) => {
  const response = await fetch(service.url + suffix, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${key}`, ...body === undefined ? {} : { 'content-type': 'application/json' }, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  })
  const value = await response.json()
  return { response, value }
}
const rpc = async (method, payload = {}) => {
  const { response, value } = await api('/api/management/channels/rpc', { method, payload })
  assert.equal(response.status, 200)
  if (!value.ok) throw new Error(value.error.message)
  return value.value
}
try {
  await check('独立业务产物的 Chat / Responses 保留工具调用关联与结果', async () => {
    const { toGenerateOptions, toResponsesGenerateOptions } = await import('../packages/standalone/channels/business.mjs')
    const signal = new AbortController().signal
    const chat = await toGenerateOptions({ model: 'fixture/model', messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-result', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-result', content: 'fixture-tool-output' },
    ] }, signal)
    const responses = await toResponsesGenerateOptions({ model: 'fixture/model', input: [
      { type: 'function_call', call_id: 'call-result', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-result', output: 'fixture-tool-output' },
    ] }, signal)
    for (const result of [chat, responses]) {
      assert.equal(result.messages[0].content[0].id, 'call-result')
      const answer = result.messages[1]
      assert.equal(answer.role, 'tool')
      assert.equal(answer.toolCallId, 'call-result')
      assert.deepEqual(answer.source, { kind: 'tool', callId: 'call-result' })
      assert.deepEqual(answer.content, [{ type: 'text', text: 'fixture-tool-output' }])
      assert.notEqual(answer.id, result.messages[0].id)
    }
  })
  service = await startStandalone({ dataDir, port: 0, refresh: false, logger: { warn: message => warnings.push(message), info() {} } })
  await service.ready
  key = JSON.parse(fs.readFileSync(service.keyFile)).forwardKey
  await check('十个真实渠道注册，独立目录、统一模型目录和机读能力可用', async () => {
    assert.equal(service.channels.providers.length, 10)
    assert.equal(service.channels.providers.includes('opencode'), false)
    assert.equal((await rpc('account.list', { provider: 'cline' })).accounts.length, 1)
    const { value } = await api('/v1/models')
    assert.ok(value.data.some(row => row.id === 'cline/cline-free/mimo-v2.6-flash'))
    assert.ok(value.data.some(row => row.id === 'loomy/fixture-free'))
    assert.ok(value.data.find(row => row.id === 'cline/cline-free/mimo-v2.6-flash').input.includes('image'))
    assert.equal(value.data.find(row => row.id === 'cline/cline-free/mimo-v2.6-flash').context_window, 1048576)
    assert.equal(value.data.find(row => row.id === 'cline/cline-free/mimo-v2.6-flash').max_tokens, 131072)
    const summary = (await api('/api/management/summary')).value
    assert.equal(summary.networkMode, 'fixture')
    assert.equal(summary.catalog.find(row => row.id === 'cline/cline-free/mimo-v2.6-flash').maxOutput, 131072)
    assert.equal(summary.channels.state, 'ready')
    assert.equal(JSON.stringify(summary).includes('fixture-refresh'), false)
    assert.equal(fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8'), 'SENTINEL_DO_NOT_READ')
    assert.equal(fs.existsSync(path.join(dshHome, 'channel-pack')), false)
    assert.equal((await api('/api/management/eac/status')).value.local, false)
  })
  await check('未知渠道保留历史账号与凭据，但不注册、不列模型、不允许旧 RPC 或网关请求', async () => {
    assertUnsupportedDataPreserved()
    const models = (await api('/v1/models')).value.data
    for (const provider of unsupportedProviders) {
      assert.equal(service.channels.providers.includes(provider), false)
      assert.equal(models.some(row => row.id.startsWith(`${provider}/`)), false)
    }
    const before = requests.length
    for (const provider of unsupportedProviders) {
      const accountId = `${provider}-fixture`
      for (const [method, payload] of [
        ['account.list', { provider }], ['account.create', { provider }],
        ['model.list', { provider }], ['provider.setEnabled', { provider, enabled: false }],
        ['credits.permanentLock', { provider, locked: true }],
        ['login.poll', { accountId }], ['account.update', { accountId, patch: { nickname: '不得修改' } }],
        ['account.delete', { accountId }], ['account.test', { accountId }], ['account.reset', { accountId }],
      ]) {
        const reply = await api('/api/management/channels/rpc', { method, payload })
        assert.equal(reply.response.status, 200)
        assert.equal(reply.value.ok, false, `${provider} ${method}: ${JSON.stringify(reply.value)}`)
        assert.equal(reply.value.error.code, 'provider-unsupported', `${provider} ${method}`)
      }
      for (const [endpoint, payload] of [
        ['/v1/chat/completions', { messages: [{ role: 'user', content: 'unsupported fixture' }] }],
        ['/v1/responses', { input: 'unsupported fixture' }],
        ['/v1/messages', { max_tokens: 16, messages: [{ role: 'user', content: 'unsupported fixture' }] }],
      ]) assert.equal((await api(endpoint, { model: `${provider}/fixture-free`, ...payload })).response.status, 404)
    }
    assert.equal(requests.length, before, '未知渠道请求不得触达任何上游端点')
    assertUnsupportedDataPreserved()
  })
  await check('同源鉴权覆盖渠道与 EAC 操作，跨域和无密钥访问失败', async () => {
    for (const endpoint of ['/api/management/eac/status', '/api/management/channels/rpc']) {
      const noAuth = await fetch(service.url + endpoint, { method: endpoint.endsWith('rpc') ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...endpoint.endsWith('rpc') ? { body: '{}' } : {} })
      assert.equal(noAuth.status, 401)
    }
    assert.equal((await api('/api/management/channels/rpc', { method: 'account.list', payload: { provider: 'cline' } }, { origin: 'http://evil.invalid' })).response.status, 403)
    assert.equal((await api('/api/management/channels/rpc', { method: 'gateway.getEnabled', payload: {} })).value.value.apiKey.value, key)
  })
  await check('真实 Cline / Loomy 适配器非流式、SSE、Responses、工具及用量链路', async () => {
    const body = { model: 'cline/cline-free/mimo-v2.6-flash', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] }
    const reply = await api('/v1/chat/completions', body)
    assert.equal(reply.response.status, 200)
    assert.equal(reply.value.choices[0].message.content, 'account-ok')
    assert.deepEqual(JSON.parse(reply.value.choices[0].message.tool_calls[0].function.arguments), { q: 'fixture' })
    const response = await fetch(`${service.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model: 'loomy/fixture-free', stream: true }) })
    assert.equal(response.status, 200)
    const stream = await response.text()
    assert.ok(stream.includes('account-ok') && stream.includes('call_fixture') && stream.includes('[DONE]'))
    const responses = await api('/v1/responses', { model: 'cline/cline-free/mimo-v2.6-flash', input: 'hi', tools: [{ type: 'function', name: 'lookup', parameters: {} }] })
    assert.equal(responses.response.status, 200, JSON.stringify(responses.value))
    assert.ok(JSON.stringify(responses.value).includes('call_fixture'))
    const stats = (await api('/api/management/stats')).value
    assert.equal(stats.turns, 3)
    assert.equal(stats.grand.input, 33)
    const ledger = await rpc('usage.tokenLedger', {})
    assert.ok(JSON.stringify(ledger).includes('cline-free/mimo-v2.6-flash'))
    assert.ok(JSON.stringify(ledger).includes('fixture-free'))
  })
  await check('Anthropic Messages 经真实渠道适配器保留消息、系统提示、工具与生成参数', async () => {
    const before = requests.length
    const body = {
      model: 'cline/cline-free/mimo-v2.6-flash',
      max_tokens: 123,
      temperature: 0.2,
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi anthropic' }] }],
      tools: [{ name: 'lookup', description: 'look up', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
    }
    const reply = await api('/v1/messages', body)
    assert.equal(reply.response.status, 200, JSON.stringify(reply.value))
    assert.equal(reply.value.type, 'message')
    assert.ok(reply.value.content.some(block => block.type === 'text' && block.text === 'account-ok'), JSON.stringify(reply.value))
    assert.ok(reply.value.content.some(block => block.type === 'tool_use' && block.name === 'lookup'), JSON.stringify(reply.value))
    const sent = requests.slice(before).find(row => row.pathname.endsWith('/chat/completions'))
    assert.ok(sent, 'the channel must receive the converted Anthropic request')
    assert.equal(sent.body.max_tokens, 123)
    assert.equal(sent.body.temperature, 0.2)
    const text = JSON.stringify(sent.body.messages)
    assert.ok(text.includes('be brief'), text)
    assert.ok(text.includes('hi anthropic'), text)
    assert.equal(sent.body.tools[0].function.name, 'lookup')
  })
  await check('内联图片真实传到渠道，远程 URL 与伪造图片被拒绝', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    const reply = await api('/v1/chat/completions', { model: 'cline/cline-free/mimo-v2.6-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'what' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }] })
    assert.equal(reply.response.status, 200)
    assert.ok(JSON.stringify(requests.at(-1).body).includes(png))
    const before = requests.length
    const remote = await api('/v1/chat/completions', { model: 'cline/cline-free/mimo-v2.6-flash', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } }] }] })
    assert.equal(remote.response.status, 400)
    assert.equal(requests.length, before, '远程图片不得触发抓取或推理请求')
    await assert.rejects(attachments.saveImage({ data: Buffer.from('not-an-image'), mediaType: 'image/png' }))
  })
  await check('模型开关、供应商开关与永久积分锁定保留业务且立即阻止调用', async () => {
    await rpc('credits.permanentLock', { provider: 'loomy', locked: true })
    assert.equal((await rpc('credits.permanentLock', { provider: 'loomy' })).locked, true)
    const loomyBefore = requests.filter(row => row.pathname.endsWith('/chat/completions')).length
    const locked = await api('/v1/chat/completions', { model: 'loomy/fixture-free', messages: [{ role: 'user', content: 'permanent-only fixture' }] })
    assert.ok(locked.response.status >= 400, JSON.stringify(locked.value))
    assert.match(JSON.stringify(locked.value), /锁定永久积分/)
    assert.equal(requests.filter(row => row.pathname.endsWith('/chat/completions')).length, loomyBefore, '锁定必须阻止仅有永久积分的账号发起推理')
    await rpc('credits.permanentLock', { provider: 'loomy', locked: false })
    const unlocked = await api('/v1/chat/completions', { model: 'loomy/fixture-free', messages: [{ role: 'user', content: 'unlocked fixture' }] })
    assert.equal(unlocked.response.status, 200, JSON.stringify(unlocked.value))
    await rpc('credits.permanentLock', { provider: 'loomy', locked: true })
    await rpc('model.setDisabled', { provider: 'cline', modelId: 'cline-free/mimo-v2.6-flash', disabled: true })
    const before = requests.filter(row => row.pathname.endsWith('/chat/completions')).length
    assert.equal((await api('/v1/chat/completions', { model: 'cline/cline-free/mimo-v2.6-flash', messages: [{ role: 'user', content: 'hi' }] })).response.status, 404)
    assert.equal(requests.filter(row => row.pathname.endsWith('/chat/completions')).length, before)
    await rpc('provider.setEnabled', { provider: 'cline', enabled: false })
    assert.equal((await rpc('account.list', { provider: 'cline' })).accounts[0].enabled, false)
    await rpc('provider.setEnabled', { provider: 'cline', enabled: true })
    assert.equal((await rpc('account.list', { provider: 'cline' })).accounts[0].enabled, true)
    assert.equal((await rpc('credits.permanentLock', { provider: 'loomy' })).locked, true)
  })
  await check('批量模型开关仅作用于当前渠道，目录更新且关闭状态落盘', async () => {
    await rpc('model.setAllDisabled', { provider: 'cline', disabled: false })
    const listed = (await rpc('model.list', { provider: 'cline' })).models
    assert.ok(listed.length > 0 && listed.every(model => model.disabled === false))
    const otherBefore = (await rpc('model.list', { provider: 'loomy' })).models
    await rpc('model.setAllDisabled', { provider: 'cline', disabled: true })
    assert.ok((await rpc('model.list', { provider: 'cline' })).models.every(model => model.disabled === true))
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'channel-pack/state.json'), 'utf8'))
    assert.ok(Object.keys(stored.disabledModels.cline).length > 0, '批量关闭必须持久化')
    assert.deepEqual((await rpc('model.list', { provider: 'loomy' })).models, otherBefore)
    await service.channels.refresh()
    assert.ok(!(await api('/v1/models')).value.data.some(model => model.id.startsWith('cline/')))
    assert.ok((await api('/v1/models')).value.data.some(model => model.id === 'loomy/fixture-free'))
    await rpc('model.setAllDisabled', { provider: 'cline', disabled: false })
    await service.channels.refresh()
    assert.ok((await api('/v1/models')).value.data.some(model => model.id === 'cline/cline-free/mimo-v2.6-flash'))
    const restored = JSON.parse(fs.readFileSync(path.join(dataDir, 'channel-pack/state.json'), 'utf8'))
    assert.equal(Object.keys(restored.disabledModels.cline ?? {}).length, 0)
    assert.equal((await rpc('credits.permanentLock', { provider: 'loomy' })).locked, true)
  })
  await check('EAC 原 GitHub 登录、签名、用户 token、清单及退出链路可用', async () => {
    const start = await api('/api/management/eac/login/start', {})
    assert.equal(start.response.status, 200)
    assert.match(start.value.link, /^[\w-]{32}$/)
    assert.equal(start.value.opened, false)
    const poll = await api(`/api/management/eac/login/poll?link=${start.value.link}`)
    assert.equal(poll.value.status, 'ok')
    assert.equal(JSON.stringify(poll.value).includes('fixture-eac-user'), false)
    await service.runtime.refreshCatalog()
    assert.ok(service.runtime.catalog.some(row => row.channel === 'eac'))
    const model = service.runtime.catalog.find(row => row.channel === 'eac').id
    const reply = await api('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(reply.response.status, 200)
    assert.equal(reply.value.choices[0].message.content, 'eac-ok')
    assert.equal(requests.at(-1).headers['x-ofm-user'], 'fixture-eac-user')
    assert.equal((await api('/api/management/eac/pool')).value.inflight, 3)
    assert.equal((await api('/api/management/eac/logout', {})).value.ok, true)
    await service.runtime.refreshSealedLane()
    assert.equal(service.runtime.catalog.some(row => row.channel === 'eac'), false)
    assert.equal(fs.existsSync(path.join(dataDir, 'eac-user.json')), false)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dshHome, 'our-free-model/eac-user.json'))).token, 'dsh-sentinel')
  })
  await check('账号轮询完成后凭据只在后端落盘，可修改、备份和删除', async () => {
    const started = await rpc('account.create', { provider: 'cline' })
    assert.ok(started.accountId && started.loginUrl)
    assert.equal(new URL(started.loginUrl).origin, fixture)
    assert.equal(JSON.stringify(started).includes('fixture-workos'), false)
    const deadline = Date.now() + 12000
    let completed
    while (Date.now() < deadline) {
      completed = await rpc('login.poll', { accountId: started.accountId, provider: 'cline' })
      if (completed.done) break
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    assert.equal(completed.done, true)
    assert.equal(completed.success, true)
    assert.equal(JSON.stringify(completed).includes('fixture-new'), false)
    const loggedIn = (await rpc('account.list', { provider: 'cline' })).accounts.find(row => row.id === started.accountId)
    const credentials = JSON.parse(fs.readFileSync(path.join(dataDir, 'channel-credentials.json'), 'utf8'))
    assert.equal(JSON.parse(credentials[loggedIn.credentialRef]).access_token, 'workos:fixture-new')
    await rpc('account.update', { accountId: started.accountId, patch: { nickname: '新昵称', enabled: false } })
    await rpc('account.reorder', { provider: 'cline', orderedIds: [started.accountId, 'cline-fixture'] })
    const backup = await rpc('backup.export')
    assert.ok(Object.keys(backup.payload.credentials).length > 0)
    await rpc('account.delete', { accountId: started.accountId })
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'channel-credentials.json'), 'utf8'))[loggedIn.credentialRef], undefined)
    assert.equal((await rpc('account.list', { provider: 'cline' })).accounts.length, 1)
    await rpc('backup.import', { payload: backup.payload })
    assert.equal((await rpc('account.list', { provider: 'cline' })).accounts[0].nickname, '新昵称')
    assertUnsupportedDataPreserved()
  })
  await check('并行独立实例不共享账号、目录、授权或账本，重启保存设置', async () => {
    other = await startStandalone({ dataDir: otherDir, port: 0, refresh: false, logger: { warn() {}, info() {} } })
    await other.ready
    assert.equal((await other.channels.rpc({ method: 'account.list', payload: { provider: 'cline' } })).value.accounts.length, 0)
    assert.equal(other.channels.publicModelRows().length, 0)
    await service.close()
    service = await startStandalone({ dataDir, port: 0, refresh: false, logger: { warn() {}, info() {} } })
    await service.ready
    key = JSON.parse(fs.readFileSync(service.keyFile)).forwardKey
    assert.equal((await rpc('account.list', { provider: 'cline' })).accounts[0].nickname, '新昵称')
    assert.equal((await rpc('credits.permanentLock', { provider: 'loomy' })).locked, true)
    assertUnsupportedDataPreserved()
    assert.equal(service.channels.providers.some(provider => unsupportedProviders.includes(provider)), false)
    assert.equal((await api('/v1/models')).value.data.some(row => unsupportedProviders.some(provider => row.id.startsWith(`${provider}/`))), false)
  })
  await check('客户端取消传播到真实渠道网络请求，服务关闭不会迟到写入凭据', async () => {
    const controller = new AbortController()
    const started = new Promise(resolve => { hold = resolve })
    const request = service.runtime.complete({ model: 'cline/cline-free/mimo-v2.6-flash', signal: controller.signal, openAi: { messages: [{ role: 'user', content: 'cancel-fixture' }] } })
    request.catch(() => {})
    await Promise.race([started, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('取消测试未收到上游请求')), 10000); timer.unref() })])
    controller.abort()
    await assert.rejects(request)
    loginReady = false
    await rpc('account.create', { provider: 'cline' })
    await service.close()
    loginReady = true
    const before = fs.readFileSync(path.join(dataDir, 'channel-credentials.json'), 'utf8')
    await new Promise(resolve => setTimeout(resolve, 1300))
    assert.equal(cancelled, true)
    assert.equal(fs.readFileSync(path.join(dataDir, 'channel-credentials.json'), 'utf8'), before)
    assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), false)
  })
  await check('EAC 退出后迟到的状态响应不能恢复页面授权状态', async () => {
    const dir = path.join(scratch, 'status-eac')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'eac-user.json'), JSON.stringify({ token: 'fixture-old', login: 'fixture-old-user' }))
    let answer
    const eac = createStandaloneEac({
      dataDir: dir, credentialOf: () => ({ mode: 'worker', base: 'https://example.invalid/v1' }),
      fetch: async url => url.endsWith('/auth/status')
        ? new Promise(resolve => { answer = resolve })
        : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
    })
    const reading = eac.status()
    assert.equal((await eac.logout()).ok, true)
    answer(new Response('{"authorized":true,"login":"fixture-old-user"}', { headers: { 'content-type': 'application/json' } }))
    assert.equal((await reading).authorized, false)
    assert.equal(eac.cached().login, '')
    assert.equal(eac.credential(), null)
    eac.dispose()
  })
  await check('EAC 取消会中断正在 prepare 的网络，不保存迟到授权', async () => {
    let resolveStarted
    const began = new Promise(resolve => { resolveStarted = resolve })
    let stored = false
    const dir = path.join(scratch, 'cancel-eac')
    fs.mkdirSync(dir)
    const eac = createStandaloneEac({
      dataDir: dir, credentialOf: () => ({ mode: 'worker', base: 'https://example.invalid/v1', signingSecret: 's'.repeat(32) }),
      fetch: async (_url, { signal }) => new Promise((resolve, reject) => {
        stored = true; resolveStarted(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      }),
    })
    const starting = eac.start()
    await began
    eac.dispose()
    assert.equal((await starting).error, 'cancelled')
    assert.equal(stored, true)
    assert.equal(fs.existsSync(path.join(dir, 'eac-user.json')), false)
  })
} finally {
  await service?.close()
  await other?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  lane.fetch = undefined
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(`\nstandalone-channels: ${checks - failures}/${checks} checks passed`)
if (failures) process.exitCode = 1
