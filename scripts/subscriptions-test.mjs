import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createSubscriptions } from '../src/subscriptions.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-subscriptions-'))
let checks = 0
let failures = 0
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok ${checks} - ${name}`) }
  catch (error) { failures++; console.error(`not ok ${checks} - ${name}\n${error.stack}`) }
}
const secret = {
  codex: 'codex-private-access-token-123456',
  refresh: 'private-refresh-token-123456',
  claude: 'claude-private-access-token-123456',
  gemini: 'gemini-private-access-token-123456',
  api: 'third-party-private-api-key-123456',
  account: 'chatgpt-private-account-id-123456',
}
const codex = () => ({ provider: 'codex', credentials: { tokens: {
  access_token: secret.codex, refresh_token: secret.refresh, account_id: secret.account,
} }, models: ['gpt-5.4', 'vendor/model'] })
const claude = () => ({ provider: 'claude', credentials: { claudeAiOauth: {
  accessToken: secret.claude, refreshToken: secret.refresh,
  expiresAt: Date.now() + 3600000, subscriptionType: 'max',
} }, models: ['claude-sonnet-4-6'] })
const gemini = () => ({ provider: 'gemini', credentials: {
  access_token: secret.gemini, refresh_token: secret.refresh, expiry_date: Date.now() + 3600000,
}, models: ['gemini-2.5-pro'] })
const api = () => ({ provider: 'api', credentials: { apiKey: secret.api }, baseUrl: 'http://127.0.0.1:1234/v1',
  models: ['provider/model'], format: 'openai-chat' })
const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
})
const newService = (extra = {}) => createSubscriptions({
  dataDir: path.join(scratch, crypto.randomUUID()), home: path.join(scratch, 'native-home'), ...extra,
})
const noSecrets = value => {
  const serialized = JSON.stringify(value)
  for (const token of Object.values(secret)) assert.ok(!serialized.includes(token), 'public data contains a secret')
}
const errorCode = expected => error => {
  assert.equal(error.code, expected)
  noSecrets({ message: error.message, stack: error.stack, ...error })
  return true
}
const privateFile = dataDir => path.join(dataDir, 'subscriptions', 'credentials.json')

try {
  await check('all supported credential shapes import as separate redacted accounts', () => {
    const service = newService()
    const rows = [codex(), claude(), gemini(), api()].map(input => service.import(input))
    assert.deepEqual(rows.map(row => row.provider), ['codex', 'claude', 'gemini', 'api'])
    assert.equal(new Set(rows.map(row => row.id)).size, 4)
    for (const row of rows) {
      assert.equal(row.quota.status, 'unknown')
      assert.equal(row.quota.fiveHour, null)
      assert.equal(row.quota.weekly, null)
      assert.equal(row.enabled, true)
      assert.ok(row.models.every(model => typeof model === 'string' && !model.startsWith('subscription:')))
      assert.equal(Object.hasOwn(row, 'credentials'), false)
    }
    noSecrets(rows)
    noSecrets(service.list())
  })
  await check('multiple accounts and returned data are independent snapshots', () => {
    const service = newService()
    const input = codex()
    const first = service.import(input)
    const second = service.import({ ...codex(), label: 'Second account' })
    input.credentials.tokens.access_token = 'mutated'
    first.models[0] = 'mutated'
    first.quota.windows.push({ usedPercent: 100 })
    assert.notEqual(first.id, second.id)
    assert.equal(service.list()[0].quota.windows.length, 0)
    assert.equal(service.list()[0].models[0], 'gpt-5.4')
  })
  await check('malformed credentials, providers, labels, expiry, models and formats fail safely', () => {
    const service = newService()
    const invalid = [
      null, [], {}, { provider: 'unknown', credentials: {} },
      { provider: 'codex', credentials: null }, { provider: 'codex', credentials: [] },
      { provider: 'codex', credentials: { OPENAI_API_KEY: secret.api } },
      { provider: 'codex', credentials: { tokens: { access_token: '' } } },
      { provider: 'claude', credentials: { accessToken: secret.claude } },
      { provider: 'gemini', credentials: { expiry_date: 123 } },
      { ...gemini(), credentials: { ...gemini().credentials, expiry_date: 'tomorrow' } },
      { ...claude(), credentials: { claudeAiOauth: { accessToken: secret.claude, expiresAt: Infinity } } },
      { ...api(), credentials: { apiKey: 42 } }, { ...api(), credentials: { apiKey: 'key\r\ninjection' } },
      { ...api(), label: '\n' }, { ...api(), label: 9 },
      { ...api(), models: 'model' }, { ...api(), models: [null] },
      { ...api(), models: ['subscription:other/model'] },
      { ...api(), models: ['model\r\nheader'] }, { ...api(), format: 'gemini' },
      { ...api(), baseUrl: undefined },
    ]
    for (const input of invalid) assert.throws(() => service.import(input), errorCode('INVALID_INPUT'))
    assert.equal(service.list().length, 0)
  })
  await check('official OAuth cannot be redirected through imported baseUrl or format', () => {
    const service = newService()
    for (const shape of [codex(), claude(), gemini()]) {
      assert.throws(() => service.import({ ...shape, baseUrl: 'http://127.0.0.1:1234' }), errorCode('INVALID_INPUT'))
      assert.throws(() => service.import({ ...shape, format: 'openai-chat' }), errorCode('INVALID_INPUT'))
    }
  })
  await check('API endpoints permit loopback HTTP(S), reject userinfo/hash/query/other schemes', async () => {
    const service = newService()
    for (const baseUrl of ['file:///tmp/key', 'ftp://example.com', 'javascript:alert(1)', 'not a URL',
      'https://user:password@example.com/v1', 'https://example.com/v1#secret', 'https://example.com/v1?key=secret']) {
      assert.throws(() => service.import({ ...api(), baseUrl }), errorCode('INVALID_INPUT'))
    }
    for (const baseUrl of ['http://localhost:5000/v1', 'http://[::1]:5000/v1', 'https://third-party.example/v1/']) {
      const row = service.import({ ...api(), baseUrl })
      const config = await service.resolve(`subscription:${row.id}/${row.models[0]}`)
      assert.equal(config.endpoint, `${baseUrl.replace(/\/$/, '')}/chat/completions`)
    }
  })
  await check('private resolve selects account/model and correct wire/auth headers', async () => {
    const service = newService()
    for (const input of [codex(), claude(), gemini(), api()]) {
      if (input.provider === 'gemini') input.credentials.project = 'saved-project'
      const row = service.import(input)
      const resolved = await service.resolve(`subscription:${row.id}/${row.models[0]}`)
      assert.equal(resolved.id, row.id)
      assert.equal(resolved.model, input.models[0])
      assert.equal(resolved.headers.authorization, `Bearer ${secret[input.provider]}`)
      assert.equal(resolved.redirect, 'error')
      resolved.models.push('mutated')
      assert.equal(service.list().find(item => item.id === row.id).models.length, input.models.length)
      if (row.provider !== 'api') {
        assert.ok(resolved.endpoint.startsWith({
          codex: 'https://chatgpt.com/', claude: 'https://api.anthropic.com/',
          gemini: 'https://cloudcode-pa.googleapis.com/',
        }[row.provider]))
      }
      if (row.provider === 'codex') assert.equal(resolved.headers['chatgpt-account-id'], secret.account)
      if (row.provider === 'claude') assert.equal(resolved.headers['anthropic-beta'], 'oauth-2025-04-20')
      if (row.provider === 'gemini') assert.equal(resolved.wire, 'gemini-code-assist')
    }
    for (const format of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
      const row = service.import({ ...api(), format })
      const resolved = await service.resolve(row.id)
      assert.equal(resolved.format, format)
      if (format === 'anthropic-messages') {
        assert.equal(resolved.headers['x-api-key'], secret.api)
        assert.equal(resolved.headers.authorization, undefined)
      }
    }
  })
  await check('enable/remove are validated, durable and enforced by private routing', async () => {
    const dataDir = path.join(scratch, 'mutations')
    const service = newService({ dataDir })
    const row = service.import(codex())
    assert.throws(() => service.setEnabled({ id: row.id, enabled: 'false' }), errorCode('INVALID_INPUT'))
    assert.equal(service.setEnabled({ id: row.id, enabled: false }).enabled, false)
    assert.equal(newService({ dataDir }).list()[0].enabled, false)
    await assert.rejects(service.resolve(`subscription:${row.id}/${row.models[0]}`), errorCode('DISABLED'))
    service.setEnabled({ id: row.id, enabled: true })
    await assert.rejects(service.resolve(`subscription:${row.id}/missing`), errorCode('NOT_FOUND'))
    assert.deepEqual(service.remove({ id: row.id }), { id: row.id, removed: true })
    assert.equal(newService({ dataDir }).list().length, 0)
    await assert.rejects(service.resolve(row.id), errorCode('NOT_FOUND'))
    assert.throws(() => service.remove({ id: row.id }), errorCode('NOT_FOUND'))
    assert.throws(() => service.setEnabled({ id: {}, enabled: true }), errorCode('INVALID_INPUT'))
  })
  await check('private file persists only normalized credentials with restrictive permissions', async () => {
    const dataDir = path.join(scratch, 'persistence')
    const service = newService({ dataDir })
    const row = service.import({ ...codex(), credentials: { ...codex().credentials, unrelatedSecret: 'DROP-ME' } })
    const file = privateFile(dataDir)
    const contents = fs.readFileSync(file, 'utf8')
    assert.ok(contents.includes(secret.codex))
    assert.ok(!contents.includes('DROP-ME'))
    assert.ok(!contents.includes('"quota"'))
    const loaded = newService({ dataDir })
    assert.equal(loaded.list()[0].id, row.id)
    assert.equal((await loaded.resolve(row.id)).headers.authorization, `Bearer ${secret.codex}`)
    noSecrets(loaded.list())
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['credentials.json'])
    if (process.platform === 'win32') {
      const acl = execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
        [file], { encoding: 'utf8', windowsHide: true })
      assert.ok(!acl.includes('(I)'), 'private file inherits permissions')
      assert.ok(!acl.includes('Everyone:'), 'private file grants Everyone access')
      assert.ok(!acl.includes('BUILTIN\\Users:'), 'private file grants all users access')
    } else {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
    }
  })
  await check('fresh process with empty PATH constructs, imports and reloads private subscription storage', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !['PATH', 'NODE_PATH', 'NODE_OPTIONS'].includes(key.toUpperCase())))
    env.PATH = ''
    env.NODE_PATH = ''
    env.NODE_OPTIONS = ''
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import path from 'node:path'
      import { execFileSync } from 'node:child_process'
      assert.equal(process.env.PATH, '')
      const { createSubscriptions } = await import(process.argv[1])
      const dataDir = process.argv[2]
      const service = createSubscriptions({ dataDir })
      const account = service.import({
        provider: 'api', credentials: { apiKey: 'empty-path-private-test-key' },
        baseUrl: 'http://127.0.0.1:1234/v1', models: ['test-model'],
      })
      const directory = path.join(dataDir, 'subscriptions')
      const file = path.join(directory, 'credentials.json')
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(stored.accounts[0].credentials.apiKey, 'empty-path-private-test-key')
      const restored = createSubscriptions({ dataDir })
      assert.equal(restored.list()[0].id, account.id)
      assert.equal((await restored.resolve(account.id)).headers.authorization,
        'Bearer empty-path-private-test-key')
      if (process.platform === 'win32') {
        const system32 = path.join(process.env.SystemRoot ?? 'C:\\\\Windows', 'System32')
        const user = execFileSync(path.join(system32, 'whoami.exe'), [],
          { encoding: 'utf8', windowsHide: true }).trim().toLowerCase()
        for (const target of [directory, file]) {
          const acl = execFileSync(path.join(system32, 'icacls.exe'), [target],
            { encoding: 'utf8', windowsHide: true }).toLowerCase()
          assert.ok(acl.includes(user + ':'), 'private ACL must grant current user')
          assert.ok(acl.includes('(f)'), 'private ACL must retain full control')
          assert.ok(!acl.includes('(i)'), 'private ACL must disable inheritance')
          assert.ok(!acl.includes('everyone:'), 'private ACL must exclude Everyone')
          assert.ok(!acl.includes('builtin\\\\users:'), 'private ACL must exclude all users')
        }
      } else {
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
        assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      }
      console.log('empty-PATH private storage verified')
    `, pathToFileURL(path.resolve('src/subscriptions.js')).href, path.join(scratch, 'empty-path-process')],
    { cwd: scratch, env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(output.trim(), 'empty-PATH private storage verified')
  })
  await check('damaged private storage fails closed without overwriting its contents', () => {
    const dataDir = path.join(scratch, 'corrupt')
    const file = privateFile(dataDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `{"private":"${secret.codex}","accounts":`)
    const before = fs.readFileSync(file, 'utf8')
    assert.throws(() => newService({ dataDir }), errorCode('STORAGE_ERROR'))
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  })
  await check('failed atomic rename preserves prior data and memory and removes temporary secrets', () => {
    const dataDir = path.join(scratch, 'atomic-failure')
    const service = newService({ dataDir })
    const row = service.import(codex())
    const file = privateFile(dataDir)
    const original = fs.readFileSync(file, 'utf8')
    fs.renameSync(file, `${file}.saved`)
    fs.mkdirSync(file)
    assert.throws(() => service.import(claude()), errorCode('STORAGE_ERROR'))
    assert.equal(service.list().length, 1)
    assert.equal(service.list()[0].id, row.id)
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['credentials.json', 'credentials.json.saved'])
    assert.equal(fs.readFileSync(`${file}.saved`, 'utf8'), original)
    fs.rmdirSync(file)
    fs.renameSync(`${file}.saved`, file)
  })
  await check('discovery returns IDs/providers only and importLocal reads fixed native paths', () => {
    const home = path.join(scratch, 'discovery-home')
    const service = newService({ home })
    assert.deepEqual(service.discover(), [])
    for (const [provider, parts, shape] of [
      ['codex', ['.codex', 'auth.json'], codex()],
      ['claude', ['.claude', '.credentials.json'], claude()],
      ['gemini', ['.gemini', 'oauth_creds.json'], gemini()],
    ]) {
      const file = path.join(home, ...parts)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(shape.credentials))
      const row = service.importLocal({ provider, models: shape.models })
      assert.equal(row.provider, provider)
      noSecrets(row)
    }
    assert.deepEqual(service.discover(), [
      { id: 'local:codex', provider: 'codex' },
      { id: 'local:claude', provider: 'claude' },
      { id: 'local:gemini', provider: 'gemini' },
    ])
    assert.equal(service.list().length, 3, 'discovery must not import')
    assert.throws(() => service.importLocal({ provider: 'codex', path: 'C:/somewhere' }), errorCode('INVALID_INPUT'))
    assert.throws(() => service.importLocal({ provider: '../codex' }), errorCode('INVALID_INPUT'))
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), `{"secret":"${secret.claude}"`)
    assert.equal(service.discover().length, 2)
    assert.throws(() => service.importLocal({ provider: 'claude' }), errorCode('LOCAL_AUTH_UNAVAILABLE'))
  })
  await check('local discovery ignores malformed, oversized and non-file credentials', () => {
    const home = path.join(scratch, 'invalid-native')
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    fs.mkdirSync(path.join(home, '.codex', 'auth.json'))
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true })
    fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), ' '.repeat(4 * 1024 * 1024 + 1))
    const service = newService({ home })
    assert.deepEqual(service.discover(), [])
    assert.throws(() => service.importLocal({ provider: 'codex' }), errorCode('LOCAL_AUTH_UNAVAILABLE'))
  })
  await check('Codex real quota URL/headers parse 5h, weekly, absolute reset and credit balance', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600
    const calls = []
    const service = newService({ fetchImpl: async (endpoint, options) => {
      calls.push({ endpoint, options })
      return json({
        plan_type: 'plus', rate_limit: {
          primary_window: { used_percent: 37, limit_window_seconds: 18000, reset_at: reset },
          secondary_window: { used_percent: 81, limit_window_seconds: 604800, reset_after_seconds: 1000 },
        },
        credits: { balance: '12.50', has_credits: true, unlimited: false },
      })
    } })
    const row = service.import(codex())
    const result = await service.refreshQuota({ id: row.id })
    assert.equal(calls[0].endpoint, 'https://chatgpt.com/backend-api/wham/usage')
    assert.equal(calls[0].options.headers.authorization, `Bearer ${secret.codex}`)
    assert.equal(calls[0].options.headers['chatgpt-account-id'], secret.account)
    assert.equal(calls[0].options.redirect, 'error')
    assert.equal(result.quota.status, 'ok')
    assert.equal(result.quota.plan, 'plus')
    assert.equal(result.quota.fiveHour.usedPercent, 37)
    assert.equal(result.quota.fiveHour.remainingPercent, 63)
    assert.equal(result.quota.fiveHour.resetsAt, new Date(reset * 1000).toISOString())
    assert.equal(result.quota.weekly.usedPercent, 81)
    assert.ok(Math.abs(Date.parse(result.quota.weekly.resetsAt) - Date.now() - 1000000) < 1000)
    assert.equal(result.quota.balance.amount, 12.5)
    noSecrets(result)
  })
  await check('Codex window duration determines meaning; missing percentages/resets stay unknown', async () => {
    let payload = { rate_limit: { primary_window: { limit_window_seconds: 2592000 },
      secondary_window: { used_percent: 4, limit_window_seconds: 18000 } } }
    const service = newService({ fetchImpl: async () => json(payload) })
    const row = service.import(codex())
    let { quota } = await service.refreshQuota({ id: row.id })
    assert.equal(quota.weekly, null)
    assert.equal(quota.windows[0].kind, 'other')
    assert.equal(quota.windows[0].usedPercent, null)
    assert.equal(quota.windows[0].resetsAt, null)
    assert.equal(quota.fiveHour.usedPercent, 4)
    payload = { plan_type: 'free', rate_limit: { primary_window: { used_percent: '0' } } }
    quota = (await service.refreshQuota({ id: row.id })).quota
    assert.equal(quota.status, 'unknown')
    assert.equal(quota.fiveHour, null)
    assert.equal(quota.weekly, null)
  })
  await check('Claude real OAuth quota parses 5h, weekly/model limits and extra spending', async () => {
    const reset = '2026-10-30T12:00:00Z'
    const service = newService({ fetchImpl: async (endpoint, options) => {
      assert.equal(endpoint, 'https://api.anthropic.com/api/oauth/usage')
      assert.equal(options.headers.authorization, `Bearer ${secret.claude}`)
      assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20')
      return json({
        five_hour: { utilization: 20, resets_at: reset },
        seven_day: { utilization: 42, resets_at: reset },
        seven_day_opus: { utilization: 12 },
        seven_day_sonnet: null,
        limits: [
          { kind: 'weekly_scoped', group: 'weekly', scope: { model: { display_name: 'Opus' } },
            percent: 55, resets_at: reset },
          { kind: 'weekly_scoped', group: 'weekly', scope: { model: { display_name: 'Sonnet' }, surface: 'cli' },
            percent: 99 },
        ],
        extra_usage: { is_enabled: true, used_credits: 125, monthly_limit: 1000 },
      })
    } })
    const { quota } = await service.refreshQuota({ id: service.import(claude()).id })
    assert.equal(quota.status, 'ok')
    assert.equal(quota.plan, 'max')
    assert.equal(quota.fiveHour.usedPercent, 20)
    assert.equal(quota.weekly.usedPercent, 42)
    assert.equal(quota.windows.find(row => row.id === 'seven_day_opus').usedPercent, 55)
    assert.equal(quota.windows.filter(row => row.id === 'seven_day_opus').length, 1)
    assert.equal(quota.windows.some(row => row.id === 'seven_day_sonnet'), false)
    assert.deepEqual(quota.extraUsage, { enabled: true, used: 125, limit: 1000, unit: 'cents' })
    assert.equal(quota.balance, null)
  })
  await check('Gemini loads project then real model quota without inventing time windows', async () => {
    const requests = []
    const service = newService({ fetchImpl: async (endpoint, options) => {
      requests.push({ endpoint, body: JSON.parse(options.body), options })
      if (endpoint.endsWith(':loadCodeAssist')) return json({
        cloudaicompanionProject: { id: 'server-project' }, currentTier: { id: 'standard-tier' },
      })
      assert.equal(endpoint, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota')
      assert.deepEqual(JSON.parse(options.body), { project: 'server-project' })
      return json({ buckets: [
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-10-24T12:00:00Z',
          remainingAmount: 120, tokenType: 'REQUESTS' },
        { modelId: 'gemini-2.5-flash', resetTime: 'invalid' },
      ] })
    } })
    const row = service.import(gemini())
    const { quota } = await service.refreshQuota({ id: row.id })
    assert.deepEqual(requests[0].body, { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } })
    assert.equal(requests[0].options.headers.authorization, `Bearer ${secret.gemini}`)
    assert.equal(quota.status, 'ok')
    assert.equal(quota.plan, 'standard-tier')
    assert.equal(quota.windows[0].usedPercent, 75)
    assert.equal(quota.windows[0].remainingAmount, 120)
    assert.equal(quota.windows[1].usedPercent, null)
    assert.equal(quota.windows[1].remainingPercent, null)
    assert.equal(quota.windows[1].resetsAt, null)
    assert.equal(quota.fiveHour, null)
    assert.equal(quota.weekly, null)
    assert.equal((await service.resolve(row.id)).project, 'server-project')
    noSecrets(service.list())
  })
  await check('Gemini accepts string/no project and does not default absent remaining fraction to full', async () => {
    for (const project of ['project-string', undefined]) {
      const service = newService({ fetchImpl: async (endpoint, options) => {
        if (endpoint.endsWith(':loadCodeAssist')) return json({ cloudaicompanionProject: project })
        assert.deepEqual(JSON.parse(options.body), project ? { project } : {})
        return json({ buckets: [{ modelId: 'model' }] })
      } })
      const { quota } = await service.refreshQuota({ id: service.import(gemini()).id })
      assert.equal(quota.status, 'unknown')
      assert.equal(quota.windows[0].remainingPercent, null)
    }
  })
  await check('third-party quota remains unknown with no guessed billing requests', async () => {
    let calls = 0
    const service = newService({ fetchImpl: async () => { calls++; throw new Error('unexpected') } })
    const { quota } = await service.refreshQuota({ id: service.import(api()).id })
    assert.equal(quota.status, 'unknown')
    assert.equal(quota.balance, null)
    assert.equal(calls, 0)
  })
  await check('successful provider payload echoes are redacted including labels', async () => {
    const service = newService({ fetchImpl: async () => json({
      plan_type: `plan ${secret.codex} ${secret.refresh} ${secret.account}`,
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
    }) })
    const row = service.import({ ...codex(), label: `Account ${secret.codex}` })
    noSecrets(row)
    noSecrets(await service.refreshQuota({ id: row.id }))
    noSecrets(service.list())
  })
  await check('provider failures clear old quota and never expose body/statusText/network errors', async () => {
    let mode = 'ok'
    const service = newService({ fetchImpl: async () => {
      if (mode === 'ok') return json({ five_hour: { utilization: 70 } })
      if (mode === 'network') throw new Error(`request failed: ${secret.claude} ${secret.refresh}`)
      return new Response(JSON.stringify({ token: secret.claude }), { status: mode, statusText: secret.claude })
    } })
    const row = service.import(claude())
    assert.equal((await service.refreshQuota({ id: row.id })).quota.fiveHour.usedPercent, 70)
    for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [429, 'PROVIDER_ERROR'],
      [500, 'PROVIDER_ERROR'], ['network', 'NETWORK_ERROR']]) {
      mode = status
      const result = await service.refreshQuota({ id: row.id })
      assert.equal(result.quota.status, 'error')
      assert.equal(result.quota.error.code, code)
      assert.equal(result.quota.fiveHour, null)
      assert.equal(result.quota.weekly, null)
      noSecrets(result)
    }
  })
  await check('malformed JSON, primitive JSON and oversized response bodies fail safely', async () => {
    for (const response of [
      new Response(`{"access_token":"${secret.codex}"`),
      json(null), json([]), new Response('x', { headers: { 'content-length': '99999999' } }),
      new Response(' '.repeat(4 * 1024 * 1024 + 1)),
    ]) {
      const service = newService({ fetchImpl: async () => response })
      const result = await service.refreshQuota({ id: service.import(codex()).id })
      assert.equal(result.quota.error.code, 'INVALID_RESPONSE')
      noSecrets(result)
    }
  })
  await check('out-of-range provider numbers stay unknown, valid zero/full values survive', async () => {
    const service = newService({ fetchImpl: async () => json({
      five_hour: { utilization: -1, resets_at: 'invalid' },
      seven_day: { utilization: 101 }, seven_day_opus: { utilization: 0 }, seven_day_sonnet: { utilization: 100 },
    }) })
    const { quota } = await service.refreshQuota({ id: service.import(claude()).id })
    assert.equal(quota.fiveHour.usedPercent, null)
    assert.equal(quota.weekly.usedPercent, null)
    assert.equal(quota.windows.find(row => row.id === 'seven_day_opus').remainingPercent, 100)
    assert.equal(quota.windows.find(row => row.id === 'seven_day_sonnet').remainingPercent, 0)
  })
  await check('pre-aborted requests never call fetch and midflight abort is bounded', async () => {
    let calls = 0
    let receivedSignal
    const service = newService({ fetchImpl: async (endpoint, options) => {
      calls++
      receivedSignal = options.signal
      return new Promise(() => {})
    } })
    const row = service.import(codex())
    const pre = AbortSignal.abort(new Error(secret.codex))
    await assert.rejects(service.refreshQuota({ id: row.id, signal: pre }), errorCode('ABORTED'))
    await assert.rejects(service.resolve(row.id, { signal: pre }), errorCode('ABORTED'))
    assert.equal(calls, 0)
    const controller = new AbortController()
    const pending = service.refreshQuota({ id: row.id, signal: controller.signal })
    setTimeout(() => controller.abort(new Error(secret.codex)), 20)
    const result = await pending
    assert.equal(result.quota.error.code, 'ABORTED')
    assert.equal(receivedSignal.aborted, true)
    noSecrets(result)
  })
  await check('timeout bounds uncooperative transport and stalled response body', async () => {
    for (const fetchImpl of [
      async () => new Promise(() => {}),
      async () => new Response(new ReadableStream({ start() {} })),
    ]) {
      const service = newService({ fetchImpl, timeoutMs: 30 })
      const start = Date.now()
      const result = await service.refreshQuota({ id: service.import(codex()).id })
      assert.equal(result.quota.error.code, 'TIMEOUT')
      assert.ok(Date.now() - start < 1000)
    }
  })
  await check('constructor endpoint overrides work; imported OAuth endpoints are ignored', async () => {
    const calls = []
    const service = newService({ endpoints: { codexQuota: 'http://127.0.0.1:9876/quota' },
      fetchImpl: async endpoint => { calls.push(endpoint); return json({}) } })
    const row = service.import({ ...codex(), credentials: { ...codex().credentials,
      quotaUrl: 'http://attacker.example', token_url: 'http://attacker.example' },
    endpoints: { codexQuota: 'http://attacker.example' } })
    await service.refreshQuota({ id: row.id })
    assert.deepEqual(calls, ['http://127.0.0.1:9876/quota'])
    assert.throws(() => newService({ endpoints: { bogus: 'https://example.com' } }), errorCode('INVALID_INPUT'))
    assert.throws(() => newService({ endpoints: { codexQuota: 'file:///tmp/key' } }), errorCode('INVALID_INPUT'))
    assert.throws(() => newService({ timeoutMs: -1 }), errorCode('INVALID_INPUT'))
  })
  await check('expired Gemini tokens refresh with real endpoint/form and rotation persists', async () => {
    const dataDir = path.join(scratch, 'token-rotation')
    const calls = []
    const refreshedAccess = 'fresh-gemini-access-private-123456'
    const refreshedRefresh = 'rotated-gemini-refresh-private-123456'
    const service = newService({ dataDir, fetchImpl: async (endpoint, options) => {
      calls.push(endpoint)
      if (endpoint === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(options.body)
        assert.equal(form.get('refresh_token'), secret.refresh)
        assert.equal(form.get('grant_type'), 'refresh_token')
        assert.match(form.get('client_id'), /\.apps\.googleusercontent\.com$/)
        return json({ access_token: refreshedAccess, refresh_token: refreshedRefresh, expires_in: 3600 })
      }
      assert.equal(options.headers.authorization, `Bearer ${refreshedAccess}`)
      if (endpoint.endsWith(':loadCodeAssist')) return json({ cloudaicompanionProject: 'p' })
      return json({ buckets: [{ modelId: 'm', remainingFraction: 1 }] })
    } })
    const input = gemini()
    input.credentials.expiry_date = 1
    const row = service.import(input)
    const result = await service.refreshQuota({ id: row.id })
    assert.equal(result.quota.status, 'ok')
    assert.equal(calls.length, 3)
    const saved = JSON.parse(fs.readFileSync(privateFile(dataDir), 'utf8')).accounts[0]
    assert.equal(saved.credentials.refreshToken, refreshedRefresh)
    assert.ok(saved.credentials.expiresAt > Date.now())
    const restored = newService({ dataDir, fetchImpl: async () => { throw new Error('must use saved access') } })
    assert.equal((await restored.resolve(row.id)).headers.authorization, `Bearer ${refreshedAccess}`)
    assert.ok(!JSON.stringify(result).includes(refreshedAccess))
    assert.ok(!JSON.stringify(restored.list()).includes(refreshedRefresh))
  })
  await check('Gemini refresh-only oauth credentials import and resolve', async () => {
    const service = newService({ fetchImpl: async endpoint => {
      if (endpoint.endsWith(':loadCodeAssist')) return json({ cloudaicompanionProject: 'project-from-server' })
      assert.equal(endpoint, 'https://oauth2.googleapis.com/token')
      return json({ access_token: 'new-access', expires_in: 3600 })
    } })
    const row = service.import({ provider: 'gemini', credentials: { refresh_token: secret.refresh } })
    assert.equal((await service.resolve(row.id)).headers.authorization, 'Bearer new-access')
  })
  await check('Codex rejected access refreshes once then retries with account-scoped auth', async () => {
    let calls = 0
    const service = newService({ fetchImpl: async (endpoint, options) => {
      calls++
      if (endpoint === 'https://auth.openai.com/oauth/token') {
        assert.equal(new URLSearchParams(options.body).get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
        return json({ access_token: 'rotated-codex-access', refresh_token: 'rotated-codex-refresh', expires_in: 3600 })
      }
      assert.equal(options.headers['chatgpt-account-id'], secret.account)
      return options.headers.authorization === `Bearer ${secret.codex}` ? json({}, 401)
        : json({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 } } })
    } })
    const result = await service.refreshQuota({ id: service.import(codex()).id })
    assert.equal(result.quota.status, 'ok')
    assert.equal(calls, 3)
  })
  await check('concurrent expired-token resolution performs only one rotation', async () => {
    let calls = 0
    let release
    const waiting = new Promise(resolve => { release = resolve })
    const service = newService({ fetchImpl: async () => {
      calls++
      await waiting
      return json({ access_token: 'shared-fresh-token', expires_in: 3600 })
    } })
    const input = gemini()
    input.credentials.expiry_date = 1
    input.credentials.project = 'saved-project'
    const row = service.import(input)
    const first = service.resolve(row.id)
    const second = service.resolve(row.id)
    release()
    const results = await Promise.all([first, second])
    assert.equal(calls, 1)
    assert.equal(results[0].headers.authorization, results[1].headers.authorization)
  })
  await check('expired Claude credentials report re-import without calling guessed refresh endpoint', async () => {
    let calls = 0
    const service = newService({ fetchImpl: async () => { calls++; return json({}) } })
    const input = claude()
    input.credentials.claudeAiOauth.expiresAt = 1
    const row = service.import(input)
    const result = await service.refreshQuota({ id: row.id })
    assert.equal(result.quota.error.code, 'AUTH_REQUIRED')
    await assert.rejects(service.resolve(row.id), errorCode('AUTH_REQUIRED'))
    assert.equal(calls, 0)
  })
  await check('a caller waiting for shared refresh can abort without waiting for the owner', async () => {
    let release
    const waiting = new Promise(resolve => { release = resolve })
    const service = newService({ fetchImpl: async () => {
      await waiting
      return json({ access_token: 'shared-rotation-access', expires_in: 3600 })
    } })
    const input = gemini()
    input.credentials.expiry_date = 1
    input.credentials.project = 'saved-project'
    const row = service.import(input)
    const owner = service.resolve(row.id)
    const controller = new AbortController()
    const dependent = service.resolve(row.id, { signal: controller.signal })
    controller.abort(new Error(secret.refresh))
    await assert.rejects(dependent, errorCode('ABORTED'))
    release()
    assert.equal((await owner).headers.authorization, 'Bearer shared-rotation-access')
  })
  await check('cancelling the refresh owner leaves one shared rotation running for a live waiter', async () => {
    let release, fetchSignal, calls = 0
    const waiting = new Promise(resolve => { release = resolve })
    const service = newService({ fetchImpl: async (_endpoint, options) => {
      calls++
      fetchSignal = options.signal
      await new Promise((resolve, reject) => {
        waiting.then(resolve)
        options.signal.addEventListener('abort', () => reject(new Error('refresh transport aborted')), { once: true })
      })
      return json({ access_token: 'owner-independent-access', refresh_token: 'rotated-owner-independent', expires_in: 3600 })
    } })
    const input = gemini()
    input.credentials.expiry_date = 1
    input.credentials.project = 'saved-project'
    const row = service.import(input)
    const controller = new AbortController()
    const owner = service.resolve(row.id, { signal: controller.signal })
    const waiter = service.resolve(row.id)
    controller.abort(new Error(secret.refresh))
    await assert.rejects(owner, errorCode('ABORTED'))
    assert.equal(fetchSignal.aborted, false, 'owner must not abort shared transport')
    release()
    assert.equal((await waiter).headers.authorization, 'Bearer owner-independent-access')
    assert.equal((await service.resolve(row.id)).headers.authorization, 'Bearer owner-independent-access')
    assert.equal(calls, 1)
  })
  await check('an abandoned shared refresh still rotates durably and has its own bounded timeout', async () => {
    let release, fetchSignal
    const waiting = new Promise(resolve => { release = resolve })
    const service = newService({ fetchImpl: async (_endpoint, options) => {
      fetchSignal = options.signal
      await waiting
      return json({ access_token: 'abandoned-owner-access', expires_in: 3600 })
    } })
    const input = gemini()
    input.credentials.expiry_date = 1
    input.credentials.project = 'saved-project'
    const row = service.import(input)
    const controller = new AbortController()
    const owner = service.resolve(row.id, { signal: controller.signal })
    controller.abort()
    await assert.rejects(owner, errorCode('ABORTED'))
    assert.equal(fetchSignal.aborted, false)
    release()
    assert.equal((await service.resolve(row.id)).headers.authorization, 'Bearer abandoned-owner-access')

    let calls = 0
    const timeoutService = newService({ timeoutMs: 25, fetchImpl: async () => {
      calls++
      return new Promise(() => {})
    } })
    const timeoutRow = timeoutService.import(input)
    const results = await Promise.allSettled([timeoutService.resolve(timeoutRow.id), timeoutService.resolve(timeoutRow.id)])
    assert.deepEqual(results.map(result => result.reason?.code), ['TIMEOUT', 'TIMEOUT'])
    assert.equal(calls, 1)
    await assert.rejects(timeoutService.resolve(timeoutRow.id), errorCode('TIMEOUT'))
    assert.equal(calls, 2, 'settled refresh must be removed so a later request can retry')
  })
  await check('removing an account during shared token rotation never persists refreshed credentials or resurrects it', async () => {
    let release, calls = 0
    const waiting = new Promise(resolve => { release = resolve })
    const dataDir = path.join(scratch, 'remove-during-rotation')
    const service = newService({ dataDir, fetchImpl: async () => {
      calls++
      await waiting
      return json({ access_token: 'removed-account-access', refresh_token: 'removed-account-refresh', expires_in: 3600 })
    } })
    const input = gemini()
    input.credentials.expiry_date = 1
    input.credentials.project = 'saved-project'
    const row = service.import(input)
    const owner = service.resolve(row.id)
    const waiter = service.resolve(row.id)
    service.remove({ id: row.id })
    release()
    const results = await Promise.allSettled([owner, waiter])
    assert.deepEqual(results.map(result => result.reason?.code), ['NOT_FOUND', 'NOT_FOUND'])
    assert.equal(calls, 1)
    assert.deepEqual(service.list(), [])
    assert.deepEqual(newService({ dataDir }).list(), [])
    assert.ok(!fs.readFileSync(privateFile(dataDir), 'utf8').includes('removed-account-'))
  })
  await check('invalid/refused refresh responses never persist or expose provider token text', async () => {
    for (const response of [json({ access_token: null, error: secret.refresh }), json({ error: secret.refresh }, 401),
      json({ access_token: 'x', expires_in: 1e100 }), json({ access_token: 'x', expires_in: -1 })]) {
      const service = newService({ fetchImpl: async () => response })
      const input = gemini()
      input.credentials.expiry_date = 1
      const result = await service.refreshQuota({ id: service.import(input).id })
      assert.equal(result.quota.status, 'error')
      assert.ok(['AUTH_REQUIRED', 'INVALID_RESPONSE'].includes(result.quota.error.code))
      noSecrets(result)
    }
  })
  await check('removal during refresh never resurrects the account', async () => {
    let release
    const waiting = new Promise(resolve => { release = resolve })
    const service = newService({ fetchImpl: async () => { await waiting; return json({}) } })
    const row = service.import(codex())
    const pending = service.refreshQuota({ id: row.id })
    service.remove({ id: row.id })
    release()
    await assert.rejects(pending, errorCode('NOT_FOUND'))
    assert.deepEqual(service.list(), [])
  })
  await check('native fetch follows constructor overrides and blocks redirects before token leakage', async () => {
    let destinationCalls = 0
    const server = http.createServer((req, res) => {
      req.resume()
      if (req.url === '/redirect') {
        res.writeHead(307, { location: '/destination' })
        res.end()
      } else if (req.url === '/destination') {
        destinationCalls++
        res.end('{}')
      } else {
        assert.equal(req.headers.authorization, `Bearer ${secret.codex}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ rate_limit: {
          primary_window: { used_percent: 15, limit_window_seconds: 18000 },
        } }))
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const base = `http://127.0.0.1:${server.address().port}`
      const service = newService({ endpoints: { codexQuota: `${base}/quota` } })
      assert.equal((await service.refreshQuota({ id: service.import(codex()).id })).quota.fiveHour.usedPercent, 15)
      const redirecting = newService({ endpoints: { codexQuota: `${base}/redirect` } })
      const { quota } = await redirecting.refreshQuota({ id: redirecting.import(codex()).id })
      assert.equal(quota.error.code, 'NETWORK_ERROR')
      assert.equal(destinationCalls, 0)
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
} finally {
  const resolved = path.resolve(scratch)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('ofm-subscriptions-'))
  fs.rmSync(resolved, { recursive: true, force: true })
}

console.log(`${checks - failures}/${checks} subscription checks passed`)
if (failures) process.exitCode = 1
