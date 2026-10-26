/**
 * Real-machine verification of the aggregated feature set.
 *
 * Every other suite in this repository runs offline against a stub. That is the
 * right default — it is fast, deterministic and costs no quota — but it cannot
 * answer the one question a user actually has about a feature that talks to the
 * network: does it work against the real gateway, with a real model, on a real
 * turn? A stub agrees with whatever the code already believes.
 *
 * So this harness spends real quota, on purpose and in a bounded way: one boot,
 * a handful of short turns, and a printed record of what came back. It verifies
 * the pieces that only exist on the wire —
 *
 *   - the merged roster the gateway advertises,
 *   - the OpenAI surface answering a real question,
 *   - the Anthropic surface (`/v1/messages`) answering the same question in
 *     Anthropic's own event vocabulary, streaming and not,
 *   - `count_tokens` answering locally,
 *   - the five local answers short-circuiting before any upstream call,
 *   - the token savers compacting a real tool result on a real turn and the
 *     savings being counted,
 *   - a combo walking past a refusing link to a real answer,
 *   - a two-turn conversation, which is what proves history replay works.
 *
 * Run: node scripts/live-feature-verify.mjs
 *      node scripts/live-feature-verify.mjs --model <id>   # pin the model
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
// `scripts/lib/fake-kernel.mjs` defaults both keyless bases to a closed loopback
// port, which is exactly right for every offline suite and exactly wrong here.
// A live run has to name the real endpoints before the plugin is imported,
// because `src/upstream.js` reads its base once at import time.
process.env.OUR_FREE_MODEL_BASE = process.env.OUR_FREE_MODEL_BASE ?? 'https://opencode.ai'
process.env.OUR_FREE_MODEL_KILO_BASE = process.env.OUR_FREE_MODEL_KILO_BASE ?? 'https://api.kilo.ai/api/gateway'

// Imported dynamically, not statically: ESM hoists every `import` above the
// statements in this file, so a static import would let the helper run — and
// install its closed-loopback default — before the two assignments above.
const { callRoute, fakeContext, freePort, until } = await import('./lib/fake-kernel.mjs')

const argv = process.argv.slice(2)
const pinnedModel = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : ''

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const checkThat = (name, condition, detail = '') => {
  if (!condition) failures++
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${condition ? '' : ` — ${detail}`}`)
}

/** A ~40 KB `git diff`, the shape the token saver exists for. */
const BIG_DIFF = [
  'diff --git a/src/parser.js b/src/parser.js',
  'index aaaaaaa..bbbbbbb 100644',
  '--- a/src/parser.js',
  '+++ b/src/parser.js',
  '@@ -1,200 +1,200 @@',
  ...Array.from({ length: 400 }, (_, i) => `-const old${i} = parse(${i})`),
  ...Array.from({ length: 400 }, (_, i) => `+const fresh${i} = parse(${i}, { strict: true })`),
  '',
].join('\n')

// ── a refusing aggregate provider, so the chain has something real to walk past
const refusingRequests = []
const refusingServer = http.createServer((req, res) => {
  const chunks = []
  req.on('data', row => chunks.push(row))
  req.on('end', () => {
    refusingRequests.push(String(req.url ?? ''))
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }))
  })
})
await new Promise(resolve => refusingServer.listen(0, '127.0.0.1', resolve))
refusingServer.unref()
const refusingBase = `http://127.0.0.1:${refusingServer.address().port}`

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-live-'))
process.env.DSH_HOME = home
const forwardPort = await freePort()
const dataDir = path.join(home, 'our-free-model')
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  enabled: true,
  probeIntervalMinutes: 0,
  forward: { enabled: true, host: '127.0.0.1', port: forwardPort, lan: { enabled: false, port: 0 } },
  tokenSaver: { enabled: true, rtk: true, prompts: { caveman: 'off', ponytail: 'off' } },
  aggregate: {
    enabled: true,
    providers: { open_router: { enabled: true, apiKey: 'sk-or-v1-live-verify', baseUrl: refusingBase, models: ['live-verify-model'], addedAt: Date.now() } },
  },
  // The chain is written after the boot roster is known (a chain link has to be a
  // real model id), so it is patched in below rather than guessed here.
  combos: [],
}))

const { apply, inject } = await import('../index.js')
const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'timer', 'connection', 'attachments'], onRegister: route => routes.push(route) })
apply(ctx, {})
const api = () => routes.find(route => route.kind === 'prefix')?.handler
await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
const get = url => callRoute(api(), 'GET', `/api/our-free-model${url}`)
const post = (url, body) => callRoute(api(), 'POST', `/api/our-free-model${url}`, body)
const summary = () => get('/summary')

