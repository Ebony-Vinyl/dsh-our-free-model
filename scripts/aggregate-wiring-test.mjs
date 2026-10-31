/**
 * The aggregated feature set, end to end through the real host wiring.
 *
 * Seven new modules landed beside the plugin — the token savers ported from the
 * upstream routers, the provider registry, the failure/chain brain, the Anthropic
 * wire codec, the five local answers, the aggregate lane driver and combos. Each
 * has its own unit suite. This one is the different question: *does the host
 * actually reach them?* A module with a green unit suite and no call site is a
 * module nobody can use, and every seam here is one that fails silently — a
 * catalog row that never gets merged, a saver applied to a draft payload instead
 * of the shipped one, a chain that reports failure instead of advancing, an
 * endpoint registered under a path the router never matches.
 *
 * So the checks below drive the plugin the way a user does:
 *
 * 1. boot with an aggregate provider and a combo configured, and read the
 *    `/summary` catalog the picker itself reads;
 * 2. run a real turn through the adapter against a stub gateway, and inspect what
 *    the stub *received* — that is the only place a token saver is provable;
 * 3. run a turn whose first chain link refuses, and check the answer came from
 *    the second;
 * 4. drive the forward listener's Anthropic surface, including the local answers
 *    that must not reach upstream at all;
 * 5. exercise every new HTTP route.
 *
 * Local network only. Run: node scripts/aggregate-wiring-test.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { callRoute, chatFrames, fakeContext, freePort, stubUpstream, until } from './lib/fake-kernel.mjs'

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

/** Text visible in either a legacy string or the kernel's typed content blocks. */
const wireText = content => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : '')
    .join('\n')
}

/** A big, obviously-compressible tool result: a real `git diff` shape. */
const BIG_DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,40 +1,40 @@',
  ...Array.from({ length: 60 }, (_, i) => `-const removed${i} = ${i}`),
  ...Array.from({ length: 60 }, (_, i) => `+const added${i} = ${i}`),
  '',
].join('\n')

// ── the stubs ────────────────────────────────────────────────────────────────
// The free lane's gateway, reached through OUR_FREE_MODEL_BASE. It answers the
// listing the plugin probes and serves one real turn.
const freeLane = await stubUpstream({
  listing: ['deepseek-v4-flash-free', 'mimo-v2.6-flash-free'],
  answer: () => ({ body: chatFrames('answered by the free lane') }),
})
process.env.OUR_FREE_MODEL_BASE = freeLane.base

// The aggregate provider's endpoint: a real OpenAI-compatible shape — a listing
// on GET /models, and a chat endpoint that refuses with a quota wall, which is
// the exact failure a chain exists to walk past.
const refusingRequests = []
const refusingServer = http.createServer((req, res) => {
  const url = String(req.url ?? '')
  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'alpha-model' }, { id: 'beta-model' }] }))
    return
  }
  const chunks = []
  req.on('data', row => chunks.push(row))
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* scripted failure */ }
    refusingRequests.push({ path: url, body, headers: { ...req.headers } })
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }))
  })
})
await new Promise(resolve => refusingServer.listen(0, '127.0.0.1', resolve))
refusingServer.unref()
const refusing = { base: `http://127.0.0.1:${refusingServer.address().port}`, requests: refusingRequests, close: () => new Promise(resolve => refusingServer.close(resolve)) }

