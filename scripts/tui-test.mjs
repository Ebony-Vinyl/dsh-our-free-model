/**
 * The plugin on a composition with no web server — the case issue #4 reported.
 *
 * `inject` used to name `webServer` and `timer` beside `llm`. Cordis withholds a
 * service the plugin does not declare and refuses to activate a plugin that
 * declares one the composition does not mount, so on dsh-tui — which has no HTTP
 * server to register against — the plugin never started and the free lane was
 * simply absent. The fix is the shape of the dependency list, not a try/catch:
 * only `llm` may be hard, and every feature that needs more has to degrade.
 *
 * Run: node scripts/tui-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callRoute, chatFrames, fakeContext, freePort, stubUpstream, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const stub = await stubUpstream({ listing: ['mimo-v2.6-flash-free', 'space-bunny-free'], answer: () => ({ body: chatFrames('hello from the tui') }) })
process.env.OUR_FREE_MODEL_BASE = stub.base
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-tui-'))
process.env.DSH_HOME = scratch
fs.mkdirSync(path.join(scratch, 'our-free-model'), { recursive: true })
// A headless user has no settings page to click, so the file the plugin owns is
// the only way in — write the forward port on before the plugin boots. The port
// is taken from the ephemeral range rather than written down here: two suites
// running side by side used to collide on the literal, the plugin's bind failed
// (correctly, and quietly), and this file then fetched a port a *different*
// process owned — which answered nothing, and the suite hung until the runner
// killed it with nothing printed to say why.
const forwardPort = await freePort()
fs.writeFileSync(path.join(scratch, 'our-free-model', 'settings.json'), JSON.stringify({
  version: 1, enabled: true, forward: { enabled: true, host: '127.0.0.1', port: forwardPort, lan: { enabled: true, port: 0 } },
}), { mode: 0o600 })
// The sealed roster persists under catalog.json. This composition has no
// profileContext, so the host gate refuses the lane; the refusal has to say so
// in the log, and it must not wipe what a desktop session on this install
// persisted — that wipe in silence is what made "EAC 渠道不显示" undiscoverable.
fs.writeFileSync(path.join(scratch, 'our-free-model', 'catalog.json'), JSON.stringify({
  version: 1, at: 0, entries: [], sealIds: ['deepseek-ai/deepseek-v4.1-flash'],
}), { mode: 0o600 })

const { apply, inject } = await import('../index.js')
const { ROUTE_MAIN } = await import('../src/adapter.js')

check('only the model lane is a hard requirement', inject, ['llm'])

// Record what the background loops arm themselves with, since a composition
// without the timer service means plain timers instead of ctx.interval.
const realSetTimeout = globalThis.setTimeout
const armed = []
const unrefed = []
globalThis.setTimeout = (fn, ms, ...rest) => {
  const handle = realSetTimeout(fn, ms, ...rest)
  if (ms >= 60_000) armed.push(ms)
  const realUnref = handle.unref?.bind(handle)
  handle.unref = () => { unrefed.push(ms); return realUnref() }
  return handle
}

// Mounted: `llm` and nothing else. The fake throws if the plugin reads a service
// it did not declare, which is the defect that made the plugin wait forever.
const ctx = fakeContext({ inject, mounted: ['llm'] })
let bootError
try { apply(ctx, {}) } catch (error) { bootError = error }
globalThis.setTimeout = realSetTimeout

check('apply() survives a composition with no web server', bootError?.message ?? 'none', 'none')
const adapter = ctx.__captured.adapters[0]?.adapter
check('the adapter still registers', typeof adapter?.listModels, 'function')
check('the probe loop and the egress watch armed on plain timers', armed.sort((a, b) => a - b), [120_000, 900_000, 1_800_000])
check('the probe loop and the egress watch armed on plain timers', armed.sort((a, b) => a - b), [120_000, 900_000, 1_800_000])
// Compared by period, not by count: `armed` holds the three long loops while
// `unrefed` also holds the 40-second and 50-millisecond one-shots, so a count
// comparison stayed true after any one of the three stopped unref'ing itself —
// which is the one property that decides whether the plugin can hold the app
// open past exit.
check('and every one of them is unref’d, so the plugin cannot hold the app open',
  armed.filter(ms => !unrefed.includes(ms)), [])
check('the dashboard half is the only thing left waiting', ctx.__captured.serverRoutes.length, 0)
// Two nested fibers now pend, and both are the same bargain: the channel pack
// waits for credentials/commands/llm (a composition without them loses the
// absorbed channels and keeps the free lane), the dashboard half waits for
// webServer. Neither is in the plugin's own `inject`, which stays `['llm']` —
// that is the property this check exists to protect.
check('it waits for services rather than running without them',
  ctx.__waiting.map(fiber => [...fiber.names]), [['credentials', 'commands', 'llm'], ['webServer']])

// The web composition has the same problem in mirror image: `webServer` is not
// provided yet while plugins load, so a one-shot read of it at apply time mounted
// no routes at all and the settings page had no data source behind a running web
// server. This is that arrival, late.
ctx.__mountService('webServer')
await until(() => ctx.__captured.serverRoutes.length >= 2, { what: 'the dashboard fiber to run once the server exists' })
check('the settings API mounts when the service does', ctx.__captured.serverRoutes.map(route => route.path).sort(),
  ['/api/our-free-model', '/api/our-free-model/events'])

await until(() => fs.existsSync(path.join(scratch, 'our-free-model', 'availability.json')), { what: 'the boot probe to land' })

await until(() => ctx.__logs.some(line => line.includes('the sealed lane is not available in this composition')), { what: 'the sealed-lane gate refusal to be logged' })
check('the host-gate refusal is logged, not silent', ctx.__logs.some(line => line.startsWith('warn our-free-model: the sealed lane is not available')), true)
const persisted = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'catalog.json'), 'utf8'))
check('and the refusal keeps the roster a desktop session persisted', persisted.sealIds, ['deepseek-ai/deepseek-v4.1-flash'])

const models = await adapter.listModels(ROUTE_MAIN)
check('the picker still gets its models', models.map(model => model.id).sort(), ['mimo-v2.6-flash-free', 'space-bunny-free'])
check('with the capacities the composer shows', models[0].description.includes('context'), true)
const resolved = await adapter.resolveModel(ROUTE_MAIN, 'mimo-v2.6-flash-free')
check('and a model resolves with its effort menu', resolved.reasoning.efforts.map(row => row.id), ['light', 'balanced', 'deep'])

/** One streamed turn through the adapter, the way the harness drives it. */
const chunks = []
for await (const chunk of adapter.stream({
  provider: ROUTE_MAIN,
  model: 'mimo-v2.6-flash-free',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  sessionId: 'tui:one',
})) chunks.push(chunk)
check('a turn streams', chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'hello from the tui')
check('and finishes', chunks.find(chunk => chunk.type === 'finish')?.reason, { kind: 'stop' })

