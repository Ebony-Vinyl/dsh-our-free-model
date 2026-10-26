/**
 * Reject inflated kilo-auto/free usage without changing other lanes' accounting.
 *
 * Run: node scripts/usage-sanitize-test.mjs
 */
import assert from 'node:assert/strict'

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const window = 256_000

// Exercise final Adapter events, not just the pure sanitizer. Every lane is
// pinned to this loopback server before the Adapter imports its transports.
const { default: http } = await import('node:http')
const sse = value => `data: ${JSON.stringify(value)}\n\n`
const inflated = {
  prompt_tokens: 618_820, completion_tokens: 717,
  prompt_tokens_details: { cached_tokens: 62_713 },
  completion_tokens_details: { reasoning_tokens: 637 },
}
const honest = {
  prompt_tokens: 37_007, completion_tokens: 191,
  prompt_tokens_details: { cached_tokens: 36_627 },
}
function answer(usage, { reasoning = false, finish = 'stop', error = false } = {}) {
  return (usage ? sse({ choices: [], usage }) : '')
    + sse({ choices: [{ index: 0, delta: reasoning ? { reasoning: 'checkpoint' } : { content: 'answer' } }] })
    + (error ? sse({ error: { message: 'scripted upstream failure', type: 'server_error' } }) : '')
    + (finish === null || error ? '' : sse({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }))
    + 'data: [DONE]\n\n'
}
let responses = []
let requests = 0
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    requests++
    const body = responses.shift()
    res.writeHead(body === undefined ? 500 : 200, { 'content-type': 'text/event-stream' })
    res.end(body ?? 'unexpected request')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
process.env.OUR_FREE_MODEL_BASE = base
process.env.OUR_FREE_MODEL_KILO_BASE = base
const { mapUsage, sanitizeUsage } = await import('../src/stream.js')

// Honest short turn stays intact.
{
  const mapped = mapUsage({
    prompt_tokens: 37_007,
    completion_tokens: 191,
    prompt_tokens_details: { cached_tokens: 36_627 },
  })
  const trusted = sanitizeUsage(mapped, window)
  check(
    'honest usage under the window is unchanged',
    trusted === mapped
      && trusted.inputTokens === 380
      && trusted.cacheReadTokens === 36_627
      && trusted.totalTokens === 37_198,
    JSON.stringify(trusted),
  )
}

// Observed kilo-auto/free stamp after two read_image results (~619k > 256k).
{
  const mapped = mapUsage({
    prompt_tokens: 618_820,
    completion_tokens: 717,
    prompt_tokens_details: { cached_tokens: 62_713 },
    completion_tokens_details: { reasoning_tokens: 637 },
  })
  assert.equal(mapped.totalTokens, 619_537)
  const trusted = sanitizeUsage(mapped, window)
  check(
    'inflated multimodal total drops prompt pressure (keeps output/reasoning)',
    trusted !== undefined
      && trusted.inputTokens === 0
      && !('cacheReadTokens' in trusted)
      && !('totalTokens' in trusted)
      && trusted.outputTokens === 717
      && trusted.reasoningTokens === 637,
    JSON.stringify(trusted),
  )
}

check(
  'missing / non-positive window is a no-op',
  sanitizeUsage({ inputTokens: 9, outputTokens: 1, totalTokens: 10 }, 0)?.totalTokens === 10
    && sanitizeUsage({ inputTokens: 9, outputTokens: 1, totalTokens: 10 }, undefined)?.totalTokens === 10,
)

check(
  'output-only inflated sample with zero output collapses to undefined',
  sanitizeUsage({ inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 }, window) === undefined,
)

const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')
const { buildCatalog, buildKiloCatalog } = await import('../src/catalog.js')
const { buildAggregateCatalog } = await import('../src/aggregate.js')
const kiloEntries = buildKiloCatalog([
  { id: 'kilo-auto/free', isFree: true, context_length: window },
  { id: 'openrouter/free', isFree: true, context_length: window },
])
const freeEntry = { ...buildCatalog(['mimo-v2.6-flash-free'])[0], contextWindow: window }
const sealedEntry = { ...freeEntry, id: 'eac:fixture', channel: 'eac', wire: 'chat' }
const aggregate = { providers: { cerebras: { enabled: true, apiKey: 'fixture', baseUrl: base, models: ['fixture-large'] } } }
const aggregateEntry = buildAggregateCatalog(aggregate)[0]
assert.ok(aggregateEntry, 'aggregate fixture must resolve a real configured catalog entry')