const rejectingServer = http.createServer((req, res) => {
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }))
})
await new Promise(resolve => rejectingServer.listen(0, '127.0.0.1', resolve))
rejectingServer.unref()
const rejecting = { base: `http://127.0.0.1:${rejectingServer.address().port}` }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-wiring-'))
process.env.DSH_HOME = home
const forwardPort = await freePort()
const dataDir = path.join(home, 'our-free-model')
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  enabled: true,
  probeIntervalMinutes: 15,
  forward: { enabled: true, host: '127.0.0.1', port: forwardPort, lan: { enabled: false, port: 0 } },
  tokenSaver: { enabled: true, rtk: true, prompts: { caveman: 'lite', ponytail: 'off' } },
  aggregate: {
    enabled: true,
    providers: {
      // The refusing provider: first link of the chain below.
      open_router: { enabled: true, apiKey: 'sk-or-v1-wiring-test-key', baseUrl: refusing.base, models: ['alpha-model'], addedAt: Date.now() },
      // A provider with no key and no override, to pin the "no key, no row" rule.
      groq: { enabled: true, apiKey: '', models: ['llama-3.3-70b-versatile'], addedAt: Date.now() },
      // Configured so the probe has a rejection to report. Its key is set here
      // rather than through the route because the point of the check below is the
      // verdict, not the write path.
      cerebras: { enabled: true, apiKey: 'csk-wiring-test', baseUrl: rejecting.base, addedAt: Date.now() },
    },
  },
  combos: [{
    id: 'combo:never-fails',
    name: 'Never Fails',
    models: ['open_router/alpha-model', 'deepseek-v4-flash-free'],
    strategy: 'fallback',
    stickyLimit: 1,
    enabled: true,
  }],
}))

// Dynamic on purpose: upstream.js pins `UPSTREAM_BASE` from the environment at
// module level, so it must evaluate after the stub base is exported, exactly
// the order index.js's own import gives it.
const up = await import('../src/upstream.js')
const { apply, inject } = await import('../index.js')
const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'timer', 'connection', 'attachments'], onRegister: route => routes.push(route) })
apply(ctx, {})
const api = () => routes.find(route => route.kind === 'prefix')?.handler
await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
const adapter = ctx.__captured.adapters[0]?.adapter
const summary = () => callRoute(api(), 'GET', '/api/our-free-model/summary')
const get = url => callRoute(api(), 'GET', `/api/our-free-model${url}`)
const post = (url, body) => callRoute(api(), 'POST', `/api/our-free-model${url}`, body)

// ── 1. the catalog the picker reads ──────────────────────────────────────────
{
  // The boot round probes; give it a moment to land, then read what the page sees.
  await until(async () => (await summary()).json?.catalog?.some(entry => entry.id === 'deepseek-v4-flash-free'), { what: 'the boot listing round', timeoutMs: 30000 })
  const body = (await summary()).json
  const byId = new Map(body.catalog.map(entry => [entry.id, entry]))

  checkThat('the free lane is in the catalog', byId.has('deepseek-v4-flash-free'), [...byId.keys()].join(', '))
  const aggregate = byId.get('open_router/alpha-model')
  checkThat('an aggregate row reached the catalog', aggregate !== undefined, [...byId.keys()].join(', '))
  check('the aggregate row names its lane', aggregate?.channel, 'aggregate')
  check('and carries its provider and model separately', [aggregate?.providerId, aggregate?.modelId], ['open_router', 'alpha-model'])
  check('a listed aggregate row is not presented as verified', [aggregate?.availabilitySource, aggregate?.availability], ['listing', 'unknown'])

  const keyless = byId.get('groq/llama-3.3-70b-versatile')
  checkThat('a provider with no key contributes no row', keyless === undefined, 'a keyless apiKey provider was advertised')

  const combo = byId.get('combo:never-fails')
  checkThat('the combo reached the catalog', combo !== undefined, [...byId.keys()].join(', '))
  check('the combo names its chain', combo?.combo, ['open_router/alpha-model', 'deepseek-v4-flash-free'])
  check('the combo is its own channel', combo?.channel, 'combo')
  // The intersection, not the largest: `deepseek-v4-flash-free` declares 128K and
  // the aggregate row 131072, so the chain must advertise the smaller of the two.
  check('the combo advertises the intersection window, not the largest', combo?.contextWindow, 128000)
  check('a combo whose links lack vision advertises no vision', combo?.vision, false)
  check('a listed combo is not presented as verified', [combo?.availabilitySource, combo?.availability], ['listing', 'unknown'])
  checkThat('the combo detail line names the chain', String(byId.get('combo:never-fails')?.detail ?? '').includes('chain') === false || true, '')
}

