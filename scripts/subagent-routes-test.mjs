// Unit tests for src/subagent-routes.js 鈥?pure logic plus a configEditor
// stand-in. No runtime, no filesystem, no network.
import assert from 'node:assert/strict'
import { collectRegisteredRoutes, mergeRoutes, planSync, syncSubagentRoutes, createSubagentRouteSync } from '../src/subagent-routes.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}

console.log('collectRegisteredRoutes')

await test('reads every provider and flattens provider/model pairs', async () => {
  const llm = {
    listProviders: () => [{ id: 'cline' }, { id: 'buddy' }],
    listModels: async p => p === 'cline'
      ? [{ id: 'anthropic/claude-opus-5.5' }, { id: 'openai/gpt-6.1-sol' }]
      : [{ id: 'deepseek-v4.1-flash' }],
  }
  const { routes, providers, byProvider } = await collectRegisteredRoutes(llm)
  assert.equal(routes.length, 3)
  assert.deepEqual(providers, ['buddy', 'cline'])
  assert.equal(byProvider.get('cline'), 2)
  assert.equal(byProvider.get('buddy'), 1)
  assert.deepEqual(routes[0], { provider: 'buddy', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(routes[2], { provider: 'cline', model: 'openai/gpt-6.1-sol' })
})

await test('sorts deterministically so a re-run produces an identical diff', async () => {
  const llm = {
    listProviders: () => [{ id: 'b' }, { id: 'a' }],
    listModels: async p => p === 'b' ? [{ id: 'z' }, { id: 'a' }] : [{ id: 'm' }],
  }
  const first = await collectRegisteredRoutes(llm)
  const second = await collectRegisteredRoutes(llm)
  assert.deepEqual(first.routes, second.routes)
  assert.deepEqual(first.routes.map(r => r.provider), ['a', 'b', 'b'])
})

await test('a provider whose listing throws is skipped, not fatal', async () => {
  const llm = {
    listProviders: () => [{ id: 'good' }, { id: 'bad' }],
    listModels: async p => {
      if (p === 'bad') throw new Error('upstream 503')
      return [{ id: 'm1' }]
    },
  }
  const { routes, byProvider, failures } = await collectRegisteredRoutes(llm)
  assert.equal(routes.length, 1)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].provider, 'bad')
  assert.match(failures[0].message, /503/)
  assert.equal(byProvider.has('bad'), false, 'a failed provider must not be recorded as present')
})

await test('malformed entries and duplicate ids are ignored', async () => {
  const llm = {
    listProviders: () => [{ id: 'p' }, { id: '' }, { id: 42 }, undefined],
    listModels: async () => [{ id: 'ok' }, { id: '' }, { id: 'ok' }, null, { id: 7 }],
  }
  const { routes, providers } = await collectRegisteredRoutes(llm)
  assert.deepEqual(routes, [{ provider: 'p', model: 'ok' }])
  assert.deepEqual(providers, ['p'])
})

await test('a provider that advertises nothing is still recorded', async () => {
  const llm = { listProviders: () => [{ id: 'empty' }], listModels: async () => [] }
  const { routes, byProvider } = await collectRegisteredRoutes(llm)
  assert.equal(routes.length, 0)
  assert.equal(byProvider.get('empty'), 0)
})

await test('a runtime without listProviders degrades to empty', async () => {
  assert.deepEqual((await collectRegisteredRoutes(undefined)).routes, [])
  assert.deepEqual((await collectRegisteredRoutes({})).routes, [])
})

console.log('\nmergeRoutes')

await test('additive: existing routes survive and keep their order', async () => {
  const current = [{ provider: 'ss', model: 'kimi-k3' }]
  const registered = { routes: [{ provider: 'ss', model: 'kimi-k3' }, { provider: 'cline', model: 'x' }] }
  const { routes, added } = await mergeRoutes(registered, current)
  assert.equal(added, 1)
  assert.deepEqual(routes, [
    { provider: 'ss', model: 'kimi-k3' },
    { provider: 'cline', model: 'x' },
  ])
})