console.log('\n=== 1. boot against the live gateway ===')
await until(async () => {
  const body = (await summary()).json
  return (body?.catalog?.filter(entry => !entry.channel).length ?? 0) > 0 && body?.settings?.forward?.running === true
}, { what: 'the live roster and the forward listener', timeoutMs: 180000 })
const boot = (await summary()).json
const named = boot.catalog.filter(entry => !entry.channel).map(entry => entry.id)
checkThat('the live gateway named models', named.length >= 5, `${named.length} models: ${named.slice(0, 6).join(', ')}`)
check('the aggregate row is merged in', boot.catalog.some(entry => entry.id === 'open_router/live-verify-model'), true)

// The routable set is what the gateway advertises *after* the probe round, which
// is the only list a user can actually dial. A model the listing named and the
// probe then refused is deliberately not dialable, and asking for one would test
// the 404 path instead of the feature.
const advertised = () => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: boot.settings.forward.actualPort, path: '/v1/models', headers: { authorization: `Bearer ${boot.settings.forward.key ?? ''}` } }, res => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { text += chunk })
    res.on('end', () => { try { resolve(JSON.parse(text).data.map(row => row.id)) } catch (error) { resolve([]) } })
  }).on('error', reject)
})
// The key is fetched through the API, not read off the summary (the summary masks
// it), so the roster probe runs after the key is in hand.
const forwardKey = (await get('/forward/key')).json.key
const advertisedWith = async () => {
  const ids = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: boot.settings.forward.actualPort, path: '/v1/models', headers: { authorization: `Bearer ${forwardKey}` } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => { try { resolve(JSON.parse(text).data.map(row => row.id)) } catch { resolve([]) } })
    }).on('error', reject)
  })
  return ids
}
let routable = []
await until(async () => { routable = await advertisedWith(); return routable.length > 0 }, { what: 'the advertised roster', timeoutMs: 60000 })
const prefer = /flash|lightning|mini|small|lite/
const model = pinnedModel !== '' && routable.includes(pinnedModel) ? pinnedModel
  : (routable.find(id => prefer.test(id)) ?? routable[0])
checkThat('the advertised roster is dialable', routable.includes(model), `${routable.length} advertised: ${routable.slice(0, 6).join(', ')}`)
console.log(`     using model: ${model} (of ${routable.length} advertised)`)

// A chain whose first link refuses and whose second link is a live free model.
const combo = await post('/combos', { combos: [{ name: 'Live Failover', models: ['open_router/live-verify-model', model], strategy: 'fallback' }] })
check('a live chain can be configured', combo.json.combos?.[0]?.id, 'combo:live-failover')
checkThat('and it resolves to at least one live model', combo.json.usable?.length === 1, JSON.stringify(combo.json.usable))

const boundPort = boot.settings.forward.actualPort
const key = (await get('/forward/key')).json.key
const base = `http://127.0.0.1:${boundPort}`
console.log(`     forward listener: ${base}`)

/** One HTTP request against the listener; returns status, raw text and parsed JSON. */
const request = (pathname, body, extra = {}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body)
  const req = http.request({
    host: '127.0.0.1', port: boundPort, path: pathname, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, host: `127.0.0.1:${boundPort}`, ...extra },
  }, res => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { text += chunk })
    res.on('end', () => {
      let json
      try { json = JSON.parse(text) } catch { json = undefined }
      resolve({ status: res.statusCode, text, json })
    })
  })
  req.on('error', reject)
  req.end(payload)
})

/** A 429 is the lane's quota wall, not a defect; retry once after a pause. */
const retrying = async (label, run) => {
  const first = await run()
  if (first.status !== 429) return first
  console.log(`     ${label}: the lane answered 429; retrying once in 20s`)
  await new Promise(resolve => setTimeout(resolve, 20000))
  return run()
}

