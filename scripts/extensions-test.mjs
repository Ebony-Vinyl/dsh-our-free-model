/**
 * The extension platform, end to end against a loopback registry:
 *
 *   1. a signed registry is fetched, verified, cached and served;
 *   2. a channel extension installs, starts in its sandbox, lists models,
 *      merges into the catalog and serves a real streaming turn;
 *   3. `replaces` takes a built-in lane over without duplication;
 *   4. an enhancement's `onRequest` rewrites outgoing bodies, fail-open;
 *   5. secrets and config reach the plugin and never the API;
 *   6. the hostile shelf: tampered signatures, digest mismatches, forbidden
 *      APIs, foreign imports, oversized sources, undeclared network origins
 *      and modules that fail to load — every one refused, none leaving files.
 *
 * The manifest's optional selfTest(ctx) answers on demand from the runtime,
 * and a minHost above this host is refused before anything is downloaded.
 *
 * Everything is loopback; no live traffic.
 * Run: node scripts/extensions-test.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'node'

// Instrumented before the runtime is imported, so section 8 can see the whole
// run: which workers loaded, and which were asked to terminate.
const workersLoaded = new Set()
const workersStopped = new Set()
const workerPostMessage = Worker.prototype.postMessage
Worker.prototype.postMessage = function (message, ...rest) {
  if (message !== null && typeof message === 'object' && message.action === 'load') workersLoaded.add(this)
  return workerPostMessage.call(this, message, ...rest)
}
const workerTerminate = Worker.prototype.terminate
Worker.prototype.terminate = function (...args) {
  workersStopped.add(this)
  return workerTerminate.apply(this, args)
}

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)?.slice(0, 240)}\n       expected ${JSON.stringify(expected)?.slice(0, 240)}`}`)
}

// ── the fixture world ────────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ext-'))
const upstreamRequests = []

/** The "provider" a channel extension points at: records bodies, answers SSE. */
const upstream = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    upstreamRequests.push({ url: req.url, headers: req.headers, body: raw })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ext-ok' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'))
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`

/** The channel extension's source. Deliberately plain: no banned APIs. */
const channelSource = `import { sdk } from 'ofm:sdk'

