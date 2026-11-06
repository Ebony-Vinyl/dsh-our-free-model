/**
 * The OFM extension platform: signed registry, verified install, sandboxed run.
 *
 * magpie taught the shape; this lane adapts it to a DSH plugin's constraints
 * (one file, zero dependencies, the host's own trust fence):
 *
 *   - **The marketplace is a repo**, `Ebony-Vinyl/ofm-extensions`: a
 *     deterministic `registry.json` generated from each package's
 *     `ofm-plugin.json` plus `main.mjs`, signed by the maintainer's Ed25519
 *     key into
 *     `registry.sig`. Authors submit pull requests; CI validates schema, code
 *     and tests; a human reviews. "Users upload" means "users open a PR" — the
 *     same curation magpie's community repo runs, with a signature the others
 *     lack.
 *   - **Install is verify-then-write**: the registry (signed) carries each
 *     package's manifest inline and its `main.mjs` sha256; the client
 *     downloads only from the registry repo's own hosts, checks size + digest,
 *     statically scans the source, writes it under the plugin's data dir, and
 *     records everything in an append-only audit log. One version stays on
 *     disk for rollback; the updater's package sweep never walks this
 *     directory (it lives in the data dir, not the package).
 *   - **Run is sandboxed**, in the honest sense available to a Node plugin: a
 *     `worker_threads` Worker with a fixed resource budget evaluates the
 *     extension inside `vm.SourceTextModule` context whose only import is the
 *     synthetic `ofm:sdk` module — no `require`, no `process`, no filesystem,
 *     no sockets of its own. Everything a channel needs — outbound HTTP,
 *     secrets, storage, logs — crosses the bridge as plain JSON, and the
 *     bridge enforces the manifest's declared network origins. This is
 *     defense-in-depth against accidents, not a security boundary against a
 *     determined author: the load-bearing gates are the signature, the review
 *     and the static scan, exactly as the settings page says before an
 *     install.
 *   - **Channels are thin.** An extension channel declares its models (static
 *     or via `listModels`) and turns one harness request into
 *     `{ url, headers, body, wire }`; the host performs the actual HTTP and
 *     SSE through the same shared streaming core the aggregate lane uses.
 *     Enhancement extensions get `onRequest` / `onModels` / `onUsage` hooks
 *     with short timeouts and fail-open semantics.
 *
 * @module src/extensions.js
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { restrictPermissions } from './open-external.js'
import { buildExtensionCatalog, extensionReplaces } from './catalog.js'

/**
 * Deterministic JSON for signature verification: sorted keys, no whitespace,
 * `undefined` dropped (object fields) or nulled (array slots). Same rules as
 * the release manifest's `stableStringify` in src/updater.js — inlined because
 * the standalone package deliberately ships without the updater, and the
 * registry signature must verify identically in every product that mounts the
 * extension platform.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(row => stableStringify(row ?? null)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// ── constants ────────────────────────────────────────────────────────────────

const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000
const REGISTRY_MAX_BYTES = 512 * 1024
const EXTENSION_SOURCE_MAX_BYTES = 256 * 1024
const MAX_INSTALLED = 32
const AUDIT_MAX_LINES = 2000

/** Per-hook budgets. A hung extension dies with its worker, never the lane. */
const HOOK_TIMEOUT_MS = {
  load: 10_000,
  listModels: 10_000,
  prepareChat: 20_000,
  onRequest: 2_000,
  onModels: 2_000,
  onUsage: 1_000,
  selfTest: 10_000,
}

/** The registry repo, and the only hosts an extension's code may download from. */
const EXTENSIONS_REPO = process.env.OFM_EXTENSIONS_REPO ?? 'Ebony-Vinyl/ofm-extensions'
const REGISTRY_HOSTS = new Set(['raw.githubusercontent.com', 'cdn.jsdelivr.net', 'gcore.jsdelivr.net', 'gh-proxy.com'])

/**
 * The registry's Ed25519 public key (SPKI, base64). The matching private key
 * lives with the publisher (GitHub Actions secret `OFM_EXTENSIONS_SIGNING_KEY`
 * and the maintainer's machine), never beside this constant — same rule as the
 * release manifest's key in src/updater.js. Tests override it through
 * `OFM_EXTENSIONS_PUBLIC_KEY` together with `OFM_EXTENSIONS_REGISTRY`.
 */
export const PINNED_EXTENSIONS_PUBLIC_KEY = process.env.OFM_EXTENSIONS_PUBLIC_KEY
  ?? 'MCowBQYDK2VwAyEA7jxuBMdejAlGd9EnkxEpqKpAnxT8vr3sdVBFHxssy/U='

/**
 * Registry sources, first alive wins: raw, then the two jsDelivr edges, then
 * the same plain-read proxy the announcement feed uses (the feed's comment on
 * mirrors applies verbatim here).
 */
export function registrySources() {
  const override = process.env.OFM_EXTENSIONS_REGISTRY
  if (override !== undefined && override !== '') return [String(override)]
  return [
    `https://raw.githubusercontent.com/${EXTENSIONS_REPO}/main/registry.json`,
    `https://cdn.jsdelivr.net/gh/${EXTENSIONS_REPO}@main/registry.json`,
    `https://gcore.jsdelivr.net/gh/${EXTENSIONS_REPO}@main/registry.json`,
    `https://gh-proxy.com/https://raw.githubusercontent.com/${EXTENSIONS_REPO}/main/registry.json`,
  ]
}

/** The sibling `.sig` URL for one registry URL. */
function signatureUrlFor(registryUrl) {
  const override = process.env.OFM_EXTENSIONS_REGISTRY
  if (override !== undefined && override !== '') return `${override.replace(/\.json$/, '')}.sig`
  if (registryUrl.includes('raw.githubusercontent.com')) return `${registryUrl.replace(/\.json$/, '')}.sig`
  if (registryUrl.includes('jsdelivr.net')) return registryUrl.replace(/registry\.json/, 'registry.sig')
  if (registryUrl.startsWith('https://gh-proxy.com/')) return `${registryUrl.replace(/\.json$/, '')}.sig`
  return `${registryUrl.replace(/\.json$/, '')}.sig`
}