console.log('\n=== 2. the OpenAI surface, live ===')
{
  const streamed = await retrying('chat stream', () => request('/v1/chat/completions', {
    model, stream: true, max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly the word: verified' }],
  }))
  check('a streamed live turn answers 200', streamed.status, 200)
  const text = [...streamed.text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map(match => JSON.parse(`"${match[1]}"`)).join('')
  checkThat('and carries real model output', text.trim().length > 0, streamed.text.slice(0, 300))
  checkThat('and terminates with [DONE]', streamed.text.includes('[DONE]'), streamed.text.slice(-200))
  console.log(`     answer: ${JSON.stringify(text.trim().slice(0, 120))}`)

  const plain = await retrying('chat json', () => request('/v1/chat/completions', {
    model, max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly the word: verified' }],
  }))
  check('a non-streamed live turn answers 200', plain.status, 200)
  const content = plain.json?.choices?.[0]?.message?.content ?? ''
  checkThat('and carries real model output', content.trim().length > 0, JSON.stringify(plain.json).slice(0, 300))
  console.log(`     answer: ${JSON.stringify(content.trim().slice(0, 120))}`)
}

console.log('\n=== 3. the Anthropic surface, live ===')
{
  const streamed = await retrying('messages stream', () => request('/v1/messages', {
    model, stream: true, max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly the word: verified' }] }],
  }))
  check('a streamed live Messages turn answers 200', streamed.status, 200)
  checkThat('it opens with message_start', streamed.text.includes('event: message_start'), streamed.text.slice(0, 200))
  checkThat('it emits content_block_delta', streamed.text.includes('content_block_delta'), streamed.text.slice(0, 400))
  checkThat('it closes with message_stop', streamed.text.includes('event: message_stop'), streamed.text.slice(-200))
  checkThat('and reports a stop_reason', streamed.text.includes('"stop_reason"'), streamed.text.slice(-400))
  const events = [...streamed.text.matchAll(/^event: (\w+)$/gm)].map(match => match[1])
  console.log(`     events: ${events.join(' ')}`)

  const plain = await retrying('messages json', () => request('/v1/messages', {
    model, max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly the word: verified' }] }],
  }))
  check('a non-streamed live Messages turn answers 200', plain.status, 200)
  check('with the Anthropic envelope', plain.json?.type, 'message')
  const text = (plain.json?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
  checkThat('and real assistant text', text.trim().length > 0, JSON.stringify(plain.json).slice(0, 300))
  checkThat('and a usage block', Number.isFinite(plain.json?.usage?.output_tokens), JSON.stringify(plain.json?.usage))
  console.log(`     answer: ${JSON.stringify(text.trim().slice(0, 120))}`)

  const counted = await request('/v1/messages/count_tokens', {
    model, messages: [{ role: 'user', content: [{ type: 'text', text: 'count these tokens' }] }],
  })
  check('count_tokens answers locally', counted.status, 200)
  checkThat('with a positive estimate', counted.json?.input_tokens > 0, counted.text)
}

console.log('\n=== 4. the local answers spend nothing ===')
{
  const before = (await get('/stats')).json.requests
  const quota = await request('/v1/messages', {
    model, max_tokens: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'quota check' }] }],
  })
  check('a live quota probe answers 200', quota.status, 200)
  check('with the canned answer', quota.json?.content?.[0]?.text, 'Quota check passed.')
  const title = await request('/v1/messages', {
    model, max_tokens: 64,
    system: 'Generate a sentence-case title for this coding session and return json with a title field.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the parser' }] }],
  })
  check('a live title request answers 200', title.status, 200)
  check('with the canned title', title.json?.content?.[0]?.text, 'Conversation')
  const after = (await get('/stats')).json.requests
  check('and neither spent an upstream call', after, before)
}

console.log('\n=== 5. the token savers, live ===')
{
  const before = (await get('/stats')).json.savings
  // Two things a real coding client does and a naive probe does not. It declares
  // its tools — without that, the model's own `[full diff: rtk git diff
  // --no-compact]`-driven decision to call `bash` is suppressed as a fingerprint
  // decoy, which is correct but is not a turn this harness means to test. And it
  // budgets for thinking, because these models spend output tokens on reasoning
  // before they write anything (measured: a 96-token budget went entirely to
  // reasoning and the answer came back empty).
  const ask = () => request('/v1/chat/completions', {
    model, max_tokens: 1024,
    tools: [{ type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }],
    messages: [
      { role: 'user', content: 'In one short sentence, what does this diff change?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_live', type: 'function', function: { name: 'bash', arguments: '{"command":"git diff"}' } }] },
      { role: 'tool', tool_call_id: 'call_live', content: BIG_DIFF },
    ],
  })
  const diff = await retrying('token saver turn', ask)
  check('a turn carrying a 40 KB tool result answers 200', diff.status, 200)
  const choice = diff.json?.choices?.[0]
  const content = choice?.message?.content ?? ''
  const calls = choice?.message?.tool_calls ?? []
  // Either shape is a real answer on this lane: the model may summarise the diff,
  // or it may follow the filter's own "get the full diff" hint and call the tool
  // the client declared. Both prove the compacted body reached it and it replied.
  checkThat('and the model replied about it', content.trim().length > 0 || calls.length > 0,
    `finish=${choice?.finish_reason} content=${JSON.stringify(content)} toolCalls=${JSON.stringify(calls)}`)
  if (content.trim().length > 0) console.log(`     answer: ${JSON.stringify(content.trim().slice(0, 160))}`)
  else console.log(`     answer: the model called ${calls.map(call => call.function?.name).join(', ')} (${String(calls[0]?.function?.arguments ?? '').slice(0, 80)})`)
  const after = (await get('/stats')).json.savings
  checkThat('the savings counter grew', after.saved > before.saved, `${before.saved} -> ${after.saved}`)
  checkThat('the call was counted', after.calls > before.calls, `${before.calls} -> ${after.calls}`)
  checkThat('the 40 KB tool result was compacted as a block', after.blocks > before.blocks, `${before.blocks} -> ${after.blocks}`)
  console.log(`     ${after.summary}`)
}