export default {
  async listModels(ctx) {
    return [
      { id: 'demo-model', name: 'Demo Model', contextWindow: 8192, maxOutput: 1024, vision: false, reasoning: false },
      { id: 'second-model', name: 'Second Model', contextWindow: 4096, maxOutput: 512 },
    ]
  },
  async prepareChat(ctx, req) {
    const key = await ctx.secrets.get('apiKey')
    return {
      url: '${upstreamOrigin}/chat/completions',
      headers: key ? { authorization: 'Bearer ' + key } : {},
      wire: 'chat',
    }
  },
  async selfTest(ctx) {
    return { ok: true, message: 'fixture self-test' }
  },
}
`

const enhancementSource = `export default {
  onRequest(ctx, body, meta) {
    return { ...body, ofm_fixture_marker: 'on' }
  },
}
`

const brokenLoadSource = `export default 42
`

const sneakySource = `import fs from 'node:fs'
export default { async prepareChat() { return { url: '${upstreamOrigin}/x' } } }
`

const bannedSource = `export default {
  async prepareChat(ctx) {
    const flag = process.env.DEBUG
    return { url: '${upstreamOrigin}/x' }
  },
}
`

/** A registry whose entry digests match the bytes it serves. */
const packageSources = {}
const coverBytes = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240"><rect width="640" height="240" fill="#134e4a"/></svg>'
function makeRegistry() {
  const entry = (manifest, source, extra = {}) => {
    packageSources[manifest.id] = source
    return ({
    ...manifest,
    main: {
      url: `http://127.0.0.1:${registryPort}/packages/${manifest.id}/main.mjs`,
      size: Buffer.byteLength(source),
      sha256: crypto.createHash('sha256').update(source).digest('hex'),
    },
    summary: `${manifest.name} summary`,
    tags: ['fixture'],
    publishedAt: '2026-11-07T00:00:00.000Z',
    ...extra,
  })
  }
  const coverFor = (id, bytes = coverBytes) => ({
    url: `http://127.0.0.1:${registryPort}/packages/${id}/cover.svg`,
    size: Buffer.byteLength(bytes),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  })
  const channelManifest = {
    schemaVersion: 1, id: 'fixture-channel', version: '1.0.0', type: 'channel',
    name: 'Fixture Channel', description: 'a loopback channel', author: 'test', license: 'MIT',
    permissions: { network: [upstreamOrigin], secrets: ['apiKey'], storage: true },
    config: [
      { key: 'region', type: 'text', label: 'Region', default: 'us' },
      { key: 'retries', type: 'number', label: 'Retries', default: 3 },
      { key: 'wire', type: 'select', label: 'Wire', default: 'chat', options: ['chat', 'responses'] },
    ],
  }
  const kiloManifest = {
    schemaVersion: 1, id: 'fixture-kilo', version: '2.0.0', type: 'channel',
    name: 'Fixture Kilo', description: 'takes the kilo lane over', author: 'test', license: 'MIT',
    replaces: 'kilo',
    permissions: { network: [upstreamOrigin], secrets: [], storage: false },
    models: [{ id: 'kilo-auto/free', name: 'Kilo Auto Free', contextWindow: 256000, maxOutput: 32768 }],
  }
  const enhancementManifest = {
    schemaVersion: 1, id: 'fixture-enhancement', version: '1.1.0', type: 'enhancement',
    name: 'Fixture Enhancement', description: 'marks outgoing bodies', author: 'test', license: 'MIT',
    permissions: { network: [], secrets: [], storage: false },
    hooks: ['onRequest'],
  }
  const brokenManifest = {
    schemaVersion: 1, id: 'fixture-broken', version: '1.0.0', type: 'channel',
    name: 'Fixture Broken', permissions: { network: [upstreamOrigin], secrets: [], storage: false },
  }
  return {
    generatedAt: '2026-11-07T00:00:00.000Z',
    plugins: [
      entry({ ...channelManifest, cover: 'cover.svg' }, channelSource, { cover: coverFor('fixture-channel') }),
      entry(kiloManifest, channelSource
        .replace("'demo-model', name: 'Demo Model', contextWindow: 8192, maxOutput: 1024, vision: false, reasoning: false", "'kilo-auto/free', name: 'Kilo Auto Free', contextWindow: 256000, maxOutput: 32768")
        .replace("{ id: 'second-model', name: 'Second Model', contextWindow: 4096, maxOutput: 512 },", '')),
      entry(enhancementManifest, enhancementSource),
      entry(brokenManifest, brokenLoadSource),
      entry({ schemaVersion: 1, id: 'fixture-sneaky', version: '1.0.0', type: 'channel', name: 'Sneaky', permissions: { network: [], secrets: [], storage: false } }, sneakySource),
      // A cover whose signed digest is well-formed but lies about the bytes:
      // the entry survives, the image does not.
      entry({ schemaVersion: 1, id: 'fixture-banned', version: '1.0.0', type: 'channel', name: 'Banned', permissions: { network: [], secrets: [], storage: false } }, bannedSource, { cover: { ...coverFor('fixture-banned'), sha256: '0'.repeat(64) } }),
      // A malformed cover (sha256 not hex) is dropped; the entry stays.
      entry({ schemaVersion: 1, id: 'fixture-digest', version: '1.0.0', type: 'channel', name: 'Digest', permissions: { network: [], secrets: [], storage: false } },
        'export default { async prepareChat() { return null } }',
        { main: { url: `http://127.0.0.1:${registryPort}/packages/fixture-digest/main.mjs`, size: 12, sha256: '0'.repeat(64) }, cover: { ...coverFor('fixture-digest'), sha256: 'zz' } }),
      // An entry whose floor is above this host: parses fine, installs never.
      entry({ schemaVersion: 1, id: 'fixture-strict', version: '1.0.0', type: 'channel', name: 'Strict', minHost: '9.9.9', permissions: { network: [], secrets: [], storage: false } },
        'export default { async prepareChat() { return null } }'),
    ],
  }
}

