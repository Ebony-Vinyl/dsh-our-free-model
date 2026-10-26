/** Real plugin components and React; isolated HTTP/RPC fixtures, no vendor traffic. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PROVIDERS } from '../src/providers/index.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const uiRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? require.resolve('playwright', {
  paths: [root, process.env.CODEX_MCP_NODE_PATH].filter(Boolean),
}))
const { build } = uiRequire('esbuild')
const output = process.env.OFM_EAC_ROUTER_OUTPUT ?? path.join(root, '.verify/eac-router-ui')
fs.mkdirSync(output, { recursive: true })
const react = await build({
  stdin: {
    contents: "import * as React from 'react';import{createRoot}from'react-dom/client';window.testReact=React;window.createRoot=createRoot;",
    resolveDir: path.join(root, 'packages/standalone'),
  },
  bundle: true, write: false, format: 'iife', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { AggregatePage, CHANNEL_PROVIDERS,')
const registry = PROVIDERS.map(provider => ({
  ...provider, authKind: provider.auth.kind, credentialUrl: provider.auth.url ?? '',
  baseUrlOverrideEnv: provider.baseUrlOverrideEnv ?? '', modelCount: provider.models.length,
}))
let configured = {
  open_router: { enabled: true, hasKey: true, keyHint: '…keep', models: ['original'] },
  groq: { enabled: false, hasKey: false, models: [] },
}
const statuses = { qoder: { accounts: { total: 1, enabled: 1 } }, gemini: { closed: true } }
const calls = []
let failRead = false, failSave = false
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--dsw-alias-label-primary:#252a2d;--dsw-alias-label-secondary:#545e63;--dsw-alias-label-tertiary:#667379;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f4f6f5;--dsw-alias-bg-layer-3:#edf1f0;--dsw-alias-border-l1:#e0e5e3;--dsw-alias-border-l2:#cbd4cf;--dsw-alias-state-business-primary:#28785b;--dsw-alias-state-success-primary:#28785b;--dsw-alias-state-error-primary:#ae4354}
[data-theme=dark]{--dsw-alias-label-primary:#eef2ef;--dsw-alias-label-secondary:#c0c8c3;--dsw-alias-label-tertiary:#a2ada6;--dsw-alias-bg-layer-1:#242a27;--dsw-alias-bg-layer-2:#1c211e;--dsw-alias-bg-layer-3:#303833;--dsw-alias-border-l1:#3b4640;--dsw-alias-border-l2:#536057;--dsw-alias-state-business-primary:#69c49b}
body{margin:0;background:var(--dsw-alias-bg-layer-2);font:14px 'Segoe UI','Microsoft YaHei',sans-serif}#root{max-width:1080px;padding:16px;margin:auto}
</style></head><body><div id="root" class="ofm_root" data-ofm-effects="off"></div><script src="/react.js"></script><script>window.__ModuleLoader__={load:r=>window.plugin=r.factory(()=>window.testReact)};</script><script src="/client.js"></script><script>
const {CSS,DICT,CHANNEL_PROVIDERS,ChannelsPage,AggregatePage}=plugin.__test;
document.head.append(Object.assign(document.createElement('style'),{textContent:CSS}));
window.channelIds=CHANNEL_PROVIDERS.map(row=>row.id);
window.summaryReloads=0;window.pageRoot=null;
window.mountPage=(page='channels',locale='zh',available=true,pack='ready')=>{
  window.pageRoot?.unmount();document.querySelectorAll('.ofm_toasts').forEach(el=>el.remove());
  const t=key=>DICT[locale][key]??key;t.locale=locale;
  const ctx=available?{connection:{rpc:{call:async(_api,_pack,request)=>({ok:true,value:await fetch('/fixture/rpc',{method:'POST',body:JSON.stringify(request)}).then(r=>r.json())})}}}:{};
  const summary={channels:{state:pack},data:{catalog:[{channel:'aggregate',providerId:'open_router',id:'open_router/original'}]},reload(){window.summaryReloads++}};
  window.pageRoot=window.createRoot(document.getElementById('root'));
  window.pageRoot.render(window.testReact.createElement(page==='channels'?ChannelsPage:AggregatePage,{t,ctx,summary}));
};
window.mountPage();
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
  if (req.url === '/fixture/rpc') {
    const { method, payload } = body
    if (method === 'provider.status') return send({ statuses })
    if (method === 'usage.autoCheckin') return send({ autoCheckin: { enabled: false } })
    if (method === 'account.create') return send({ accountId: `fixture-${payload.provider}` })
    if (method === 'login.poll') {
      statuses[payload.provider] = { accounts: { total: 1, enabled: 1 }, models: { total: 1 } }
      return send({ done: true, success: true, login: 'fixture account' })
    }
    if (method === 'account.list') return send({ accounts: [{ id: 'fixture-account', nickname: 'Fixture', enabled: true }] })
    if (method === 'model.list') return send({ models: [{ id: 'fixture-model', name: 'Fixture model' }] })
    if (method === 'credits.balances') return send({ accounts: [] })
    return send({})
  }
  if (req.url === '/api/our-free-model/providers' && req.method === 'GET') {
    return failRead ? send({ error: 'fixture registry unavailable' }, 'application/json', 503)
      : send({ registry, configured: { providers: configured } })
  }
  if (req.url === '/api/our-free-model/providers' && req.method === 'POST') {
    if (failSave) return send({ error: 'fixture save refused' }, 'application/json', 503)
    const previous = configured[body.providerId] ?? {}
    const { providerId, apiKey, ...patch } = body
    configured[providerId] = {
      ...previous, ...patch,
      ...(apiKey === undefined ? {} : { hasKey: apiKey !== '', keyHint: apiKey === '' ? '' : '…test' }),
    }
    return send({ aggregate: { providers: configured } })
  }
  if (req.url === '/api/our-free-model/providers/test') return send({ ok: true, status: 200, message: '' })
  if (req.url === '/api/our-free-model/providers/discover') {
    configured[body.providerId].models = ['discovered-a', 'discovered-b']
    return send({ models: ['discovered-a', 'discovered-b'] })
  }
  if (req.url === '/api/our-free-model/providers/remove') {
    delete configured[body.providerId]
    return send({ aggregate: { providers: configured } })
  }
  return send({ error: `unexpected fixture request ${req.url}` }, 'application/json', 404)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
let browser
const errors = [], external = []
try {
  browser = await chromium.launch({
    headless: true, ...(fs.existsSync(edge) ? { executablePath: edge } : {}),
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    external.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', error => errors.push(error.message))
  const mount = (name, locale = 'zh', available = true, pack = 'ready') =>
    page.evaluate(args => window.mountPage(...args), [name, locale, available, pack])
  const count = async (selector, expected) => {
    await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector, expected })
    assert.equal(await page.locator(selector).count(), expected)
  }
  const text = async (locator, value) => {
    await locator.filter({ hasText: value }).waitFor()
    assert.ok((await locator.textContent()).includes(value))
  }
  const channel = id => page.locator(`[data-channel="${id}"]`)
  const provider = id => page.locator(`[data-provider="${id}"]`)
  const button = (scope, name) => scope.getByRole('button', { name, exact: true })
  const lastWrite = url => calls.filter(call => call.url === url && call.method === 'POST').at(-1)?.body
  await page.goto(origin)
  const channelIds = await page.evaluate(() => window.channelIds)
  await count('[data-channel]', channelIds.length)
  assert.equal(await page.getByRole('heading', { name: 'EAC router', exact: true }).count(), 1)
  assert.ok(!channelIds.some(id => /codebuddy|workbuddy|opencode/i.test(id)), 'removed account channels stay absent')
  await text(channel('qoder').locator('.ofm_chanstate'), '已连接')
  await text(channel('gemini').locator('.ofm_chanstate'), '已关闭')
  for (const id of channelIds.filter(id => !['qoder', 'gemini'].includes(id))) {
    await text(channel(id).locator('.ofm_chanstate'), '未连接')
    assert.equal(await button(channel(id), '连接').isEnabled(), true)
  }
  assert.equal(await page.locator('.ofm_directorydetail').count(), 0, 'overview starts compact')
  await page.getByLabel('搜索渠道、厂商或 ID').fill('  QODER  ')
  await count('[data-channel]', 2)
  await page.getByLabel('连接状态', { exact: true }).selectOption('connected')
  await count('[data-channel]', 1)
  await button(channel('qoder'), '管理').click()
  await channel('qoder').getByText('Fixture', { exact: true }).waitFor()
  assert.ok(calls.some(call => call.body.method === 'account.list' && call.body.payload.provider === 'qoder'))
  assert.equal(await button(channel('qoder'), '测试').isEnabled(), true)
  await button(channel('qoder'), '收起').click()
  await page.getByLabel('搜索渠道、厂商或 ID').fill('no-such-channel')
  await text(page.locator('.ofm_page'), '没有符合筛选条件的渠道。')
  await page.getByLabel('搜索渠道、厂商或 ID').fill('')
  await page.getByLabel('连接状态', { exact: true }).selectOption('disconnected')
  await count('[data-channel]', channelIds.length - 2)
  await button(channel('lobsterai'), '连接').click()
  await page.getByRole('dialog').waitFor()
  await count('[data-channel]', channelIds.length - 3)
  assert.ok(calls.some(call => call.body.method === 'account.create' && call.body.payload.provider === 'lobsterai'))
  await page.getByLabel('连接状态', { exact: true }).selectOption('')
  await text(channel('lobsterai').locator('.ofm_chanstate'), '已连接')
  console.log('ok  current account roster, compact overview, combined filters, real login and account management')

  await mount('channels', 'zh', false, 'failed')
  await count('[data-channel]', channelIds.length)
  for (const id of channelIds) {
    await text(channel(id).locator('.ofm_chanstate'), '未连接')
    assert.equal(await button(channel(id), '连接').isDisabled(), true)
  }
  console.log('ok  missing transport/failed pack retains every channel with disabled connection actions')

  await mount('aggregate')
  await count('[data-provider]', registry.length)
  assert.deepEqual((await page.locator('[data-provider]').evaluateAll(rows => rows.map(row => row.dataset.provider))).sort(), registry.map(row => row.id).sort())
  assert.equal(await page.locator('[data-provider]').filter({ hasText: '未连接' }).count(), registry.length - 2)
  await page.getByLabel('连接状态', { exact: true }).selectOption('configured')
  await count('[data-provider]', 2)
  await page.getByLabel('连接状态', { exact: true }).selectOption('disabled')
  await count('[data-provider]', 1)
  assert.equal(await provider('groq').count(), 1)
  await page.getByLabel('连接状态', { exact: true }).selectOption('unconfigured')
  await page.getByLabel('分类', { exact: true }).selectOption('apikey')
  await page.getByLabel('搜索名称或 ID', { exact: true }).fill('  ANTHROPIC  ')
  await count('[data-provider]', registry.filter(row => row.category === 'apikey'
    && `${row.id} ${row.name}`.toLowerCase().includes('anthropic')).length)
  await button(provider('anthropic'), '连接').click()
  await provider('anthropic').getByRole('textbox').first().waitFor()
  let key = provider('anthropic').locator('input[type=password]')
  assert.equal(await key.inputValue(), '')
  await key.fill('synthetic-secret-test')
  await button(provider('anthropic'), '添加').click()
  await provider('anthropic').waitFor({ state: 'detached' })
  assert.equal(lastWrite('/api/our-free-model/providers').apiKey, 'synthetic-secret-test')
  await page.getByLabel('连接状态', { exact: true }).selectOption('')
  await text(provider('anthropic'), '已配置')
  await button(provider('anthropic'), '管理').click()
  key = provider('anthropic').locator('input[type=password]')
  assert.equal(await key.inputValue(), '', 'saved keys never prefill the editor')
  assert.ok(!(await page.locator('body').innerText()).includes('synthetic-secret-test'))
  await button(provider('anthropic'), '保存').click()
  await page.waitForFunction(() => !document.querySelector('[data-provider=anthropic] button[disabled]'))
  assert.equal(Object.hasOwn(lastWrite('/api/our-free-model/providers'), 'apiKey'), false, 'blank key preserves credentials')
  await button(provider('anthropic'), '测试').click()
  await text(provider('anthropic'), '验证通过')
  assert.deepEqual(lastWrite('/api/our-free-model/providers/test'), { providerId: 'anthropic' })
  await button(provider('anthropic'), '发现模型').click()
  await text(provider('anthropic'), '发现 2 个模型')
  await button(provider('anthropic'), '填入模型覆盖').click()
  assert.equal(await provider('anthropic').locator('textarea').inputValue(), 'discovered-a, discovered-b')
  failSave = true
  await button(provider('anthropic'), '保存').click()
  await text(provider('anthropic'), 'fixture save refused')
  failSave = false
  await button(provider('anthropic'), '保存').click()
  await page.waitForFunction(() => !document.querySelector('[data-provider=anthropic] button[disabled]'))
  assert.deepEqual(lastWrite('/api/our-free-model/providers').models, ['discovered-a', 'discovered-b'])
  await button(provider('anthropic'), '清除已保存的 Key').click()
  await text(provider('anthropic'), '未存 Key')
  assert.equal(lastWrite('/api/our-free-model/providers').apiKey, '', 'explicit clear remains distinct from blank save')
  await button(provider('anthropic'), '移除').click()
  assert.equal(lastWrite('/api/our-free-model/providers/remove'), undefined, 'deletion still requires confirmation')
  await button(provider('anthropic'), '确认移除').click()
  await text(provider('anthropic'), '未连接')
  assert.equal(await button(provider('anthropic'), '连接').isEnabled(), true)
  assert.equal(await provider('anthropic').locator('input').count(), 0)
  assert.ok(await page.evaluate(() => window.summaryReloads) >= 6, 'writes and discovery refresh the host summary')
  console.log('ok  full registry, combined filters, connect/save, blank-key preservation, test/discover, explicit clear, failure/retry and confirmed deletion')

  configured = {}
  await mount('aggregate')
  await count('[data-provider]', registry.length)
  assert.equal(await page.locator('[data-provider]').filter({ hasText: '未连接' }).count(), registry.length)
  for (const row of registry.filter(row => ['oauth', 'adc'].includes(row.authKind))) {
    assert.equal(await button(provider(row.id), '连接').isDisabled(), true)
    await text(provider(row.id), '本车道不会调用它')
  }
  await page.getByLabel('搜索名称或 ID', { exact: true }).fill('no-such-provider')
  await text(page.locator('.ofm_page'), '没有符合筛选条件的提供商。')
  failRead = true
  await mount('aggregate')
  await text(page.locator('.ofm_page'), 'fixture registry unavailable')
  failRead = false
  await button(page, '重试').click()
  await count('[data-provider]', registry.length)
  console.log('ok  empty configuration retains full directory, unsupported auth stays explicit, registry retry and no-match states')

  for (const locale of ['zh', 'en']) {
    for (const width of [1280, 390, 320]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 })
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
        for (const name of ['channels', 'aggregate']) {
          await mount(name, locale)
          await count(name === 'channels' ? '[data-channel]' : '[data-provider]', name === 'channels' ? channelIds.length : registry.length)
          const first = page.locator(name === 'channels' ? '[data-channel]' : '[data-provider]').first()
          if (name === 'aggregate') {
            await button(first, locale === 'zh' ? '连接' : 'Connect').click()
            await first.locator('input[type=password]').waitFor()
          } else {
            await button(channel('qoder'), locale === 'zh' ? '管理' : 'Manage').click()
            await channel('qoder').getByText('Fixture', { exact: true }).waitFor()
          }
          await page.screenshot({ path: path.join(output, `${name}-${locale}-${width}-${theme}.png`), fullPage: false, animations: 'disabled' })
          const overflow = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth > innerWidth,
            controls: [...document.querySelectorAll('.ofm_directory button,.ofm_directory input,.ofm_directory select,.ofm_directory textarea')]
              .filter(el => el.getBoundingClientRect().width > 0 && (el.scrollWidth > el.clientWidth + 2 || el.getBoundingClientRect().right > innerWidth))
              .map(el => el.textContent || el.tagName),
          }))
          assert.deepEqual(overflow, { page: false, controls: [] }, `${name}/${locale}/${width}/${theme} must fit`)
        }
      }
    }
  }
  assert.deepEqual(errors, [], 'no browser runtime errors')
  assert.deepEqual(external, [], 'fixtures must never contact external services')
  console.log(`ok  desktop/mobile (1280/390/320), Chinese/English, light/dark, expanded editors; screenshots: ${output}`)
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