// ── manifest ─────────────────────────────────────────────────────────────────

const MANIFEST_ID_RE = /^[a-z][a-z0-9-]{1,47}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const NETWORK_ORIGIN_RE = /^https?:\/\//
const EXTENSION_TYPES = new Set(['channel', 'enhancement'])

/**
 * Validate one `ofm-plugin.json` into the normalized shape the rest of the
 * platform reads, or throw with the reason. Untrusted by definition — it
 * travels inside a signed registry, but the signer is a build script and this
 * is the last reader.
 */
export function parseExtensionManifest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest must be a JSON object')
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!MANIFEST_ID_RE.test(id)) throw new Error(`manifest id "${id}" must match ${MANIFEST_ID_SOURCE}`)
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  if (!SEMVER_RE.test(version)) throw new Error(`manifest version "${version}" is not semver`)
  if (!EXTENSION_TYPES.has(raw.type)) throw new Error('manifest type must be "channel" or "enhancement"')
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 64) : id
  const main = typeof raw.main === 'string' && raw.main.trim() !== '' ? raw.main.trim() : 'main.mjs'
  if (!/^[\w.-]+\.mjs$/.test(main) || main.includes('..')) throw new Error('manifest main must be a relative .mjs file name')
  const permissions = normalizePermissions(raw.permissions)
  const minHost = typeof raw.minHost === 'string' && SEMVER_RE.test(raw.minHost.trim()) ? raw.minHost.trim() : '0.0.0'
  const manifest = {
    schemaVersion: 1,
    id, version, type: raw.type, name, main,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 400) : '',
    author: typeof raw.author === 'string' ? raw.author.slice(0, 80) : '',
    license: typeof raw.license === 'string' ? raw.license.slice(0, 40) : '',
    homepage: safeUrl(raw.homepage),
    repository: safeUrl(raw.repository),
    icon: typeof raw.icon === 'string' ? raw.icon.slice(0, 200) : '',
    minHost,
    permissions,
    replaces: typeof raw.replaces === 'string' ? raw.replaces : undefined,
    ...(raw.type === 'enhancement' ? { hooks: normalizeHooks(raw.hooks) } : {}),
    ...(raw.type === 'channel' && Array.isArray(raw.models) ? { models: raw.models.slice(0, 256) } : {}),
    config: normalizeConfig(raw.config),
  }
  return manifest
}

const MANIFEST_ID_SOURCE = '/^[a-z][a-z0-9-]{1,47}$/'

function safeUrl(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.href : ''
  } catch { return '' }
}

/** Like `safeUrl`, but a loopback http address is also accepted — the offline
 *  suite and self-hosted registries live there. */
function safeTransportUrl(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'https:') return parsed.href
    if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return parsed.href
    return ''
  } catch { return '' }
}

function normalizePermissions(raw) {
  const permissions = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const network = (Array.isArray(permissions.network) ? permissions.network : [])
    .map(origin => String(origin ?? '').trim().replace(/\/+$/, ''))
    .filter(origin => NETWORK_ORIGIN_RE.test(origin) && origin.length <= 128)
    .slice(0, 8)
  const secrets = (Array.isArray(permissions.secrets) ? permissions.secrets : [])
    .map(key => String(key ?? '').trim())
    .filter(key => /^[\w-]{1,64}$/.test(key))
    .slice(0, 8)
  return { network, secrets, storage: permissions.storage === true }
}

function normalizeHooks(raw) {
  const allowed = new Set(['onRequest', 'onModels', 'onUsage'])
  const hooks = (Array.isArray(raw) ? raw : []).filter(hook => allowed.has(hook))
  return hooks.length > 0 ? hooks : ['onRequest']
}

function normalizeConfig(raw) {
  const rows = Array.isArray(raw) ? raw : []
  const out = []
  for (const row of rows.slice(0, 12)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const key = typeof row.key === 'string' && /^[\w-]{1,64}$/.test(row.key) ? row.key : ''
    if (key === '') continue
    const type = ['text', 'password', 'toggle', 'number', 'select'].includes(row.type) ? row.type : 'text'
    out.push({
      key,
      type,
      label: typeof row.label === 'string' ? row.label.slice(0, 80) : key,
      description: typeof row.description === 'string' ? row.description.slice(0, 200) : '',
      default: row.default,
      ...(type === 'select' && Array.isArray(row.options) ? { options: row.options.slice(0, 16).map(String) } : {}),
    })
  }
  return out
}

// ── registry ─────────────────────────────────────────────────────────────────

/**
 * Verify one registry document's Ed25519 signature over its canonical form.
 * A signature that cannot be checked is a signature that is not there.
 */