/** Registry + signature + package files over loopback. */
let registryPort
let registryPayload
let signature
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/registry.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(registryPayload))
    return
  }
  if (url.pathname === '/registry.sig') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(signature)
    return
  }
  const match = /\/packages\/([\w-]+)\/main\.mjs/.exec(url.pathname)
  if (match !== null) {
    const id = match[1]
    const body = id === 'fixture-digest' ? 'tampered bytes' : packageSources[id]
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(body)
    return
  }
  const coverMatch = /\/packages\/([\w-]+)\/cover\.svg/.exec(url.pathname)
  if (coverMatch !== null) {
    res.writeHead(200, { 'content-type': 'image/svg+xml' })
    res.end(coverBytes)
    return
  }
  res.writeHead(404).end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
registryPort = server.address().port

// Sign the registry with an ephemeral Ed25519 key; the runtime pins the public half.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const publicKeySpki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
registryPayload = makeRegistry()
const { stableStringify } = await import('../src/updater.js')
signature = crypto.sign(null, Buffer.from(stableStringify(registryPayload)), privateKey).toString('base64')

process.env.DSH_HOME = dataDir
process.env.OFM_EXTENSIONS_REGISTRY = `http://127.0.0.1:${registryPort}/registry.json`
process.env.OFM_EXTENSIONS_PUBLIC_KEY = publicKeySpki
process.env.OUR_FREE_MODEL_BASE = 'http://127.0.0.1:1'
process.env.OUR_FREE_MODEL_KILO_BASE = 'http://127.0.0.1:2'

const { createExtensionRuntime, verifyRegistrySignature, parseRegistry, scanExtensionSource, parseExtensionManifest } = await import('../src/extensions.js')
const { createRuntimeStores, createModelRuntime } = await import('../src/core/runtime.js')

const runtimeDataDir = path.join(dataDir, 'runtime')
const stores = createRuntimeStores({ dataDir: runtimeDataDir, logger: { warn: () => {} } })
// Seed a built-in Kilo row so the `replaces` handover has something to stand down.
stores.catalogStore.update({ kiloRows: [{ id: 'kilo-auto/free', name: 'Kilo Auto Free', channel: 'kilo', wire: 'chat', vision: false, reasoning: true, contextWindow: 256000, maxOutput: 32768, canDisableThinking: false, regionSensitive: false }] })
stores.catalogStore.flush()

let catalogChanged = 0
const extensions = createExtensionRuntime({
  dataDir: runtimeDataDir,
  logger: { warn: (...a) => console.error('WARN', ...a), info: () => {} },
  hostVersion: '2.8.1',
  onCatalogChanged: () => { catalogChanged += 1 },
})
const modelRuntime = createModelRuntime({
  ...stores,
  logger: { warn: () => {}, info: () => {} },
  extensionRuntime: extensions,
  onTopology: () => {},
})
await extensions.init()

const sync = () => { modelRuntime.syncExtensionCatalog(); return modelRuntime.catalog }

console.log('=== 1. the signed registry is fetched, verified and parsed ===')
{
  const view = await extensions.refreshRegistry({ force: true })
  check('the registry lists every readable entry', view.plugins.map(plugin => plugin.manifest.id),
    ['fixture-channel', 'fixture-kilo', 'fixture-enhancement', 'fixture-broken', 'fixture-sneaky', 'fixture-banned', 'fixture-digest', 'fixture-strict'])
  check('a tampered signature is refused', verifyRegistrySignature(registryPayload, signature.slice(0, -2) + 'aa', publicKeySpki), false)
  check('a foreign key is refused', verifyRegistrySignature(registryPayload, signature, publicKeySpki.slice(0, -4) + 'AAAA'), false)
  const dropForeign = parseRegistry({ plugins: [{ id: 'evil', version: '1.0.0', type: 'channel', name: 'x', main: { url: 'https://evil.example/x.mjs', size: 3, sha256: '0'.repeat(64) } }] })
  check('entries hosted off the registry mirrors are dropped', dropForeign.plugins.length, 0)
  const scan = scanExtensionSource(sneakySource)
  check('a node: import fails the scan', scan.ok, false)
  const bannedScan = scanExtensionSource(bannedSource)
  check('a forbidden API fails the scan', bannedScan.ok, false)
  // Covers: carried through when well-formed, dropped when malformed, and the
  // bytes are digest-verified before the first serve.
  const rowWithCover = view.plugins.find(plugin => plugin.manifest.id === 'fixture-channel')
  check('a well-formed cover rides the entry', rowWithCover?.cover === undefined ? false : [rowWithCover.cover.contentType, rowWithCover.cover.size], ['image/svg+xml', Buffer.byteLength(coverBytes)])
  check('a malformed cover costs the image, never the entry', view.plugins.find(plugin => plugin.manifest.id === 'fixture-digest') === undefined
    ? false
    : view.plugins.find(plugin => plugin.manifest.id === 'fixture-digest').cover, undefined)
  const image = await extensions.coverImage('fixture-channel')
  check('coverImage verifies and serves the signed bytes', image === null ? false : [image.contentType, image.bytes.length], ['image/svg+xml', Buffer.byteLength(coverBytes)])
  check('coverImage answers null without a cover', await extensions.coverImage('fixture-kilo'), null)
  check('coverImage refuses bytes that miss the signed digest', await extensions.coverImage('fixture-banned'), null)
  check('an entry within the host floor is installable', extensions.registryView().plugins.find(plugin => plugin.id === 'fixture-channel')?.installable, true)
  check('an entry above the host floor is not installable', extensions.registryView().plugins.find(plugin => plugin.id === 'fixture-strict')?.installable, false)
}

