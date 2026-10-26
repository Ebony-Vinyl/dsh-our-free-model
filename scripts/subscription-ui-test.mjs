/** Actual plugin React components and subscription storage, isolated HTTP fixtures. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createSubscriptions } from '../src/subscriptions.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const uiRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'D:/Cache/npm-global/node_modules/playwright')
const { build } = uiRequire('esbuild')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-subscription-ui-'))
const output = path.join(root, '.verify/subscription-ui')
fs.mkdirSync(output, { recursive: true })
const react = await build({
  stdin: {
    contents: "import * as React from 'react';import * as ReactDOM from 'react-dom';import{createRoot}from'react-dom/client';window.testReact=React;window.testReactDOM=ReactDOM;window.createRoot=createRoot;",
    resolveDir: path.join(root, 'packages/standalone'),
  },
  bundle: true, write: false, format: 'iife', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const tokens = {
  codex: 'fixture-codex-private-token-123456',
  claude: 'fixture-claude-private-token-123456',
  gemini: 'fixture-gemini-private-token-123456',
  api: 'fixture-api-private-key-123456',
}
const native = {
  codex: { tokens: { access_token: tokens.codex } },
  claude: { claudeAiOauth: { accessToken: tokens.claude, subscriptionType: 'max' } },
  gemini: { access_token: tokens.gemini },
}
const home = path.join(scratch, 'home')
for (const [provider, parts] of Object.entries({
  codex: ['.codex', 'auth.json'], claude: ['.claude', '.credentials.json'], gemini: ['.gemini', 'oauth_creds.json'],
})) {
  const file = path.join(home, ...parts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(native[provider]))
}
let quotaMode = 'ok'
const providerCalls = []
const subscriptions = createSubscriptions({
  dataDir: path.join(scratch, 'data'), home,
  fetchImpl: async (endpoint, options) => {
    providerCalls.push({ endpoint, method: options.method })
    const json = body => new Response(JSON.stringify(body))
    if (quotaMode === 'error') return new Response('no quota access', { status: 403 })
    if (quotaMode === 'unknown') return json({})
    if (endpoint.includes('wham/usage')) return json({
      plan_type: 'plus', credits: { balance: '12.50', has_credits: true, unlimited: false },
      rate_limit: {
        primary_window: { limit_window_seconds: 18000, used_percent: 25, reset_at: 1793448000 },
        secondary_window: { limit_window_seconds: 604800, used_percent: 61, reset_at: 1794052800 },
      },
    })
    if (endpoint.includes('anthropic.com')) return json({
      five_hour: { utilization: 0, resets_at: '2026-10-31T12:00:00Z' },
      seven_day: { utilization: 100, resets_at: '2026-11-07T12:00:00Z' },
      seven_day_opus: { utilization: 75 },
    })
    if (endpoint.endsWith(':loadCodeAssist')) return json({ cloudaicompanionProject: 'fixture-project' })
    return json({ buckets: [{ modelId: 'gemini-fixture-pro', remainingFraction: 0.4, resetTime: '2026-10-31T12:00:00Z' }] })
  },
})
let failRead = false, failWrite = false, emptyDiscovery = false, holdWrite
const calls = []
const changed = []
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--dsw-alias-label-primary:#252a2d;--dsw-alias-label-secondary:#545e63;--dsw-alias-label-tertiary:#667379;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f4f6f5;--dsw-alias-bg-layer-3:#edf1f0;--dsw-alias-border-l1:#e0e5e3;--dsw-alias-border-l2:#cbd4cf;--dsw-alias-state-business-primary:#28785b;--dsw-alias-state-success-primary:#28785b;--dsw-alias-state-error-primary:#ae4354}
[data-theme=dark]{--dsw-alias-label-primary:#eef2ef;--dsw-alias-label-secondary:#c0c8c3;--dsw-alias-label-tertiary:#a2ada6;--dsw-alias-bg-layer-1:#242a27;--dsw-alias-bg-layer-2:#1c211e;--dsw-alias-bg-layer-3:#303833;--dsw-alias-border-l1:#3b4640;--dsw-alias-border-l2:#536057;--dsw-alias-state-business-primary:#69c49b}
body{margin:0;background:var(--dsw-alias-bg-layer-2);font:14px 'Segoe UI','Microsoft YaHei',sans-serif}#root{max-width:1080px;padding:16px;margin:auto}
</style></head><body><div id="root" class="ofm_root" data-ofm-effects="off"></div><script src="/react.js"></script><script>
window.__ModuleLoader__={load:r=>window.plugin=r.factory(name=>name==='react-dom'?window.testReactDOM:window.testReact)};
</script><script src="/client.js"></script><script>
const {CSS,DICT,SubscriptionsPage,Shell}=plugin.__test;
document.head.append(Object.assign(document.createElement('style'),{textContent:CSS}));
window.summaryReloads=0;window.pageRoot=null;
window.mountPage=(locale='en',shell=false)=>{
  window.pageRoot?.unmount();
  const t=key=>DICT[locale][key]??key;t.locale=locale;
  const data={settings:{},catalog:[]};
  const summary={data,reload(){window.summaryReloads++}};
  window.localStorage.setItem('ofm.tab','subscriptions');
  window.pageRoot=window.createRoot(document.getElementById('root'));
  window.pageRoot.render(window.testReact.createElement(shell?Shell:SubscriptionsPage,{
    t,summary,data,counts:{},stats:{reload(){}},eacLogin:{},ctx:{}
  }));
};
window.mountPage('en',true);
</script></body></html>`
const server = http.createServer(async (req, res) => {
  const send = (body, type = 'application/json', status = 200) => {
    res.writeHead(status, { 'content-type': type })
    res.end(type === 'application/json' ? JSON.stringify(body) : body)
  }
  if (req.url === '/') return send(html, 'text/html; charset=utf-8')
  if (req.url === '/react.js') return send(react.outputFiles[0].text, 'application/javascript')
  if (req.url === '/client.js') return send(client, 'application/javascript')
  if (req.url === '/favicon.ico') return send('', 'image/x-icon')
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  calls.push({ url: req.url, method: req.method, body })
  const prefix = '/api/our-free-model/subscriptions'
  if (req.url === prefix && req.method === 'GET') {
    return failRead ? send({ error: 'fixture cannot read accounts' }, 'application/json', 503) : send({ accounts: subscriptions.list() })
  }
  if (req.url === `${prefix}/discover`) return send({ accounts: emptyDiscovery ? [] : subscriptions.discover() })
  const actions = { import: 'import', 'import-local': 'importLocal', quota: 'refreshQuota', enabled: 'setEnabled', remove: 'remove' }
  const action = req.url.slice(prefix.length + 1)
  if (req.method === 'POST' && req.url.startsWith(`${prefix}/`) && actions[action]) {
    if (holdWrite) await holdWrite
    if (failWrite) return send({ error: `fixture rejected input ${tokens.api}` }, 'application/json', 503)
    try {
      await subscriptions[actions[action]](body)
      if (action !== 'quota') changed.push(action)
      return send({ accounts: subscriptions.list() })
    } catch { return send({ error: 'Invalid subscription request' }, 'application/json', 400) }
  }
  return send({ error: `unexpected fixture request ${req.url}` }, 'application/json', 404)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
let browser
const errors = [], external = []
let checks = 0
const check = async (name, action) => { await action(); checks++; console.log(`ok ${checks} - ${name}`) }
const prefix = '/api/our-free-model/subscriptions'
const posts = action => calls.filter(call => call.url === `${prefix}/${action}` && call.method === 'POST')
try {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(edge) ? { executablePath: edge } : {}) })
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    external.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', error => errors.push(error.message))
  const button = (scope, name) => scope.getByRole('button', { name, exact: true })
  const form = () => page.getByRole('form', { name: 'Import account', exact: true })
  const mount = (locale = 'en', shell = false) => page.evaluate(args => window.mountPage(...args), [locale, shell])
  const rows = () => page.locator('[data-subscription]')
  const row = id => page.locator(`[data-subscription="${id}"]`)
  const ready = async () => { await button(page, 'Import account').waitFor(); await page.waitForFunction(() =>
    !document.querySelector('.ofm_subscriptions header button[disabled]')) }
  const text = async (locator, value) => { await locator.getByText(value, { exact: true }).first().waitFor() }
  const clean = async () => {
    const snapshot = await page.evaluate(() => ({
      text: document.body.innerText, html: document.querySelector('#root').innerHTML,
      storage: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }),
    }))
    for (const token of Object.values(tokens)) {
      for (const value of Object.values(snapshot)) assert.ok(!value.includes(token), 'snapshot/storage must not expose credentials')
    }
    assert.ok(!snapshot.html.includes('access_token'), 'credentials must not populate snapshots')
  }
  await check('legacy subscriptions selection migrates into the unified workspace without discovery or quota calls', async () => {
    await page.goto(origin)
    assert.equal(await page.locator('#ofm-tab-subscriptions').count(), 0)
    assert.equal(await page.locator('#ofm-tab-workspace').getAttribute('aria-selected'), 'true')
    await page.getByRole('tab', { name: 'Subscriptions', exact: false }).waitFor()
    assert.equal(await page.getByRole('tab', { name: 'Subscriptions', exact: false }).getAttribute('aria-selected'), 'true')
    await text(page, 'No subscription accounts imported.')
    assert.equal(calls.filter(call => call.url.endsWith('/discover')).length, 0)
    assert.equal(posts('quota').length, 0)
    assert.equal(providerCalls.length, 0)
    assert.equal(await page.evaluate(() => localStorage.getItem('ofm.tab')), 'workspace')
    assert.equal(await page.evaluate(() => localStorage.getItem('ofm.workspace.section')), 'accounts')
  })
  await check('initial read failure is explicit and retry loads the page', async () => {
    failRead = true
    await mount()
    await text(page, 'Could not load subscription accounts')
    failRead = false
    await button(page, 'Retry').click()
    await text(page, 'No subscription accounts imported.')
    await ready()
  })
  await check('malformed JSON and model IDs fail locally without credential-bearing errors', async () => {
    await button(page, 'Import account').click()
    await form().getByLabel('Model IDs').fill('model-one')
    const before = posts('import').length
    for (const credentials of [`{"private":"${tokens.codex}"`, '[]', 'null', '"text"']) {
      await form().getByRole('textbox', { name: 'Credentials JSON', exact: true }).fill(credentials)
      await button(form(), 'Confirm import').click()
      await text(form(), 'Credentials must be a valid JSON object.')
      assert.ok(!(await page.locator('[role=alert]').allTextContents()).join('').includes(tokens.codex))
    }
    assert.equal(posts('import').length, before)
    await form().getByRole('textbox', { name: 'Credentials JSON', exact: true }).fill(JSON.stringify(native.codex))
    await form().getByLabel('Model IDs').fill('subscription:forged/model')
    await button(form(), 'Confirm import').click()
    await text(form(), 'Enter valid model IDs separated by commas or newlines.')
    assert.equal(posts('import').length, before)
  })
  let codexId, claudeId, geminiId, apiId
  await check('Codex JSON imports use actual module, deduplicate models and refresh host summary', async () => {
    await form().getByLabel('Account label').fill('Personal ChatGPT')
    await form().getByLabel('Model IDs').fill('gpt-5.4, gpt-5.4\nvendor/model')
    await button(form(), 'Confirm import').click()
    await form().waitFor({ state: 'detached' })
    codexId = subscriptions.list().find(account => account.label === 'Personal ChatGPT').id
    await text(row(codexId), 'Personal ChatGPT')
    assert.deepEqual(posts('import').at(-1).body, {
      provider: 'codex', label: 'Personal ChatGPT', models: ['gpt-5.4', 'vendor/model'], credentials: native.codex,
    })
    assert.equal(await row(codexId).locator('progress').count(), 0)
    assert.equal(await row(codexId).getByText('Unknown', { exact: true }).count(), 2)
    assert.ok(await page.evaluate(() => window.summaryReloads) >= 1)
    await clean()
  })
  await check('file import validates size and malformed JSON and keeps raw file content out of snapshots', async () => {
    await button(page, 'Import account').click()
    await form().getByLabel('Provider', { exact: true }).selectOption('claude')
    await form().getByLabel('Account label').fill('Claude file')
    await form().getByLabel('Model IDs').fill('claude-test')
    await button(form(), 'Choose file').click()
    const file = form().getByLabel('Credentials file')
    const before = posts('import').length
    await file.setInputFiles({ name: 'oversized.json', mimeType: 'application/json', buffer: Buffer.alloc(1024 * 1024 + 1) })
    await text(form(), 'Credentials file must be 1 MB or smaller.')
    await file.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') })
    await button(form(), 'Confirm import').click()
    await text(form(), 'Credentials must be a valid JSON object.')
    assert.equal(posts('import').length, before)
    await file.setInputFiles({ name: '.credentials.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(native.claude)) })
    await clean()
    await button(form(), 'Confirm import').click()
    await form().waitFor({ state: 'detached' })
    claudeId = subscriptions.list().find(account => account.label === 'Claude file').id
    assert.deepEqual(posts('import').at(-1).body.credentials, native.claude)
    await text(row(claudeId), 'Claude file')
    await clean()
  })
  await check('Gemini JSON import and provider switching clear unused secret input', async () => {
    await button(page, 'Import account').click()
    await form().getByRole('textbox', { name: 'Credentials JSON', exact: true }).fill(JSON.stringify(native.codex))
    await form().getByLabel('Provider', { exact: true }).selectOption('gemini')
    assert.equal(await form().getByRole('textbox', { name: 'Credentials JSON', exact: true }).inputValue(), '')
    assert.equal(await form().getByLabel('Base URL').count(), 0)
    await form().getByLabel('Account label').fill('Gemini personal')
    await form().getByLabel('Model IDs').fill('gemini-fixture-pro')
    await form().getByRole('textbox', { name: 'Credentials JSON', exact: true }).fill(JSON.stringify(native.gemini))
    await button(form(), 'Confirm import').click()
    await form().waitFor({ state: 'detached' })
    geminiId = subscriptions.list().find(account => account.label === 'Gemini personal').id
    await clean()
  })
  await check('third-party keys are masked; invalid URLs stay local; all three API formats import', async () => {
    for (const format of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
      await button(page, 'Import account').click()
      await form().getByLabel('Provider', { exact: true }).selectOption('api')
      assert.equal(await form().getByLabel('API Key', { exact: true }).getAttribute('type'), 'password')
      assert.equal(await form().getByLabel('API Key', { exact: true }).inputValue(), '')
      await form().getByLabel('API Key', { exact: true }).fill(tokens.api)
      await form().getByLabel('Account label').fill(`Third party ${format}`)
      await form().getByLabel('Model IDs').fill('vendor/model')
      await form().getByLabel('API format').selectOption(format)
      if (format === 'openai-chat') {
        const before = posts('import').length
        for (const endpoint of ['file:///tmp/key', 'https://user:pass@example.com/v1', 'https://example.com/v1#key']) {
          await form().getByLabel('Base URL').fill(endpoint)
          await button(form(), 'Confirm import').click()
          await text(form(), 'Enter an HTTP(S) address without userinfo, query parameters or a fragment.')
        }
        assert.equal(posts('import').length, before)
      }
      await form().getByLabel('Base URL').fill('http://127.0.0.1:2345/v1')
      await button(form(), 'Confirm import').click()
      await form().waitFor({ state: 'detached' })
      const saved = subscriptions.list().find(account => account.label === `Third party ${format}`)
      apiId ??= saved.id
      assert.equal(posts('import').at(-1).body.format, format)
      assert.equal(posts('import').at(-1).body.credentials.apiKey, tokens.api)
      assert.deepEqual(saved.models, ['vendor/model'])
      await clean()
    }
  })
  await check('local discovery only returns candidates and import requires its own explicit confirmation', async () => {
    const before = subscriptions.list().length
    await button(page, 'Find local accounts').click()
    const candidates = page.getByRole('region', { name: 'Local sign-ins', exact: true })
    await button(candidates, 'Select for import').first().waitFor()
    assert.equal(await button(candidates, 'Select for import').count(), 3)
    assert.equal(subscriptions.list().length, before)
    assert.equal(posts('import-local').length, 0)
    await clean()
    await button(candidates, 'Select for import').first().click()
    assert.equal(await form().getByLabel('Provider', { exact: true }).isDisabled(), true)
    assert.equal(await form().getByRole('textbox', { name: 'Credentials JSON', exact: true }).count(), 0)
    assert.equal(subscriptions.list().length, before)
    await form().getByLabel('Account label').fill('Local Codex')
    await form().getByLabel('Model IDs').fill('local-codex')
    await button(form(), 'Confirm import').click()
    await form().waitFor({ state: 'detached' })
    assert.deepEqual(posts('import-local').at(-1).body, { provider: 'codex', models: ['local-codex'], label: 'Local Codex' })
    assert.equal(subscriptions.list().length, before + 1)
    emptyDiscovery = true
    await button(page, 'Find local accounts').click()
    await text(candidates, 'No local sign-ins available to import.')
    emptyDiscovery = false
  })
  await check('quota actions show real parsed 5h/weekly snapshots, resets and plan/balance without auto-refresh', async () => {
    assert.equal(posts('quota').length, 0)
    await button(row(codexId), 'Refresh quotas').click()
    await text(row(codexId), '25% used')
    await text(row(codexId), '61% used')
    assert.ok((await row(codexId).innerText()).includes('Plan: plus'))
    assert.ok((await row(codexId).innerText()).includes('12.5 credits'))
    assert.equal(await row(codexId).locator('progress').count(), 2)
    assert.equal(await row(codexId).locator('time').count(), 3)
    assert.deepEqual(posts('quota').at(-1).body, { id: codexId })
    await button(row(claudeId), 'Refresh quotas').click()
    await text(row(claudeId), '0% used')
    await text(row(claudeId), '100% used')
    await text(row(claudeId), '75% used')
    assert.equal(await row(claudeId).locator('progress').count(), 3)
    await button(row(geminiId), 'Refresh quotas').click()
    await text(row(geminiId), '60% used')
    assert.equal(await row(geminiId).getByText('Unknown', { exact: true }).count(), 2)
    await button(row(apiId), 'Refresh quotas').click()
    assert.equal(await row(apiId).locator('progress').count(), 0)
    await clean()
  })
  await check('quota unknown/errors replace stale values without presenting fabricated availability', async () => {
    quotaMode = 'error'
    await button(row(codexId), 'Refresh quotas').click()
    await text(row(codexId), 'Quota query failed')
    assert.equal(await row(codexId).locator('progress').count(), 0)
    assert.equal(await row(codexId).getByText('Unknown', { exact: true }).count(), 2)
    assert.ok((await row(codexId).innerText()).includes('require re-import'))
    quotaMode = 'unknown'
    await button(row(codexId), 'Refresh quotas').click()
    await row(codexId).getByText('Quota query failed', { exact: true }).waitFor({ state: 'detached' })
    assert.equal(await row(codexId).locator('progress').count(), 0)
    quotaMode = 'ok'
  })
  await check('failed enable writes keep the saved switch state; pending writes disable repeat actions', async () => {
    failWrite = true
    await row(apiId).getByRole('switch', { name: 'Enable account' }).click()
    await text(page, 'Operation failed. Please retry.')
    assert.equal(await row(apiId).getByRole('switch').getAttribute('aria-checked'), 'true')
    assert.equal(subscriptions.list().find(account => account.id === apiId).enabled, true)
    failWrite = false
    let release
    holdWrite = new Promise(resolve => { release = resolve })
    try {
      await row(apiId).getByRole('switch').click()
      await page.waitForFunction(id => document.querySelector('[data-subscription="' + id + '"] [role=switch]').disabled, apiId)
      assert.equal(await button(row(apiId), 'Remove').isDisabled(), true)
      assert.equal(await button(page, 'Import account').isDisabled(), true)
      assert.equal(await row(apiId).getByRole('switch').getAttribute('aria-checked'), 'true')
    } finally { release(); holdWrite = undefined }
    await page.waitForFunction(id => document.querySelector('[data-subscription="' + id + '"] [role=switch]').getAttribute('aria-checked') === 'false', apiId)
    assert.deepEqual(posts('enabled').at(-1).body, { id: apiId, enabled: false })
    await row(apiId).getByRole('switch').click()
    await page.waitForFunction(id => document.querySelector('[data-subscription="' + id + '"] [role=switch]').getAttribute('aria-checked') === 'true', apiId)
    assert.equal(subscriptions.list().find(account => account.id === apiId).enabled, true)
    await clean()
  })
  await check('failed imports preserve the form for retry and cancellation clears secrets', async () => {
    await button(page, 'Import account').click()
    await form().getByLabel('Provider', { exact: true }).selectOption('api')
    await form().getByLabel('Model IDs').fill('retry-model')
    await form().getByLabel('API Key', { exact: true }).fill(tokens.api)
    await form().getByLabel('Base URL').fill('http://127.0.0.1:3456/v1')
    const before = subscriptions.list().length
    failWrite = true
    await button(form(), 'Confirm import').click()
    await text(page, 'Operation failed. Please retry.')
    assert.equal(subscriptions.list().length, before)
    assert.ok(!(await page.locator('[role=alert]').allTextContents()).join('').includes(tokens.api))
    failWrite = false
    await button(form(), 'Cancel').click()
    await button(page, 'Import account').click()
    await form().getByLabel('Provider', { exact: true }).selectOption('api')
    assert.equal(await form().getByLabel('API Key', { exact: true }).inputValue(), '')
    await button(form(), 'Cancel').click()
    await clean()
  })
  await check('removal needs confirmation and only removes the selected persisted account', async () => {
    const before = posts('remove').length
    await button(row(apiId), 'Remove').click()
    await text(row(apiId), 'Remove this account and its saved credentials?')
    assert.equal(posts('remove').length, before)
    await button(row(apiId), 'Cancel').click()
    assert.equal(posts('remove').length, before)
    await button(row(apiId), 'Remove').click()
    await button(row(apiId), 'Confirm removal').click()
    await row(apiId).waitFor({ state: 'detached' })
    assert.deepEqual(posts('remove').at(-1).body, { id: apiId })
    assert.ok(!subscriptions.list().some(account => account.id === apiId))
    assert.ok(subscriptions.list().some(account => account.id === codexId))
    assert.equal(await page.evaluate(() => window.summaryReloads), changed.length)
  })
  await check('Chinese/English light/dark layouts fit desktop and 390/320px mobile, including import fields', async () => {
    const long = subscriptions.import({ provider: 'api', label: 'Long account name with multiple words',
      credentials: { apiKey: tokens.api }, baseUrl: 'http://127.0.0.1:2345/v1',
      models: ['vendor/' + 'long-model-id-'.repeat(12)] })
    for (const locale of ['zh', 'en']) for (const width of [1280, 390, 320]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
      await mount(locale)
      await row(long.id).waitFor()
      await button(page, locale === 'zh' ? '导入账号' : 'Import account').click()
      const editor = page.locator('.ofm_subform')
      await editor.getByLabel(locale === 'zh' ? '服务商' : 'Provider', { exact: true }).selectOption('api')
      await editor.getByLabel('Base URL').fill('http://127.0.0.1:2345/v1')
      await editor.getByLabel(locale === 'zh' ? '模型 ID' : 'Model IDs').fill('vendor/model')
      await page.screenshot({ path: path.join(output, `${locale}-${width}-${theme}.png`), fullPage: true, animations: 'disabled' })
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth > innerWidth,
        controls: [...document.querySelectorAll('.ofm_subscriptions button,.ofm_subscriptions input,.ofm_subscriptions select,.ofm_subscriptions textarea')]
          .filter(el => {
            const rect = el.getBoundingClientRect()
            return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < 0
              || (!['INPUT', 'TEXTAREA'].includes(el.tagName) && el.scrollWidth > el.clientWidth + 2))
          }).map(el => el.textContent || el.tagName),
      }))
      assert.deepEqual(overflow, { page: false, controls: [] }, `${locale}/${width}/${theme}`)
      await clean()
    }
  })
  assert.deepEqual(errors, [], 'no browser runtime errors')
  assert.deepEqual(external, [], 'fixtures never contact external services')
  console.log(`${checks}/${checks} subscription UI checks passed; screenshots: ${output}`)
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  const resolved = path.resolve(scratch)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('ofm-subscription-ui-'))
  fs.rmSync(resolved, { recursive: true, force: true })
}
