/**
 * #589: catalog readiness must not wait for a full availability round.
 *
 * The gateway answers the listing immediately and holds every model probe.
 * Boot must publish a topology update and `discoverModels()` must return in
 * that window; releasing the probes must publish one later update with the
 * verdicts. The same file also checks failed listings keep the cached roster,
 * concurrent discovery does not multiply requests/events, and a disposed
 * generation cannot publish a late topology update after a hot reload.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chatFrames, fakeContext, stubUpstream, until } from './lib/fake-kernel.mjs'

const LISTING = ['mimo-v2.6-flash-free', 'space-bunny-free']
let activeGate
const stub = await stubUpstream({
  listing: LISTING,
  answer: () => activeGate === undefined
    ? { body: chatFrames() }
    : { wait: activeGate.promise, body: chatFrames() },
})
process.env.OUR_FREE_MODEL_BASE = stub.base
const originalHome = process.env.DSH_HOME
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-catalog-readiness-'))
const { apply, inject } = await import('../index.js')
const contexts = []
const disposedContexts = new WeakSet()

const topologyCount = ctx => ctx.__captured.events
  .filter(event => event === 'emit:llm/adapters-updated').length
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function within(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs} ms`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function boot(name) {
  const home = path.join(scratch, name)
  fs.mkdirSync(path.join(home, 'our-free-model'), { recursive: true })
  fs.writeFileSync(path.join(home, 'our-free-model', 'settings.json'), JSON.stringify({
    version: 1,
    enabled: true,
    combos: [],
    probeIntervalMinutes: 1440,
  }))
  process.env.DSH_HOME = home
  const ctx = fakeContext({ inject, mounted: ['llm'] })
  apply(ctx, { distribution: 'managed' })
  contexts.push(ctx)
  return ctx
}

function disposeContext(ctx) {
  if (disposedContexts.has(ctx)) return
  disposedContexts.add(ctx)
  for (const dispose of ctx.__disposers.splice(0).reverse()) {
    try { dispose() } catch { /* teardown must not mask the assertion */ }
  }
}