console.log('\n=== 2. a channel extension installs, starts and serves a turn ===')
{
  const record = await extensions.install('fixture-channel')
  check('the install is recorded', [record.id, record.version, record.enabled, record.state], ['fixture-channel', '1.0.0', true, 'ready'])
  // The minHost gate sits before the download: nothing is written for a refusal.
  await assert.rejects(() => extensions.install('fixture-strict'), /requires host >= 9\.9\.9/)
  check('the strict entry stayed uninstalled', extensions.listInstalled().some(row => row.id === 'fixture-strict'), false)
  modelRuntime.syncExtensionCatalog()
  const rows = modelRuntime.catalog.filter(row => row.channel === 'extension')
  check('the catalog carries the extension models', rows.map(row => row.id),
    ['ext:fixture-channel/demo-model', 'ext:fixture-channel/second-model'])
  const entry = rows.find(row => row.modelId === 'demo-model')
  const chunks = []
  for await (const chunk of modelRuntime.adapter.stream({
    model: entry.id,
    messages: [{ role: 'user', content: 'hello from the host' }],
    sessionId: 'ext:turn',
  }, entry, modelRuntime.state())) chunks.push(chunk)
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  check('the turn answered through the extension', text, 'ext-ok')
  check('the upstream saw the turn', upstreamRequests.length, 1)
  const sent = JSON.parse(upstreamRequests[0].body)
  check('the model id is the extension bare id', sent.model, 'demo-model')
  check('the stream flag is forced on', sent.stream, true)
  check('usage options ride the chat wire', sent.stream_options?.include_usage, true)
  const finish = chunks.find(chunk => chunk.type === 'finish')
  check('the turn finished cleanly', finish?.reason?.kind, 'stop')
  const live = extensions.listInstalled().find(row => row.id === 'fixture-channel')
  check('a module that exports selfTest advertises it', live.selfTestAvailable, true)
  check('the self-test returns the hook verdict', await extensions.runSelfTest('fixture-channel'), { ok: true, message: 'fixture self-test' })
}