async function drive(entry, bodies, { abort = false } = {}) {
  responses = [...bodies]
  requests = 0
  const records = []
  const controller = new AbortController()
  const adapter = new FreeModelAdapter({
    state: () => ({ catalog: [entry], membership: { [ROUTE_MAIN]: [entry.id] }, settings: { enabled: true, aggregate } }),
    recordUsage: row => records.push(row), recordTurn: () => {},
    sealedCredential: () => ({ mode: 'direct', base, apiKey: 'fixture' }),
  })
  const timeout = setTimeout(() => controller.abort(new Error('fixture timeout')), 3000)
  const chunks = []
  try {
    for await (const chunk of adapter.stream({ provider: ROUTE_MAIN, model: entry.id,
      maxTokens: 4096, messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }], signal: controller.signal })) {
      chunks.push(chunk)
      if (abort && chunk.type === 'text-delta') controller.abort()
    }
  } finally { clearTimeout(timeout) }
  assert.equal(responses.length, 0, 'all scripted attempts must be requested')
  const usages = chunks.filter(chunk => chunk.type === 'usage')
  assert.equal(usages.length, 1, 'exactly one final usage event')
  const finishes = chunks.filter(chunk => chunk.type === 'finish')
  assert.equal(finishes.length, 1, 'exactly one finish event')
  return { usage: usages[0].usage, finish: finishes[0].reason, records, requests }
}
function partial(usage, output, reasoning) {
  assert.equal(usage.inputTokens, 0)
  assert.equal(usage.outputTokens, output)
  assert.equal(usage.reasoningTokens, reasoning)
  for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    assert.equal(key in usage, false, `${key} must not claim exact input accounting`)
  }
}
async function test(name, run) {
  try { await run(); check(name, true) }
  catch (error) { check(name, false, error.stack) }
}
try {
  for (const [name, options, kind] of [
    ['normal finish', {}, 'stop'],
    ['early EOF', { finish: null }, 'error'],
    ['SSE failure', { error: true }, 'error'],
    ['caller abort', {}, 'aborted'],
  ]) {
    await test(`final sanitized event: ${name}`, async () => {
      const run = await drive(kiloEntries[0], [answer(inflated, options)], { abort: kind === 'aborted' })
      assert.equal(run.finish.kind, kind)
      partial(run.usage, 717, 637)
      assert.equal(run.records[0].input, 0)
      assert.equal(run.records[0].output, 717)
    })
  }
  await test('zero-output rejected sample does not emit an exact zero total', async () => {
    const run = await drive(kiloEntries[0], [answer({ prompt_tokens: 500_000, completion_tokens: 0 })])
    partial(run.usage, 0, undefined)
    assert.equal(run.records[0].noUsage, true)
  })
  for (const [name, first, second] of [
    ['rejected then honest', inflated, honest],
    ['honest then rejected', honest, inflated],
    ['both rejected', inflated, inflated],
  ]) {
    await test(`continuation keeps input untrusted: ${name}`, async () => {
      const run = await drive(kiloEntries[0], [answer(first, { reasoning: true, finish: null }), answer(second)])
      assert.equal(run.requests, 2)
      assert.equal(run.finish.kind, 'stop')
      partial(run.usage, first.completion_tokens + second.completion_tokens,
        (first.completion_tokens_details?.reasoning_tokens ?? 0) + (second.completion_tokens_details?.reasoning_tokens ?? 0))
    })
  }
  await test('failed continuation does not restore rejected input totals', async () => {
    const run = await drive(kiloEntries[0], [answer(inflated, { reasoning: true, finish: null }), answer(honest, { error: true })])
    assert.equal(run.requests, 2)
    assert.equal(run.finish.kind, 'error')
    partial(run.usage, 908, 637)
  })
  await test('honest target usage is unchanged end to end', async () => {
    const run = await drive(kiloEntries[0], [answer(honest)])
    assert.deepEqual(run.usage, mapUsage(honest))
  })
  await test('honest continuation retains exact aggregate totals', async () => {
    const run = await drive(kiloEntries[0], [answer(honest, { reasoning: true, finish: null }), answer(honest)])
    const expected = Object.fromEntries(Object.entries(mapUsage(honest)).map(([key, value]) => [key, value * 2]))
    assert.deepEqual(run.usage, expected)
  })
  for (const [name, entry] of [
    ['other Kilo model', kiloEntries[1]], ['free lane', freeEntry],
    ['EAC lane', sealedEntry], ['aggregate lane', aggregateEntry],
  ]) {
    for (const error of [false, true]) {
      await test(`non-target usage preserved: ${name}, ${error ? 'failure' : 'success'}`, async () => {
        const run = await drive(entry, [answer(inflated, { error })])
        assert.equal(run.finish.kind, error ? 'error' : 'stop')
        assert.deepEqual(run.usage, mapUsage(inflated))
        assert.equal(run.records[0].input, mapUsage(inflated).inputTokens)
      })
    }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }

console.log(failed === 0
  ? '\nusage-sanitize: unit and Adapter integration checks passed'
  : `
usage-sanitize: ${failed} failure(s)`)
process.exitCode = failed === 0 ? 0 : 1