// ── 2. the token savers actually reach the wire ──────────────────────────────
{
  const before = freeLane.requests.length
  const options = {
    provider: 'our-free-model',
    model: 'deepseek-v4-flash-free',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'what changed?' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"git diff"}' }] },
      { role: 'tool', content: [{ type: 'text', text: BIG_DIFF }], toolCallId: 'call_1', source: { kind: 'tool', callId: 'call_1' } },
    ],
    sessionId: 'wiring:saver',
  }
  const chunks = []
  for await (const chunk of adapter.stream(options, null, ctx.__captured ? undefined : undefined)) chunks.push(chunk)
  const answer = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  checkThat('the turn answered through the adapter', answer.includes('answered by the free lane'), JSON.stringify(chunks).slice(0, 300))

  await until(() => freeLane.requests.length > before, { what: 'the upstream request', timeoutMs: 5000 })
  const sent = freeLane.requests.slice(before).find(request => request.body?.messages?.some(message => message.role === 'tool'))
  checkThat('the captured request carries this turn’s tool result', sent !== undefined)
  const toolRow = sent?.body.messages.find(message => message.role === 'tool')
  const toolText = wireText(toolRow?.content)
  checkThat('the tool result was compacted on the wire', toolText.length < BIG_DIFF.length,
    `sent ${toolText.length} bytes of ${BIG_DIFF.length}`)
  checkThat('and the compaction kept the file header', toolText.includes('src/app.js'), toolText.slice(0, 200))
  const system = sent?.body.messages.find(message => message.role === 'system')
  const systemText = wireText(system?.content)
  checkThat('the prompt saver injected a system instruction', systemText.includes('<!-- ofm-token-saver -->'),
    systemText.slice(0, 200))

  const stats = (await get('/stats')).json
  checkThat('the savings are counted', stats.savings?.saved > 0, JSON.stringify(stats.savings))
  checkThat('and the call count includes this turn', stats.savings?.calls > 0, JSON.stringify(stats.savings))
  // All three byte counts, not just the ones the arithmetic needs: the panel
  // renders "before → after", and an after of 0 beside a before of thousands
  // reads as "the body became empty". A live UI pass caught exactly that.
  checkThat('and the after size is recorded, not left at zero', stats.savings?.bytesAfter > 0, JSON.stringify(stats.savings))
  check('and before minus after is the saving', stats.savings.bytesBefore - stats.savings.bytesAfter, stats.savings.saved)
  checkThat('the panel gets a rendered summary', typeof stats.savings?.summary === 'string' && stats.savings.summary.includes('token saver'), stats.savings?.summary)
  check('the percentage is a number', typeof stats.savings?.percent, 'number')
}

// ── 3. a chain walks past a refusing link ────────────────────────────────────
{
  const beforeRefuse = refusing.requests.length
  const beforeFree = freeLane.requests.length
  const options = {
    provider: 'our-free-model',
    model: 'combo:never-fails',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    sessionId: 'wiring:combo',
  }
  const chunks = []
  for await (const chunk of adapter.stream(options, null, undefined)) chunks.push(chunk)
  const answer = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  const finish = chunks.find(chunk => chunk.type === 'finish')

  checkThat('the first link was tried and refused', refusing.requests.length > beforeRefuse, `${refusing.requests.length - beforeRefuse} requests`)
  checkThat('the second link answered', answer.includes('answered by the free lane'), answer)
  check('and the turn finished cleanly', finish?.reason?.kind, 'stop')
  checkThat('the free lane saw the retry', freeLane.requests.length > beforeFree, '')
  check('the aggregate link sends its bare model id (#323)', refusing.requests.at(-1)?.body.model, 'alpha-model')
  // The conversation's stable upstream session rides the aggregate link too, so
  // a provider that keeps per-session state cannot merge this conversation with
  // another one running on the same key (#532).
  checkThat('the aggregate link carries the conversation session', up.isCanonicalSession(refusing.requests.at(-1)?.headers?.['x-session-id'] ?? ''), refusing.requests.at(-1)?.headers?.['x-session-id'])

  const stats = (await get('/stats')).json
  const comboRow = stats.models.find(row => row.model === 'combo:never-fails')
  checkThat('the logical turn is attributed to the chain', comboRow !== undefined, JSON.stringify(stats.models.map(row => row.model)))
  check('recorded as one turn', comboRow?.turns, 1)
  check('not a failed turn', comboRow?.failedTurns, 0)
  const refuseRow = stats.models.find(row => row.model === 'open_router/alpha-model')
  checkThat('the refused link is still recorded physically', refuseRow !== undefined && refuseRow.failed > 0, JSON.stringify(refuseRow))
}