console.log('\n=== 3. secrets and config reach the plugin; the API never sees them ===')
{
  await extensions.saveSecret('fixture-channel', 'apiKey', 'sk-fixture-1234567890')
  const record = await extensions.saveConfig('fixture-channel', { region: 'eu', hacker: 'ignored' })
  check('the unknown key is dropped', record.values.region, 'eu')
  check('the secret reads back masked', record.secrets, [{ key: 'apiKey', hasValue: true, hint: '…7890' }])
  const typed = await extensions.saveConfig('fixture-channel', { retries: '5', wire: 'grpc' })
  check('a numeric config value coerces', typed.values.retries, 5)
  check('an unlisted select option falls back to the signed default', typed.values.wire, 'chat')
  const picked = await extensions.saveConfig('fixture-channel', { wire: 'responses' })
  check('a listed select option saves', picked.values.wire, 'responses')
  // The next turn carries the secret upstream as a header, not in the body.
  const rows = sync().filter(row => row.channel === 'extension')
  const entry = rows.find(row => row.modelId === 'demo-model')
  for await (const chunk of modelRuntime.adapter.stream({
    model: entry.id, messages: [{ role: 'user', content: 'again' }], sessionId: 'ext:turn2',
  }, entry, modelRuntime.state())) { /* drain */ }
  check('the secret rode the authorization header', upstreamRequests.at(-1).headers.authorization, 'Bearer sk-fixture-1234567890')
  const apiView = extensions.listInstalled().find(row => row.id === 'fixture-channel')
  check('the public record never carries the secret value', JSON.stringify(apiView).includes('sk-fixture-1234567890'), false)
}

console.log('\n=== 4. replaces takes the built-in lane over, without duplication ===')
{
  const before = modelRuntime.catalog.filter(row => row.channel === 'kilo').length
  check('the seeded kilo row exists before the takeover', before, 1)
  await extensions.install('fixture-kilo')
  modelRuntime.syncExtensionCatalog()
  const kiloRows = modelRuntime.catalog.filter(row => row.channel === 'kilo')
  const extRows = modelRuntime.catalog.filter(row => row.extensionId === 'fixture-kilo')
  check('the built-in kilo lane stood down', kiloRows.length, 0)
  check('the extension kept the raw ids', extRows.map(row => row.id), ['kilo-auto/free'])
}

console.log('\n=== 5. an enhancement rewrites outgoing bodies, fail-open ===')
{
  await extensions.install('fixture-enhancement')
  // Enhancements install disabled: a body rewriter is opt-in, unlike a channel.
  await extensions.setEnabled('fixture-enhancement', true)
  modelRuntime.syncExtensionCatalog()
  const before = upstreamRequests.length
  const rows = sync().filter(row => row.channel === 'extension')
  const entry = rows.find(row => row.extensionId === 'fixture-channel' && row.modelId === 'demo-model')
  for await (const chunk of modelRuntime.adapter.stream({
    model: entry.id, messages: [{ role: 'user', content: 'marked' }], sessionId: 'ext:turn3',
  }, entry, modelRuntime.state())) { /* drain */ }
  const body = JSON.parse(upstreamRequests.at(-1).body)
  check('the enhancement marker reached the wire', body.ofm_fixture_marker, 'on')
  check('the upstream body stayed intact beside the marker', body.messages?.[0]?.content, 'marked')
  const enhancer = extensions.listInstalled().find(row => row.id === 'fixture-enhancement')
  check('a module without selfTest does not advertise it', enhancer.selfTestAvailable, false)
  check('a self-test without the hook reports the miss', await extensions.runSelfTest('fixture-enhancement'), { ok: false, message: 'the extension does not implement selfTest' })

  // Fail-open: uninstall the enhancement and the same turn ships unmarked.
  await extensions.uninstall('fixture-enhancement')
  const rowsAfter = sync().filter(row => row.channel === 'extension')
  const entryAfter = rowsAfter.find(row => row.modelId === 'demo-model')
  for await (const chunk of modelRuntime.adapter.stream({
    model: entryAfter.id, messages: [{ role: 'user', content: 'plain' }], sessionId: 'ext:turn4',
  }, entryAfter, modelRuntime.state())) { /* drain */ }
  check('the marker left with the extension', JSON.parse(upstreamRequests.at(-1).body).ofm_fixture_marker, undefined)
}

