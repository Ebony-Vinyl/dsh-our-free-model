/**
 * Native Magpie engine through the plugin management routes and DSH adapter.
 * Build first: node scripts/build-magpie-engine.mjs
 * All accounts are synthetic; every inference request targets loopback.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { skipWithoutEngineBinary } from './lib/engine-binary.mjs'

if (skipWithoutEngineBinary('magpie-plugin')) process.exit(0)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-magpie-plugin-'))
const savedEnvironment = new Map()
for (const [name, value] of Object.entries({
  MAGPIE_NO_ACCOUNTS: '1',
  MAGPIE_PARTNERS: 'off',
  HOME: path.join(scratch, 'native-home'),
  USERPROFILE: path.join(scratch, 'native-home'),
  XDG_CONFIG_HOME: path.join(scratch, 'native-config'),
  XDG_CACHE_HOME: path.join(scratch, 'native-cache'),
})) {
  savedEnvironment.set(name, process.env[name])
  process.env[name] = value
  if (name !== 'MAGPIE_NO_ACCOUNTS' && name !== 'MAGPIE_PARTNERS') fs.mkdirSync(value, { recursive: true })
}
const resources = []
const logs = []
const logger = { info: value => logs.push(String(value)), warn: value => logs.push(String(value)), error: value => logs.push(String(value)) }
const key = 'synthetic-magpie-upstream-key'
const managementKey = 'synthetic-plugin-management-key'
const providerId = 'integration-fixture'
const upstreamModel = 'fixture-vision-tool'
const composite = `subscription:magpie/${providerId}/${upstreamModel}`
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=', 'base64')
const imageUrl = `data:image/png;base64,${image.toString('base64')}`
const received = []
let checks = 0
const check = async (name, run) => {
  await run()
  checks++
  console.log(`ok ${checks} - ${name}`)
}
const listen = async server => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  resources.push(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}
const collect = async stream => {
  const chunks = []
  while (true) {
    const row = await stream.next()
    if (row.done) return { chunks, outcome: row.value }
    chunks.push(row.value)
  }
}
const filesUnder = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name)
  return entry.isDirectory() ? filesUnder(file) : [file]
})

try {
  const { createMagpieEngine } = await import('../src/magpie-engine.js')
  const { createMagpieModels, combineSubscriptionRuntimes } = await import('../src/magpie-models.js')
  const { createModelRuntime, createRuntimeStores } = await import('../src/core/runtime.js')
  const { createApiRoutes } = await import('../index.js')
  const { structuralRejection } = await import('../src/trust.js')

  const upstream = await listen(http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{
          id: upstreamModel, object: 'model', context_window: 32768,
          max_output_tokens: 4096, vision: true,
        }] }))
        return
      }
      assert.equal(req.url, '/v1/chat/completions')
      assert.equal(req.headers.authorization, `Bearer ${key}`)
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      assert.equal(body.model, upstreamModel, 'engine must strip its provider namespace')
      received.push({ body, path: req.url })
      const hasResult = body.messages.some(message => message.role === 'tool')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const frame = value => res.write(`data: ${JSON.stringify(value)}\n\n`)
      if (hasResult) {
        frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture tool returned 42.' } }] })
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 } })
      } else {
        frame({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
          index: 0, id: 'call_fixture', type: 'function', function: { name: 'inspect_fixture', arguments: '{"value":' },
        }] } }] })
        frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '42}' } }] } }] })
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 8, completion_tokens: 4 } })
      }
      res.end('data: [DONE]\n\n')
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(error.message) } }))
    }
  }))

  const instances = []
  const open = async dataDir => {
    const engine = createMagpieEngine({ dataDir, logger })
    const stores = createRuntimeStores({ dataDir: path.join(dataDir, 'core'), logger })
    stores.settings.update({ combos: [], tokenSaver: { enabled: false } })
    let runtime
    let catchAllCalls = 0
    const magpieModels = createMagpieModels({
      engine, stats: stores.stats, logger,
      onChanged: () => runtime?.syncAggregateCatalog(),
    })
    const subscriptionRuntime = combineSubscriptionRuntimes(magpieModels, {
      handles: id => id.startsWith('subscription:'),
      catalog: () => [],
      complete: () => { catchAllCalls++; assert.fail('Magpie request reached imported-account catch-all') },
    })
    runtime = createModelRuntime({
      ...stores, subscriptionRuntime, logger,
      resolveImage: attachment => attachment?.attachmentId === 'fixture-native-image' ? imageUrl : undefined,
    })
    const connection = { admit: req => {
      const rejection = req.headers.authorization === `Bearer ${managementKey}` ? structuralRejection(req) : 401
      return rejection === undefined ? undefined : { rejection }
    } }
    const handler = createApiRoutes({ magpieEngine: engine, magpieModels, connection })
    const management = await listen(http.createServer((req, res) => {
      void handler(req, res).catch(error => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error.message) }))
      })
    }))
    let closed = false
    const instance = {
      dataDir, engine, magpieModels, runtime, stores, management,
      catchAllCalls: () => catchAllCalls,
      async close() {
        if (closed) return
        closed = true
        magpieModels.close()
        runtime.dispose()
        stores.dispose()
        await engine.close()
      },
      async request(method, suffix, body, extra = {}) {
        const response = await fetch(`${management}/api/our-free-model${suffix}`, {
          method,
          headers: { authorization: `Bearer ${managementKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'manual', signal: AbortSignal.timeout(90000),
        })
        const text = await response.text()
        let json
        try { json = JSON.parse(text) } catch {}
        return { status: response.status, headers: response.headers, text, json }
      },
    }
    instances.push(instance)
    return instance
  }
  resources.push(async () => { for (const instance of instances.reverse()) await instance.close() })
  const first = await open(path.join(scratch, 'workspace-a'))
  const ok = async (instance, method, suffix, body) => {
    const result = await instance.request(method, suffix, body)
    assert.equal(result.status, 200, `${method} ${suffix}: ${result.text.slice(0, 1000)}`)
    return result
  }
  const refresh = instance => ok(instance, 'POST', '/engine/refresh', {})
  const published = async instance => (await instance.runtime.adapter.listModels('our-free-model')).some(row => row.id === composite)
  const mutate = async (instance, action, body = { id: providerId }) => {
    const result = await ok(instance, 'POST', `/engine/ui/api/provider/${action}`, body)
    await refresh(instance)
    return result
  }
  const provider = {
    id: providerId, name: 'Local integration fixture', key, chat: `${upstream}/v1`,
    models: [upstreamModel], modelPrefs: { [upstreamModel]: { images: true } },
    new: true,
  }

  await check('management rejects unauthenticated and cross-origin status/start/proxy requests before startup', async () => {
    for (const [method, suffix] of [['GET', '/engine/status'], ['POST', '/engine/start'], ['POST', '/engine/refresh'],
      ['GET', '/engine/ui/'], ['POST', '/engine/ui/api/provider/save']]) {
      const body = method === 'POST' ? {} : undefined
      assert.equal((await first.request(method, suffix, body, { authorization: '' })).status, 401, suffix)
      assert.equal((await first.request(method, suffix, body, { origin: 'https://untrusted.invalid' })).status, 403, suffix)
    }
    assert.notEqual(first.engine.status().state, 'ready')
  })
  await check('start route starts the real bundled engine and returns a redacted ready status', async () => {
    await ok(first, 'POST', '/engine/start', {})
    const status = await ok(first, 'GET', '/engine/status')
    assert.equal(status.json.state, 'ready')
    assert.equal(status.json.revision, 'c551a229975653b7ae5b6a35e2278c983a272e06')
    const gateway = first.engine.gateway()
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(gateway.url).hostname))
    assert.ok(gateway.key)
    assert.ok(!status.text.includes(gateway.key), 'management status must not disclose engine gateway credentials')
    const settings = (await ok(first, 'GET', '/engine/ui/api/settings')).json
    assert.equal(settings.noAccountDiscovery, true, 'native account discovery must stay disabled')
    assert.equal(settings.noAutoUpdate, true)
    assert.equal(await published(first), false)
  })
  await check('workspace proxy serves real HTML and native provider/preset management JSON', async () => {
    const redirect = await first.request('GET', '/engine/ui?integration=1')
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), '/api/our-free-model/engine/ui/?integration=1')
    const page = await ok(first, 'GET', '/engine/ui/')
    assert.match(page.headers.get('content-type'), /text\/html/)
    assert.match(page.text, /<html|<!doctype html/i)
    const listing = await ok(first, 'GET', '/engine/ui/api/providers')
    assert.ok(listing.json && typeof listing.json === 'object')
    const presets = listing.json.presets.filter(preset => preset.kind !== 'partner')
    // 58 pinned built-ins minus Huawei Cloud, which this build does not offer.
    assert.equal(presets.length, 57, 'every offered built-in preset must reach the plugin management API')
    assert.equal(new Set(presets.map(preset => preset.id)).size, 57)
    const regional = presets.filter(preset => preset.regions?.length)
    assert.equal(regional.length, 13)
    assert.equal(regional.reduce((total, preset) => total + preset.regions.length, 0), 58)
    // The excluded channel must be absent from the very list the add sheet reads.
    assert.ok(!presets.some(preset => preset.id === 'huaweicloud'), 'Huawei Cloud must not be offered')
    assert.ok(!JSON.stringify(presets).toLowerCase().includes('huawei'), 'no Huawei Cloud preset may reach the page')
    for (const id of ['moonshot-cn', 'kimi-code', 'stepfun', 'stepfun-cn', 'tencent-cloud',
      'qwen-cn', 'qwen-token-plan', 'bailian-token-plan', 'bedrock', 'nous', 'commandcode', 'modelscope',
      'aihubmix', 'pipellm', '302ai', 'cherryin', 'yylx', 'typesafe', 'vercel-jev', 'cloudflare-jev',
      'bailian-decision', 'qwen-decision', 'omlx', 'mlx-serve', 'remote-magpie']) {
      assert.ok(presets.some(preset => preset.id === id), `missing native preset ${id}`)
    }
  })
  await check('native provider save plus refresh publishes its model in core and actual DSH adapter', async () => {
    await mutate(first, 'save', provider)
    assert.ok(await published(first), `engine=${first.engine.status().state}; facade=${JSON.stringify(first.magpieModels.catalog())}`)
    assert.ok(first.runtime.catalog.some(row => row.id === composite && row.channel === 'subscription'))
    assert.ok(first.runtime.publicModelRows().some(row => row.id === composite))
    const rows = await first.runtime.adapter.listModels('our-free-model')
    assert.ok(rows.find(row => row.id === composite).inputModalities.includes('image'))
  })
  const attachment = { attachmentId: 'fixture-native-image', mediaType: 'image/png' }
  const user = { role: 'user', content: [{ type: 'text', text: 'Inspect this fixture and call inspect_fixture.' }, { type: 'image', attachment }] }
  const tools = [{ name: 'inspect_fixture', description: 'Inspect the local fixture', parameters: {
    type: 'object', properties: { value: { type: 'integer' } }, required: ['value'],
  } }]
  let call
  await check('DSH adapter streams a tool call and image through the actual engine to loopback upstream', async () => {
    const result = await collect(first.runtime.adapter.stream({
      provider: 'our-free-model', model: composite, messages: [user], tools,
    }))
    assert.equal(result.chunks.at(-1)?.type, 'finish', JSON.stringify(result.chunks))
    assert.notEqual(result.chunks.at(-1).reason.kind, 'error', JSON.stringify(result.chunks))
    call = result.chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')?.block
    assert.ok(call, JSON.stringify(result.chunks))
    assert.equal(call.name, 'inspect_fixture')
    assert.deepEqual(JSON.parse(call.arguments), { value: 42 })
    const posted = received.at(-1).body
    assert.equal(posted.tools[0].function.name, 'inspect_fixture')
    assert.equal(posted.messages.find(message => message.role === 'user').content.find(part => part.type === 'image_url').image_url.url, imageUrl)
    assert.equal(first.catchAllCalls(), 0)
  })
  await check('tool result returns through DSH and engine with call identity, streamed text and single accounting', async () => {
    const result = await collect(first.runtime.adapter.stream({
      provider: 'our-free-model', model: composite, tools,
      messages: [user, { role: 'assistant', content: [call] },
        { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: '42' }] }],
    }))
    assert.ok(result.chunks.some(chunk => chunk.type === 'text-delta' && chunk.text.includes('Fixture tool returned 42.')), JSON.stringify(result.chunks))
    assert.equal(result.chunks.at(-1).reason.kind, 'stop')
    const resultMessage = received.at(-1).body.messages.find(message => message.role === 'tool')
    assert.equal(resultMessage.tool_call_id, call.id)
    assert.equal(resultMessage.content, '42')
    assert.equal(received.length, 2, 'one upstream request per DSH turn')
    assert.equal(first.stores.stats.get().models[composite].calls, 2)
    assert.equal(first.catchAllCalls(), 0)
  })
  await check('disable/re-enable/delete mutations remove and restore published models without stale dispatch', async () => {
    await mutate(first, 'off')
    assert.equal(await published(first), false)
    assert.ok(!first.runtime.publicModelRows().some(row => row.id === composite))
    await mutate(first, 'on')
    assert.ok(await published(first))
    await mutate(first, 'delete')
    assert.equal(await published(first), false)
    assert.ok(!first.runtime.catalog.some(row => row.id === composite))
  })
  await check('restart persists only its own engine settings and a separate data directory starts empty', async () => {
    await mutate(first, 'save', provider)
    const providerFiles = filesUnder(first.dataDir).filter(file => path.basename(file) === 'providers.json')
    assert.equal(providerFiles.length, 1, JSON.stringify(providerFiles))
    const stored = JSON.parse(fs.readFileSync(providerFiles[0], 'utf8'))
    assert.ok(JSON.stringify(stored).includes(providerId))
    const settings = (await ok(first, 'GET', '/engine/ui/api/settings')).json
    assert.equal(path.resolve(settings.dir), path.dirname(providerFiles[0]),
      'settings API directory must match the file the actual engine wrote')
    assert.equal(path.relative(first.dataDir, providerFiles[0]).replaceAll('\\', '/'),
      'magpie/config/magpie/providers.json')
    assert.ok(fs.existsSync(path.join(settings.dir, 'settings.json')))
    console.log(`engine provider file (relative to isolated dataDir): ${path.relative(first.dataDir, providerFiles[0]).replaceAll('\\', '/')}`)
    await first.close()
    const restarted = await open(first.dataDir)
    await ok(restarted, 'POST', '/engine/start', {})
    assert.ok(await published(restarted), 'same dataDir must retain configured provider')
    const second = await open(path.join(scratch, 'workspace-b'))
    await ok(second, 'POST', '/engine/start', {})
    assert.equal(await published(second), false, 'another dataDir must not inherit the first provider')
    assert.ok(!(await ok(second, 'GET', '/engine/ui/api/providers')).text.includes(providerId))
    await mutate(restarted, 'delete')
    assert.equal(await published(restarted), false)
    assert.ok(!logs.join('\n').includes(key))
    assert.ok(!logs.join('\n').includes(image.toString('base64')))
  })
  console.log(`magpie-plugin: ${checks}/${checks} real-engine integration groups passed`)
} finally {
  for (const close of resources.reverse()) await close()
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(scratch).startsWith('ofm-magpie-plugin-'))
  fs.rmSync(scratch, { recursive: true, force: true })
}