const discoveredIds = models => models.map(model => model.id)
let gate
try {
  gate = Promise.withResolvers()
  activeGate = gate
  const ctx = boot('boot')

  await until(() => topologyCount(ctx) >= 1, { timeoutMs: 3000, what: 'early catalog topology' })
  assert.equal(topologyCount(ctx), 1, 'the merged catalog publishes exactly one early topology update')
  assert.deepEqual(ctx.__captured.adapters[0].adapter.deps.state().catalog.map(row => row.id), LISTING)
  await until(() => stub.requests.length >= LISTING.length, { what: 'the held probe round to start' })

  const discovered = await within(ctx.__captured.discovery(), 1000, 'discoverModels while probes are held')
  assert.deepEqual(discoveredIds(discovered).sort(), [...LISTING].sort(),
    'discovery returns the merged directory while its probe is still in flight')
  assert.equal(topologyCount(ctx), 2, 'the discovery catalog phase publishes one topology update of its own')

  gate.resolve()
  await until(() => topologyCount(ctx) >= 3, { timeoutMs: 3000, what: 'late availability topology' })
  await until(() => {
    const saved = JSON.parse(fs.readFileSync(path.join(scratch, 'boot', 'our-free-model', 'availability.json'), 'utf8'))
    return LISTING.every(id => saved.results?.[id]?.state === 'available')
  }, { timeoutMs: 3000, what: 'the background verdicts to persist' })
  assert.equal(topologyCount(ctx), 3, 'a completed probe publishes one late topology update')
  for (const id of LISTING) {
    assert.equal(stub.requests.filter(row => row.body?.model === id).length, 1,
      `boot and discovery share one probe request for ${id}`)
  }

  const beforeFailure = stub.api.listingCalls
  stub.api.failListing = true
  const failedListingModels = await within(ctx.__captured.discovery(), 1000, 'discovery with a failed listing')
  assert.deepEqual(discoveredIds(failedListingModels).sort(), [...LISTING].sort(),
    'a failed listing keeps the cached catalog instead of emptying it')
  assert.equal(stub.api.listingCalls, beforeFailure + 1)
  assert.ok(ctx.__logs.some(line => line.includes('model listing refresh failed')), 'the failed listing is logged')
  await until(() => topologyCount(ctx) >= 4, { timeoutMs: 3000, what: 'the failed-listing catalog phase' })
  await until(() => topologyCount(ctx) >= 5, { timeoutMs: 3000, what: 'the failed-listing probe to finish' })
  stub.api.failListing = false

  activeGate = Promise.withResolvers()
  const repeatedGate = activeGate
  const beforeEvents = topologyCount(ctx)
  const beforeListings = stub.api.listingCalls
  const beforeRequests = stub.requests.length
  const simultaneous = await within(
    Promise.all(Array.from({ length: 6 }, () => ctx.__captured.discovery())),
    1000,
    'six simultaneous discoveries',
  )
  assert.equal(simultaneous.length, 6)
  assert.ok(simultaneous.every(rows => discoveredIds(rows).length === LISTING.length))
  assert.equal(stub.api.listingCalls, beforeListings + 1, 'simultaneous discoveries share one listing request')
  assert.equal(topologyCount(ctx), beforeEvents + 1, 'their shared catalog phase emits one topology update')
  await until(() => stub.requests.length >= beforeRequests + LISTING.length,
    { what: 'one shared probe request per model' })
  assert.equal(stub.requests.length, beforeRequests + LISTING.length,
    'six discoveries join one probe round instead of starting six')
  repeatedGate.resolve()
  await until(() => topologyCount(ctx) >= beforeEvents + 2, { timeoutMs: 3000, what: 'the shared probe topology' })
  await sleep(75)
  assert.equal(topologyCount(ctx), beforeEvents + 2, 'the completed probe emits once')
  assert.equal(stub.requests.length, beforeRequests + LISTING.length, 'the completed probe sends no duplicate requests')

  const oldGate = Promise.withResolvers()
  activeGate = oldGate
  const beforeOldProbe = stub.requests.length
  await ctx.__captured.discovery()
  await until(() => stub.requests.length >= beforeOldProbe + LISTING.length,
    { what: 'the old generation probe to start' })
  const oldEvents = topologyCount(ctx)
  disposeContext(ctx)

  const newGate = Promise.withResolvers()
  activeGate = newGate
  const beforeNewProbe = stub.requests.length
  const reloaded = boot('reloaded')
  await until(() => topologyCount(reloaded) >= 1, { timeoutMs: 3000, what: 'reloaded catalog topology' })
  assert.equal(topologyCount(reloaded), 1)
  await until(() => stub.requests.length >= beforeNewProbe + LISTING.length,
    { timeoutMs: 3000, what: 'the reloaded generation probe to start' })
  oldGate.resolve()
  await sleep(100)
  assert.equal(topologyCount(ctx), oldEvents, 'the disposed generation cannot publish a late topology update')
  assert.equal(topologyCount(reloaded), 1, 'the reloaded generation is still waiting for its probe')
  newGate.resolve()
  await until(() => topologyCount(reloaded) >= 2, { timeoutMs: 3000, what: 'the reloaded probe topology' })
  await sleep(75)
  assert.equal(topologyCount(reloaded), 2, 'reload leaves exactly one early and one late topology update')
  assert.equal(stub.requests.length, beforeNewProbe + LISTING.length,
    'reload neither retries nor multiplies the new probe round')

  console.log('catalog readiness: early topology/discovery, late verdicts, cached failure, coalescing and reload passed')
} finally {
  activeGate?.resolve?.()
  gate?.resolve?.()
  for (const ctx of contexts.reverse()) disposeContext(ctx)
  await stub.close()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  const target = fs.realpathSync(scratch)
  assert.ok(target.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(target, { recursive: true, force: true })
}
