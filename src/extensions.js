/**
 * The OFM plugin platform: signed registry, verified install, sandboxed run.
 *
 * The lane is adapted to this host's constraints (zero runtime dependencies,
 * the host's own trust fence, one data directory per service):
 *
 *   - **The marketplace is a repo**, `Ebony-Vinyl/ofm-extensions`: a
 *     deterministic `registry.json` generated from each package's
 *     `ofm-plugin.json` plus its code and page files, signed by the
 *     maintainer's Ed25519 key into
 *     `registry.sig`. Authors submit pull requests; CI validates schema, code
 *     and tests; a human reviews. "Users upload" means "users open a PR" —
 *     curated distribution with a signature on the index.
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
import { compareVersions } from './semver.js'
import {
  parsePluginManifest,
  manifestHasChannel,
  manifestHasEnhancement,
  manifestHasPage,
  safePluginPath,
  scanExtensionSource,
  scanPageAsset,
  REGISTRY_FALLBACK,
} from './plugins.js'

export { parseExtensionManifest, scanExtensionSource } from './plugins.js'

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
const PAGE_ASSET_MAX_BYTES = 2 * 1024 * 1024
const PAGE_FILE_LIMIT = 32
/** The cover is display-only; a bigger file would outweigh every source. */
const COVER_MAX_BYTES = 192 * 1024
const COVER_NAME_RE = /^[\w.-]+\.(?:png|jpe?g|webp|svg)$/i
const COVER_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }
const MAX_INSTALLED = 32
const AUDIT_MAX_LINES = 2000
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

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

// Manifest parsing lives in ./plugins/manifest.js. v1 and v2 both normalize to
// the same shape, so the installer and runtime below never branch on
// schemaVersion; `parseExtensionManifest` is re-exported above for callers that
// used the old entry point.

/** Like a strict URL check, but a loopback http address is also accepted — the
 *  offline suite and self-hosted registries live there. */
function safeTransportUrl(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'https:') return parsed.href
    if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return parsed.href
    return ''
  } catch { return '' }
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
      const manifest = parsePluginManifest(row)
      const files = registryFiles(row, manifest)
      if (files.length === 0) throw new Error('entry carries no downloadable files')
      const primary = files.find(file => file.path === manifest.main) ?? files[0]
      // The cover is cosmetic — a malformed one costs the image, never the
      // entry: a broken picture must not take a channel down with it.
      let cover
      const rawCover = row.cover !== null && typeof row.cover === 'object' && !Array.isArray(row.cover) ? row.cover : {}
      const coverUrl = safeTransportUrl(rawCover.url)
      if (coverUrl !== '' && hostAllowed(coverUrl)
        && Number.isInteger(rawCover.size) && rawCover.size > 0 && rawCover.size <= COVER_MAX_BYTES
        && typeof rawCover.sha256 === 'string' && /^[0-9a-f]{64}$/.test(rawCover.sha256)) {
        const extension = coverUrl.split('.').pop().split('?')[0].toLowerCase()
        if (COVER_TYPES[extension] !== undefined) cover = { url: coverUrl, size: rawCover.size, sha256: rawCover.sha256, contentType: COVER_TYPES[extension] }
      }
      plugins.push({
        manifest,
        url: primary.url,
        size: primary.size,
        sha256: primary.sha256,
        files,
        cover,
        summary: typeof row.summary === 'string' ? row.summary.slice(0, 300) : '',
        tags: Array.isArray(row.tags) ? row.tags.slice(0, 8).map(String) : [],
        publishedAt: typeof row.publishedAt === 'string' ? row.publishedAt : '',
        changelog: Array.isArray(row.changelog) ? row.changelog.slice(0, 8).map(String) : [],
      })
      seen.add(manifest.id)
    } catch (error) {
      // A broken entry is one card fewer, never a broken market. The opt-in
      // diagnostic exists so an author can see which rule their row missed.
      if (process.env.OFM_PLUGIN_DEBUG === '1') console.error(`plugin entry ${row?.id ?? '?'} refused: ${String(error?.message ?? error)}`)
    }
  }
  return { schemaVersion: payload.schemaVersion === 2 ? 2 : 1, generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : '', plugins }
}

/** One registry file row: path + transport URL + signed size/digest. */
function registryFile(pathValue, raw, max) {
  const filePath = safePluginPath(pathValue)
  if (filePath === null) throw new Error(`entry file path "${pathValue}" is not a safe package path`)
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const url = safeTransportUrl(source.url)
  if (url === '') throw new Error(`entry ${filePath}.url must be an https (or loopback http) URL`)
  if (!Number.isInteger(source.size) || source.size <= 0 || source.size > max) throw new Error(`entry ${filePath}.size is out of range`)
  if (typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256)) throw new Error(`entry ${filePath}.sha256 is malformed`)
  if (!hostAllowed(url)) throw new Error(`entry ${filePath}.url host is not an accepted mirror: ${url}`)
  return { path: filePath, url, size: source.size, sha256: source.sha256 }
}

/**
 * Collect every downloadable file a registry entry names: the code entry, the
 * page bundle, and (for v1) the single `main` object. A v2 entry must not name
 * a file the manifest did not declare, so the signed manifest and the signed
 * file list cannot disagree about what a package contains.
 */