console.log('\n=== 6. the hostile shelf is refused, one reason at a time ===')
{
  const before = extensions.listInstalled().length
  const dirBefore = fs.readdirSync(path.join(runtimeDataDir, 'extensions', 'packages')).sort()
  await assert.rejects(() => extensions.install('fixture-digest'), /registry signed/)
  await assert.rejects(() => extensions.install('fixture-sneaky'), /failed its pre-install scan/)
  await assert.rejects(() => extensions.install('fixture-banned'), /failed its pre-install scan/)
  await assert.rejects(() => extensions.install('missing-extension'), /does not carry/)
  await assert.rejects(() => extensions.saveSecret('fixture-channel', 'undeclared', 'x'), /not declared/)
  await assert.rejects(() => extensions.setEnabled('ghost', true), /not installed/)
  check('no hostile file was written', fs.readdirSync(path.join(runtimeDataDir, 'extensions', 'packages')).sort(), dirBefore)
  check('the installed set is unchanged', extensions.listInstalled().length, before)
  // A signed entry whose module fails at load is quarantined, not fatal.
  await extensions.install('fixture-broken')
  modelRuntime.syncExtensionCatalog()
  const broken = extensions.listInstalled().find(row => row.id === 'fixture-broken')
  check('the broken module installs but never runs', broken.state !== 'ready', true)
  check('the broken module contributes no models', modelRuntime.catalog.some(row => row.extensionId === 'fixture-broken'), false)
  await extensions.uninstall('fixture-broken')
}

console.log('\n=== 7. disable and uninstall tear the lane down cleanly ===')
{
  await extensions.setEnabled('fixture-channel', false)
  modelRuntime.syncExtensionCatalog()
  check('a disabled extension contributes no rows', modelRuntime.catalog.some(row => row.extensionId === 'fixture-channel'), false)
  check('a disabled extension cannot self-test', await extensions.runSelfTest('fixture-channel'), { ok: false, message: 'the extension is disabled' })
  const record = await extensions.setEnabled('fixture-channel', true)
  check('re-enabling restores the rows', [record.enabled, extensions.isRunning('fixture-channel')], [true, true])
  modelRuntime.syncExtensionCatalog()
  check('the rows are back', modelRuntime.catalog.some(row => row.extensionId === 'fixture-channel'), true)
  const audit = fs.readFileSync(path.join(runtimeDataDir, 'extensions', 'audit.jsonl'), 'utf8').trim().split('\n')
  check('the audit log names every action', audit.length >= 8, true)
  check('the audit lines are json', JSON.parse(audit.at(-1)).action, 'set-enabled')
  await extensions.uninstall('fixture-kilo')
  await extensions.uninstall('fixture-channel')
  modelRuntime.syncExtensionCatalog()
  check('uninstall clears the lane', modelRuntime.catalog.some(row => row.channel === 'extension'), false)
  check('the seeded kilo lane is back', modelRuntime.catalog.filter(row => row.channel === 'kilo').length, 1)
}

console.log('\n=== 8. reconciling the market never orphans a worker ===')
{
  // Every install/enable/disable/uninstall reconciles the running set. A
  // process dropped from the runtime's map without being terminated keeps its
  // own thread — no handle, no listener, unreachable — so the workers that
  // loaded and the workers told to stop must end up equal. This is the
  // regression the section exists for: reconciling once spawned fifteen
  // workers for two extensions and left nine of them running after dispose.
  await extensions.install('fixture-channel')
  await extensions.install('fixture-enhancement')
  const before = workersLoaded.size
  // The channel is already enabled and running. Re-enabling it reconciles the
  // set; a reconcile that rebuilds what it already has re-runs the module's
  // `load` and abandons the worker that was serving.
  await extensions.setEnabled('fixture-channel', true)
  check('re-enabling a running extension keeps its worker', workersLoaded.size - before, 0)
  await extensions.setEnabled('fixture-enhancement', true)
  await extensions.setEnabled('fixture-enhancement', false)
  await extensions.setEnabled('fixture-enhancement', true)
  check('the toggles still started the extension they toggled', workersLoaded.size - before, 2)
  await extensions.dispose()
  await new Promise(resolve => setTimeout(resolve, 250))
  const orphaned = [...workersLoaded].filter(worker => !workersStopped.has(worker))
  check('every worker that ever loaded was terminated', orphaned.length, 0)
  check('the run spawned workers, so the check above is not vacuous', workersLoaded.size > 0, true)
}

server.close()
upstream.close()
stores.dispose()
fs.rmSync(dataDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nall extension checks passed' : `\n${failures} extension check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1

// The verdict is on stdout and the workers are terminated; Node's worker
// teardown on Windows can wedge the loop at exit (libuv handle race), so the
// script leaves synchronously instead of draining it.
process.exit(process.exitCode)
