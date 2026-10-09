/**
 * Promo transport probe — asserts the `model.list` RPC **carries the structured
 * `promo` field** through its row projection.
 *
 * Why this is its own probe: the settings card's rows come from
 * `channel-pack-rpc.ts`'s `model.list` handler, which **rebuilds** every row as
 * `{id, name, disabled, dead, isFree}`. Whatever an adapter writes beyond those
 * keys is silently dropped there — that projection is exactly why the badge had
 * to be routed through the host's `description` field for three rounds, and it
 * is the one link neither of the other two probes can see:
 *
 *   • `promo-buddy-test.mjs`  proves the PRODUCER builds the right structure;
 *   • `promo-badge-test.mjs`  proves the CLIENT renders it from a stubbed `promo`;
 *   • this file               proves the RPC in BETWEEN does not eat it.
 *
 * Runs the real handler against a fake kernel and a stub adapter, so a future
 * edit that adds a field to the projection's "known keys" but forgets `promo`
 * fails here instead of silently emptying the badge again.
 *
 * Run: node scripts/promo-contract-test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.join(fileURLToPath(new URL('..', import.meta.url)))

// `channel-pack-rpc.ts` pulls a whole module graph whose sources use `.js`
// specifiers for `.ts` files, which Node cannot resolve on its own. Bundling the
// module with esbuild (the same tool `build-channel-pack.mjs` uses) is the
// shortest path to loading the REAL handler rather than a copy of its logic.
const require = createRequire(import.meta.url)
const esbuildPath = require.resolve('esbuild', {
  paths: [process.env.OFM_ESBUILD_DIR, process.cwd(), repoRoot].filter(Boolean),
})
const esbuild = await import(pathToFileURL(esbuildPath).href)
const built = await esbuild.build({
  entryPoints: [path.join(repoRoot, 'vendor/channel-pack/src/channel-pack-rpc.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  external: ['@deepseek-ai/*', 'node:*'],
  write: false,
  logLevel: 'warning',
  // Bundled CJS deps (undici) call require() for node builtins; in an ESM bundle
  // esbuild's helper throws unless a real `require` is in scope. Same banner the
  // real pack build uses (see scripts/build-channel-pack.mjs).
  banner: {
    js: [
      "import { createRequire as __ofmCreateRequire } from 'node:module'",
      'const require = __ofmCreateRequire(import.meta.url)',
    ].join('\n'),
  },
})
// Written INSIDE the repo (not os.tmpdir()): a stray `package.json` in the temp
// root makes Node refuse to resolve the bundle's bare specifiers.
const tmpDir = mkdtempSync(path.join(repoRoot, '.ofm-rpc-'))
const tmp = path.join(tmpDir, 'rpc.mjs')
writeFileSync(tmp, built.outputFiles[0].text)
const { registerChannelPackRpc } = await import(pathToFileURL(tmp).href)

// A stub adapter: the shape `ModelCatalogSource` requires, plus the promo we

const PROMO = {
  kind: 'discount',
  displayMode: 'strikethrough',
  price: { effective: 'x0', original: 'x0.29' },
  windows: [{ start: '23:00', end: '08:00' }],
  timezone: 'Asia/Shanghai',
  validUntil: '2026-11-01',
  active: false,
  status: '常时',
  note: '错峰时段23:00-08:00·限免·至11月1日',
  priority: 100,
}

const ROUTES = []
const RPC_CALLS = []
const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  emit() {},
  on() { return () => {} },
  get: () => undefined,
  // The RPC module defers endpoint registration until `connection` is available;
  // call the callback right away so the route lands in `ROUTES`.
  inject(_deps, callback) { callback(this) },
  connection: {
    // The module registers its HTTP endpoint through `connection.fetch.register()`.
    fetch: { register: route => { ROUTES.push(route); return () => {} } },
    rpc: { call: (...args) => { RPC_CALLS.push(args); return Promise.resolve({ ok: true, value: {} }) } },
  },
  effect: fn => { try { fn() } catch { /* optional */ } return { [Symbol.dispose]() {} } },
  // `model.list` reads the caller-visible list from `ctx.llm.listModels` and the
  // unfiltered one from the stub adapter above.
  llm: { listModels: () => [{ id: 'hy4-preview', name: 'Hy4 preview · x0.29 (常时)' }, { id: 'plain-model', name: 'Plain · x1' }] },
}