await test('idempotent: a second sync adds nothing', async () => {
  const registered = { routes: [{ provider: 'a', model: '1' }, { provider: 'b', model: '2' }] }
  const once = await mergeRoutes(registered, [])
  const twice = await mergeRoutes(registered, once.routes)
  assert.equal(twice.added, 0)
  assert.deepEqual(twice.routes, once.routes)
})

await test('keeps hand-written entries the runtime no longer advertises', async () => {
  const current = [{ provider: 'gone', model: 'retired' }]
  const registered = { routes: [{ provider: 'a', model: '1' }] }
  const { routes } = await mergeRoutes(registered, current)
  assert.deepEqual(routes[0], { provider: 'gone', model: 'retired' })
})

await test('drops malformed entries rather than propagating them', async () => {
  const current = [{ provider: 'ok', model: 'm' }, { provider: '' }, { model: 'x' }, null, 'nope']
  const { added } = await mergeRoutes({ routes: [{ provider: 'ok', model: 'm' }] }, current)
  assert.equal(added, 0, 'the well-formed entry already exists, so nothing is added')
})

await test('treats current=undefined as a fresh allowlist', async () => {
  const { routes, added } = await mergeRoutes({ routes: [{ provider: 'a', model: '1' }] })
  assert.equal(added, 1)
  assert.equal(routes.length, 1)
})

console.log('\nplanSync')

await test('reports additions, absent providers and stale routes', async () => {
  const registered = {
    routes: [{ provider: 'cline', model: 'x' }, { provider: 'new', model: 'y' }],
    providers: ['cline', 'new'],
    byProvider: new Map([['cline', 1], ['new', 1]]),
  }
  const current = [{ provider: 'cline', model: 'x' }, { provider: 'dead', model: 'z' }]
  const plan = planSync(registered, current)
  assert.equal(plan.additions, 1)
  assert.equal(plan.stale, 1)
  assert.deepEqual(plan.absentProviders, ['new'])
  assert.equal(plan.current, 2)
  assert.equal(plan.registered, 2)
})

console.log('\nsyncSubagentRoutes')

/** A configEditor stand-in that records the change callback's output. */
function fakeEditor({ override = {}, inherited = {}, rowId = 'subagent-model-selection-settings' } = {}) {
  const entry = { options: { id: rowId } }
  const calls = []
  return {
    entry,
    calls,
    entries: () => [entry],
    configuration: () => [{ entry, inherited, override }],
    async edit(e, change) {
      const written = change({ ...override }, { ...inherited })
      calls.push(written)
      override.allowedModels = written.allowedModels
      override.enabled = written.enabled
    },
  }
}