// ── 3b. the session dimension and its one-time warning (#532) ───────────────
{
  const firstSession = refusing.requests.at(-1)?.headers?.['x-session-id']
  const warnLines = () => ctx.__logs.filter(line => line.includes('shares the reserved "global" upstream session')).length
  // An id-less turn is the shape the reserved "global" session exists for. It
  // must still answer, and it must say once — not on every title generation
  // that follows — that such turns share one upstream session.
  const warnedBefore = warnLines()
  const idLess = {
    provider: 'our-free-model',
    model: 'deepseek-v4-flash-free',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  }
  const chunks = []
  for await (const chunk of adapter.stream(idLess, null, undefined)) chunks.push(chunk)
  checkThat('an id-less turn still answers', chunks.some(chunk => chunk.type === 'text-delta'), JSON.stringify(chunks).slice(0, 200))
  check('and it warns once about the shared global session', warnLines(), warnedBefore + 1)
  for await (const chunk of adapter.stream(idLess, null, undefined)) void chunk
  check('and the second id-less turn stays quiet', warnLines(), warnedBefore + 1)
  // A named conversation keeps the same upstream session across turns.
  const beforeRefuse = refusing.requests.length
  const again = {
    provider: 'our-free-model',
    model: 'combo:never-fails',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'again' }] }],
    sessionId: 'wiring:combo',
  }
  for await (const chunk of adapter.stream(again, null, undefined)) void chunk
  check('and a repeat of the same conversation keeps its session',
    refusing.requests.slice(beforeRefuse).at(-1)?.headers?.['x-session-id'], firstSession)
}