const problems = []
function check(label, cond, detail) {
  if (cond) console.log(`ok  ${label}`)
  else { problems.push(label); console.error(`FAIL ${label} — ${detail}`) }
}

// A stub adapter: the shape `ModelCatalogSource` requires, plus the promo we
// expect to survive the projection.
const adapter = {
  listAllModels: () => [
    { id: 'hy4-preview', name: 'Hy4 preview · x0.29 (常时)', promo: PROMO },
    { id: 'plain-model', name: 'Plain · x1' },
  ],
}
const store = {
  listDisabledModels: () => ({}),
  disabledModelsFor: () => new Map(),
  listAccountsByProvider: () => [],
}
// `registerChannelPackRpc(ctx, pool, codearts, buddy, workbuddy, lobsterai,
//  qoder, qoderCn, trae, cline, loomy, raccoon, minimax, zcode, gemini,
//  modelAdapters, config)` — positional, so every provider slot needs a filler.
// `model.list` touches only `pool`, `modelAdapters` and `ctx.llm`.
const STUB_AUTH = {}
registerChannelPackRpc(
  ctx, store,
  STUB_AUTH, STUB_AUTH, STUB_AUTH, STUB_AUTH, STUB_AUTH, STUB_AUTH,
  STUB_AUTH, STUB_AUTH, STUB_AUTH, STUB_AUTH, STUB_AUTH, STUB_AUTH, STUB_AUTH,
  { buddy: adapter },
  undefined,
)

const route = ROUTES.find(row => row.path === '/api/channel-pack')
check('the channel-pack RPC route is registered', route !== undefined, `routes=${ROUTES.map(r => r.path).join(',')}`)

if (route !== undefined) {
  const call = async (method, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 't', method: 'channel-pack', payload: { method, payload } }),
    }))
    return (await response.json()).result
  }
  const result = await call('model.list', { provider: 'buddy' })
  check('model.list answers ok', result?.ok === true, JSON.stringify(result).slice(0, 300))
  const rows = result?.value?.models ?? []
  check('model.list returned both rows', rows.length === 2, JSON.stringify(rows))

  const promoted = rows.find(row => row.id === 'hy4-preview')
  check('the promoted row still carries id/name/disabled/dead', promoted !== undefined
    && promoted.name === 'Hy4 preview · x0.29 (常时)' && promoted.disabled === false && promoted.dead === false,
    JSON.stringify(promoted))
  check('model.list TRANSPORTS promo (the projection must not eat it)',
    promoted?.promo !== undefined, `keys=${promoted === undefined ? '-' : Object.keys(promoted).join(',')}`)
  check('the transported promo is byte-identical to what the adapter wrote',
    JSON.stringify(promoted?.promo) === JSON.stringify(PROMO), JSON.stringify(promoted?.promo))
  check('the multi-window array survives as an array',
    Array.isArray(promoted?.promo?.windows) && promoted.promo.windows[0].start === '23:00',
    JSON.stringify(promoted?.promo?.windows))
  check('the dual price survives intact',
    promoted?.promo?.price?.original === 'x0.29' && promoted?.promo?.price?.effective === 'x0',
    JSON.stringify(promoted?.promo?.price))
  check('the unpromoted row has NO promo key (omitted, not null)',
    rows.find(row => row.id === 'plain-model')?.promo === undefined,
    JSON.stringify(rows.find(row => row.id === 'plain-model')))
  // The capability bit is what the card keys its compat read on. It must be
  // declared even though `plain-model` has no promo: the point is that "a row
  // lacks promo" is the NORM and says nothing about the pack's ability.
  check('model.list declares promoTransport (the client needs the bit, not a row sample)',
    result?.value?.promoTransport === true, JSON.stringify(result?.value?.promoTransport))
}

if (problems.length === 0) {
  console.log('\nALL PASS — promo survives the model.list projection')
  rmSync(tmpDir, { recursive: true, force: true })
  process.exit(0)
}
console.error(`\n${problems.length} FAILURE(S)`)
rmSync(tmpDir, { recursive: true, force: true })
process.exit(1)