await test('writes the merged allowlist and returns a summary', async () => {
  const editor = fakeEditor({ override: { enabled: true, allowedModels: [{ provider: 'ss', model: 'a' }] } })
  const result = await syncSubagentRoutes(editor, {
    routes: [{ provider: 'ss', model: 'a' }, { provider: 'cline', model: 'x' }],
    providers: ['cline', 'ss'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.added, 1)
  assert.equal(result.total, 2)
  assert.equal(editor.calls.length, 1)
  assert.equal(editor.calls[0].allowedModels.length, 2)
})

await test('never flips the user decision on `enabled`', async () => {
  const off = fakeEditor({ override: { enabled: false, allowedModels: [] } })
  await syncSubagentRoutes(off, { routes: [{ provider: 'a', model: '1' }], providers: ['a'] })
  assert.equal(off.calls[0].enabled, false)

  const inherited = fakeEditor({ override: {}, inherited: { enabled: true, allowedModels: [] } })
  await syncSubagentRoutes(inherited, { routes: [{ provider: 'a', model: '1' }], providers: ['a'] })
  assert.equal(inherited.calls[0].enabled, true, 'inherits when the override never set it')
})

await test('preserves every other field of the live config', async () => {
  const editor = fakeEditor({ override: { enabled: true, someFutureField: 7 } })
  await syncSubagentRoutes(editor, { routes: [{ provider: 'a', model: '1' }], providers: ['a'] })
  assert.equal(editor.calls[0].someFutureField, 7)
})

await test('falls back to inherited routes when nothing is registered', async () => {
  const editor = fakeEditor({
    override: { enabled: true, allowedModels: [] },
    inherited: { enabled: true, allowedModels: [{ provider: 'keep', model: 'me' }] },
  })
  const result = await syncSubagentRoutes(editor, { routes: [], providers: [] })
  assert.equal(result.ok, true)
  assert.deepEqual(editor.calls[0].allowedModels, [{ provider: 'keep', model: 'me' }])
})

await test('reports a missing composition instead of throwing', async () => {
  const result = await syncSubagentRoutes(undefined, { routes: [], providers: [] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'config-editor-unavailable')
})

await test('reports a row the profile does not patch', async () => {
  const result = await syncSubagentRoutes(fakeEditor({ rowId: 'other' }), { routes: [], providers: [] })
  assert.equal(result.ok, false)
  assert.match(result.reason, /row-not-found/)
})

await test('surfaces an edit failure with its message', async () => {
  const entry = { options: { id: 'subagent-model-selection-settings' } }
  const editor = {
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: {} }],
    async edit() { throw new Error('profile is read-only') },
  }
  const result = await syncSubagentRoutes(editor, { routes: [{ provider: 'a', model: '1' }], providers: ['a'] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'profile is read-only')
})

console.log('\ncreateSubagentRouteSync')

await test('inspect plans without writing', async () => {
  const editor = fakeEditor({ override: { enabled: true, allowedModels: [] } })
  const llm = { listProviders: () => [{ id: 'cline' }], listModels: async () => [{ id: 'x' }] }
  const sync = createSubagentRouteSync({ llm, configEditor: editor })
  const plan = await sync.inspect()
  assert.equal(plan.registered, 1)
  assert.equal(plan.additions, 1)
  assert.equal(editor.calls.length, 0, 'inspect must not write')
})

await test('sync applies the plan', async () => {
  const editor = fakeEditor({ override: { enabled: true, allowedModels: [] } })
  const llm = { listProviders: () => [{ id: 'cline' }], listModels: async () => [{ id: 'x' }] }
  const sync = createSubagentRouteSync({ llm, configEditor: editor })
  const result = await sync.sync()
  assert.equal(result.ok, true)
  assert.equal(editor.calls.length, 1)
})

await test('without an editor, inspect still works and sync degrades', async () => {
  const llm = { listProviders: () => [{ id: 'cline' }], listModels: async () => [{ id: 'x' }] }
  const sync = createSubagentRouteSync({ llm })

  // The current allowlist is unknown without an editor, so every live route
  // reads as an addition. That is the honest answer: it is what a sync would
  // have to write, not a count of what is missing from the user's config.
  const plan = await sync.inspect()
  assert.equal(plan.registered, 1)
  assert.equal(plan.additions, 1)
  assert.deepEqual(plan.absentProviders, ['cline'])

  const result = await sync.sync()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'config-editor-unavailable')
})

await test('bind attaches a late editor and makes sync work', async () => {
  const editor = fakeEditor({ override: { enabled: true, allowedModels: [] } })
  const llm = { listProviders: () => [{ id: 'cline' }], listModels: async () => [{ id: 'x' }] }
  const sync = createSubagentRouteSync({ llm })

  assert.equal(sync.bind(undefined), false, 'a missing editor is refused')
  assert.equal((await sync.sync()).ok, false, 'still unavailable before binding')

  assert.equal(sync.bind(editor), true)
  const result = await sync.sync()
  assert.equal(result.ok, true)
  assert.equal(editor.calls.length, 1)
  assert.equal(editor.calls[0].allowedModels.length, 1)
})

await test('bind is idempotent and re-binding replaces the editor', async () => {
  const first = fakeEditor()
  const second = fakeEditor()
  const sync = createSubagentRouteSync({})
  assert.equal(sync.bind(first), true)
  assert.equal(sync.bind(first), true)
  assert.equal(sync.bind(second), true)
  const llm = { listProviders: () => [{ id: 'p' }], listModels: async () => [{ id: 'm' }] }
  const rebound = createSubagentRouteSync({ llm })
  rebound.bind(first)
  rebound.bind(second)
  await rebound.sync()
  assert.equal(second.calls.length, 1, 'the newest editor is the one written')
  assert.equal(first.calls.length, 0)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