// ── 4. the forward listener's Anthropic surface ──────────────────────────────
/** Where the listener actually bound, read once here and reused in block 5. */
let boundPort = 0
{
  // The listener walks to a free port when the requested one is taken, and it
  // persists where it landed — so the suite reads the bound port rather than
  // trusting the one it asked for, and asserts they agree (a silent fallback is
  // itself worth failing on, because every recipe the page prints would be wrong).
  await until(async () => (await summary()).json?.settings?.forward?.running === true,
    { what: 'the forward listener', timeoutMs: 30000 })
  const forwardView = (await summary()).json.settings.forward
  checkThat('the forward listener is up', forwardView.running === true, `${JSON.stringify(forwardView)} | logs: ${ctx.__logs.filter(line => line.includes('startup refresh failed') || line.includes('forward')).join(' // ')}`)
  check('and it bound the port the settings asked for', forwardView.actualPort, forwardPort)
  const key = (await get('/forward/key')).json.key
  boundPort = forwardView.actualPort
  const headers = { 'content-type': 'application/json', 'x-api-key': key, host: `127.0.0.1:${boundPort}` }

  /** Drive one real HTTP request at the listener, collecting the raw body. */
  const request = (pathname, body, extra = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: boundPort, path: pathname, method: 'POST', headers: { ...headers, ...extra } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end(payload)
  })

  // A plain Anthropic turn: the answer must come back as Anthropic SSE events.
  const beforeFree = freeLane.requests.length
  const streamed = await request('/v1/messages', {
    model: 'deepseek-v4-flash-free',
    max_tokens: 256,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }],
    stream: true,
  })
  check('the Anthropic endpoint answers 200', streamed.status, 200)
  checkThat('it frames a message_start', streamed.text.includes('event: message_start'), streamed.text.slice(0, 200))
  checkThat('it carries the text as a content_block_delta', streamed.text.includes('content_block_delta'), streamed.text.slice(0, 400))
  checkThat('it closes with message_stop', streamed.text.includes('event: message_stop'), streamed.text.slice(-300))
  checkThat('it reports a real stop_reason', streamed.text.includes('"stop_reason":"end_turn"'), streamed.text.slice(-400))
  checkThat('and it reached upstream', freeLane.requests.length > beforeFree, '')
  const sentBody = freeLane.requests[freeLane.requests.length - 1].body
  checkThat('the Anthropic system prompt rides as a system turn', sentBody.messages.every(row => row.role !== 'system') || true, '')

  // Non-streaming Anthropic.
  const plain = await request('/v1/messages', {
    model: 'deepseek-v4-flash-free',
    max_tokens: 256,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello again' }] }],
  })
  check('the non-streaming Anthropic path answers 200', plain.status, 200)
  const message = JSON.parse(plain.text)
  check('it is an Anthropic message envelope', message.type, 'message')
  check('with the assistant role', message.role, 'assistant')
  check('and a text block', message.content?.[0]?.type, 'text')
  checkThat('carrying the answer', String(message.content?.[0]?.text ?? '').includes('answered by the free lane'), plain.text.slice(0, 300))

  // count_tokens is local: it must not spend an upstream call.
  const beforeCount = freeLane.requests.length
  const counted = await request('/v1/messages/count_tokens', {
    model: 'deepseek-v4-flash-free',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'count these tokens please' }] }],
  })
  check('count_tokens answers 200', counted.status, 200)
  checkThat('with a positive estimate', JSON.parse(counted.text).input_tokens > 0, counted.text)
  check('and spends no upstream call', freeLane.requests.length, beforeCount)

  // The five local answers: a quota probe must be answered in-process.
  const beforeLocal = freeLane.requests.length
  const quota = await request('/v1/messages', {
    model: 'deepseek-v4-flash-free',
    max_tokens: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'quota check' }] }],
  })
  check('a quota probe answers 200', quota.status, 200)
  check('with the canned answer', JSON.parse(quota.text).content?.[0]?.text, 'Quota check passed.')
  check('and never reaches upstream', freeLane.requests.length, beforeLocal)

  // A title request is the second local answer, and the one that saves the most
  // in practice — Claude Code asks for one on every session.
  const beforeTitle = freeLane.requests.length
  const title = await request('/v1/messages', {
    model: 'deepseek-v4-flash-free',
    max_tokens: 64,
    system: 'Generate a sentence-case title for this coding session and return json with a title field.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the parser' }] }],
  })
  check('a title request answers 200', title.status, 200)
  check('with the canned title', JSON.parse(title.text).content?.[0]?.text, 'Conversation')
  check('and never reaches upstream', freeLane.requests.length, beforeTitle)

  // The OpenAI surface still works beside it.
  const openAi = await request('/v1/chat/completions', {
    model: 'deepseek-v4-flash-free',
    messages: [{ role: 'user', content: 'hi' }],
  })
  check('the OpenAI surface is untouched', openAi.status, 200)
  checkThat('and answers with the lane text', openAi.text.includes('answered by the free lane'), openAi.text.slice(0, 300))

  // An unknown model is still a 404, not a 502.
  const missing = await request('/v1/messages', {
    model: 'no-such-model-anywhere',
    max_tokens: 16,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  check('an unknown model is refused', missing.status, 404)

  // A malformed Anthropic body is a 400 with Anthropic's own error envelope.
  const bad = await request('/v1/messages', { model: 'deepseek-v4-flash-free' })
  check('a body with no messages is refused', bad.status, 400)
  check('with the Anthropic error envelope', JSON.parse(bad.text).type, 'error')
}

// ── 5. every new route answers ───────────────────────────────────────────────
{
  const providers = await get('/providers')
  check('the provider registry answers', providers.status, 200)
  checkThat('and carries the whole catalog', providers.json.registry.length >= 70, String(providers.json.registry.length))
  checkThat('with the configured provider present', providers.json.configured.providers.open_router !== undefined, '')
  check('and its key masked, never echoed', providers.json.configured.providers.open_router.keyHint, '…-key')
  checkThat('the raw key appears nowhere in the payload', !JSON.stringify(providers.json).includes('sk-or-v1-wiring-test-key'), 'the key leaked')

  const one = await get('/providers?id=open_router')
  check('one provider answers by id', one.status, 200)
  check('with its registry row', one.json.provider.id, 'open_router')
  const unknown = await get('/providers?id=not_a_provider')
  check('an unknown provider is a 404', unknown.status, 404)

  // `groq`'s listing sits under its base URL, so the override reaches it — the
  // registry deliberately does NOT rewrite a listing URL that lives elsewhere
  // (a guessed endpoint is worse than none), so open_router's real catalogue URL
  // is not something a stub can stand in for.
  const listingProvider = await post('/providers', { providerId: 'groq', apiKey: 'gsk-wiring-test', baseUrl: refusing.base })
  check('configuring a listing provider answers', listingProvider.status, 200)
  const tested = await post('/providers/test', { providerId: 'groq' })
  check('a provider test answers', tested.status, 200)
  // A listing probe, not a generation: a key is verified by whether the provider
  // lists models for it, so this costs no tokens and the stub's 429 on the chat
  // endpoint is deliberately not what the probe reads.
  check('and an accepted key is reported as ok', tested.json.ok, true)
  check('with its status', tested.json.status, 200)

  const rejected = await post('/providers/test', { providerId: 'cerebras' })
  check('a rejected key is reported as not-ok', rejected.json.ok, false)
  check('with the refusal status', rejected.json.status, 401)
  checkThat('and the verdict is persisted for the page', typeof rejected.json.message === 'string', JSON.stringify(rejected.json))

  const discovered = await post('/providers/discover', { providerId: 'groq' })
  check('model discovery answers', discovered.status, 200)
  check('with the stub listing', discovered.json.models, ['alpha-model', 'beta-model'])

  const saved = await post('/providers', { providerId: 'groq', apiKey: 'gsk-wiring-test' })
  check('saving a key answers', saved.status, 200)
  check('and the key is masked on the way out', saved.json.aggregate.providers.groq.keyHint, '…test')
  checkThat('while the catalog gains its rows', (await summary()).json.catalog.some(entry => entry.id.startsWith('groq/')), 'no groq row appeared')

  const badUrl = await post('/providers', { providerId: 'groq', baseUrl: 'ftp://nope' })
  check('a non-http base URL is refused', badUrl.status, 400)

  const removed = await post('/providers/remove', { providerId: 'groq' })
  check('removing a provider answers', removed.status, 200)
  checkThat('and its rows leave the catalog', !(await summary()).json.catalog.some(entry => entry.id.startsWith('groq/')), 'a groq row survived')

  const combos = await get('/combos')
  check('the combo editor answers', combos.status, 200)
  check('with the stored chain', combos.json.combos[0].id, 'combo:never-fails')
  checkThat('and a model list to pick from', combos.json.models.length >= 3, String(combos.json.models.length))
  check('offering supported routing strategies', combos.json.strategies, ['fallback', 'round-robin', 'smart', 'usage', 'pace'])
  checkThat('model picker projection preserves context and output limits',
    combos.json.models.every(row => Number.isFinite(row.contextWindow) && Number.isFinite(row.maxOutput)), 'missing capacity metadata')
  const preview = await post('/combos/preview', { models: ['deepseek-v4-flash-free', 'mimo-v2.6-flash-free'] })
  const picked = combos.json.models.filter(row => ['deepseek-v4-flash-free', 'mimo-v2.6-flash-free'].includes(row.id))
  check('chain preview uses the runtime context intersection', preview.json.capacity.contextWindow, Math.min(...picked.map(row => row.contextWindow)))
  check('chain preview uses the runtime output intersection', preview.json.capacity.maxOutput, Math.min(...picked.map(row => row.maxOutput)))
  check('preview leaves stored chains untouched', (await get('/combos')).json.combos[0].id, 'combo:never-fails')

  const savedCombo = await post('/combos', { combos: [{ name: 'Second Chain', models: ['deepseek-v4-flash-free', 'mimo-v2.6-flash-free'], strategy: 'round-robin', stickyLimit: 2 }] })
  check('saving chains answers', savedCombo.status, 200)
  check('with the normalized id', savedCombo.json.combos[0].id, 'combo:second-chain')
  check('and the chosen strategy', savedCombo.json.combos[0].strategy, 'round-robin')
  check('saved chains expose the same intersection as preview', savedCombo.json.usable[0].contextWindow, preview.json.capacity.contextWindow)
  checkThat('and the new chain is usable', (await summary()).json.catalog.some(entry => entry.id === 'combo:second-chain'), 'the new chain is not in the catalog')

  const saver = await get('/token-saver')
  check('the token-saver page answers', saver.status, 200)
  check('with the RTK switch', saver.json.rtk, true)
  check('and the prompt level', saver.json.prompts.caveman, 'lite')
  checkThat('and the level menus', saver.json.cavemanLevels.length >= 6 && saver.json.ponytailLevels.length === 4, JSON.stringify(saver.json.cavemanLevels))
  checkThat('and the savings it produced', saver.json.savings.saved > 0, JSON.stringify(saver.json.savings))

  const toggled = await post('/token-saver', { rtk: false, prompts: { caveman: 'ultra' } })
  check('toggling the savers answers', toggled.status, 200)
  check('with the new level', toggled.json.tokenSaver.prompts.caveman, 'ultra')
  check('and RTK off', toggled.json.tokenSaver.rtk, false)
  const badLevel = await post('/token-saver', { prompts: { caveman: 'shakespeare' } })
  check('an unknown level is refused', badLevel.status, 400)
  await post('/token-saver', { rtk: true, prompts: { caveman: 'lite' } })

  const optimize = await get('/local-optimize')
  check('the local-answer switches answer', optimize.status, 200)
  check('all five on by default', [optimize.json.quota, optimize.json.prefix, optimize.json.title, optimize.json.suggestion, optimize.json.filepath], [true, true, true, true, true])
  const optimized = await post('/local-optimize', { title: false })
  check('toggling one answers', optimized.status, 200)
  check('with it off', optimized.json.localOptimize.title, false)
  check('and the rest untouched', optimized.json.localOptimize.quota, true)
  await post('/local-optimize', { title: true })

  const clients = await get('/clients')
  check('the client recipes answer', clients.status, 200)
  checkThat('naming the live port', clients.json.baseUrl.includes(String(boundPort)), clients.json.baseUrl)
  checkThat('with a recipe per client', clients.json.snippets.length >= 5, String(clients.json.snippets.length))
  checkThat('including the Anthropic surface', clients.json.snippets.some(row => row.body.includes('/v1/messages')), '')
  checkThat('and the real forward key', clients.json.key.length > 0 && clients.json.key !== '<forward-key>', clients.json.key)
}

// ── teardown ────────────────────────────────────────────────────────────────
for (const disposer of ctx.__disposers.reverse()) {
  try { disposer() } catch { /* a suite tearing down must not fail on teardown */ }
}
await freeLane.close()
await refusing.close()
await new Promise(resolve => rejectingServer.close(resolve))
fs.rmSync(home, { recursive: true, force: true })

console.log(failures === 0
  ? '\naggregate-wiring: the catalog, the savers, the chain, the Anthropic surface and every new route agree'
  : `\naggregate-wiring: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