function registryFiles(row, manifest) {
  const declared = new Set(Array.isArray(manifest.files) ? manifest.files : [])
  const files = []
  const seen = new Set()
  const add = (pathValue, raw, max) => {
    const file = registryFile(pathValue, raw, max)
    if (declared.size > 0 && !declared.has(file.path)) throw new Error(`entry file "${file.path}" is not in the manifest files list`)
    if (seen.has(file.path)) throw new Error(`entry file "${file.path}" is listed twice`)
    seen.add(file.path)
    files.push(file)
  }
  if (manifest.main !== '') add(manifest.main, row.main, EXTENSION_SOURCE_MAX_BYTES)
  const ui = row.ui !== null && typeof row.ui === 'object' && !Array.isArray(row.ui) ? row.ui : {}
  const uiFiles = Array.isArray(ui.files) ? ui.files.slice(0, PAGE_FILE_LIMIT) : []
  for (const file of uiFiles) {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) throw new Error('entry ui.files rows must be objects')
    add(file.path, file, PAGE_ASSET_MAX_BYTES)
  }
  if (manifest.pages.length > 0) {
    const listed = new Set(files.map(file => file.path))
    for (const page of manifest.pages) {
      if (!listed.has(page.entry)) throw new Error(`page "${page.id}" entry "${page.entry}" is missing from ui.files`)
    }
    const uiPaths = files.filter(file => file !== undefined && file.path !== manifest.main)
    if (uiPaths.length > PAGE_FILE_LIMIT) throw new Error(`entry ships ${uiPaths.length} page files; the limit is ${PAGE_FILE_LIMIT}`)
  }
  return files
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