const forward = await fetch(`http://127.0.0.1:${forwardPort}/v1/models`, { headers: { authorization: 'Bearer local-test-key' } })
check('the forward listener came up without a web server', forward.status, 401)
const key = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'settings.json'), 'utf8')).forwardKey
const rows = await (await fetch(`http://127.0.0.1:${forwardPort}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).json()
check('and lists the usable models with the real key', rows.data.map(row => row.id).sort(), ['mimo-v2.6-flash-free', 'space-bunny-free'])
// The forwarding caller's effort knob: the ladder is this plugin's own ids, so
// nothing but the roster can tell an API client what to ask for.
check('the roster tells an API caller which thinking strengths a model takes',
  rows.data.find(row => row.id === 'mimo-v2.6-flash-free')?.x_ofm_efforts, ['light', 'balanced', 'deep'])
check('and which one applies when the caller names none',
  rows.data.find(row => row.id === 'mimo-v2.6-flash-free')?.x_ofm_effort_default, 'balanced')
const answered = await (await fetch(`http://127.0.0.1:${forwardPort}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }] }),
})).json()
check('a non-streaming call answers', String(answered.choices?.[0]?.message?.content ?? ''), 'hello from the tui')
check('usage comes back in the OpenAI spelling the caller reads', [answered.usage?.prompt_tokens, answered.usage?.completion_tokens], [11, 7])
const requestTraces = () => ctx.__logs
  .filter(line => line.startsWith('info our-free-model request: '))
  .map(line => JSON.parse(line.slice('info our-free-model request: '.length)))
await until(() => requestTraces().some(event => event.stage === 'finished'), { what: 'forward diagnostics to reach the host logger' })
check('forward lifecycle events reach the host info logger',
  requestTraces().map(event => event.stage), ['received', 'body_received', 'dispatch', 'generation_finished', 'finished'])
check('the host diagnostics do not include the local key', JSON.stringify(requestTraces()).includes(key), false)

// The same listener's Responses route has to carry a caller's *tool* history
// upstream, not only its prose. Those rows arrive in OpenAI's spelling, with the
// call and its answer in side fields the projector never reads, so a caller
// replaying its own tool round trip silently lost both halves of it — issue #9's
// defect one layer down, on a route no suite had exercised.
await fetch(`http://127.0.0.1:${forwardPort}/v1/responses`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'space-bunny-free',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Shanghai"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":22}' },
    ],
  }),
}).then(res => res.json())
const forwarded = stub.requests[stub.requests.length - 1]?.body ?? {}
check('a forwarded /v1/responses call sends the tool call upstream',
  (forwarded.messages ?? []).filter(row => row.role === 'assistant').flatMap(row => row.tool_calls?.map(call => `${call.function.name} ${call.function.arguments}`) ?? []),
  ['get_weather {"city":"Shanghai"}'])
