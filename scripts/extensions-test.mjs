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
 * Everything is loopback; no live traffic.
 * Run: node scripts/extensions-test.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'node'

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
  const channelManifest = {
    schemaVersion: 1, id: 'fixture-channel', version: '1.0.0', type: 'channel',
    name: 'Fixture Channel', description: 'a loopback channel', author: 'test', license: 'MIT',
    permissions: { network: [upstreamOrigin], secrets: ['apiKey'], storage: true },
    config: [{ key: 'region', type: 'text', label: 'Region', default: 'us' }],
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
      entry(channelManifest, channelSource),
      entry(kiloManifest, channelSource
        .replace("'demo-model', name: 'Demo Model', contextWindow: 8192, maxOutput: 1024, vision: false, reasoning: false", "'kilo-auto/free', name: 'Kilo Auto Free', contextWindow: 256000, maxOutput: 32768")
        .replace("{ id: 'second-model', name: 'Second Model', contextWindow: 4096, maxOutput: 512 },", '')),
      entry(enhancementManifest, enhancementSource),
      entry(brokenManifest, brokenLoadSource),
      entry({ schemaVersion: 1, id: 'fixture-sneaky', version: '1.0.0', type: 'channel', name: 'Sneaky', permissions: { network: [], secrets: [], storage: false } }, sneakySource),
      entry({ schemaVersion: 1, id: 'fixture-banned', version: '1.0.0', type: 'channel', name: 'Banned', permissions: { network: [], secrets: [], storage: false } }, bannedSource),
      // Digest mismatch: the manifest promises bytes the server does not serve.
      { schemaVersion: 1, id: 'fixture-digest', version: '1.0.0', type: 'channel', name: 'Digest', permissions: { network: [], secrets: [], storage: false },
        main: { url: `http://127.0.0.1:${registryPort}/packages/fixture-digest/main.mjs`, size: 12, sha256: '0'.repeat(64) } },
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
  hostVersion: '2.9.0',
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
    ['fixture-channel', 'fixture-kilo', 'fixture-enhancement', 'fixture-broken', 'fixture-sneaky', 'fixture-banned', 'fixture-digest'])
  check('a tampered signature is refused', verifyRegistrySignature(registryPayload, signature.slice(0, -2) + 'aa', publicKeySpki), false)
  check('a foreign key is refused', verifyRegistrySignature(registryPayload, signature, publicKeySpki.slice(0, -4) + 'AAAA'), false)
  const dropForeign = parseRegistry({ plugins: [{ id: 'evil', version: '1.0.0', type: 'channel', name: 'x', main: { url: 'https://evil.example/x.mjs', size: 3, sha256: '0'.repeat(64) } }] })
  check('entries hosted off the registry mirrors are dropped', dropForeign.plugins.length, 0)
  const scan = scanExtensionSource(sneakySource)
  check('a node: import fails the scan', scan.ok, false)
  const bannedScan = scanExtensionSource(bannedSource)
  check('a forbidden API fails the scan', bannedScan.ok, false)
}

console.log('\n=== 2. a channel extension installs, starts and serves a turn ===')
{
  const record = await extensions.install('fixture-channel')
  check('the install is recorded', [record.id, record.version, record.enabled, record.state], ['fixture-channel', '1.0.0', true, 'ready'])
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
}

console.log('\n=== 3. secrets and config reach the plugin; the API never sees them ===')
{
  extensions.saveSecret('fixture-channel', 'apiKey', 'sk-fixture-1234567890')
  const record = extensions.saveConfig('fixture-channel', { region: 'eu', hacker: 'ignored' })
  check('the unknown key is dropped', record.values.region, 'eu')
  check('the secret reads back masked', record.secrets, [{ key: 'apiKey', hasValue: true, hint: '…7890' }])
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
  assert.throws(() => extensions.saveSecret('fixture-channel', 'undeclared', 'x'), /not declared/)
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

extensions.dispose()
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
