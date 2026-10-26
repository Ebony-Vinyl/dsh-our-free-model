import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { startStandalone } from '../packages/standalone/service.mjs'
import { pinnedEngineEntry } from './lib/engine-binary.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-workbench-http-'))
const upstream = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString())
  assert.equal(req.headers.authorization, 'Bearer isolated-subscription-secret')
  assert.equal(input.model, 'http-test')
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end('data: {"choices":[{"delta":{"content":"HTTP_SUBSCRIPTION_OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n')
})
let service
let checks = 0
const check = async (name, action) => { await action(); checks++; console.log(`ok ${name}`) }
try {
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  service = await startStandalone({ dataDir: path.join(scratch, 'data'), port: 0, refresh: false,
    subscriptionOptions: { home: path.join(scratch, 'empty-home') }, workbenchOptions: { env: { PATH: '' }, home: scratch },
    logger: { info() {}, warn() {} },
  })
  await service.ready
  const key = JSON.parse(fs.readFileSync(service.keyFile)).forwardKey
  const managementKey = JSON.parse(fs.readFileSync(service.keyFile)).managementKey
  assert.notEqual(managementKey, key)
  const sessionResponse = await fetch(service.url + '/api/management/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: managementKey }),
  })
  assert.equal(sessionResponse.status, 200)
  const managementCookie = sessionResponse.headers.get('set-cookie').split(';')[0]
  const call = async (route, body, authorized = true) => {
    const response = await fetch(service.url + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(authorized ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const api = async (route, body, authorized = true) => {
    const response = await fetch(service.url + '/api/management' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(authorized ? { cookie: managementCookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  await check('all new management routes require authentication and reject cross-origin requests', async () => {
    const inferenceLogin = await fetch(service.url + '/api/management/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
    })
    assert.equal(inferenceLogin.status, 200)
    const inferenceCookie = inferenceLogin.headers.get('set-cookie').split(';')[0]
    for (const route of ['/workbench', '/providers', '/subscriptions', '/subscriptions/discover', '/library', '/routing']) {
      assert.equal((await api(route, undefined, false)).status, 401)
      assert.equal((await call('/api/management' + route)).status, 403, 'inference bearer cannot administer the workbench')
      assert.equal((await fetch(service.url + '/api/management' + route, {
        headers: { cookie: inferenceCookie },
      })).status, 403, 'inference key cannot upgrade its privileges through a session')
      assert.equal((await fetch(service.url + '/api/management' + route, {
        headers: { authorization: `Bearer ${key}`, origin: 'http://hostile.invalid' },
      })).status, 403)
    }
    assert.equal((await call('/v1/models', undefined, true)).status, 200)
    assert.equal((await fetch(service.url + '/v1/models', { headers: { authorization: `Bearer ${managementKey}` } })).status, 401)
    assert.equal(JSON.stringify((await api('/summary')).body).includes(managementKey), false)
  })
  await check('the disclaimer reads once, acknowledges durably, and names both excluded channels', async () => {
    const first = await api('/disclaimer')
    assert.equal(first.status, 200)
    assert.equal(first.body.acknowledged, false, 'a fresh install has not acknowledged it')
    assert.equal(first.body.version, 2)
    assert.ok(Array.isArray(first.body.sections) && first.body.sections.length >= 3)
    const copy = JSON.stringify(first.body)
    assert.match(copy, /WorkBuddy/i, 'WorkBuddy is named')
    assert.match(copy, /Huawei/i, 'Huawei Cloud is named')
    assert.match(copy, /与我们无关|与本项目作者及团队无关/, 'the team is stated as not responsible')
    assert.equal((await api('/disclaimer/ack', {})).status, 200)
    const second = await api('/disclaimer')
    assert.equal(second.body.acknowledged, true, 'the acknowledgement persists')
    assert.equal((await api('/disclaimer', undefined, false)).status, 401, 'the copy is not public')
  })
  await check('provider directory exposes every preset with no stored secret', async () => {
    const before = await api('/providers')
    assert.equal(before.body.registry.length, 76)
    assert.deepEqual(before.body.configured, {})
    const saved = await api('/providers/save', { providerId: 'deepseek', apiKey: 'isolated-provider-secret', enabled: true, models: ['http-test'] })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.configured.deepseek.hasKey, true)
    assert.equal(JSON.stringify(saved).includes('isolated-provider-secret'), false)
    assert.equal((await api('/providers/remove', { providerId: 'deepseek' })).status, 200)
  })
  let account
  await check('import publishes subscription models and real gateway inference uses that account', async () => {
    const imported = await api('/subscriptions/import', {
      provider: 'api', label: 'HTTP fixture', credentials: { apiKey: 'isolated-subscription-secret' },
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, models: ['http-test'],
    })
    assert.equal(imported.status, 200)
    account = imported.body.accounts[0]
    const id = `subscription:${account.id}/http-test`
    assert.ok((await api('/summary')).body.catalog.some(row => row.id === id && row.routable))
    const response = await call('/v1/chat/completions', { model: id, messages: [{ role: 'user', content: 'test' }] })
    assert.equal(response.status, 200)
    assert.equal(response.body.choices[0].message.content, 'HTTP_SUBSCRIPTION_OK')
    assert.equal(JSON.stringify(imported).includes('isolated-subscription-secret'), false)
    const usage = (await api('/stats')).body
    assert.equal(usage.requests, 1, 'subscription usage should be counted exactly once')
  })
  await check('unknown quota stays unknown and disabled subscription disappears immediately', async () => {
    const quota = await api('/subscriptions/quota', { id: account.id })
    assert.equal(quota.status, 200)
    assert.equal(quota.body.accounts[0].quota.status, 'unknown')
    assert.equal((await api('/subscriptions/enabled', { id: account.id, enabled: false })).status, 200)
    assert.ok(!(await call('/v1/models')).body.data.some(row => row.id.startsWith(`subscription:${account.id}/`)))
    assert.equal((await api('/subscriptions/remove', { id: account.id })).status, 200)
  })
  await check('library profile and resources use authenticated durable CRUD', async () => {
    const saved = await api('/library/resources/save', { kind: 'prompt', name: 'Review', content: 'Review before changing files.', enabled: true })
    assert.equal(saved.status, 200)
    const list = (await api('/library')).body
    assert.equal(list.resources[0].name, 'Review')
    const profile = await api('/library/profiles/save', { name: 'Default' })
    assert.equal(profile.status, 200)
    assert.equal((await api('/library/profiles/apply', { id: profile.body.id })).status, 200)
    assert.equal((await api('/library/resources/remove', { id: saved.body.id })).status, 200)
    assert.equal((await api('/library/profiles/remove', { id: profile.body.id })).status, 200)
    assert.deepEqual((await api('/library')).body, { profiles: [], resources: [] })
  })
  await check('client launch rejects missing model and arbitrary executable arguments', async () => {
    const clients = (await api('/workbench')).body.clients
    assert.equal(clients.length, 6)
    assert.equal((await api('/workbench/clients/save', { id: 'codex', executable: process.execPath, cwd: scratch, mode: 'gateway' })).status, 200)
    assert.equal((await api('/workbench/clients/launch', { id: 'codex' })).status, 409)
    assert.equal((await api('/workbench/clients/save', { id: 'codex', args: ['arbitrary'] })).status, 400)
  })
  await check('routing CRUD publishes groups, previews capacities and rejects recursive membership', async () => {
    const model = (await api('/summary')).body.catalog.find(row => row.channel !== 'combo').id
    const saved = await api('/routing/save', {
      combo: { name: 'HTTP Routing', models: [model], strategy: 'smart', stickyLimit: 1, enabled: true },
    })
    assert.equal(saved.status, 200)
    const group = saved.body.combos.find(row => row.name === 'HTTP Routing')
    assert.ok((await call('/v1/models')).body.data.some(row => row.id === group.id))
    const preview = await api('/routing/preview', { models: [group.id], strategy: 'smart' })
    assert.equal(preview.status, 200)
    assert.ok(preview.body.capacity.contextWindow > 0)
    assert.deepEqual(preview.body.order.map(row => row.id), [model])
    assert.equal((await api('/routing/save', { combo: { ...group, models: [group.id] } })).status, 400)
    assert.equal((await api('/routing/remove', { id: group.id })).status, 200)
    assert.ok(!(await call('/v1/models')).body.data.some(row => row.id === group.id))
  })
  await check('the model workspace starts the real engine and serves its UI from this console', async () => {
    // The workspace is an integration check against the pinned engine binary,
    // which only exists for the platforms that were built. A runner without one
    // has nothing to start, so this group reports that instead of failing.
    if (pinnedEngineEntry() === null) {
      console.log(`  ok  skipped: no pinned engine binary for ${process.platform}-${process.arch}`)
      return
    }
    // The desktop console carries the same embedded workspace as the plugin. It
    // must start the pinned engine, proxy the page under its own mount, and keep
    // that mount out of reach for anyone without a session.
    const page = async (route, method = 'GET', authorized = true) => {
      const response = await fetch(service.url + route, {
        method, headers: { ...(authorized ? { cookie: managementCookie } : {}) },
      })
      return { status: response.status, headers: response.headers, text: await response.text() }
    }
    const before = await api('/engine/status')
    assert.equal(before.status, 200)
    assert.equal(before.body.state, 'stopped')
    assert.equal((await api('/engine/start', {})).status, 200)
    const started = await api('/engine/status')
    assert.equal(started.body.state, 'ready', JSON.stringify(started.body))
    const html = await page('/api/management/engine/ui/')
    assert.equal(html.status, 200)
    assert.match(html.headers.get('content-type'), /text\/html/)
    assert.match(html.text, /<html|<!doctype html/i)
    // Rewritten for this mount, not the plugin's: the page must load its own
    // assets from the console's prefix.
    assert.match(html.text, /\/api\/management\/engine\/ui\//)
    assert.ok(!html.text.includes('/api/our-free-model/engine/ui/'), 'the plugin mount must not leak into this console')
    const providers = await page('/api/management/engine/ui/api/providers')
    assert.equal(providers.status, 200)
    const presets = JSON.parse(providers.text)
    assert.ok(Array.isArray(presets.presets), 'the workspace reaches the engine API')
    assert.ok(!JSON.stringify(presets).toLowerCase().includes('huawei'), 'the excluded channel stays out here too')
    // Same session fence as every other workspace route.
    assert.equal((await api('/engine/status', undefined, false)).status, 401)
    assert.equal((await page('/api/management/engine/ui/', 'GET', false)).status, 401)
    assert.equal((await api('/engine/start', {}, false)).status, 401)
  })
} finally {
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  assert.ok(fs.realpathSync(scratch).startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(`workbench management: ${checks} HTTP integration groups passed`)
