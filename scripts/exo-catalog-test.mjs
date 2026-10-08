/**
 * The real Host catalog lifecycle against loopback listing fixtures.
 *
 * Only the sealed credential factory is replaced: index.js, catalog stores,
 * discovery, adapter pickers, listings and free-lane probes run unchanged.
 * The worker transport uses its existing lane seam, with external requests
 * rejected before any network call. No real credentials or homes are used.
 *
 * Run: node scripts/exo-catalog-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { callRoute, chatFrames, fakeContext, until } from './lib/fake-kernel.mjs'

let checks = 0
let failures = 0
async function test(name, run) {
  checks += 1
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error?.stack ?? error}`)
  }
}

const savedEnvironment = Object.fromEntries(
  ['DSH_HOME', 'OUR_FREE_MODEL_BASE', 'OUR_FREE_MODEL_KILO_BASE']
    .map(key => [key, process.env[key]]),
)
const savedFetch = globalThis.fetch
const fixtureKey = Symbol.for('our-free-model.exo-catalog-test')
const savedFactory = globalThis[fixtureKey]
const homes = []
const contexts = new Set()
const requests = []
const workerRequests = []
let externalAttempts = 0
let mode = 'worker'
let listing = { data: [{ id: 'mimo-v2.6-flash-free' }, { id: 'exo-free' }, { id: 'exo-free' }] }
let listingStatus = 200
let workerStatus = 200
const serverModel = 'deepseek-ai/deepseek-v4.1-flash'
const kiloModel = 'fixture/model:free'
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    requests.push({ path: req.url, method: req.method, model: body.model })
    let payload
    let status = 200
    if (req.url === '/zen/v1/models') {
      status = listingStatus
      payload = listing
    } else if (req.url === '/eac/v1/models') {
      status = workerStatus
      payload = status === 200
        ? { data: [{ id: serverModel }, { id: 'EAC-claude opus 5.5' }] }
        : { error: { message: 'fixture worker unavailable' } }
    } else if (req.url === '/kilo/models') {
      payload = { data: [{ id: kiloModel, name: 'Fixture Model', isFree: true }] }
    } else if (req.url === '/zen/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatFrames())
      return
    } else {
      status = 404
      payload = { error: { message: 'unexpected fixture path' } }
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
process.env.OUR_FREE_MODEL_BASE = origin
process.env.OUR_FREE_MODEL_KILO_BASE = `${origin}/kilo`
globalThis.fetch = async (url, init) => {
  if (new URL(String(url)).origin !== origin) {
    externalAttempts += 1
    throw new Error('external network is disabled in the exo catalog test')
  }
  return savedFetch(url, init)
}

globalThis[fixtureKey] = ({ profileName }) => {
  if (!['desktop', 'web', 'web-desktop'].includes(profileName) || mode === null) return null
  const base = `${origin}/eac/v1`
  return mode === 'worker'
    ? { mode, base, signingSecret: 'exo-catalog-fixture-signing-secret' }
    : { mode, base, apiKey: 'exo-catalog-fixture-direct-key' }
}
const entryUrl = new URL('../index.js', import.meta.url).href
const credentialStub = `data:text/javascript,${encodeURIComponent(
  "export const unlockSealedLane = options => globalThis[Symbol.for('our-free-model.exo-catalog-test')](options)",
)}`
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === entryUrl && specifier === './src/vault.js') {
      return { url: credentialStub, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

let lane
let laneUser
let savedLaneFetch
let savedUserToken
try {
  const { apply, inject } = await import('../index.js')
  const { ROUTE_MAIN } = await import('../src/adapter.js')
  const { EAC_EXO_MODEL_ID } = await import('../src/catalog.js')
  ;({ lane, laneUser } = await import('../src/eac.js'))
  savedLaneFetch = lane.fetch
  savedUserToken = laneUser.token
  laneUser.token = null
  lane.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).origin, origin)
    workerRequests.push({ path: new URL(String(url)).pathname, headers: init.headers })
    return globalThis.fetch(url, init)
  }

  const hasExo = rows => rows.some(row => row.id === EAC_EXO_MODEL_ID)
  const cacheFile = home => path.join(home, 'our-free-model', 'catalog.json')
  const readCache = home => JSON.parse(fs.readFileSync(cacheFile(home), 'utf8'))
  async function boot({ home, profile = 'desktop', cache } = {}) {
    if (home === undefined) {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-exo-catalog-'))
      homes.push(home)
    }
    process.env.DSH_HOME = home
    if (cache !== undefined) {
      fs.mkdirSync(path.dirname(cacheFile(home)), { recursive: true })
      fs.writeFileSync(cacheFile(home), JSON.stringify(cache))
    }
    const ctx = fakeContext({
      inject,
      profileContext: profile === null ? undefined : { name: profile },
    })
    contexts.add(ctx)
    apply(ctx, { distribution: 'managed' })
    await until(() => ctx.__captured.serverRoutes.some(row => row.kind === 'prefix'), { timeoutMs: 5000 })
    const api = ctx.__captured.serverRoutes.find(row => row.kind === 'prefix').handler
    const catalog = async () => (await callRoute(api, 'GET', '/api/our-free-model/summary')).json.catalog
    return { ctx, home, catalog, refresh: () => ctx.__captured.discovery() }
  }
  async function stop(host) {
    for (const dispose of host.ctx.__disposers.slice().reverse()) await dispose()
    contexts.delete(host.ctx)
  }
  const cachedRoster = {
    version: 1, at: 1, entries: ['mimo-v2.6-flash-free'],
    exoListingIds: ['exo-free'], sealIds: [serverModel, EAC_EXO_MODEL_ID],
  }

  let host = await boot()
  await host.refresh()
  await test('worker host advertises the exact EAC identity and local transport', async () => {
    const rows = await host.catalog()
    const row = rows.find(row => row.id === EAC_EXO_MODEL_ID)
    assert.equal(row.name, 'EAC-claude opus 5.5')
    assert.equal(row.channel, 'eac')
    assert.equal(row.transport, 'exo-local')
    assert.equal(row.upstreamModel, 'exo-free')
    assert.equal(row.wire, 'chat')
    assert.equal(row.route, ROUTE_MAIN)
  })
  await test('discovery and the actual adapter picker advertise the EAC entry', async () => {
    assert.equal(hasExo(await host.refresh()), true)
    assert.equal(hasExo(await host.ctx.__captured.adapters[0].adapter.listModels(ROUTE_MAIN)), true)
  })
  await test('anonymous exo-free is absent and neither exo identity is probed', async () => {
    assert.equal((await host.catalog()).some(row => row.id === 'exo-free'), false)
    assert.equal(requests.some(row => row.method === 'POST'
      && ['exo-free', EAC_EXO_MODEL_ID].includes(row.model)), false)
  })
  await test('repeated refreshes keep one local entry and retain other channels', async () => {
    for (let round = 0; round < 3; round++) {
      await host.refresh()
      const rows = await host.catalog()
      assert.equal(rows.filter(row => row.id === EAC_EXO_MODEL_ID).length, 1)
      assert.equal(rows.some(row => row.id === serverModel), true)
      assert.equal(rows.some(row => row.id === kiloModel), true)
    }
  })
  await test('worker listings exercise the real signed lane transport', async () => {
    assert.ok(workerRequests.length > 0)
    assert.ok(workerRequests.every(row => row.path === '/eac/v1/models'
      && typeof row.headers['x-ofm-signature'] === 'string'
      && typeof row.headers['x-ofm-timestamp'] === 'string'))
  })
  await stop(host)
  await test('cache separates the listing observation from server sealIds', async () => {
    const cache = readCache(host.home)
    assert.deepEqual(cache.exoListingIds, ['exo-free'])
    assert.equal(cache.entries.includes('exo-free'), false)
    assert.deepEqual(cache.sealIds, [serverModel])
  })

  listingStatus = 503
  workerStatus = 503
  host = await boot({ home: host.home })
  await test('offline restart revives the real listing observation and EAC cache', async () => {
    assert.equal(hasExo(await host.catalog()), true)
    await host.refresh()
    const rows = await host.catalog()
    assert.equal(hasExo(rows), true)
    assert.equal(rows.some(row => row.id === serverModel), true)
    assert.deepEqual(readCache(host.home).exoListingIds, ['exo-free'])
  })
  listingStatus = 200
  workerStatus = 200
  for (const [name, payload] of [
    ['error envelope', { error: { message: 'temporary' } }],
    ['error envelope with empty data', { error: { message: 'temporary' }, data: [] }],
    ['malformed data', { data: {} }],
  ]) {
    await test(`${name} retains the observed local entry`, async () => {
      listing = payload
      await host.refresh()
      assert.equal(hasExo(await host.catalog()), true)
      assert.deepEqual(readCache(host.home).exoListingIds, ['exo-free'])
    })
  }
  await test('a successful listing that removes exo-free revokes the entry', async () => {
    listing = { data: [{ id: 'mimo-v2.6-flash-free' }] }
    assert.equal(hasExo(await host.refresh()), false)
    assert.equal(hasExo(await host.catalog()), false)
    assert.deepEqual(readCache(host.home).exoListingIds, [])
  })
  await test('exo-free can return after a previous successful removal', async () => {
    listing = { data: [{ id: 'exo-free' }, { id: 'mimo-v2.6-flash-free' }] }
    assert.equal(hasExo(await host.refresh()), true)
  })
  await test('a successful empty listing revokes the entry in all live views', async () => {
    listing = { data: [] }
    assert.equal(hasExo(await host.refresh()), false)
    assert.equal(hasExo(await host.catalog()), false)
    assert.equal(hasExo(await host.ctx.__captured.adapters[0].adapter.listModels(ROUTE_MAIN)), false)
  })
  await stop(host)
  listingStatus = 503
  host = await boot({ home: host.home })
  await test('offline restart after an empty listing cannot resurrect exo', async () => {
    assert.deepEqual(readCache(host.home).exoListingIds, [])
    assert.equal(hasExo(await host.catalog()), false)
    assert.equal(hasExo(await host.refresh()), false)
  })
  await stop(host)

  await test('legacy anonymous cache migrates only a genuinely observed exo-free', async () => {
    host = await boot({
      cache: { version: 1, at: 1, entries: ['exo-free'], sealIds: [serverModel, EAC_EXO_MODEL_ID] },
    })
    assert.equal(hasExo(await host.catalog()), true)
    assert.equal((await host.catalog()).some(row => row.id === 'exo-free'), false)
    await host.refresh()
    assert.equal(hasExo(await host.catalog()), true)
    await stop(host)
  })
  await test('a cold offline fallback never invents an exo listing observation', async () => {
    host = await boot()
    assert.equal(hasExo(await host.catalog()), false)
    assert.equal(hasExo(await host.refresh()), false)
    await stop(host)
  })

  listingStatus = 200
  listing = { data: [{ id: 'exo-free' }, { id: 'mimo-v2.6-flash-free' }] }
  await test('an unrecognized host hides the EAC entry without erasing its observation', async () => {
    host = await boot({ profile: null, cache: cachedRoster })
    assert.equal(hasExo(await host.catalog()), false)
    await host.refresh()
    assert.equal(hasExo(await host.catalog()), false)
    assert.equal((await host.catalog()).some(row => row.id === 'exo-free'), false)
    assert.deepEqual(readCache(host.home).exoListingIds, ['exo-free'])
    await stop(host)
  })
  await test('a direct seal hides local exo but retains ordinary EAC models', async () => {
    mode = 'direct'
    host = await boot({ cache: cachedRoster })
    assert.equal(hasExo(await host.catalog()), false)
    await host.refresh()
    const rows = await host.catalog()
    assert.equal(hasExo(rows), false)
    assert.equal(rows.some(row => row.id === 'exo-free'), false)
    assert.equal(rows.some(row => row.id === serverModel), true)
    await stop(host)
  })
  await test('refresh removes a previous local entry when the worker seal disappears', async () => {
    mode = 'worker'
    host = await boot({ cache: cachedRoster })
    await host.refresh()
    assert.equal(hasExo(await host.catalog()), true)
    mode = null
    await host.refresh()
    assert.equal(hasExo(await host.catalog()), false)
    await stop(host)
  })
  await test('the fixture made no external network attempts', async () => {
    assert.equal(externalAttempts, 0)
  })
} finally {
  for (const ctx of contexts) {
    for (const dispose of ctx.__disposers.slice().reverse()) await dispose()
  }
  hooks.deregister()
  if (lane !== undefined) lane.fetch = savedLaneFetch
  if (laneUser !== undefined) laneUser.token = savedUserToken
  globalThis.fetch = savedFetch
  if (savedFactory === undefined) delete globalThis[fixtureKey]
  else globalThis[fixtureKey] = savedFactory
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

console.log(`\nexo-catalog-test: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