console.log('\n=== 6. a chain fails over, live ===')
{
  const before = refusingRequests.length
  const answer = await retrying('combo turn', () => request('/v1/chat/completions', {
    model: 'combo:live-failover', max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly the word: verified' }],
  }))
  checkThat('the refusing link was tried', refusingRequests.length > before, `${refusingRequests.length - before} requests`)
  check('the chain still answered 200', answer.status, 200)
  const content = answer.json?.choices?.[0]?.message?.content ?? ''
  checkThat('with a real answer from the next link', content.trim().length > 0, JSON.stringify(answer.json).slice(0, 300))
  console.log(`     answer: ${JSON.stringify(content.trim().slice(0, 120))}`)
  const stats = (await get('/stats')).json
  const chain = stats.models.find(row => row.model === 'combo:live-failover')
  checkThat('and the chain is attributed in the stats', chain !== undefined && chain.turns >= 1, JSON.stringify(stats.models.map(row => row.model)))
}

console.log('\n=== 7. a two-turn conversation, live ===')
{
  const first = await retrying('conversation turn 1', () => request('/v1/chat/completions', {
    model, max_tokens: 64,
    messages: [{ role: 'user', content: 'Remember the number 4173. Reply with just: ok' }],
  }))
  check('the first turn answers 200', first.status, 200)
  const firstText = first.json?.choices?.[0]?.message?.content ?? ''
  console.log(`     turn 1: ${JSON.stringify(firstText.trim().slice(0, 80))}`)
  const second = await retrying('conversation turn 2', () => request('/v1/chat/completions', {
    model, max_tokens: 64,
    messages: [
      { role: 'user', content: 'Remember the number 4173. Reply with just: ok' },
      { role: 'assistant', content: firstText },
      { role: 'user', content: 'What number did I ask you to remember? Reply with just the number.' },
    ],
  }))
  check('the second turn answers 200', second.status, 200)
  const secondText = second.json?.choices?.[0]?.message?.content ?? ''
  console.log(`     turn 2: ${JSON.stringify(secondText.trim().slice(0, 80))}`)
  checkThat('and history replay carried the fact forward', secondText.includes('4173'), `the model answered ${JSON.stringify(secondText.slice(0, 120))}`)
}

console.log('\n=== 8. the roster the gateway advertises ===')
{
  const models = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: boundPort, path: '/v1/models', headers: { authorization: `Bearer ${key}` } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }))
    }).on('error', reject)
  })
  check('the merged model list answers 200', models.status, 200)
  const ids = models.json.data.map(row => row.id)
  checkThat('it carries the live lane', ids.some(id => id === model), ids.slice(0, 5).join(', '))
  checkThat('and the aggregate row', ids.includes('open_router/live-verify-model'), '')
  checkThat('and the chain', ids.includes('combo:live-failover'), '')
  console.log(`     ${ids.length} models advertised`)
}

// ── teardown ────────────────────────────────────────────────────────────────
for (const disposer of ctx.__disposers.reverse()) {
  try { disposer() } catch { /* teardown must not fail the run */ }
}
await new Promise(resolve => refusingServer.close(resolve))
fs.rmSync(home, { recursive: true, force: true })

console.log(failures === 0
  ? '\nlive-feature-verify: every new surface answered against the real gateway'
  : `\nlive-feature-verify: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