check('…and sends its result, keyed to the call it answers',
  (forwarded.messages ?? []).filter(row => row.role === 'tool').map(row => `${row.tool_call_id}=${row.content}`),
  ['call_1={"temp":22}'])

// The LAN relay is the second door a headless user's settings file can open: off
// unless it says so, and then a listener of its own. The machine's key must not
// work there, and the liveness probe that answers keyless on loopback must not
// answer on an address the whole subnet can reach.
const written = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'settings.json'), 'utf8'))
const lanPort = written.forward?.lan?.port ?? 0
check('the LAN relay came up and wrote back the port it settled on', lanPort > 0, true)
// The address to hand out is re-read from this machine's interfaces on every
// ask — the panel polls it while the relay is on — so a machine that moved
// networks is not told to dial where it used to be.
const lanApi = ctx.__captured.serverRoutes.find(route => route.path === '/api/our-free-model')?.handler
const lanRead = await callRoute(lanApi, 'GET', '/api/our-free-model/forward/lan/addresses')
check('the panel can re-read the LAN addresses while the relay is up',
  [lanRead.status, Array.isArray(lanRead.json?.addresses)], [200, true])
check('and the settings snapshot carries the same list',
  Array.isArray((await callRoute(lanApi, 'GET', '/api/our-free-model/summary')).json?.settings?.forward?.lan?.addresses), true)
const lanKey = written.forwardLanKey
check('with a key of its own, minted apart from the local one', typeof lanKey === 'string' && lanKey !== '' && lanKey !== key, true)
const lanModels = await fetch(`http://127.0.0.1:${lanPort}/v1/models`, { headers: { authorization: `Bearer ${lanKey}` } })
check('the network key reaches the model list', lanModels.status, 200)
check('…with the roster the local listener serves', (await lanModels.json()).data.map(row => row.id).sort(), ['mimo-v2.6-flash-free', 'space-bunny-free'])
check('the local key is not accepted on the network door',
  (await fetch(`http://127.0.0.1:${lanPort}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status, 401)
check('and a keyless liveness probe answers nothing on a routable address',
  (await fetch(`http://127.0.0.1:${lanPort}/health`)).status, 401)
check('the relay carries the API paths, not whatever else answers on loopback',
  (await fetch(`http://127.0.0.1:${lanPort}/health`, { headers: { authorization: `Bearer ${lanKey}` } })).status, 404)
const lanAnswer = await fetch(`http://127.0.0.1:${lanPort}/v1/chat/completions`, {
  method: 'POST', headers: { authorization: `Bearer ${lanKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }] }),
})
await lanAnswer.json()
await until(() => requestTraces().some(event => event.hop === 'relay' && event.stage === 'finished'), { what: 'relay diagnostics to reach the host logger' })
const relayId = lanAnswer.headers.get('x-ofm-request-id')
check('host logs link a relay request to the local completion',
  requestTraces().some(event => event.hop === 'forward' && event.parentId === relayId && event.stage === 'finished'), true)
check('the host diagnostics do not include either forward key',
  requestTraces().some(event => JSON.stringify(event).includes(key) || JSON.stringify(event).includes(lanKey)), false)

// A turn the lane refuses must not arrive as an empty 200.
stub.api.refuseAll = true
const refused = await fetch(`http://127.0.0.1:${forwardPort}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }] }),
})
const refusedBody = await refused.json()
check('a refused forward call is a failure', refused.status, 502)
check('and says what the gateway said', /unavailable/i.test(refusedBody.error?.message ?? ''), true)
stub.api.refuseAll = false

// The same refusal on the streaming side, where the status line was already spent
// on the SSE headers: it has to say so in the body rather than close the stream as
// though the model had answered with an empty turn.
stub.api.refuseAll = true
const streamedRefusal = await fetch(`http://127.0.0.1:${forwardPort}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }], stream: true }),
})
const streamedText = await streamedRefusal.text()
check('a refused streaming call carries an error frame', /"error"/.test(streamedText), true)
check('and not a clean stop', /finish_reason":"stop/.test(streamedText), false)
stub.api.refuseAll = false

for (const dispose of ctx.__disposers.reverse()) dispose()
await stub.close()
fs.rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\ntui: the lane works with no browser half' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