export function verifyRegistrySignature(registry, signatureBase64, publicKeyBase64) {
  if (typeof signatureBase64 !== 'string' || signatureBase64 === '') return false
  if (typeof publicKeyBase64 !== 'string' || publicKeyBase64 === '') return false
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(stableStringify(registry)), key, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/** Validate the registry document's entries; drops malformed ones silently. */
export function parseRegistry(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('registry document must be a JSON object')
  if (!Array.isArray(payload.plugins)) throw new Error('registry document must carry a plugins array')
  const seen = new Set()
  const plugins = []
  for (const row of payload.plugins.slice(0, 256)) {
    try {
      const manifest = parseExtensionManifest(row)
      const main = row.main !== null && typeof row.main === 'object' && !Array.isArray(row.main) ? row.main : {}
      const url = safeTransportUrl(main.url)
      if (url === '') throw new Error('entry main.url must be an https (or loopback http) URL')
      if (!Number.isInteger(main.size) || main.size <= 0 || main.size > EXTENSION_SOURCE_MAX_BYTES) throw new Error('entry main.size is out of range')
      if (typeof main.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(main.sha256)) throw new Error('entry main.sha256 is malformed')
      if (!hostAllowed(url)) throw new Error(`entry main.url host is not an accepted mirror: ${url}`)
      plugins.push({
        manifest,
        url,
        size: main.size,
        sha256: main.sha256,
        summary: typeof row.summary === 'string' ? row.summary.slice(0, 300) : '',
        tags: Array.isArray(row.tags) ? row.tags.slice(0, 8).map(String) : [],
        publishedAt: typeof row.publishedAt === 'string' ? row.publishedAt : '',
      })
      seen.add(manifest.id)
    } catch { /* a broken entry is one card fewer, never a broken market */ }
  }
  return { schemaVersion: 1, generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : '', plugins }
}

/** Only the registry repo's own hosts serve extension code — plus, when the
 *  registry source itself is overridden (the offline suite, a self-hosted
 *  mirror), that override's own origin. */
function hostAllowed(url) {
  const override = process.env.OFM_EXTENSIONS_REGISTRY
  if (override !== undefined && override !== '') {
    try {
      const registryOrigin = new URL(override).origin
      const parsed = new URL(url)
      if (parsed.origin === registryOrigin) return true
    } catch { /* fall through to the standard hosts */ }
  }
  try {
    const parsed = new URL(url)
    if (!REGISTRY_HOSTS.has(parsed.hostname)) return false
    if (parsed.protocol !== 'https:') return false
    if (parsed.hostname === 'raw.githubusercontent.com') return parsed.pathname.startsWith(`/${EXTENSIONS_REPO}/`)
    if (parsed.hostname.endsWith('jsdelivr.net')) return parsed.pathname.startsWith(`/gh/${EXTENSIONS_REPO}@`)
    if (parsed.hostname === 'gh-proxy.com') return parsed.pathname.includes(`raw.githubusercontent.com/${EXTENSIONS_REPO}/`)
    return false
  } catch { return false }
}

// ── static scan ──────────────────────────────────────────────────────────────

/** The APIs an extension must never name. Case-sensitive on purpose for most,
 *  with the noisy ones folded. */
const BANNED_SOURCE_PATTERNS = [
  /\brequire\s*\(/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bglobal\s*\./,
  /\bFunction\s*\(/,
  /\beval\s*\(/,
  /\bWebAssembly\b/,
  /\bimportScripts\b/,
  /\bchild_process\b/,
  /\bworker_threads\b/,
  /\bnode\s*:\s*(?:fs|path|os|net|tls|dns|http|https|child_process|worker_threads|module|vm|inspector)\b/,
  /\bimport\s*\(/,
]

/**
 * Static scan of one extension's source, before it ever executes. This is a
 * tripwire for the obvious and the accidental — a reviewed, signed extension
 * has already passed CI's deeper lint — and it is deliberately readable about
 * what it refuses.
 */
export function scanExtensionSource(source, { manifest } = {}) {
  const violations = []
  const text = String(source ?? '')
  if (text.length > EXTENSION_SOURCE_MAX_BYTES) violations.push(`source is ${text.length} bytes; the limit is ${EXTENSION_SOURCE_MAX_BYTES}`)
  if (text.trim() === '') violations.push('source is empty')
  // Import specifiers live inside strings, so they are read from the raw
  // source; the API tripwire runs over the stripped text so a quoted manual
  // ("never call process") is prose, not a violation.
  const imports = text.matchAll(/\bimport\b[^'";]*['"]([^'"]+)['"]/g)
  for (const match of imports) {
    if (match[1] !== 'ofm:sdk') violations.push(`import of "${match[1]}" — only "ofm:sdk" is available`)
  }
  const withoutStringsAndComments = stripStringsAndComments(text)
  for (const pattern of BANNED_SOURCE_PATTERNS) {
    if (pattern.test(withoutStringsAndComments)) violations.push(`source names a forbidden API: ${pattern}`)
  }
  // Minified/bundled sources are refused on review grounds, not security: an
  // unreadable diff cannot be reviewed.
  const lines = text.split('\n')
  const longLines = lines.filter(line => line.length > 500).length
  if (longLines > 2) violations.push(`${longLines} lines exceed 500 characters — bundles and minified output are not reviewable`)
  return { ok: violations.length === 0, violations }
}

/** Blank comments and string bodies so pattern scans read code, not prose. */
function stripStringsAndComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const end = stringEnd(source, index, char)
      if (end !== -1) {
        out += char + char
        index = end + 1
        continue
      }
    }
    out += char
    index += 1
  }
  return out
}

/**
 * The index of the quote closing the string opened at `start`, or -1 when this
 * quote does not open one. A single- or double-quoted literal cannot span a raw
 * newline, so a lone quote is a character inside something else — a regular
 * expression such as `/['"]/`, for one. Repairing to end-of-file from there
 * would blank everything after it and retire every tripwire below, silently and
 * depending only on the author's punctuation. Template literals may span lines,
 * so they keep scanning for their backtick.
 */
function stringEnd(source, start, quote) {
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') { index += 2; continue }
    if (char === quote) return index
    if (char === '\n' && quote !== '`') return -1
    index += 1
  }
  return -1
}

// ── the sandbox worker ───────────────────────────────────────────────────────

/**
 * The worker source, inlined like the Bun worker's (`src/bun-fetch.js`): one
 * Worker per enabled extension, each loading its module inside a `vm` context
 * whose only import is the synthetic `ofm:sdk`. No request content is
 * evaluated; the bridge talks JSON in both directions.
 */
const WORKER_SOURCE = `
import { parentPort } from 'node:worker_threads'
import vm from 'node:vm'

let state = null // { manifest, hooks, config, sdk }
let rpcId = 0
const pending = new Map()

parentPort.on('message', async message => {
  try {
    if (message === null || typeof message !== 'object') return
    if (message.event === 'rpc-reply') {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(new Error(String(message.error ?? 'bridge call failed')))
      return
    }
    const reply = { id: message.id }
    try {
      reply.result = await handle(message)
      reply.ok = true
    } catch (error) {
      reply.ok = false
      reply.error = String(error?.message ?? error)
    }
    parentPort.postMessage(reply)
  } catch (error) {
    parentPort.postMessage({ id: message?.id, ok: false, error: String(error?.message ?? error) })
  }
})

function bridge(method, params) {
  rpcId += 1
  const id = rpcId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    parentPort.postMessage({ event: 'rpc', id, method, params })
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('bridge call timed out')) }
    }, 15000).unref()
  })
}

async function handle(message) {
  if (message.action === 'load') {
    const manifest = message.manifest
    const allowed = (manifest.permissions?.network ?? []).map(origin => String(origin).replace(/\\/+$/, ''))
    const sdk = {
      config: message.config ?? {},
      meta: { id: manifest.id, version: manifest.version, type: manifest.type, host: message.hostVersion ?? '' },
      log: (...args) => { void bridge('log', { args: args.map(value => typeof value === 'string' ? value.slice(0, 500) : JSON.stringify(value)?.slice(0, 500) ?? String(value)) }) },
      fetch: async (url, init) => {
        const target = new URL(String(url))
        const origin = target.origin
        if (!allowed.includes(origin)) throw new Error(\`network origin "\${origin}" is not in this extension's permissions\`)
        if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('only http(s) is available')
        const response = await fetch(target, {
          method: init?.method ?? 'GET',
          headers: init?.headers,
          body: init?.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
          redirect: 'error',
        })
        const text = await response.text()
        return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), text, json: () => JSON.parse(text) }
      },
      storage: {
        get: async key => (await bridge('storage-get', { key })) ?? null,
        set: async (key, value) => { await bridge('storage-set', { key, value }) },
        delete: async key => { await bridge('storage-delete', { key }) },
      },
      secrets: {
        get: async key => (await bridge('secrets-get', { key })) ?? null,
      },
    }
    const context = vm.createContext({
      defineChannel: value => ({ type: 'channel', value }),
      defineEnhancement: value => ({ type: 'enhancement', value }),
    })
    const module = new vm.SourceTextModule(message.source, { identifier: manifest.main, context })
    const sdkModule = new vm.SyntheticModule(['sdk'], () => {
      // setExport rides the module itself (the evaluate callback's arguments
      // differ across Node lines, so the closure is the portable handle).
      sdkModule.setExport('sdk', sdk)
    }, { context })
    await module.link(specifier => {
      if (specifier === 'ofm:sdk') return sdkModule
      throw new Error(\`import of "\${specifier}" is not available in the extension sandbox\`)
    })
    await module.evaluate({ timeout: 5000 })
    const exported = module.namespace.default
    const value = exported?.value ?? exported
    if (value === null || typeof value !== 'object') throw new Error('the module must default-export defineChannel({...}) or defineEnhancement({...})')
    const declaredType = exported?.type ?? manifest.type
    if (declaredType !== manifest.type) throw new Error(\`the module exports a \${declaredType} but the manifest declares a \${manifest.type}\`)
    const hooks = {}
    for (const hook of manifest.type === 'channel' ? ['listModels', 'prepareChat'] : (manifest.hooks ?? ['onRequest'])) {
      if (typeof value[hook] === 'function') hooks[hook] = value[hook]
    }
    if (typeof value.selfTest === 'function') hooks.selfTest = value.selfTest
    const required = manifest.type === 'channel' ? ['prepareChat'] : (manifest.hooks ?? ['onRequest'])
    for (const hook of required) {
      if (typeof hooks[hook] !== 'function') throw new Error(\`the module does not implement the \${hook} hook its manifest declares\`)
    }
    state = { manifest, hooks, config: message.config ?? {}, sdk }
    return { ok: true }
  }
  if (message.action === 'call') {
    if (state === null) throw new Error('the extension is not loaded')
    const hook = state.hooks[message.hook]
    if (typeof hook !== 'function') throw new Error(\`the extension does not implement \${message.hook}\`)
    const ctx = { manifest: state.manifest, config: state.config, ...state.sdk, ...(message.context ?? {}) }
    const result = await hook(ctx, ...message.args)
    return JSON.parse(JSON.stringify(result ?? null))
  }
  throw new Error('unknown action')
}
`

// ── the runtime ──────────────────────────────────────────────────────────────

/**
 * One installed extension's live process. Owns its Worker, its RPC sequence,
 * its timeout policy and its restart-on-crash; everything above this class
 * speaks plain async calls.
 */
class ExtensionProcess {
  constructor({ manifest, source, config, secrets, hostVersion, logger }) {
    this.manifest = manifest
    this.source = source
    this.config = config
    this.secrets = secrets
    this.hostVersion = hostVersion
    this.logger = logger
    this.worker = null
    this.rpcId = 0
    this.pending = new Map()
    this.starting = null
    this.state = 'stopped' // stopped | starting | ready | failed
    this.error = ''
  }

  async start() {
    if (this.starting !== null) return this.starting
    if (this.worker !== null) return
    this.state = 'starting'
    this.starting = (async () => {
      try {
        this.worker = new Worker(WORKER_SOURCE, {
          eval: true,
          execArgv: ['--experimental-vm-modules'],
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
        })
        this.worker.unref()
        this.worker.on('message', message => this.onMessage(message))
        this.worker.on('error', error => this.onDeath(String(error?.message ?? error)))
        this.worker.on('exit', code => this.onDeath(code === 0 ? 'the extension stopped' : `the extension exited with code ${code}`))
        await this.request({ action: 'load', manifest: this.manifest, source: this.source, config: this.config, hostVersion: this.hostVersion }, HOOK_TIMEOUT_MS.load)
        this.state = 'ready'
        this.error = ''
      } catch (error) {
        this.state = 'failed'
        this.error = String(error?.message ?? error)
        this.kill()
        throw error
      } finally {
        this.starting = null
      }
    })()
    return this.starting
  }

  onMessage(message) {
    if (message === null || typeof message !== 'object') return
    if (message.event === 'rpc') {
      void this.handleBridge(message)
      return
    }
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(String(message.error ?? 'the extension failed')))
  }

  async handleBridge(message) {
    const params = message.params ?? {}
    try {
      if (message.method === 'log') {
        this.logger?.warn?.(`extension ${this.manifest.id}: ${String(params.args ?? []).join(' ').slice(0, 500)}`)
      } else if (message.method === 'storage-get') {
        this.reply(message.id, true, this.storageRead()[String(params.key ?? '').slice(0, 128)] ?? null)
      } else if (message.method === 'storage-set') {
        const store = this.storageRead()
        store[String(params.key ?? '').slice(0, 128)] = params.value ?? null
        this.storageWrite(store)
        this.reply(message.id, true, null)
      } else if (message.method === 'storage-delete') {
        const store = this.storageRead()
        delete store[String(params.key ?? '').slice(0, 128)]
        this.storageWrite(store)
        this.reply(message.id, true, null)
      } else if (message.method === 'secrets-get') {
        const key = String(params.key ?? '')
        if (!this.manifest.permissions.secrets.includes(key)) {
          this.reply(message.id, false, `secret "${key}" is not in this extension's permissions`)
          return
        }
        this.reply(message.id, true, this.secrets[key] ?? null)
      } else {
        this.reply(message.id, false, 'unknown bridge method')
      }
    } catch (error) {
      this.reply(message.id, false, String(error?.message ?? error))
    }
  }

  reply(id, ok, result) {
    this.worker?.postMessage({ id, ok, result, event: 'rpc-reply' })
  }

  storagePath() { return this.paths?.storage }
  storageRead() {
    try { return JSON.parse(fs.readFileSync(this.storagePath(), 'utf8')) } catch { return {} }
  }
  storageWrite(value) {
    if (this.storagePath() === undefined) return
    try {
      fs.mkdirSync(path.dirname(this.storagePath()), { recursive: true })
      fs.writeFileSync(this.storagePath(), JSON.stringify(value, null, 1), { mode: 0o600 })
      restrictPermissions(this.storagePath())
    } catch { /* a full disk is logged by the next read's failure */ }
  }

  onDeath(reason) {
    if (this.worker === null) return
    this.worker = null
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`the extension stopped: ${reason}`))
    }
    this.pending.clear()
    if (this.state !== 'failed') {
      this.state = 'stopped'
      this.error = reason
    }
  }

  kill() {
    const worker = this.worker
    this.worker = null
    const termination = worker?.terminate().catch(() => {}) ?? Promise.resolve()
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('the extension was stopped'))
    }
    this.pending.clear()
    if (this.state !== 'failed') this.state = 'stopped'
    return termination
  }

  request(payload, timeoutMs) {
    if (this.worker === null) return Promise.reject(new Error('the extension is not running'))
    this.rpcId += 1
    const id = this.rpcId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.state = 'failed'
        this.error = `the extension did not answer ${payload.action ?? payload.hook} within ${Math.round(timeoutMs / 1000)}s`
        this.logger?.warn?.(`our-free-model: extension ${this.manifest.id} ${this.error}; stopping it`)
        this.kill()
        reject(new Error(this.error))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, ...payload })
    })
  }

  async call(hook, args, context, timeoutKey = hook) {
    if (this.state === 'failed') throw new Error(this.error)
    if (this.state !== 'ready') await this.start()
    return this.request({ action: 'call', hook, args, context }, HOOK_TIMEOUT_MS[timeoutKey] ?? 10_000)
  }
}