// Code and page scans live in ./plugins/scanner.js; `scanExtensionSource` is
// re-exported above so the old import surface keeps working.

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
    return { ok: true, hooks: Object.keys(hooks) }
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
    this.hooks = [] // what the module actually implements, reported by load
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
        const loaded = await this.request({ action: 'load', manifest: this.manifest, source: this.source, config: this.config, hostVersion: this.hostVersion }, HOOK_TIMEOUT_MS.load)
        this.hooks = Array.isArray(loaded?.hooks) ? loaded.hooks : []
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
  /** id -> {manifest, contributions}; always enabled, never uninstallable. */
  const builtins = new Map()
  /** id -> why an enabled plugin is waiting (a required host capability). */
  const pending = new Map()
  /** stable-per-boot capability tokens for sandboxed page assets. */
  const pageTokens = new Map()
  const providedCapabilities = new Set([
    'ui', 'channels', 'enhancements', 'providers', 'clients', 'formats',
    'network', 'storage', 'secrets', 'http',
  ])
  const pageRpcWindow = new Map()
  let watchTimer = null
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
  const storagePathFor = id => path.join(rootDir, 'storage', `${id}.json`)

  function readStorageFile(id) {
    try { return JSON.parse(fs.readFileSync(storagePathFor(id), 'utf8')) } catch { return {} }
  }

  function writeStorageFile(id, value) {
    const file = storagePathFor(id)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const staged = `${file}.tmp`
    fs.writeFileSync(staged, JSON.stringify(value, null, 1), { mode: 0o600 })
    fs.renameSync(staged, file)
    restrictPermissions(file)
  }

  /**
   * Register a built-in contribution. Built-ins use the same manifest and
   * contribution shapes as third-party plugins, but their implementation lives
   * in core code: they are essential, always ready, and cannot be uninstalled.
   * Registering them here is what makes the plugin center one list rather than
   * two worlds.
   */
  function registerBuiltin(descriptor) {
    if (descriptor === null || typeof descriptor !== 'object') throw new Error('builtin descriptor must be an object')
    const manifest = parsePluginManifest({
      schemaVersion: 2,
      kind: 'bundle',
      apiVersion: '^2',
      version: hostVersion,
      ...descriptor.manifest,
      essential: true,
    }, { source: 'builtin' })
    if (builtins.has(manifest.id)) throw new Error(`builtin "${manifest.id}" is already registered`)
    builtins.set(manifest.id, { manifest, contributions: descriptor.contributions ?? {} })
    for (const capability of manifest.provides) providedCapabilities.add(capability)
    return builtins.get(manifest.id)
  }

  function builtinRecord(entry) {
    const { manifest, contributions } = entry
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      kinds: manifest.kinds,
      type: manifest.type,
      description: manifest.description,
      author: manifest.author,
      license: manifest.license,
      homepage: manifest.homepage,
      repository: manifest.repository,
      icon: manifest.icon,
      permissions: manifest.permissions,
      config: [],
      hooks: manifest.hooks ?? [],
      enabled: true,
      builtin: true,
      essential: true,
      verified: true,
      source: 'builtin',
      installedAt: '',
      state: 'ready',
      error: '',
      selfTestAvailable: false,
      secrets: [],
      values: {},
      pages: [],
      pageCount: 0,
      modelCount: Array.isArray(contributions.channels) ? contributions.channels.length : 0,
      provides: manifest.provides,
      requires: manifest.requires,
      apiVersion: manifest.apiVersion,
    }
  }

  /** The first missing host capability, or '' when the plugin can mount. */
  function missingRequirement(manifest) {
    for (const capability of Array.isArray(manifest.requires) ? manifest.requires : []) {
      if (!providedCapabilities.has(capability)) return `需要宿主能力：${capability}`
    }
    return ''
  }

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

  /** Verify an installed package still hashes to what the registry signed. */
  function verifyInstalled(id) {
    const record = readLock().extensions[id]
    if (record === undefined) throw new Error(`extension "${id}" is not installed`)
    const base = path.resolve(installDir(id), record.manifest.version)
    const files = Array.isArray(record.files) && record.files.length > 0
      ? record.files
      : (record.manifest.main !== '' ? [{ path: record.manifest.main, sha256: record.sha256 }] : [])
    let source
    for (const file of files) {
      const full = path.resolve(base, ...String(file.path).split('/'))
      if (full !== base && !full.startsWith(`${base}${path.sep}`)) throw new Error(`extension "${id}" has an unsafe file path`)
      let bytes
      try { bytes = fs.readFileSync(full) } catch { throw new Error(`extension "${id}" is missing ${file.path} on disk`) }
      const digest = crypto.createHash('sha256').update(bytes).digest('hex')
      if (typeof file.sha256 === 'string' && digest !== file.sha256) throw new Error(`extension "${id}" failed its integrity check; reinstall it`)
      if (file.path === record.manifest.main) source = bytes.toString('utf8')
    }
    return { record, source, files }
  }

  function packageFileTarget(dir, relPath) {
    const base = path.resolve(dir)
    const target = path.resolve(base, ...String(relPath).split('/'))
    if (target === base || !target.startsWith(`${base}${path.sep}`)) throw new Error(`unsafe package path "${relPath}"`)
    return target
  }

  function defaultEnabled(manifest) {
    if (manifestHasChannel(manifest) || manifestHasPage(manifest)) return true
    return false
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
    if (record.manifest.main === '') return // a page-only plugin has no worker
    try {
      const { source } = verifyInstalled(id)
      await stopExtension(id)
      await startExtension(record, source)
      if (manifestHasChannel(record.manifest)) {
        channelManifests.set(id, record.manifest)
        const rows = await listChannelModels(processes.get(id), record.manifest)
        channelRows = [
          ...channelRows.filter(row => row.extensionId !== id),
          ...buildExtensionCatalog(record.manifest, rows),
        ]
        channelRows = await applyModelHooks(channelRows)
        onCatalogChanged()
      }
    } catch (error) {
      logger?.warn?.(`our-free-model: extension "${id}" restart failed (${String(error?.message ?? error).slice(0, 200)})`)
    }
  }

  // ── install / uninstall ──────────────────────────────────────────────────

  async function fetchSignedFile(file) {
    const response = await fetch(file.url, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`${file.path} answered HTTP ${response.status}`)
    const raw = Buffer.from(await response.arrayBuffer())
    // The registry's builder signs the decoded source: `size` counts UTF-8
    // code units and the digest runs over the re-encoded text. Accept that
    // convention first, then the raw-byte convention for binary assets — the
    // digest decides which one applies, and the stored bytes are the ones the
    // signature actually covers.
    const text = new TextDecoder().decode(raw)
    const textBytes = Buffer.from(text, 'utf8')
    const textDigest = crypto.createHash('sha256').update(textBytes).digest('hex')
    if (textDigest === file.sha256) {
      if (text.length !== file.size) throw new Error(`${file.path} is ${text.length} characters, the registry signed ${file.size}`)
      return { bytes: textBytes, text }
    }
    const byteDigest = crypto.createHash('sha256').update(raw).digest('hex')
    if (byteDigest === file.sha256) {
      if (raw.length !== file.size) throw new Error(`${file.path} is ${raw.length} bytes, the registry signed ${file.size}`)
      return { bytes: raw, text }
    }
    throw new Error(`${file.path} does not match its signed digest (the registry signed ${file.size})`)
  }

  function scanInstalledFile(manifest, file, bytes) {
    const name = file.path.toLowerCase()
    const text = bytes.toString('utf8')
    if (file.path === manifest.main) return scanExtensionSource(text, { manifest })
    if (name.endsWith('.mjs') || name.endsWith('.js') || name.endsWith('.html') || name.endsWith('.css')) {
      return scanPageAsset({ path: file.path, text })
    }
    return { ok: true, violations: [] }
  }

  async function install(id, { version } = {}) {
    if (disposed) throw new Error('the extension runtime is stopped')
    const registry = await refreshRegistry()
    const entry = registry.plugins.find(plugin => plugin.manifest.id === id)
    if (entry === undefined) throw new Error(`the registry does not carry "${id}"`)
    if (builtins.has(id)) throw new Error(`"${id}" is reserved by a built-in plugin`)
    if (version !== undefined && entry.manifest.version !== version) throw new Error(`the registry carries "${id}" at ${entry.manifest.version}, not ${version}`)
    if (compareVersions(hostVersion, entry.manifest.minHost) < 0) {
      throw new Error(`the extension requires host >= ${entry.manifest.minHost}, this host is ${hostVersion}`)
    }
    if (entry.manifest.apiCompatible === false) {
      throw new Error(`the extension requires plugin API ${entry.manifest.apiVersion}, this host implements 2.x`)
    }
    const lock = readLock()
    if (Object.keys(lock.extensions).length >= MAX_INSTALLED && lock.extensions[id] === undefined) {
      throw new Error(`at most ${MAX_INSTALLED} extensions may be installed at once`)
    }
    // Download every file the signed registry names, verify size + digest,
    // then scan before the first byte reaches the package directory.
    const downloaded = []
    for (const file of entry.files) {
      const { bytes } = await fetchSignedFile(file)
      const scan = scanInstalledFile(entry.manifest, file, bytes)
      if (!scan.ok) throw new Error(`the extension failed its pre-install scan: ${file.path}: ${scan.violations.join('; ')}`)
      downloaded.push({ file, bytes })
    }
    const dir = path.join(installDir(id), entry.manifest.version)
    fs.mkdirSync(dir, { recursive: true })
    for (const { file, bytes } of downloaded) {
      const target = packageFileTarget(dir, file.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, bytes, { mode: 0o600 })
      restrictPermissions(target)
    }
    const previous = lock.extensions[id]
    lock.extensions[id] = {
      manifest: entry.manifest,
      sha256: entry.sha256,
      url: entry.url,
      files: entry.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      source: 'registry',
      verified: true,
      installedAt: new Date().toISOString(),
      enabled: previous?.enabled ?? defaultEnabled(entry.manifest),
      updateSeen: previous?.updateSeen,
    }
    writeLock(lock)
    audit('install', id, { version: entry.manifest.version, sha256: entry.sha256, files: entry.files.length, previous: previous?.manifest.version })
    // The bytes may differ even when the version matches (a republished
    // package). Retire the running worker first so remount's reuse path cannot
    // keep serving the source that was on disk a moment ago.
    await stopExtension(id)
    await remount()
    onCatalogChanged()
    return publicRecord(lock.extensions[id])
  }

  /**
   * Install a local, unsigned package from a directory. Developer mode only:
   * the caller (the management layer) enforces the setting and the explicit
   * acknowledgement. The package must declare every file it ships; nothing
   * outside that list is read or copied.
   */
  async function installLocal({ path: sourceDir, acknowledgeUnsigned = false } = {}) {
    if (disposed) throw new Error('the extension runtime is stopped')
    if (acknowledgeUnsigned !== true) throw new Error('local plugins require an explicit unsigned-package acknowledgement')
    if (typeof sourceDir !== 'string' || sourceDir.trim() === '') throw new Error('local plugin path is required')
    const root = fs.realpathSync(path.resolve(sourceDir))
    if (!fs.statSync(root).isDirectory()) throw new Error('local plugin path must be a directory')
    const manifestFile = path.join(root, 'ofm-plugin.json')
    let raw
    try { raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { throw new Error('local plugin is missing a readable ofm-plugin.json') }
    const manifest = parsePluginManifest(raw, { source: 'local' })
    if (builtins.has(manifest.id)) throw new Error(`"${manifest.id}" is reserved by a built-in plugin`)
    if (compareVersions(hostVersion, manifest.minHost) < 0) {
      throw new Error(`the plugin requires host >= ${manifest.minHost}, this host is ${hostVersion}`)
    }
    if (manifest.apiCompatible === false) {
      throw new Error(`the plugin requires API ${manifest.apiVersion}, this host implements 2.x`)
    }
    const declared = Array.isArray(manifest.files) ? manifest.files : []
    if (declared.length === 0) throw new Error('local plugins must list every shipped file in manifest.files')
    if (manifest.main === '' && manifest.pages.length === 0) throw new Error('local plugin ships no code entry and no page')
    const lock = readLock()
    if (Object.keys(lock.extensions).length >= MAX_INSTALLED && lock.extensions[manifest.id] === undefined) {
      throw new Error(`at most ${MAX_INSTALLED} extensions may be installed at once`)
    }
    const staged = []
    for (const relPath of declared) {
      const source = path.resolve(root, ...relPath.split('/'))
      if (!source.startsWith(`${root}${path.sep}`)) throw new Error(`local plugin file "${relPath}" escapes its directory`)
      let stat
      try { stat = fs.lstatSync(source) } catch { throw new Error(`local plugin file "${relPath}" is missing`) }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`local plugin file "${relPath}" must be a regular file`)
      const max = relPath === manifest.main ? EXTENSION_SOURCE_MAX_BYTES : PAGE_ASSET_MAX_BYTES
      if (stat.size <= 0 || stat.size > max) throw new Error(`local plugin file "${relPath}" is out of range`)
      const bytes = fs.readFileSync(source)
      const scan = scanInstalledFile(manifest, { path: relPath }, bytes)
      if (!scan.ok) throw new Error(`local plugin failed its scan: ${relPath}: ${scan.violations.join('; ')}`)
      staged.push({ path: relPath, bytes, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
    }
    const dir = path.join(installDir(manifest.id), manifest.version)
    fs.mkdirSync(dir, { recursive: true })
    for (const file of staged) {
      const target = packageFileTarget(dir, file.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.bytes, { mode: 0o600 })
      restrictPermissions(target)
    }
    const previous = lock.extensions[manifest.id]
    const primary = staged.find(file => file.path === manifest.main) ?? staged[0]
    lock.extensions[manifest.id] = {
      manifest,
      sha256: primary.sha256,
      url: `local:${root}`,
      files: staged.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      source: 'local',
      verified: false,
      installedAt: new Date().toISOString(),
      enabled: previous?.enabled ?? defaultEnabled(manifest),
      updateSeen: previous?.updateSeen,
    }
    writeLock(lock)
    audit('install-local', manifest.id, { version: manifest.version, files: staged.length })
    await stopExtension(manifest.id)
    await remount()
    onCatalogChanged()
    return publicRecord(lock.extensions[manifest.id])
  }

  function invalidatePageTokens(id) {
    for (const [token, value] of pageTokens) if (value.pluginId === id) pageTokens.delete(token)
  }

  async function uninstall(id) {
    if (builtins.has(id)) throw new Error(`builtin plugin "${id}" cannot be uninstalled`)
    const lock = readLock()
    if (lock.extensions[id] === undefined) throw new Error(`extension "${id}" is not installed`)
    await stopExtension(id)
    delete lock.extensions[id]
    writeLock(lock)
    invalidatePageTokens(id)
    fs.rmSync(installDir(id), { recursive: true, force: true })
    audit('uninstall', id)
    await remount()
    onCatalogChanged()
  }

  async function setEnabled(id, enabled) {
    if (builtins.has(id)) throw new Error(`builtin plugin "${id}" is always enabled`)
    const lock = readLock()
    const record = lock.extensions[id]
    if (record === undefined) throw new Error(`extension "${id}" is not installed`)
    record.enabled = enabled === true
    writeLock(lock)
    invalidatePageTokens(id)
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
      clean[field.key] = sanitizeValue(values[field.key], field)
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

  function sanitizeValue(value, field) {
    const type = field.type
    if (type === 'toggle') return value === true
    if (type === 'number') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
      return Number.isFinite(Number(field.default)) ? Number(field.default) : 0
    }
    if (type === 'select') {
      // Only a listed option is a value; anything else falls back to the
      // default the manifest signed, then to the first option.
      const options = field.options ?? []
      const chosen = String(value ?? '')
      if (options.includes(chosen)) return chosen
      if (options.includes(String(field.default))) return String(field.default)
      return options[0] ?? ''
    }
    return String(value ?? '').slice(0, 300)
  }

  /** The manifest's optional selfTest(ctx), run on demand from the marketplace
   *  card. The hook speaks for itself: a bare boolean, or an {ok, message};
   *  a thrown hook is the failure. Disabled extensions have no process to
   *  ask — that is a verdict, not an error. */
  async function runSelfTest(id) {
    const lock = readLock()
    const record = lock.extensions[id]
    if (record === undefined) throw new Error(`extension "${id}" is not installed`)
    if (record.enabled !== true) return { ok: false, message: 'the extension is disabled' }
    const process_ = processes.get(id)
    if (process_ === undefined) return { ok: false, message: 'the extension is not running' }
    try {
      const result = await process_.call('selfTest', [])
      if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
        return { ok: result.ok, message: typeof result.message === 'string' ? result.message.slice(0, 200) : '' }
      }
      return { ok: true, message: '' }
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error).slice(0, 200) }
    }
  }

  // ── registry ─────────────────────────────────────────────────────────────

  /** The in-flight registry read: the boot warm-up, a page's first look and a
   *  manual refresh all want the same document, and racing them would fetch the
   *  index three times. */
  let refreshing = null
  /** Why the last read failed, or '' when it succeeded. The page needs the
   *  sentence, not just the fact: "unreachable" and "failed its signature
   *  check" send the reader after different problems. */
  let registryFailure = ''

  /** The registry snapshot shipped with the build. It is a build-time artifact,
   *  not a network trust root: used only when every mirror fails, so a fresh
   *  install still shows the official shelf instead of an empty market. */
  let bundledRegistry
  function readBundledRegistry() {
    if (bundledRegistry !== undefined) return bundledRegistry
    try {
      const payload = REGISTRY_FALLBACK
      bundledRegistry = { payload, view: parseRegistry(payload) }
    } catch {
      bundledRegistry = null
    }
    return bundledRegistry
  }

  async function refreshRegistry({ force = false } = {}) {
    const cached = readJson(registryCachePath, null)
    if (cached !== null && !force && Date.now() - (cached.fetchedAt ?? 0) < REGISTRY_TTL_MS && Array.isArray(cached.registry?.plugins)) {
      registryCache = cached
      return cached.view
    }
    if (refreshing !== null) return refreshing
    const run = readRegistry(cached)
    refreshing = run
    try {
      return await run
    } finally {
      if (refreshing === run) refreshing = null
    }
  }

  /** One pass over the mirror list, first alive wins. */
  async function readRegistry(cached) {
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
        registryFailure = ''
        return view
      } catch (error) {
        errors.push(`${new URL(source).hostname}: ${String(error?.message ?? error).slice(0, 120)}`)
      }
    }
    registryFailure = errors.join('; ')
    if (cached !== null && Array.isArray(cached.registry?.plugins)) {
      logger?.warn?.(`our-free-model: the extension registry could not be refreshed (${errors.join('; ')}); serving the cache from ${new Date(cached.fetchedAt).toISOString()}`)
      registryCache = cached
      return cached.view
    }
    const bundled = readBundledRegistry()
    if (bundled !== null && bundled.view.plugins.length > 0) {
      logger?.warn?.(`our-free-model: the extension registry could not be refreshed (${errors.join('; ')}); serving the bundled shelf`)
      registryCache = { fetchedAt: 0, source: 'bundled', registry: bundled.payload, signature: '', view: bundled.view }
      return bundled.view
    }
    throw new Error(`the extension registry is unreachable (${errors.join('; ')})`)
  }

  /**
   * The registry for a first paint, with a bounded wait for a read already in
   * flight. Without this the page a user opens during the boot warm-up is told
   * the index is unreadable — for a document that lands a few hundred
   * milliseconds later — and never asks again.
   */
  async function registryStatusSoon(waitMs = 3000) {
    if (registryCache === null && refreshing !== null) {
      // The warm-up owns the failure; this caller only wants to stop waiting.
      await Promise.race([
        refreshing.catch(() => {}),
        new Promise(resolve => { const timer = setTimeout(resolve, waitMs); timer.unref?.() }),
      ])
    }
    return { registry: registryView(), error: registryCache === null ? registryFailure : '' }
  }

  // ── covers ───────────────────────────────────────────────────────────────

  let coverFetchSeq = 0

  /**
   * One entry's cover image, verified and cached: the marketplace card's
   * banner. The bytes are display-only, so the failure mode is deliberately
   * soft — `null` means "render without a cover", never an error to the page.
   * Digest-checked against the signed registry before the first write, then
   * served from the data dir by digest (immutable per sha256).
   */
  async function coverImage(id) {
    const entry = registryCache?.view?.plugins?.find(plugin => plugin.manifest.id === id)
    const cover = entry?.cover
    if (cover === undefined) return null
    const extension = cover.url.split('.').pop().split('?')[0].toLowerCase()
    const cachePath = path.join(rootDir, 'covers', `${cover.sha256}.${extension}`)
    try {
      const cached = fs.readFileSync(cachePath)
      if (crypto.createHash('sha256').update(cached).digest('hex') === cover.sha256) {
        return { bytes: cached, contentType: cover.contentType }
      }
    } catch { /* not cached yet — fetch below */ }
    try {
      const response = await fetch(cover.url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
      if (!response.ok) return null
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length !== cover.size) return null
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== cover.sha256) return null
      // A unique staged name: two parallel requests for the same cover must
      // not interleave into one truncated file — each renames its own complete
      // buffer, and the loser's rename is a no-op overwrite of equal bytes.
      const staged = `${cachePath}.${Date.now()}-${coverFetchSeq += 1}.tmp`
      fs.mkdirSync(path.dirname(cachePath), { recursive: true })
      fs.writeFileSync(staged, bytes, { mode: 0o644 })
      fs.renameSync(staged, cachePath)
      return { bytes, contentType: cover.contentType }
    } catch {
      // A mirror hiccup costs the banner for this request only; the next one
      // (or the browser's own retry) tries again.
      return null
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** (Re)start every enabled extension and rebuild the channel lane's rows. */
  async function remount() {
    if (disposed) return
    const lock = readLock()
    pending.clear()
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
      const missing = missingRequirement(record.manifest)
      if (missing !== '') {
        pending.set(id, missing)
        const stale = processes.get(id)
        if (stale !== undefined) { processes.delete(id); stale.kill() }
        continue
      }
      // A page-only plugin has no worker; its contribution is the files on disk.
      if (record.manifest.main === '') continue
      try {
        const { source } = verifyInstalled(id)
        const existing = processes.get(id)
        const process_ = existing !== undefined ? existing : await startExtension(record, source)
        if (manifestHasChannel(record.manifest)) {
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
    channelRows = await applyModelHooks(channelRows)
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

  /**
   * Enhancement `onModels`: a fail-open filter over the extension lane's rows.
   * A hook may remove or rewrite rows but cannot introduce a row that is not
   * already an extension row, and a thrown/timed-out hook ships the catalog
   * unchanged. This is the hook the manifest has always declared; it is wired
   * here so it is not a dead surface.
   */
  async function applyModelHooks(rows) {
    let current = Array.isArray(rows) ? rows : []
    for (const [id, process_] of processes) {
      if (!manifestHasEnhancement(process_.manifest)) continue
      if (!Array.isArray(process_.manifest.hooks) || !process_.manifest.hooks.includes('onModels')) continue
      try {
        const result = await process_.call('onModels', [current], { manifest: process_.manifest }, 'onModels')
        if (Array.isArray(result)) {
          current = result.filter(row => row !== null && typeof row === 'object'
            && typeof row.id === 'string' && row.channel === 'extension')
        }
      } catch (error) {
        logger?.warn?.(`our-free-model: enhancement "${id}" onModels failed (${String(error?.message ?? error).slice(0, 160)}); the catalog ships unchanged`)
      }
    }
    return current
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
      if (!manifestHasEnhancement(process_.manifest)) continue
      if (!Array.isArray(process_.manifest.hooks) || !process_.manifest.hooks.includes('onRequest')) continue
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
      if (!manifestHasEnhancement(process_.manifest)) continue
      if (!Array.isArray(process_.manifest.hooks) || !process_.manifest.hooks.includes('onUsage')) continue
      process_.call('onUsage', [record, {}], { manifest: process_.manifest }, 'onUsage')
        .catch(error => logger?.warn?.(`our-free-model: enhancement "${id}" onUsage failed (${String(error?.message ?? error).slice(0, 160)})`))
    }
  }

  // ── read models for the API ──────────────────────────────────────────────

  const MASK = value => typeof value === 'string' && value.length >= 8 ? `…${value.slice(-4)}` : '…'

  const PAGE_MIME = {
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    woff2: 'font/woff2',
    json: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
  }

  const pageTokenKeys = new Map()

  function pageTokenFor(pluginId, version, pageId, entry) {
    const key = `${pluginId}@${version}:${pageId}`
    let token = pageTokenKeys.get(key)
    if (token === undefined || !pageTokens.has(token)) {
      token = crypto.randomBytes(16).toString('hex')
      pageTokenKeys.set(key, token)
      pageTokens.set(token, { pluginId, version, pageId, entry })
    }
    return token
  }

  function recordFor(pluginId) {
    if (builtins.has(pluginId)) return { builtin: true, entry: builtins.get(pluginId), record: undefined }
    const record = readLock().extensions[pluginId]
    return record === undefined ? undefined : { builtin: false, record, entry: undefined }
  }

  /** Every page contribution the console may render, one per enabled plugin. */
  function pages() {
    const out = []
    for (const [id, entry] of builtins) {
      for (const page of Array.isArray(entry.contributions?.pages) ? entry.contributions.pages : []) {
        const token = pageTokenFor(id, entry.manifest.version, page.id, page.entry)
        out.push({
          id: `plugin:${id}:${page.id}`,
          pluginId: id,
          pageId: page.id,
          title: page.title,
          description: page.description ?? '',
          group: page.group ?? '插件',
          order: page.order ?? 100,
          icon: page.icon ?? 'puzzle',
          url: `/api/management/plugins/assets/${token}/${page.entry}`,
          builtin: true,
          version: entry.manifest.version,
        })
      }
    }
    const lock = readLock()
    for (const [id, record] of Object.entries(lock.extensions)) {
      if (record.enabled !== true || pending.has(id)) continue
      for (const page of Array.isArray(record.manifest.pages) ? record.manifest.pages : []) {
        const token = pageTokenFor(id, record.manifest.version, page.id, page.entry)
        out.push({
          id: `plugin:${id}:${page.id}`,
          pluginId: id,
          pageId: page.id,
          title: page.title,
          description: page.description ?? '',
          group: page.group ?? '插件',
          order: page.order ?? 100,
          icon: page.icon ?? 'puzzle',
          url: `/api/management/plugins/assets/${token}/${page.entry}`,
          builtin: false,
          version: record.manifest.version,
        })
      }
    }
    return out.sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
  }

  /**
   * One declared page asset. The token is the capability: a sandboxed iframe
   * has an opaque origin and no session, so the path itself authorizes exactly
   * the files the plugin declared and nothing else.
   */
  function pageAsset(token, relPath) {
    const value = pageTokens.get(String(token ?? ''))
    if (value === undefined) return null
    const found = recordFor(value.pluginId)
    if (found === undefined) return null
    const manifest = found.builtin ? found.entry.manifest : found.record.manifest
    const enabled = found.builtin || (found.record.enabled === true && !pending.has(value.pluginId))
    if (!enabled) return null
    if (!found.builtin && found.record.manifest.version !== value.version) return null
    const pathValue = safePluginPath(relPath)
    if (pathValue === null || pathValue === manifest.main) return null
    const files = found.builtin
      ? (Array.isArray(found.entry.contributions?.files) ? found.entry.contributions.files : [])
      : (Array.isArray(found.record.files) ? found.record.files.map(file => file.path) : [])
    if (!files.includes(pathValue)) return null
    const recordFiles = found.builtin || !Array.isArray(found.record.files) ? [] : found.record.files
    const base = found.builtin
      ? path.join(rootDir, 'builtin-assets', value.pluginId)
      : path.join(installDir(value.pluginId), value.version)
    let bytes
    try { bytes = fs.readFileSync(packageFileTarget(base, pathValue)) } catch { return null }
    if (!found.builtin) {
      const expected = recordFiles.find(file => file.path === pathValue)?.sha256
      if (typeof expected === 'string' && crypto.createHash('sha256').update(bytes).digest('hex') !== expected) return null
    }
    const extension = pathValue.split('.').pop().toLowerCase()
    return { bytes, type: PAGE_MIME[extension] ?? 'application/octet-stream', pluginId: value.pluginId, pageId: value.pageId }
  }

  function configWithDefaults(manifest) {
    const values = readConfigStore().values[manifest.id] ?? {}
    const out = {}
    for (const field of manifest.config) out[field.key] = field.default
    return { ...out, ...values }
  }

  /**
   * A page plugin's only door to the host. Mirrored by the bridge injected
   * into its HTML; every method is allowlisted here, and the iframe never sees
   * a secret value or a management session.
   */
  async function pageRpc(pluginId, pageId, method, params = {}) {
    const found = recordFor(String(pluginId ?? ''))
    if (found === undefined) throw new Error('plugin is not installed')
    const manifest = found.builtin ? found.entry.manifest : found.record.manifest
    const enabled = found.builtin || (found.record.enabled === true && !pending.has(manifest.id))
    if (!enabled) throw new Error('plugin is not enabled')
    if (!manifest.pages.some(page => page.id === pageId)) throw new Error('page is not declared by this plugin')
    const key = manifest.id
    const now = Date.now()
    const window_ = pageRpcWindow.get(key)
    if (window_ === undefined || now - window_.at > 60_000) pageRpcWindow.set(key, { at: now, count: 1 })
    else if (++window_.count > 120) throw new Error('页面调用过于频繁，请稍后再试')
    const name = String(method ?? '')
    if (name === 'plugin.info') {
      return { id: manifest.id, name: manifest.name, version: manifest.version, pageId }
    }
    if (name === 'config.get') return configWithDefaults(manifest)
    if (name === 'storage.get' || name === 'storage.set' || name === 'storage.delete') {
      if (manifest.permissions.storage !== true) throw new Error('this plugin did not declare storage permission')
      const store = readStorageFile(manifest.id)
      const storageKey = String(params.key ?? '').slice(0, 128)
      if (storageKey === '') throw new Error('storage key is required')
      if (RESERVED_KEYS.has(storageKey)) throw new Error('storage key is reserved')
      if (name === 'storage.get') return Object.hasOwn(store, storageKey) ? store[storageKey] : null
      if (name === 'storage.set') {
        store[storageKey] = params.value ?? null
        writeStorageFile(manifest.id, store)
        return null
      }
      delete store[storageKey]
      writeStorageFile(manifest.id, store)
      return null
    }
    if (name === 'http.fetch') {
      const target = String(params.url ?? '')
      let url
      try { url = new URL(target) } catch { throw new Error('invalid URL') }
      if (!manifest.permissions.network.includes(url.origin)) throw new Error(`network origin "${url.origin}" is not in this plugin's permissions`)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('only http(s) is available')
      const requestMethod = String(params.method ?? 'GET').toUpperCase()
      if (requestMethod !== 'GET' && requestMethod !== 'POST') throw new Error('only GET and POST are available')
      const headers = {}
      if (params.headers !== null && typeof params.headers === 'object' && !Array.isArray(params.headers)) {
        for (const [header, value] of Object.entries(params.headers).slice(0, 32)) {
          const headerName = String(header).toLowerCase()
          if (RESERVED_KEYS.has(headerName)) continue
          if (['host', 'content-length', 'connection', 'transfer-encoding', 'cookie'].includes(headerName)) continue
          if (typeof value === 'string' && value.length <= 2048) headers[headerName] = value
        }
      }
      const body = params.body === undefined || params.body === null ? undefined
        : typeof params.body === 'string' ? params.body.slice(0, 64 * 1024)
          : JSON.stringify(params.body).slice(0, 64 * 1024)
      const response = await fetch(url, {
        method: requestMethod, headers, body,
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      })
      const text = (await response.text()).slice(0, 1024 * 1024)
      return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), text }
    }
    throw new Error(`unknown page method "${name}"`)
  }

  function auditTail(limit = 100) {
    const count = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100
    let lines = []
    try { lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean) } catch { return [] }
    const out = []
    for (const line of lines.slice(-count)) {
      try { out.push(JSON.parse(line)) } catch { /* one corrupt line is one row fewer */ }
    }
    return out
  }

  function contributions() {
    const out = {
      pages: pages(), channels: [], enhancements: [], providers: [], clients: [], formats: [], themes: [],
    }
    for (const [, entry] of builtins) {
      for (const key of ['channels', 'providers', 'clients', 'formats', 'themes']) {
        if (Array.isArray(entry.contributions?.[key])) out[key].push(...entry.contributions[key])
      }
    }
    const lock = readLock()
    for (const [id, record] of Object.entries(lock.extensions)) {
      if (record.enabled !== true || pending.has(id)) continue
      if (manifestHasChannel(record.manifest)) out.channels.push({ id, name: record.manifest.name, kind: 'installed' })
      if (manifestHasEnhancement(record.manifest)) out.enhancements.push({ id, name: record.manifest.name, hooks: record.manifest.hooks ?? [] })
    }
    return out
  }

  /** Optional 2s reconciler for config/lock edits made outside the API. */
  function startWatching({ intervalMs = 2000 } = {}) {
    if (watchTimer !== null) return
    const stamps = new Map()
    const stamp = file => { try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}` } catch { return '' } }
    const files = [lockPath, configPath, secretsPath]
    for (const file of files) stamps.set(file, stamp(file))
    let running = false
    watchTimer = setInterval(async () => {
      if (disposed || running) return
      let changed = false
      for (const file of files) {
        const next = stamp(file)
        if (next !== stamps.get(file)) { stamps.set(file, next); changed = true }
      }
      if (!changed) return
      running = true
      try { await remount() } catch { /* the next tick retries */ } finally { running = false }
    }, Math.max(500, intervalMs))
    watchTimer.unref?.()
  }

  function publicRecord(record) {
    const manifest = record.manifest
    const process_ = processes.get(manifest.id)
    const wait = pending.get(manifest.id)
    const state = record.enabled !== true ? 'disabled'
      : wait !== undefined ? 'pending'
        : manifest.main === '' ? 'ready'
          : process_ === undefined ? 'stopped' : process_.state
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      kinds: manifest.kinds,
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
      builtin: false,
      essential: false,
      source: record.source ?? 'registry',
      verified: record.verified !== false,
      installedAt: record.installedAt,
      state,
      error: wait ?? process_?.error ?? '',
      apiVersion: manifest.apiVersion,
      requires: manifest.requires,
      provides: manifest.provides,
      selfTestAvailable: process_?.hooks?.includes('selfTest') === true,
      secrets: manifest.permissions.secrets.map(key => {
        const current = (readSecrets().values[manifest.id] ?? {})[key]
        return { key, hasValue: typeof current === 'string' && current !== '', hint: typeof current === 'string' && current.length >= 4 ? MASK(current) : '' }
      }),
      values: readConfigStore().values[manifest.id] ?? {},
      pages: Array.isArray(manifest.pages) ? manifest.pages : [],
      pageCount: Array.isArray(manifest.pages) ? manifest.pages.length : 0,
      fileCount: Array.isArray(record.files) ? record.files.length : (record.manifest.main === '' ? 0 : 1),
      modelCount: channelManifests.has(manifest.id)
        ? channelRows.filter(row => row.extensionId === manifest.id).length
        : undefined,
    }
  }

  function listInstalled() {
    const records = [...builtins.values()].map(entry => builtinRecord(entry))
    const lock = readLock()
    records.push(...Object.values(lock.extensions).map(record => publicRecord(record)))
    return records
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
          changelog: entry.changelog,
          cover: entry.cover,
          // The signed source file's own URL — the detail view's "read the code
          // before you trust it" link.
          sourceUrl: entry.url,
          fileCount: entry.files.length,
          installed: installed !== undefined,
          installedVersion: installed?.manifest.version,
          enabled: installed?.enabled === true,
          updateAvailable: installed !== undefined && installed.manifest.version !== entry.manifest.version,
          // The install button's gate: host floor and plugin API range.
          installable: compareVersions(hostVersion, entry.manifest.minHost) >= 0 && entry.manifest.apiCompatible !== false,
          state: pending.get(entry.manifest.id) !== undefined ? 'pending' : (processes.get(entry.manifest.id)?.state ?? 'stopped'),
        }
      }),
    }
  }

  return {
    init: remount,
    dispose() {
      disposed = true
      if (watchTimer !== null) { clearInterval(watchTimer); watchTimer = null }
      pageTokens.clear()
      pageTokenKeys.clear()
      const terminations = []
      for (const [, process_] of processes) terminations.push(process_.kill())
      processes.clear()
      // Worker termination is async; the host's dispose effect may return this
      // so a hot reload does not race a dying worker against a fresh mount.
      return Promise.allSettled(terminations)
    },
    install, installLocal, uninstall, setEnabled, saveConfig, saveSecret, runSelfTest,
    refreshRegistry, registryStatusSoon, coverImage,
    listInstalled, registryView, installedVersions,
    registerBuiltin, contributions, pages, pageAsset, pageRpc, auditTail, startWatching,
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