/**
 * The extension runtime: the install store, the registry client, and the live
 * processes of every enabled extension — the one object `index.js` holds.
 */
export function createExtensionRuntime({
  dataDir,
  logger = console,
  hostVersion = '0.0.0',
  onCatalogChanged = () => {},
} = {}) {
  const rootDir = path.join(dataDir, 'extensions')
  const installDir = id => path.join(rootDir, 'packages', id)
  const lockPath = path.join(rootDir, 'installed.json')
  const registryCachePath = path.join(rootDir, 'registry-cache.json')
  const auditPath = path.join(rootDir, 'audit.jsonl')
  const configPath = path.join(rootDir, 'config.json')
  const secretsPath = path.join(rootDir, 'secrets.json')

  /** id -> ExtensionProcess (channels and enhancements, enabled only). */
  const processes = new Map()
  let registryCache = null
  let channelRows = []
  let channelManifests = new Map()
  let disposed = false

  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return structuredClone(fallback) }
  }
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const staged = `${file}.tmp`
    fs.writeFileSync(staged, JSON.stringify(value, null, 1), { mode: 0o600 })
    fs.renameSync(staged, file)
    restrictPermissions(file)
  }
  const readLock = () => readJson(lockPath, { version: 1, extensions: {} })
  const writeLock = lock => writeJson(lockPath, lock)
  const readConfigStore = () => readJson(configPath, { version: 1, values: {} })
  const readSecrets = () => readJson(secretsPath, { version: 1, values: {} })

  function audit(action, id, detail = {}) {
    try {
      fs.mkdirSync(rootDir, { recursive: true })
      let lines = []
      try { lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).slice(-AUDIT_MAX_LINES) } catch { /* fresh log */ }
      lines.push(JSON.stringify({ at: new Date().toISOString(), action, id, ...detail }))
      while (lines.length > AUDIT_MAX_LINES) lines.shift()
      fs.writeFileSync(auditPath, `${lines.join('\n')}\n`, { mode: 0o600 })
    } catch { /* the audit trail never blocks the lane */ }
  }

  function sourcePathFor(id, version) {
    const record = readLock().extensions[id]
    const safeVersion = record?.manifest?.version === version ? version : String(version ?? '').replace(/[^\w.-]/g, '')
    return path.join(installDir(id), safeVersion, 'main.mjs')
  }

  /** Verify an installed package still hashes to what the registry signed. */
  function verifyInstalled(id) {
    const record = readLock().extensions[id]
    if (record === undefined) throw new Error(`extension "${id}" is not installed`)
    const file = path.join(installDir(id), record.manifest.version, 'main.mjs')
    let source
    try { source = fs.readFileSync(file, 'utf8') } catch { throw new Error(`extension "${id}" is missing its code on disk`) }
    const digest = crypto.createHash('sha256').update(source).digest('hex')
    if (digest !== record.sha256) throw new Error(`extension "${id}" failed its integrity check; reinstall it`)
    return { record, source }
  }

  async function startExtension(record, source) {
    const { manifest } = record
    const config = readConfigStore().values[manifest.id] ?? {}
    const secrets = readSecrets().values[manifest.id] ?? {}
    const paths = { storage: path.join(rootDir, 'storage', `${manifest.id}.json`) }
    // Retire whatever process already holds this id before taking its slot.
    // The map keeps exactly one worker per extension, so an entry overwritten
    // in place would leave its thread running with no handle left to stop it —
    // unreachable, unbounded, and re-running the module's `load` side effects.
    const retired = processes.get(manifest.id)
    if (retired !== undefined) {
      processes.delete(manifest.id)
      await retired.kill()
    }
    const process_ = new ExtensionProcess({ manifest, source, config, secrets, hostVersion, logger })
    process_.paths = paths
    processes.set(manifest.id, process_)
    try {
      await process_.start()
    } catch (error) {
      processes.delete(manifest.id)
      throw error
    }
    return process_
  }

  async function stopExtension(id) {
    const process_ = processes.get(id)
    processes.delete(id)
    process_?.kill()
    await Promise.resolve()
  }

  /** Stop and start one extension so it re-reads config/secrets from disk. */
  async function restartExtension(id) {
    const lock = readLock()
    const record = lock.extensions[id]
    if (record === undefined || record.enabled !== true) return
    try {
      const { source } = verifyInstalled(id)
      await stopExtension(id)
      await startExtension(record, source)
      if (record.manifest.type === 'channel') {
        channelManifests.set(id, record.manifest)
        const rows = await listChannelModels(processes.get(id), record.manifest)
        channelRows = [
          ...channelRows.filter(row => row.extensionId !== id),
          ...buildExtensionCatalog(record.manifest, rows),
        ]
        onCatalogChanged()
      }
    } catch (error) {
      logger?.warn?.(`our-free-model: extension "${id}" restart failed (${String(error?.message ?? error).slice(0, 200)})`)
    }
  }

  // ── install / uninstall ──────────────────────────────────────────────────

  async function install(id, { version } = {}) {
    if (disposed) throw new Error('the extension runtime is stopped')
    const registry = await refreshRegistry()
    const entry = registry.plugins.find(plugin => plugin.manifest.id === id)
    if (entry === undefined) throw new Error(`the registry does not carry "${id}"`)
    if (version !== undefined && entry.manifest.version !== version) throw new Error(`the registry carries "${id}" at ${entry.manifest.version}, not ${version}`)
    const lock = readLock()
    if (Object.keys(lock.extensions).length >= MAX_INSTALLED && lock.extensions[id] === undefined) {
      throw new Error(`at most ${MAX_INSTALLED} extensions may be installed at once`)
    }
    // Download from the signed registry's URL only, verify size + digest.
    const response = await fetch(entry.url, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`the extension's source answered HTTP ${response.status}`)
    const source = await response.text()
    if (source.length !== entry.size) throw new Error(`the extension's source is ${source.length} bytes, the registry signed ${entry.size}`)
    const digest = crypto.createHash('sha256').update(source).digest('hex')
    if (digest !== entry.sha256) throw new Error('the downloaded extension does not match its signed digest')
    const scan = scanExtensionSource(source, { manifest: entry.manifest })
    if (!scan.ok) throw new Error(`the extension failed its pre-install scan: ${scan.violations.join('; ')}`)
    if (entry.manifest.main !== 'main.mjs') {
      // A non-default main name is legal in the manifest but the registry
      // format ships exactly one file; keep them congruent.
      throw new Error(`the manifest names "${entry.manifest.main}" but the registry ships one main.mjs`)
    }
    const dir = path.join(installDir(id), entry.manifest.version)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'main.mjs')
    fs.writeFileSync(file, source, { mode: 0o600 })
    restrictPermissions(file)
    const previous = lock.extensions[id]
    lock.extensions[id] = {
      manifest: entry.manifest,
      sha256: entry.sha256,
      url: entry.url,
      installedAt: new Date().toISOString(),
      enabled: previous?.enabled ?? (entry.manifest.type === 'channel'),
      updateSeen: previous?.updateSeen,
    }
    writeLock(lock)
    audit('install', id, { version: entry.manifest.version, sha256: entry.sha256, previous: previous?.manifest.version })
    // The bytes may differ even when the version matches (a republished
    // package). Retire the running worker first so remount's reuse path cannot
    // keep serving the source that was on disk a moment ago.
    await stopExtension(id)
    await remount()
    onCatalogChanged()
    return publicRecord(lock.extensions[id])
  }

  async function uninstall(id) {
    const lock = readLock()
    if (lock.extensions[id] === undefined) throw new Error(`extension "${id}" is not installed`)
    await stopExtension(id)
    delete lock.extensions[id]
    writeLock(lock)
    fs.rmSync(installDir(id), { recursive: true, force: true })
    audit('uninstall', id)
    await remount()
    onCatalogChanged()
  }

  async function setEnabled(id, enabled) {
    const lock = readLock()
    const record = lock.extensions[id]
    if (record === undefined) throw new Error(`extension "${id}" is not installed`)
    record.enabled = enabled === true
    writeLock(lock)
    audit('set-enabled', id, { enabled: record.enabled })
    await remount()
    onCatalogChanged()
    return publicRecord(record)
  }

  async function saveConfig(id, values) {
    const lock = readLock()
    const record = lock.extensions[id]
    if (record === undefined) throw new Error(`extension "${id}" is not installed`)
    const store = readConfigStore()
    const previous = store.values[id] ?? {}
    const clean = {}
    for (const field of record.manifest.config) {
      if (!(field.key in values)) continue
      clean[field.key] = sanitizeValue(values[field.key], field.type)
    }
    store.values[id] = { ...previous, ...clean }
    writeJson(configPath, store)
    // The worker captured its config at load; a running extension must restart
    // to see new values (a hot patch would race the module's own reads). The
    // caller awaits the restart, so the next turn already sees the new values.
    await restartExtension(id)
    return publicRecord(record)
  }

  async function saveSecret(id, key, value) {
    const lock = readLock()
    const record = lock.extensions[id]
    if (record === undefined) throw new Error(`extension "${id}" is not installed`)
    if (!record.manifest.permissions.secrets.includes(key)) throw new Error(`secret "${key}" is not declared by "${id}"`)
    const store = readSecrets()
    store.values[id] = { ...(store.values[id] ?? {}), [key]: String(value ?? '') }
    writeJson(secretsPath, store)
    audit('set-secret', id, { key })
    // Same freshness rule as saveConfig: secrets are read at load.
    await restartExtension(id)
    return publicRecord(record)
  }

  function sanitizeValue(value, type) {
    if (type === 'toggle') return value === true
    if (type === 'number') {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
    return String(value ?? '').slice(0, 300)
  }

  // ── registry ─────────────────────────────────────────────────────────────

  async function refreshRegistry({ force = false } = {}) {
    const cached = readJson(registryCachePath, null)
    if (cached !== null && !force && Date.now() - (cached.fetchedAt ?? 0) < REGISTRY_TTL_MS && Array.isArray(cached.registry?.plugins)) {
      registryCache = cached
      return cached.view
    }
    const errors = []
    for (const source of registrySources()) {
      try {
        const [registryResponse, signatureResponse] = await Promise.all([
          fetch(source, { redirect: 'error', signal: AbortSignal.timeout(10_000) }),
          fetch(signatureUrlFor(source), { redirect: 'error', signal: AbortSignal.timeout(10_000) }),
        ])
        if (!registryResponse.ok) throw new Error(`HTTP ${registryResponse.status}`)
        const text = await registryResponse.text()
        if (text.length > REGISTRY_MAX_BYTES) throw new Error(`the registry is ${text.length} bytes; the limit is ${REGISTRY_MAX_BYTES}`)
        const payload = JSON.parse(text)
        const signature = (await signatureResponse.text()).trim()
        const publicKey = process.env.OFM_EXTENSIONS_PUBLIC_KEY ?? PINNED_EXTENSIONS_PUBLIC_KEY
        const allowUnsigned = process.env.OFM_EXTENSIONS_ALLOW_UNSIGNED === '1' && process.env.OFM_EXTENSIONS_REGISTRY !== undefined
        if (!allowUnsigned && !verifyRegistrySignature(payload, signature, publicKey)) {
          throw new Error('the registry failed its signature check')
        }
        const view = parseRegistry(payload)
        if (view.plugins.length === 0) throw new Error('the registry carries no readable entries')
        registryCache = { fetchedAt: Date.now(), source, registry: payload, signature, view }
        writeJson(registryCachePath, registryCache)
        return view
      } catch (error) {
        errors.push(`${new URL(source).hostname}: ${String(error?.message ?? error).slice(0, 120)}`)
      }
    }
    if (cached !== null && Array.isArray(cached.registry?.plugins)) {
      logger?.warn?.(`our-free-model: the extension registry could not be refreshed (${errors.join('; ')}); serving the cache from ${new Date(cached.fetchedAt).toISOString()}`)
      registryCache = cached
      return cached.view
    }
    throw new Error(`the extension registry is unreachable (${errors.join('; ')})`)
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** (Re)start every enabled extension and rebuild the channel lane's rows. */
  async function remount() {
    if (disposed) return
    const lock = readLock()
    // Retire only the processes nobody wants any more: one whose extension was
    // removed or disabled, one whose version changed, and one that already
    // failed. Everything else keeps its worker — a reconcile that rebuilt the
    // healthy ones would re-run their `load` on every marketplace action, and
    // the replaced worker would leak.
    for (const [id, process_] of [...processes]) {
      const record = lock.extensions[id]
      const wanted = record !== undefined && record.enabled === true
        && record.manifest.version === process_.manifest.version
      if (wanted && process_.state !== 'failed') continue
      processes.delete(id)
      process_.kill()
    }
    channelRows = []
    channelManifests = new Map()
    for (const [id, record] of Object.entries(lock.extensions)) {
      if (record.enabled !== true) continue
      try {
        const { source } = verifyInstalled(id)
        const existing = processes.get(id)
        const process_ = existing !== undefined ? existing : await startExtension(record, source)
        if (record.manifest.type === 'channel') {
          channelManifests.set(id, record.manifest)
          const rows = await listChannelModels(process_, record.manifest)
          channelRows = channelRows.concat(buildExtensionCatalog(record.manifest, rows))
        }
      } catch (error) {
        // A row whose bytes no longer hash to the signed digest is not served:
        // stop it, and let the warning say why.
        const stale = processes.get(id)
        if (stale !== undefined) {
          processes.delete(id)
          stale.kill()
        }
        logger?.warn?.(`our-free-model: extension "${id}" did not start (${String(error?.message ?? error).slice(0, 200)})`)
      }
    }
  }

  async function listChannelModels(process_, manifest) {
    if (Array.isArray(manifest.models)) return manifest.models
    try {
      return await process_.call('listModels', [], { manifest }, 'listModels')
    } catch (error) {
      logger?.warn?.(`our-free-model: extension "${manifest.id}" model list failed (${String(error?.message ?? error).slice(0, 200)})`)
      return []
    }
  }

  // ── the lane surface the adapter calls ───────────────────────────────────

  /**
   * Turn one harness request into the upstream call an extension channel
   * serves. The adapter has already built the wire-shaped payload; the
   * extension names where it goes and with which headers, and may rewrite the
   * body (never the model or the stream flag).
   */
  async function prepareChat(entry, payload, session) {
    const process_ = processes.get(entry.extensionId)
    if (process_ === undefined) throw new Error(`extension "${entry.extensionId}" is not running`)
    const request = {
      model: entry.modelId,
      wire: entry.wire,
      messages: payload.messages ?? payload.input ?? [],
      tools: payload.tools,
      maxTokens: payload.max_tokens ?? payload.max_completion_tokens,
      temperature: payload.temperature,
      sessionId: session ?? '',
    }
    const prepared = await process_.call('prepareChat', [request], { manifest: process_.manifest }, 'prepareChat')
    if (prepared === null || typeof prepared !== 'object' || typeof prepared.url !== 'string') {
      throw new Error(`extension "${entry.extensionId}" returned no url for this turn`)
    }
    const target = new URL(prepared.url)
    const allowed = process_.manifest.permissions.network
    if (!allowed.includes(target.origin)) {
      throw new Error(`extension "${entry.extensionId}" named ${target.origin}, which its permissions do not allow`)
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new Error(`extension "${entry.extensionId}" named a ${target.protocol} endpoint`)
    }
    const headers = {}
    for (const [key, value] of Object.entries(prepared.headers ?? {})) {
      const name = String(key).toLowerCase()
      // The extension's own credentials ride its headers; the hop-by-hop set
      // and anything that would re-frame or re-address the request do not.
      if (['host', 'content-length', 'connection', 'transfer-encoding', 'cookie'].includes(name)) continue
      if (typeof value !== 'string' || value.length > 2048) continue
      headers[name] = value
    }
    let body = prepared.body
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') {
        try { body = JSON.parse(body) } catch { throw new Error(`extension "${entry.extensionId}" returned a body that is not JSON`) }
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error(`extension "${entry.extensionId}" returned a non-object body`)
      }
    } else {
      body = { ...payload }
      delete body.sessionId
    }
    body.model = entry.modelId
    body.stream = true
    if (entry.wire === 'chat' && body.stream_options === undefined) body.stream_options = { include_usage: true }
    const wire = ['chat', 'responses', 'messages'].includes(prepared.wire) ? prepared.wire : entry.wire
    // Serialized: the shared streaming core posts bodies as bytes, exactly as
    // the aggregate lane's resolver hands it a string.
    return { url: target.href, headers, body: JSON.stringify(body), wire, model: entry.modelId, secret: '' }
  }

  /** Enhancement hook: rewrite one outgoing body (fail-open). */
  async function applyRequestHooks(payload, meta) {
    let body = payload
    for (const [id, process_] of processes) {
      if (process_.manifest.type !== 'enhancement') continue
      if (!process_.manifest.hooks.includes('onRequest')) continue
      try {
        const result = await process_.call('onRequest', [body, meta], { manifest: process_.manifest }, 'onRequest')
        if (result !== null && typeof result === 'object' && !Array.isArray(result)) body = result
      } catch (error) {
        logger?.warn?.(`our-free-model: enhancement "${id}" onRequest failed (${String(error?.message ?? error).slice(0, 160)}); the body ships unchanged`)
      }
    }
    return body
  }

  /** Enhancement hook: observe one usage record (never mutates it). */
  function noteUsage(record) {
    for (const [id, process_] of processes) {
      if (process_.manifest.type !== 'enhancement') continue
      if (!process_.manifest.hooks.includes('onUsage')) continue
      process_.call('onUsage', [record, {}], { manifest: process_.manifest }, 'onUsage')
        .catch(error => logger?.warn?.(`our-free-model: enhancement "${id}" onUsage failed (${String(error?.message ?? error).slice(0, 160)})`))
    }
  }

  // ── read models for the API ──────────────────────────────────────────────

  const MASK = value => typeof value === 'string' && value.length >= 8 ? `…${value.slice(-4)}` : '…'

  function publicRecord(record) {
    const manifest = record.manifest
    const process_ = processes.get(manifest.id)
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      description: manifest.description,
      author: manifest.author,
      license: manifest.license,
      homepage: manifest.homepage,
      repository: manifest.repository,
      icon: manifest.icon,
      replaces: manifest.replaces,
      permissions: manifest.permissions,
      config: manifest.config,
      hooks: manifest.hooks ?? [],
      enabled: record.enabled === true,
      installedAt: record.installedAt,
      state: process_ === undefined ? 'stopped' : process_.state,
      error: process_?.error ?? '',
      secrets: manifest.permissions.secrets.map(key => {
        const current = (readSecrets().values[manifest.id] ?? {})[key]
        return { key, hasValue: typeof current === 'string' && current !== '', hint: typeof current === 'string' && current.length >= 4 ? MASK(current) : '' }
      }),
      values: readConfigStore().values[manifest.id] ?? {},
      modelCount: channelManifests.has(manifest.id)
        ? channelRows.filter(row => row.extensionId === manifest.id).length
        : undefined,
    }
  }

  function listInstalled() {
    const lock = readLock()
    return Object.values(lock.extensions).map(record => publicRecord(record))
  }

  function installedVersions() {
    return Object.fromEntries(Object.entries(readLock().extensions).map(([id, record]) => [id, record.manifest.version]))
  }

  /** Registry entries joined with install state — the marketplace page's data. */
  function registryView() {
    const lock = readLock()
    const view = registryCache?.view ?? null
    if (view === null) return null
    return {
      generatedAt: view.generatedAt,
      plugins: view.plugins.map(entry => {
        const installed = lock.extensions[entry.manifest.id]
        return {
          ...entry.manifest,
          summary: entry.summary,
          tags: entry.tags,
          publishedAt: entry.publishedAt,
          installed: installed !== undefined,
          installedVersion: installed?.manifest.version,
          enabled: installed?.enabled === true,
          updateAvailable: installed !== undefined && installed.manifest.version !== entry.manifest.version,
          state: processes.get(entry.manifest.id)?.state ?? 'stopped',
        }
      }),
    }
  }

  return {
    init: remount,
    dispose() {
      disposed = true
      const terminations = []
      for (const [, process_] of processes) terminations.push(process_.kill())
      processes.clear()
      // Worker termination is async; the host's dispose effect may return this
      // so a hot reload does not race a dying worker against a fresh mount.
      return Promise.allSettled(terminations)
    },
    install, uninstall, setEnabled, saveConfig, saveSecret,
    refreshRegistry,
    listInstalled, registryView, installedVersions,
    // The lane surface.
    get catalog() { return channelRows },
    get replacesLane() {
      for (const manifest of channelManifests.values()) {
        const lane = extensionReplaces(manifest)
        if (lane !== null) return lane
      }
      return null
    },
    prepareChat, applyRequestHooks, noteUsage,
    isRunning: id => processes.get(id)?.state === 'ready',
  }
}
