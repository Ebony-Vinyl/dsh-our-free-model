/**
 * Our Free Model — plugin entry (Host half).
 *
 * Wiring: one adapter instance, two provider routes (usable now / region-limited
 * on this egress), a live-catalog + availability-probe loop behind them, the
 * browser-facing JSON API the settings page reads, and the OpenAI-compatible
 * forward listener.
 *
 * On top of the model lane the plugin owns a small distribution channel of its
 * own: a remote announcement feed the repository owner publishes by pushing a
 * JSON document, an in-app self-updater that verifies and installs new releases
 * from the same repository, and a self hot-reload that swaps the running plugin
 * for the code now on disk. All three report to the browser over one
 * Server-Sent-Events route, because the kernel has no notification service and
 * the settings page should not have to poll.
 *
 * Every harness facility is reached through `ctx`, and only the one the plugin
 * cannot exist without is declared in `inject`, so a composition that omits the
 * rest degrades a feature rather than failing the plugin: no web server means no
 * in-app dashboard, no attachments means image blocks fall back to the text
 * projection the runtime already performs. See `inject` below.
 *
 * @module index.js
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { FreeModelAdapter, ROUTE_LABELS, ROUTE_MAIN, ROUTE_REGION } from './src/adapter.js'
import { JsonStore, SETTINGS_INITIAL, STATS_INITIAL, STATS_VERSION, DATA_DIR_NAME, MIN_DECODE_MS, decodeWindow, migrateStats, pruneDays, recordTurn, recordUsage, resolveDshHome } from './src/store.js'
import { buildCatalog, buildEacCatalog, buildKiloCatalog, isEacEntry, isKiloEntry, parseListing, reviveKiloCatalog } from './src/catalog.js'
import { STATE, detectEgress, probeCatalog } from './src/probe.js'
import { generateKey, startForwardServer, startLanRelay, toOpenAiUsage } from './src/forward.js'
import { chanGatewayCredential, chanGatewayEnabled, chanGatewayPort, startChanRelay } from './src/chan-relay.js'
import { CODE, UpstreamError, getJson } from './src/http.js'
import { addressBlock, egressLane, outletLabel, readOutletSelection, stepOffBlamedAddress, startEgressRelay } from './src/egress.js'
import { directFetch, fetchSealedListing } from './src/eac.js'
import { fetchKiloListing } from './src/kilo.js'
import { clearEacUser, readEacUser, writeEacUser } from './src/eac-user.js'
import { createEacLoginPoller } from './src/eac-login.js'
import { unlockSealedLane } from './src/vault.js'
import { mintRequestId, sessionForConversation } from './src/upstream.js'
import { DEFAULT_LEVEL, budgetLadder } from './src/effort.js'
import { windowTokens } from './src/stream.js'
import { AnnouncementFeed } from './src/feed.js'
import { PluginUpdater } from './src/updater.js'
import { selfReload, watchPackage, isReloading } from './src/reload.js'
import { createPushHub } from './src/push.js'
import { rejectionFor, isLoopbackHost, connectionAdmissionView } from './src/trust.js'
import { resolveAttributionUserAgent } from './adapter/kernel.js'

export const name = 'our-free-model'

/** The installed package directory — the self-updater and hot reload operate here. */
const PKG_URL = new URL('./', import.meta.url)
const PKG_DIR = fileURLToPath(PKG_URL)
const ENTRY_URL = new URL('index.js', import.meta.url).href

/** Published version of the installed package, read once at load. */
function readPackageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

// Bind the version to this module generation. Re-registering cached old exports
// after a failed reload must not pick up the new package.json still on disk.
export const version = readPackageVersion()

/**
 * Open a URL in the system browser, best effort. The settings page shows the
 * same URL with a copy button, so a headless host or a refused spawn costs a
 * paste, never the flow. The URL is always one this plugin built from the
 * sealed gateway endpoint — never user input.
 */
function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]]
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * `llm` is what the plugin exists for, so it is the only hard requirement of the
 * plugin itself.
 *
 * Cordis withholds from a context any service its fiber does not name in
 * `inject`, and keeps that fiber PENDING while a named one is absent — which is
 * how v1.2.1 stayed permanently inactive on a composition with no HTTP server,
 * the surface issue #4 reported. So nothing else may be named here: a headless
 * composition would rather serve models without a settings page than serve
 * nothing.
 *
 * What that costs and what still works:
 * - `webServer` — the in-app dashboard and the SSE push channel. Reached through
 *   a nested `ctx.inject` fiber (see the browser-facing API section), which pends
 *   on its own and never blocks the lane above.
 * - `timer` (`ctx.interval`) — nothing. The background loops are plain unref'd
 *   timers (see `every`), because reading a mixin off an undeclared service
 *   throws rather than answering `undefined`.
 * - `connection`, `attachments` — one feature each: the fence falls back to its
 *   structural replica, image blocks to the text projection. Both are read with
 *   `ctx.get()`, which is the opportunistic lookup that answers `undefined`.
 */
export const inject = ['llm']

/** Static fallback catalog, so a cold start with no network still lists models. */
const FALLBACK_CATALOG = buildCatalog([
  'mimo-v2.6-flash-free', 'mimo-v2.5-free', 'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'space-bunny-free',
  'muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free',
])

/** Where the plugin's own announcement copy lives; bump it to re-announce. */
export const ANNOUNCEMENT_VERSION = '2026-09-25.1'

/**
 * Who owns the plugin's bytes — the distribution mode:
 *
 * - `self` (default): the plugin updates itself from its repository, publishes
 *   its announcement feed, and hot-reloads, exactly as before.
 * - `managed`: the plugin arrived through a distribution pack (an EAC
 *   integration pack, a Mojobox install). The pack manager owns the bytes now,
 *   so the in-app updater, the announcement channel and the hot reload stand
 *   down — two writers to one installed directory is a corrupted install. The
 *   model lane is untouched; this is about who ships the code, not what it does.
 *
 * `config.distribution` (what a pack's bundle patch passes) outranks the
 * settings file, and the settings API never accepts the field back, so an
 * install that shipped managed stays managed.
 */
const MANAGED_MESSAGE = 'this installation is managed; updates are handled by the pack that installed it'

/** Effective distribution mode: config override first, then the settings file. */
function distributionOf(config, settings) {
  if (config?.distribution === 'managed' || settings.get().distribution === 'managed') return 'managed'
  return 'self'
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const home = resolveDshHome()
  const dataDir = path.join(home, DATA_DIR_NAME)
  fs.mkdirSync(dataDir, { recursive: true })
  const packageVersion = version

  // A hot reload re-enters apply with fresh stores; the generation counter lives
  // on globalThis so the new instance knows it replaced a predecessor, and does
  // the post-swap bookkeeping itself (the old closure must not touch stores
  // after its own dispose — that would race the new instance's writes).
  const generation = (globalThis[Symbol.for('our-free-model.generation')] ?? 0) + 1
  globalThis[Symbol.for('our-free-model.generation')] = generation

  const settings = new JsonStore(path.join(dataDir, 'settings.json'), SETTINGS_INITIAL, { log: message => logger.warn?.(message) })
  const stats = new JsonStore(path.join(dataDir, 'stats.json'), STATS_INITIAL, { log: message => logger.warn?.(message) })
  const availability = new JsonStore(path.join(dataDir, 'availability.json'), { version: 1, at: 0, egress: null, results: {} }, { log: message => logger.warn?.(message) })
  const catalogStore = new JsonStore(path.join(dataDir, 'catalog.json'), { version: 1, at: 0, entries: FALLBACK_CATALOG.map(entry => entry.id) }, { log: message => logger.warn?.(message) })

  if (stats.get().version !== STATS_VERSION) stats.edit(migrateStats)

  if (generation > 1) {
    settings.update({ reloadedAt: Date.now(), reloadCount: generation - 1 })
    settings.flush()
  }

  /** `managed` stands down everything that would rewrite the installed bytes. */
  const distribution = distributionOf(config, settings)
  const managed = distribution === 'managed'

  let catalog = materializeCatalog(catalogStore.get().entries ?? [])
  let attributionUserAgent = 'deepseek-harness'
  let egress = availability.get().egress ?? null
  let forward = null
  let forwardError = ''
  // Non-fatal: the listener is up, but not where the settings asked for it.
  let forwardNotice = ''
  /** The optional LAN relay: a second door, with a key of its own. */
  let relay = null
  let relayError = ''
  /** The optional egress outlet (subscription or single client), off by
   *  default. Named `outlet*` so the `egress` IP/country snapshot stays clear. */
  let outletRelay = null
  let outletError = ''
  /** Last reading of the outlet's own view of itself, cached for `/summary`. */
  let outletNode = { node: '', delayMs: 0, at: 0 }
  /** How long the last successful listing round took over the current path. */
  let gatewayLatency = { ms: 0, at: 0 }

  // ── the co-paid lane ────────────────────────────────────────────────────────
  /**
   * The sealed lane is invisible until the host gate passes and the seal opens,
   * both re-checked per use. Its roster persists under `sealIds` in the catalog
   * store so a desktop restart offline still shows what it served last. A host
   * the gate refuses never reads that list — `sealedCatalog` starts and stays
   * empty, and no entry, request, or error of the lane is observable — but the
   * persisted list survives the refusal, and the refusal itself is logged, so
   * an empty EAC group has a reason in the log instead of silence.
   */
  const profileNameOf = () => {
    const context = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
    return typeof context?.name === 'string' ? context.name : undefined
  }
  const sealedCredentialOf = () => unlockSealedLane({ profileName: profileNameOf() })
  let sealedCatalog = sealedCredentialOf() === null ? [] : buildEacCatalog(catalogStore.get().sealIds ?? [])
  // The Kilo channel needs no credential and no host gate, so its roster loads
  // from the persisted cache before the first listing round ever runs.
  let kiloCatalog = reviveKiloCatalog(catalogStore.get().kiloRows)
  const mergeCatalogs = () => {
    catalog = [...catalog, ...sealedCatalog.filter(row => !catalog.some(entry => entry.id === row.id))]
    catalog = [...catalog, ...kiloCatalog.filter(row => !catalog.some(entry => entry.id === row.id))]
  }
  mergeCatalogs()

  // ── the pool snapshot (settings-page gauge) ─────────────────────────────────
  // The co-paid gateway publishes aggregate, non-sensitive numbers (provisioned
  // capacity, live traffic) at `{mount}/pool`; this proxy exists so the browser
  // never needs the gateway URL — the seal stays server-side. Thirty seconds
  // of server-side cache keeps a settings page that re-mounts often from
  // turning into a request flood, while staying fresh enough for the load
  // verdict to mean something. A host without the lane — or a gateway that
  // does not answer — throws a tagged reason, and the route answers 404 with
  // that reason, which the client shows as a muted diagnostic line. The
  // outbound hop rides directFetch, the lane's own node:http(s) transport: if
  // global fetch is wrapped or broken in this composition, the lane still is.
  const poolError = reason => Object.assign(new Error(`pool: ${reason}`), { code: 'POOL_UNAVAILABLE', reason })
  // A snapshot this young still describes the same day; under load the panel
  // shows it rather than blanking while the gateway is slow to answer.
  const POOL_STALE_MS = 10 * 60_000
  let poolCache = { at: 0, data: null }
  async function fetchPoolSnapshot() {
    if (poolCache.data !== null && Date.now() - poolCache.at < 30_000) return poolCache.data
    const credential = sealedCredentialOf()
    if (credential === null || credential.mode !== 'worker') throw poolError('no-lane')
    const gatewayRoot = credential.base.replace(/\/v1\/?$/, '')
    const controller = new AbortController()
    // The gateway may be genuinely slow when it is saturated (that is what the
    // verdict is about); twenty seconds is the patience this hop gets.
    const timer = setTimeout(() => controller.abort(), 20_000)
    timer.unref?.()
    try {
      const response = await directFetch(`${gatewayRoot}/pool`, { headers: { accept: 'application/json' }, signal: controller.signal })
      if (!response.ok) throw poolError('gateway-status')
      const data = await response.json()
      // The gateway may answer a degraded snapshot: stars unreachable means
      // pool/poolSource come back null/'unavailable' while the live counters
      // stay real. That is still a valid snapshot — only the in-flight core
      // is required, and the panel renders the rest as it finds it.
      if (data?.ok !== true || !Number.isFinite(data.inflight)) throw poolError('malformed')
      poolCache = { at: Date.now(), data }
      return data
    } catch (error) {
      if (poolCache.data !== null && Date.now() - poolCache.at < POOL_STALE_MS) return poolCache.data
      throw error?.code === 'POOL_UNAVAILABLE' ? error : poolError('unreachable')
    } finally {
      clearTimeout(timer)
    }
  }

  // ── the GitHub authorization gate on the co-paid lane ───────────────────────
  // One per-user token (src/eac-user.js) is what the gateway's GitHub gate
  // mints after login + star, and these four hops are the settings page's whole
  // relationship with that gate. The token never reaches the browser: the page
  // sees a login name and a verdict, the file and the signed wire keep the
  // credential. `cached` is the sync bit /summary can carry.
  const eacAuthCache = { at: 0, data: { available: false, authorized: false, login: '' } }
  const eacAuthRootOf = credential => credential.base.replace(/\/v1\/?$/, '')
  async function eacAuthStatus() {
    const credential = sealedCredentialOf()
    if (credential === null || credential.mode !== 'worker') {
      return { available: false, authorized: false, login: '', mode: credential?.mode ?? null }
    }
    const local = readEacUser()
    const base = {
      available: true,
      mode: 'worker',
      local: local !== null,
      login: local?.login ?? '',
      avatar: local?.avatar ?? '',
      savedAt: local?.savedAt ?? 0,
    }
    try {
      const response = await directFetch(`${eacAuthRootOf(credential)}/auth/status`, {
        headers: { accept: 'application/json', ...(local === null ? {} : { 'x-ofm-user': local.token }) },
        signal: AbortSignal.timeout(15_000),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || data === null) throw new Error('bad answer')
      const result = {
        ...base,
        configured: data.configured === true,
        required: data.required === true,
        authorized: data.authorized === true,
        login: typeof data.login === 'string' && data.login !== '' ? data.login : base.login,
        avatar: typeof data.avatar === 'string' && data.avatar !== '' ? data.avatar : base.avatar,
        starred: data.starred === true,
        lastCheck: Number.isFinite(data.lastCheck) ? data.lastCheck : 0,
        reason: typeof data.reason === 'string' ? data.reason : null,
        repo: typeof data.repo === 'string' ? data.repo : '',
        checkedAt: Date.now(),
      }
      eacAuthCache.at = Date.now()
      eacAuthCache.data = result
      return result
    } catch {
      // The gateway did not answer: report what this machine holds, marked
      // unverified, rather than claiming an authorization nobody confirmed.
      const fallback = { ...base, authorized: local !== null, unverified: true, checkedAt: Date.now() }
      eacAuthCache.at = Date.now()
      eacAuthCache.data = fallback
      return fallback
    }
  }
  const eacLoginPoller = createEacLoginPoller({
    credentialOf: sealedCredentialOf, fetch: directFetch,
    readUser: readEacUser, writeUser: writeEacUser,
    onSaved: saved => {
      eacAuthCache.data = { ...eacAuthCache.data, available: true, local: true, authorized: true, login: saved.login, avatar: saved.avatar, savedAt: saved.savedAt }
    },
  })
  const eacAuth = {
    /** Fresh read; the settings page calls this on mount and after actions. */
    status: eacAuthStatus,
    /** The last verdict, for the sync /summary document. */
    cached: () => eacAuthCache.data,
    /** Begin a login: mint the link code, hand the URL to the system browser. */
    async start() {
      const credential = sealedCredentialOf()
      if (credential === null || credential.mode !== 'worker') return { error: 'no-lane' }
      const link = crypto.randomBytes(24).toString('base64url')
      const url = `${eacAuthRootOf(credential)}/auth/github/start?link=${link}`
      const prepared = await eacLoginPoller.prepare(link)
      if (prepared.error !== undefined) return prepared
      return { url, link, opened: openExternal(url) }
    },
    /** Collect the token the browser flow just produced. */
    poll: link => eacLoginPoller.poll(link),
    cancel: link => eacLoginPoller.cancel(link),
    /** Revoke server-side, then forget locally. Local removal is the part that
     * must always happen — a gateway that cannot be reached must not leave the
     * user logged in on this machine. */
    async logout() {
      eacLoginPoller.reset()
      const credential = sealedCredentialOf()
      const local = readEacUser()
      if (local !== null && credential !== null && credential.mode === 'worker') {
        try {
          await directFetch(`${eacAuthRootOf(credential)}/auth/logout`, {
            method: 'POST',
            headers: { accept: 'application/json', 'x-ofm-user': local.token },
            signal: AbortSignal.timeout(8000),
          })
        } catch { /* local removal below is what the user asked for */ }
      }
      const cleared = clearEacUser()
      eacAuthCache.data = { available: credential !== null && credential.mode === 'worker', authorized: false, login: '', local: false }
      return { ok: cleared }
    },
  }

  // ── push channel ────────────────────────────────────────────────────────────
  const push = createPushHub({ logger })

  /** Set of announcement ids the user has acknowledged. */
  const ackedIds = () => new Set(Array.isArray(settings.get().announcementsAcked) ? settings.get().announcementsAcked : [])

  const feed = new AnnouncementFeed({
    settings: () => settings.get(),
    cacheFile: path.join(dataDir, 'feed.json'),
    onArrival: items => {
      push.emit('announcements', { items, unread: feedView().unread })
      refreshUpdatePush?.()
    },
    log: message => logger.info?.(message),
  })
  feed.load()

  /**
   * The announcement view the settings page reads. A managed install polls no
   * feed and caches no copy — the pack speaks for the plugin — so its view is a
   * fixed empty one that names its source honestly.
   */
  const MANAGED_FEED_VIEW = { items: [], unread: 0, fetchedAt: 0, source: 'managed', error: '', lastError: '' }
  function feedView() {
    return managed ? MANAGED_FEED_VIEW : feed.view({ ackedIds: ackedIds() })
  }

  const updater = new PluginUpdater({
    pkgDir: PKG_DIR,
    dataDir,
    settings: () => settings.get(),
    log: message => logger.info?.(message),
    runningVersion: packageVersion,
  })
  /** Update versions we have already pushed a notification for. */
  let updateNotifiedFor = typeof settings.get().updateNotifiedFor === 'string' ? settings.get().updateNotifiedFor : ''

  /** Push an `update` event once per version (manual checks force a re-push). */
  function pushUpdate(force = false) {
    if (disposed || managed) return
    const status = updater.status()
    if (status.available !== true || status.latest === '') return
    if (!force && status.latest === updateNotifiedFor) return
    updateNotifiedFor = status.latest
    settings.update({ updateNotifiedFor: status.latest })
    push.emit('update', { current: status.current, latest: status.latest, notes: status.notes })
  }
  let refreshUpdatePush = undefined
  /** Set when this generation is disposed; late async callbacks must stand down. */
  let disposed = false

  // The successor offers a notification callback, but only the caller that
  // confirmed selfReload() and committed the outcome may invoke it. Booting a
  // replacement is not yet evidence that every fiber started successfully.
  const pendingUpgrade = globalThis[Symbol.for('our-free-model.pending-upgrade')]
  if (pendingUpgrade?.version === packageVersion) {
    pendingUpgrade.notify = () => {
      if (disposed) return
      settings.update({ installedVersion: packageVersion })
      settings.flush()
      push.emit('upgraded', { version: packageVersion, clientChanged: true })
    }
  }

  /** The immutable snapshot every adapter call binds to. */
  const state = () => ({
    catalog,
    membership: computeMembership(catalog, availability.get(), settings.get()),
    settings: settings.get(),
    attributionUserAgent,
  })

  /** A turn refused for geography means the egress moved; re-classify promptly. */
  let reprobeTimer
  function scheduleReprobe() {
    if (disposed || reprobeTimer !== undefined) return
    reprobeTimer = setTimeout(() => {
      reprobeTimer = undefined
      // Teardown clears this handle, but the trigger comes from a turn that can
      // land the instant after `disposed` was set; a forced round against
      // disposed stores would be swallowed whole and still spend the quota.
      if (disposed) return
      void refreshAvailability(true)
        .catch(error => logger.warn?.(`our-free-model: region reprobe failed (${error?.message ?? error})`))
    }, 4000)
    reprobeTimer.unref?.()
  }

  const adapter = new FreeModelAdapter({
    state,
    resolveImage: imageResolver(ctx, logger),
    sealedCredential: sealedCredentialOf,
    recordUsage: record => {
      recordUsage(stats, record)
      stats.edit(state => pruneDays(state, 120))
    },
    recordTurn: record => recordTurn(stats, record),
    warn: message => logger.warn?.(message) ?? logger.log?.(message),
    onRegionBlocked: () => scheduleReprobe(),
    // A quota refusal is the one trigger that is an address verdict, so it is the
    // one that may blame an address block and not just the node on it.
    onQuotaHit: () => scheduleOutletRotation('the lane rate-limited this exit', { refusal: true }),
  })

  // ── registration ────────────────────────────────────────────────────────────
  const routes = () => Object.keys(computeMembership(catalog, availability.get(), settings.get()))
  const registration = ctx.llm.registerAdapter([ROUTE_MAIN, ROUTE_REGION], adapter)
  ctx.llm.registerConfigurableProviders?.([
    { provider: ROUTE_MAIN, displayName: ROUTE_LABELS[ROUTE_MAIN], settingsNs: ctx.fiber?.entry?.options?.id ?? name, settingsPath: [] },
  ])

  // Advertise a probe endpoint for the in-app "detect models" button. It offers
  // what the picker itself advertises — a model the gateway refuses to route at
  // all must not be addable to a profile just because it still appears in the
  // upstream listing.
  ctx.llm.registerModelDiscovery?.(ctx.fiber?.entry?.options?.id ?? name, async () => {
    await refreshCatalog({ probe: true, force: true })
    const advertised = new Set(Object.values(state().membership).flat())
    return catalog
      .filter(entry => advertised.has(entry.id))
      .map(entry => ({
        id: entry.id,
        name: entry.name,
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxOutput,
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
  })

  ctx.on?.('loader/volatile-update', () => {
    registration.replace(routes())
  })

  // ── catalog + availability ──────────────────────────────────────────────────
  // One round at a time, coalesced: the boot refresh, a model discovery, and
  // the refresh button all arrive together at startup, and each used to fetch
  // the listing and probe the lane on its own. A forced round covers every
  // waiter; one that still needs forcing (a reprobe inside the 429 backoff,
  // where an unforced round deliberately skips the probe) runs its own after
  // the shared round rather than inheriting its softer options.
  let catalogRefresh = null
  let catalogRefreshForced = false
  async function refreshCatalog(opts) {
    const { probe = true, force = false } = opts ?? {}
    while (catalogRefresh !== null) {
      const shared = catalogRefresh
      const sharedForced = catalogRefreshForced
      const value = await shared
      if (!force || sharedForced) return value
    }
    const run = refreshCatalogOnce({ probe, force })
    catalogRefresh = run
    catalogRefreshForced = force
    try { return await run } finally {
      if (catalogRefresh === run) { catalogRefresh = null; catalogRefreshForced = false }
    }
  }
  async function refreshCatalogOnce({ probe, force }) {
    let ids = []
    try {
      ids = parseListing(await fetchListing())
    } catch (error) {
      logger.warn?.(`our-free-model: model listing refresh failed (${error?.message ?? error}); keeping the cached catalog`)
    }
    if (ids.length > 0) {
      catalog = buildCatalog(ids)
      catalogStore.update({ at: Date.now(), entries: catalog.map(entry => entry.id) })
      catalogStore.flush()
      settings.update({ catalogSyncedAt: Date.now() })
    } else {
      catalog = materializeCatalog(catalogStore.get().entries ?? [])
    }
    await refreshSealedRoster()
    await refreshKiloRoster()
    mergeCatalogs()
    if (probe) await refreshAvailability(force)
    emitTopology()
    return catalog
  }

  /**
   * One roster round for the sealed lane, after the free lane's.
   *
   * A transient listing failure keeps the roster it served last; a credential
   * refusal means the lane is closed to this install, so the roster and its
   * persisted ids are dropped — a picker full of models the relay now refuses
   * is worse than an empty group with the failure in the log. Every log line
   * carries the failure class only, never the endpoint or the credential.
   *
   * A host the gate refuses is different: the lane was never open here, so
   * nothing this install did was wrong, and the persisted ids belong to a
   * machine that may be back on the supported host tomorrow. They stay, and
   * the refusal is logged — this branch used to wipe the cache in silence,
   * which made every "the EAC models are gone" report undiscoverable.
   */
  async function refreshSealedRoster() {
    const credential = sealedCredentialOf()
    if (credential === null) {
      sealedCatalog = []
      // Web hosts are admitted too (issues #58/#59), so reaching here means the
      // kernel gave no profile context at all — an embedding this lane is not
      // published for, not a misconfigured desktop or web install.
      logger.warn?.('our-free-model: the sealed lane is not available in this composition (no recognized host profile); its models stay hidden')
      return
    }
    try {
      const ids = parseListing(await fetchSealedListing(credential))
      if (ids.length > 0) {
        sealedCatalog = buildEacCatalog(ids)
        catalogStore.update({ sealIds: sealedCatalog.map(entry => entry.id) })
      }
    } catch (error) {
      if (error?.code === CODE.credential) {
        sealedCatalog = []
        catalogStore.update({ sealIds: [] })
        logger.warn?.('our-free-model: the sealed lane refused its credential; its models are hidden until it is accepted again')
        return
      }
      logger.warn?.(`our-free-model: sealed lane listing failed (${error?.code ?? 'unknown'}); keeping its cached roster`)
    }
  }

  /**
   * One roster round for the Kilo channel, after the other two.
   *
   * A successful listing replaces the whole free roster, including an empty
   * pool when every model has become paid or disappeared. A failed or malformed
   * listing retains the last roster; it must not masquerade as an empty pool.
   */
  async function refreshKiloRoster() {
    try {
      const payload = await fetchKiloListing()
      if (payload?.error || !Array.isArray(payload?.data)) throw new Error('invalid Kilo model listing')
      const entries = buildKiloCatalog(payload.data)
      kiloCatalog = entries
      catalogStore.update({ kiloRows: entries })
    } catch (error) {
      logger.warn?.(`our-free-model: Kilo channel listing failed (${error?.code ?? error?.message ?? 'unknown'}); keeping its cached roster`)
    }
  }

  async function fetchListing() {
    // Read straight from the listing path rather than the probe helper: a listing
    // needs no session identity, and a failure should be a plain throw. Through
    // `getJson` so the base URL stays the one override every other request uses.
    const started = Date.now()
    const listing = await getJson('/zen/v1/models', {
      session: sessionForConversation('catalog:our-free-model'),
      requestId: mintRequestId(),
      attributionUserAgent,
    })
    // The one number that answers "how far away is opencode right now": the
    // listing is the cheapest call that proves the whole path, and it goes
    // through `egressFetch` like every other gateway request.
    gatewayLatency = { ms: Date.now() - started, at: Date.now() }
    return listing
  }

  async function runProbeRound() {
    // The absorbed channels get no per-model probes: their verdicts would be
    // spent against a different gateway than the one that serves them, and a
    // roster the listing named is advertised as-is (its health is the listing
    // round's, refreshed on the same cadence).
    const probeable = catalog.filter(entry => !isEacEntry(entry) && !isKiloEntry(entry))
    const results = await probeCatalog(probeable, { attributionUserAgent }, (id, result) => {
      availability.edit(state => ({ ...state, results: { ...state.results, [id]: { state: result.state, ...result.detail === undefined ? {} : { detail: result.detail }, ...result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs }, latencyMs: result.latencyMs, at: Date.now() } } }))
    }, 2)
    availability.update({ at: Date.now(), egress })
    availability.flush()
    // Say it out loud when a round refuses everything: `computeMembership` keeps
    // the roster advertised in that case, and without this line the log would
    // read as a healthy probe while the gateway was turning every model down.
    const verdicts = Object.values(results)
    if (verdicts.length > 0 && verdicts.every(row => row.state === STATE.unavailable)) {
      logger.warn?.(`our-free-model: the gateway refused all ${verdicts.length} models this round (${verdicts[0].detail ?? 'no detail'}); keeping them advertised`)
    }
    // A round the lane answered with nothing but 429s is the lane saying "this
    // egress is out of quota". The probe draws from the same per-IP pool as the
    // user's turns, so answering "how full is the pool?" by draining it again
    // every period makes the shortage permanent. Back the next periodic round
    // off (doubling, capped) and let real traffic — a manual reprobe, an egress
    // change, the boot round — through regardless: those are worth their cost.
    const allThrottled = verdicts.length > 0 && verdicts.every(row => row.state === STATE.throttled)
    probeThrottleStreak = allThrottled ? probeThrottleStreak + 1 : 0
    probeBackoffUntil = allThrottled
      ? Date.now() + Math.min(30 * 2 ** (probeThrottleStreak - 1), 120) * 60_000
      : 0
    if (allThrottled) {
      logger.warn?.(`our-free-model: the probe round hit the lane's quota; availability probes pause for ${Math.round((probeBackoffUntil - Date.now()) / 60_000)} minutes (your own requests are unaffected, and the reprobe button forces a round)`)
    }
    emitTopology()
    return results
  }

  /**
   * One catalog round at a time, for every caller.
   *
   * Four things start a round: the periodic catalog loop, the 2-minute egress
   * watch, a mid-turn `RegionError`, and the two settings buttons. Each awaited a
   * fresh `probeCatalog`, so a slow round and a trigger arriving during it ran
   * whole catalogs side by side — against a lane whose 429 carries a growing
   * `retry-after`, that is the user's own quota spent on the same question. A
   * caller that arrives mid-round joins the round in flight instead of starting
   * another, which is what the feed poll above already does.
   *
   * `force` is for the callers whose round is worth its quota no matter what the
   * lane just said: a manual reprobe, the boot round, an egress change. The
   * periodic loop passes nothing and is the one that gets held off while a
   * quota-backoff window is open (see {@link runProbeRound}).
   */
  let probeRound = null
  let probeThrottleStreak = 0
  let probeBackoffUntil = 0
  async function refreshAvailability(force = false) {
    if (!force && probeBackoffUntil > Date.now()) return {}
    if (probeRound !== null) return probeRound
    const round = runProbeRound()
    probeRound = round
    try {
      return await round
    } finally {
      if (probeRound === round) probeRound = null
    }
  }


  /** Returns whether the exit could actually be read, not just whether it moved. */
  async function watchEgress() {
    const seen = await detectEgress()
    if (seen === undefined) return false
    const previous = availability.get().egress
    const changed = previous === null || previous === undefined
      || previous.ip !== seen.ip || (seen.country !== undefined && previous.country !== seen.country)
    egress = seen
    if (changed) {
      availability.update({ egress: seen })
      availability.flush()
      logger.info?.(`our-free-model: egress changed to ${seen.ip}${seen.country ? ` (${seen.country})` : ''}; re-probing availability`)
      await refreshAvailability(true)
    }
    return true
  }

  /**
   * A freshly started outlet needs a moment before its nodes carry traffic: the
   * first read comes back empty, and a re-probe fired on that cold path would
   * record "unavailable" for models the new exit would have unlocked. Retry a
   * few times and let the re-probe run only once the exit answers.
   */
  async function settleOutletWatch() {
    let lastError
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 2500 : 5000))
      if (disposed) return
      try {
        if (await watchEgress()) {
          // The exit answers, but url-test may not have ranked a node yet: read
          // the selection now, and once more a beat later so the settings page
          // does not sit on an empty node until the next periodic tick.
          await readOutletStatus().catch(() => {})
          const later = setTimeout(() => {
            if (!disposed) void readOutletStatus().catch(() => {})
          }, 5000)
          later.unref?.()
          return
        }
      } catch (error) {
        lastError = error
      }
    }
    logger.warn?.(
      `our-free-model: egress changed but the new exit never answered; leaving verdicts alone`
      + (lastError ? ` (${lastError?.message ?? lastError})` : ''),
    )
  }

  // ── forward listener ────────────────────────────────────────────────────────
  // Both reconciles get a serialisation gate: two callers (the boot refresh and
  // every settings POST) used to overlap, and whichever bind finished last wrote
  // its entry-time snapshot of the settings back over the other one - rolling
  // the user's just-saved `enabled` edits back, or leaving an orphan listener
  // behind. The waiter re-runs after the first settles; the early-exit below
  // makes that rerun free when nothing changed.
  let forwardSyncInFlight = null
  async function syncForward() {
    while (forwardSyncInFlight !== null) await forwardSyncInFlight.catch(() => {})
    const run = syncForwardOnce()
    forwardSyncInFlight = run
    try { await run } finally { if (forwardSyncInFlight === run) forwardSyncInFlight = null }
  }
  async function syncForwardOnce() {
    const desired = settings.get().forward ?? {}
    const wanted = desired.enabled === true
    // A listener already bound where the settings want it is left alone. Two
    // callers reconcile the same state — the boot refresh and every settings
    // POST — and the second one used to close and re-bind the port anyway,
    // resetting whatever request was in flight on the old socket.
    if (forward !== null && wanted
      && forward.host === (desired.host || '127.0.0.1')
      && forward.port === (Number.isFinite(Number(desired.port)) ? Number(desired.port) : 0)) return
    if (forward === null && !wanted) return
    if (forward !== null) {
      const closing = forward
      forward = null
      await closing.close().catch(() => {})
    }
    if (!wanted) {
      forwardError = ''
      forwardNotice = ''
      return
    }
    // Checked again here, not only where the settings page posts: a headless
    // composition has no page to click, and `settings.json` is the way in. A
    // routable bind would spend this machine's free lane on the whole subnet.
    if (!isLoopbackHost(desired.host || '127.0.0.1')) {
      forwardError = 'the forward listener binds a loopback address only'
      logger.warn?.(`our-free-model: forward listener not started (${forwardError})`)
      return
    }
    try {
      forward = await startForwardServer({
        config: () => {
          const current = settings.get().forward ?? {}
          return { host: current.host || '127.0.0.1', port: current.port ?? 0, enabled: current.enabled === true, key: forwardKey() }
        },
        complete: (request, onChunk) => runForwarded(request, onChunk),
        modelRows: () => publicModelRows(),
        log: message => logger.warn?.(`our-free-model forward: ${message}`),
        onTrace: event => logger.info?.(`our-free-model request: ${JSON.stringify(event)}`),
      })
      forwardError = ''
      // The requested port is somebody else's for good — a `netsh interface
      // portproxy` rule outlives this plugin, and on Windows it surfaces as
      // EACCES on a loopback bind. `startForwardServer` walks to a free port
      // rather than leaving the feature down; the port it settled on is what
      // gets persisted below, and this notice is what says so.
      forwardNotice = forward.fellBack === true && forward.bindError !== null
        ? `port ${forward.requestedPort} is not available on this machine (${forward.bindError.code}); the listener is on port ${forward.port} instead`
        : ''
      if (forwardNotice !== '') logger.warn?.(`our-free-model forward: ${forwardNotice}`)
      // Persist the port that actually answers, but out of the CURRENT
      // settings - not the desired snapshot from before the await. An
      // overlapped save would otherwise be rolled back to entry-time values.
      const settledForward = settings.get().forward ?? {}
      settings.update({ forward: { ...settledForward, port: forward.port, host: forward.host || desired.host || '127.0.0.1' } })
      settings.flush()
    } catch (error) {
      forwardError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: forward listener could not start (${forwardError})`)
    }
  }

  function forwardKey() {
    const current = settings.get()
    if (typeof current.forwardKey === 'string' && current.forwardKey !== '') return current.forwardKey
    const minted = generateKey()
    settings.update({ forwardKey: minted })
    settings.flush()
    return minted
  }

  /**
   * The relay's own key. Never the local one: a key that has to travel to other
   * devices on a network is a key that will eventually leak, and a leak must
   * cost a rotation here rather than every tool already wired to the local port.
   */
  function relayKey() {
    const current = settings.get()
    if (typeof current.forwardLanKey === 'string' && current.forwardLanKey !== '') return current.forwardLanKey
    const minted = generateKey()
    settings.update({ forwardLanKey: minted })
    settings.flush()
    return minted
  }

  /** IPv4 addresses another machine on this network could dial. */
  function lanAddresses() {
    const out = []
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && entry.internal !== true) out.push(entry.address)
      }
    }
    return out
  }

  /**
   * Reconcile the optional LAN relay.
   *
   * Deliberately not folded into `syncForward`: the two doors have separate
   * lives, and toggling the relay must not close and re-bind the local port
   * under a request that is already in flight on it.
   */
  let relaySyncInFlight = null
  async function syncRelay() {
    while (relaySyncInFlight !== null) await relaySyncInFlight.catch(() => {})
    const run = syncRelayOnce()
    relaySyncInFlight = run
    try { await run } finally { if (relaySyncInFlight === run) relaySyncInFlight = null }
  }
  async function syncRelayOnce() {
    const desired = settings.get().forward ?? {}
    const lan = desired.lan ?? {}
    const wanted = lan.enabled === true
    const host = String(lan.host ?? '').trim() || '0.0.0.0'
    const port = Number.isFinite(Number(lan.port)) && Number(lan.port) > 0 ? Math.trunc(Number(lan.port)) : 0
    if (relay !== null && wanted && forward !== null && relay.host === host && relay.port === port) return
    if (relay === null && !wanted) return
    if (relay !== null) {
      const closing = relay
      relay = null
      await closing.close().catch(() => {})
    }
    if (!wanted) {
      relayError = ''
      return
    }
    // Without the local listener there is nothing to relay to, and a relay on
    // the local port would dial itself. Both are settings mistakes worth naming
    // here rather than surfacing as a socket error later.
    if (desired.enabled !== true || forward === null) {
      relayError = 'the local forward listener is not running'
      return
    }
    if (port !== 0 && port === forward.port) {
      relayError = 'the LAN relay needs a port of its own'
      logger.warn?.(`our-free-model: LAN relay not started (${relayError})`)
      return
    }
    try {
      relay = await startLanRelay({
        config: () => {
          const current = settings.get().forward ?? {}
          const currentLan = current.lan ?? {}
          return {
            enabled: currentLan.enabled === true,
            host: String(currentLan.host ?? '').trim() || '0.0.0.0',
            port: currentLan.port ?? 0,
            lanKey: relayKey(),
            localKey: forwardKey(),
            targetPort: forward?.port ?? 0,
          }
        },
        log: message => logger.warn?.(`our-free-model lan relay: ${message}`),
        onTrace: event => logger.info?.(`our-free-model request: ${JSON.stringify(event)}`),
      })
      relayError = ''
      // The port that was actually bound goes back into the settings, so the
      // address the page shows is the address that answers. Out of the CURRENT
      // settings — not the entry-time snapshot: an overlapped save during the
      // bind would otherwise be rolled back to the values this run started with.
      const settledForward = settings.get().forward ?? {}
      settings.update({ forward: { ...settledForward, lan: { ...(settledForward.lan ?? {}), port: relay.port } } })
      settings.flush()
    } catch (error) {
      relayError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: LAN relay could not start (${relayError})`)
    }
  }

  // ── the channels' gateway relay ─────────────────────────────────────────────
  /**
   * The absorbed pack serves every 白嫖 provider through one OpenAI-compatible
   * gateway on the loopback. The relay is this plugin's own door in front of
   * it: callers authenticate with `chanGateway.relay.key` and the forwarded
   * hop is re-stamped with the gateway's own credential, which never leaves
   * the host. Off until asked for; the settings page owns the switch.
   */
  let chanRelay = null
  let chanRelayError = ''
  let chanRelaySyncInFlight = null

  function chanRelayKey() {
    const relay = settings.get().chanGateway?.relay ?? {}
    if (typeof relay.key === 'string' && relay.key !== '') return relay.key
    const minted = generateKey()
    settings.update({ chanGateway: { ...(settings.get().chanGateway ?? {}), relay: { ...(settings.get().chanGateway?.relay ?? {}), key: minted } } })
    settings.flush()
    return minted
  }

  function rotateChanRelayKey() {
    const minted = generateKey()
    settings.update({ chanGateway: { ...(settings.get().chanGateway ?? {}), relay: { ...(settings.get().chanGateway?.relay ?? {}), key: minted } } })
    settings.flush()
    return minted
  }

  /** The gateway's address and credential, read fresh: both can move (env). */
  function chanGatewayTarget() {
    return {
      port: chanGatewayPort(process.env),
      enabledByEnv: chanGatewayEnabled(process.env),
      credential: chanGatewayCredential({ profileContext: optional('profileContext'), env: process.env }),
    }
  }

  async function syncChanRelay() {
    while (chanRelaySyncInFlight !== null) await chanRelaySyncInFlight.catch(() => {})
    const run = syncChanRelayOnce()
    chanRelaySyncInFlight = run
    try { await run } finally { if (chanRelaySyncInFlight === run) chanRelaySyncInFlight = null }
  }
  async function syncChanRelayOnce() {
    const relay = settings.get().chanGateway?.relay ?? {}
    const wanted = relay.enabled === true
    const host = String(relay.host ?? '').trim() || '127.0.0.1'
    const port = Number.isFinite(Number(relay.port)) && Number(relay.port) > 0 ? Math.trunc(Number(relay.port)) : 0
    const target = chanGatewayTarget()
    if (chanRelay !== null && wanted && chanRelay.host === host && chanRelay.port === port) return
    if (chanRelay === null && !wanted) return
    if (chanRelay !== null) {
      const closing = chanRelay
      chanRelay = null
      await closing.close().catch(() => {})
    }
    if (!wanted) { chanRelayError = ''; return }
    if (port !== 0 && target.port === port) {
      chanRelayError = 'the relay needs a port of its own (the gateway listens on ' + target.port + ')'
      logger.warn?.(`our-free-model: channel gateway relay not started (${chanRelayError})`)
      return
    }
    try {
      chanRelay = await startChanRelay({
        config: () => {
          const current = settings.get().chanGateway?.relay ?? {}
          const targetNow = chanGatewayTarget()
          return {
            enabled: current.enabled === true,
            host: String(current.host ?? '').trim() || '127.0.0.1',
            port: current.port ?? 0,
            lanKey: chanRelayKey(),
            gatewayHost: '127.0.0.1',
            gatewayPort: targetNow.port,
            gatewayKey: targetNow.credential?.key ?? '',
          }
        },
        log: message => logger.warn?.(`our-free-model channel relay: ${message}`),
      })
      chanRelayError = ''
      // The bound port goes back into the settings, so the page shows the
      // address that actually answers (the OS picks when 0 was asked for).
      const settled = settings.get().chanGateway ?? {}
      settings.update({ chanGateway: { ...settled, relay: { ...(settled.relay ?? {}), port: chanRelay.port } } })
      settings.flush()
    } catch (error) {
      chanRelayError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: channel gateway relay could not start (${chanRelayError})`)
    }
  }

  function chanRelayStatus() {
    const relay = settings.get().chanGateway?.relay ?? {}
    const target = chanGatewayTarget()
    return {
      relay: {
        enabled: relay.enabled === true,
        running: chanRelay !== null,
        host: chanRelay?.host ?? (String(relay.host ?? '').trim() || '127.0.0.1'),
        port: chanRelay?.port ?? relay.port ?? 0,
        hasKey: typeof relay.key === 'string' && relay.key !== '',
        error: chanRelayError,
      },
      gateway: {
        port: target.port,
        enabledByEnv: target.enabledByEnv,
        keyFound: target.credential !== null,
        keyFromEnv: target.credential?.fromEnv === true,
        keyPath: target.credential?.path ?? '',
      },
    }
  }


  // ── egress outlet ───────────────────────────────────────────────────────────
  /** One gateway round trip at a time; the panel polls, the throttle decides. */
  let latencyMeasureInFlight = null
  /**
   * Which node the outlet is carrying traffic on, and what it costs to reach the
   * gateway through it. Purely informational: every failure is a missing reading,
   * never an error, because the outlet itself may be perfectly healthy while the
   * controller call that describes it is not.
   */
  /**
   * The settings page asks "how long does opencode take to answer right now", and
   * the honest answer is a real round trip through the outlet — not the age of the
   * last catalog refresh. Re-reading the listing is the cheapest call that proves
   * the whole path (it is the same request the catalog uses, and free), so it is
   * reused here, throttled so a panel left open cannot turn into a loop.
   */
  async function measureGatewayLatency() {
    if (gatewayLatency.at !== 0 && Date.now() - gatewayLatency.at < 60_000) return
    if (latencyMeasureInFlight !== null) return await latencyMeasureInFlight.catch(() => {})
    const run = fetchListing()
      .then(() => {})
      .catch(error => {
        logger.debug?.(`our-free-model: gateway latency reading failed (${error?.message ?? error})`)
      })
    latencyMeasureInFlight = run
    try { await run } finally { if (latencyMeasureInFlight === run) latencyMeasureInFlight = null }
  }

  async function readOutletStatus() {
    const relay = outletRelay
    if (relay === null) {
      outletNode = { node: '', delayMs: 0, at: 0 }
      return { node: '', nodeDelayMs: 0, nodeAt: 0, latencyMs: 0, latencyAt: 0, lane: egressLane() }
    }
    await measureGatewayLatency().catch(() => {})
    const selection = await readOutletSelection(relay).catch(() => null)
    // A settled read is cached for `/summary`, which cannot await a round trip.
    if (outletRelay === relay) {
      outletNode = { node: selection?.node ?? '', delayMs: selection?.delayMs ?? 0, at: Date.now() }
    }
    return {
      node: selection?.node ?? '',
      nodeDelayMs: selection?.delayMs ?? 0,
      nodeAt: Date.now(),
      latencyMs: gatewayLatency.ms,
      latencyAt: gatewayLatency.at,
      lane: egressLane(),
    }
  }
  // Same serialisation gate as the two listeners above: the boot chain and every
  // settings POST call this, and overlapping runs would leak a spawned mihomo
  // (the loser overwrites `outletRelay` while the winner's child still runs).
  let outletSyncInFlight = null
  /** What the currently running outlet was started with — restart on change. */
  let outletFingerprint = ''
  async function syncEgress() {
    while (outletSyncInFlight !== null) await outletSyncInFlight.catch(() => {})
    const run = syncEgressOnce()
    outletSyncInFlight = run
    try { await run } finally { if (outletSyncInFlight === run) outletSyncInFlight = null }
  }
  async function syncEgressOnce() {
    const desired = settings.get().egress ?? {}
    const wanted = desired.enabled === true
    const mode = desired.mode === 'client' ? 'client' : 'subscription'
    const url = String(desired.url ?? '').trim()
    const mihomoPath = String(desired.mihomoPath ?? '').trim()
    const fingerprint = `${mode}\n${url}\n${mihomoPath}`
    if (outletRelay !== null && wanted && outletFingerprint === fingerprint && !outletRelay.dead) return
    if (outletRelay === null && !wanted) return
    if (outletRelay !== null) {
      const closing = outletRelay
      outletRelay = null
      outletFingerprint = ''
      await closing.close().catch(() => {})
      // The way out changed under every fetch: re-detect the exit so the pill and
      // the model verdicts describe the path the next request actually takes.
      void settleOutletWatch()
    }
    if (!wanted) {
      outletError = ''
      return
    }
    if (url === '') {
      outletError = 'the outlet needs a subscription or proxy URL'
      logger.warn?.(`our-free-model: egress outlet not started (${outletError})`)
      return
    }
    try {
      outletRelay = await startEgressRelay({
        config: () => {
          const current = settings.get().egress ?? {}
          return {
            mode: current.mode === 'client' ? 'client' : 'subscription',
            url: String(current.url ?? '').trim(),
            mihomoPath: String(current.mihomoPath ?? '').trim(),
          }
        },
        dataDir,
        log: message => logger.info?.(`our-free-model egress: ${message}`),
        onDead: scheduleOutletRestart,
        // Every failed request through the outlet, not just a refusal: the node
        // that stopped carrying traffic is the one to leave, and the cooldown in
        // the rotation below is what keeps a burst of failures from thrashing.
        onFault: error => scheduleOutletRotation(`the outlet stopped carrying traffic (${error?.message ?? error})`),
        // The lane changed path, so the exit this machine shows — and every
        // region-gated verdict measured through it — belongs to the old one.
        onLane: event => {
          logger.warn?.(event.state === 'direct'
            ? `our-free-model: egress outlet is not carrying traffic (${event.reason}); sending requests direct for ${Math.round(Math.max(0, event.benchUntil - Date.now()) / 1000)}s`
            : 'our-free-model: egress outlet is carrying traffic again')
          void watchEgress().catch(() => {})
        },
      })
      outletFingerprint = fingerprint
      outletError = ''
      outletUpSince = Date.now()
      logger.info?.(`our-free-model: egress outlet up (${outletLabel(url)} via ${mode})`)
      // Same as the close path: the exit IP, its country and the region-gated
      // verdicts all moved with the outlet, so settle them now instead of at the
      // next periodic watch.
      void settleOutletWatch()
    } catch (error) {
      outletError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: egress outlet could not start (${outletError})`)
    }
  }

  // A managed mihomo that dies mid-run used to leave the outlet bricked until
  // the user touched the settings page: the relay stays up but its dial port is
  // gone, so every upstream turn fails. syncEgressOnce already restarts a dead
  // relay with an unchanged fingerprint — this only calls it, with a backoff so
  // a mihomo that dies at boot cannot spin into a start/exit loop. A run that
  // lasted two minutes counts as healthy and resets the ladder.
  const OUTLET_STABLE_MS = 120_000
  let outletUpSince = 0
  let outletRestartAttempts = 0
  let outletRestartTimer = null
  function scheduleOutletRestart() {
    if (outletRestartTimer !== null) return
    if (Date.now() - outletUpSince >= OUTLET_STABLE_MS) outletRestartAttempts = 0
    const delay = Math.min(15_000 * 2 ** outletRestartAttempts, 600_000)
    outletRestartAttempts += 1
    logger.warn?.(`our-free-model: egress outlet went down; restarting in ${Math.round(delay / 1000)}s (attempt ${outletRestartAttempts})`)
    outletRestartTimer = setTimeout(() => {
      outletRestartTimer = null
      void syncEgress().catch(() => {})
    }, delay)
    outletRestartTimer.unref?.()
  }

  /**
   * A quota refusal — "Rate limit exceeded" — is a verdict on the address the
   * lane saw, not on the node that carried the request, and mihomo's url-test
   * cannot act on it: the health-check target still answers 204 through the node
   * the lane just refused, so that node keeps its rank and keeps winning. The
   * plugin is the only component that sees the refusal, so a refusal asks the
   * outlet to re-measure every node now and steps onto one that is off the
   * refused address.
   *
   * The unit of avoidance is that address's block, because the nodes of one
   * subscription share them. Measured on a live outlet: all five nodes
   * presenting 5.34.220.113-117 were refused together, while 23.185.208.66,
   * 155.254.104.158, 188.253.124.12 and 188.253.116.228 carried the same request
   * — several of them slower than every refused node. Remembering only names
   * therefore walked that block one node per cooldown and left the lane refused
   * the whole time, which is the report this answers.
   *
   * The same call serves the other two things that say "this exit is the wrong
   * one": a request the outlet could not carry at all, and a measured path that
   * has gone slow (the 120-second watch below). All three want the same first
   * answer — re-measure, and move to a node that is not the one being blamed —
   * so they share the guards rather than each growing their own; only a refusal,
   * which is about the address, is allowed to blame one.
   *
   * Three guards keep a burst of failed turns from thrashing the exit: one
   * rotation a minute, one at a time, and a ten-minute memory of the nodes and
   * addresses that refused — the very measurement that makes them look "fast" is
   * what hands them back.
   */
  const OUTLET_ROTATE_COOLDOWN_MS = 60_000
  const OUTLET_LIMITED_TTL_MS = 10 * 60_000
  // A refused address is out for the same window, and it is the address that
  // decides: leaving the block it belongs to can take more than one switch.
  const OUTLET_MAX_HOPS = 3
  // Which address each node presents, learned by measuring after every switch.
  const OUTLET_ADDRESS_TTL_MS = 30 * 60_000
  const limitedNodes = new Map()
  const limitedBlocks = new Map()
  const outletAddresses = new Map()
  let outletRotateAt = 0
  let outletRotation = null
  function scheduleOutletRotation(why = 'the lane rate-limited this exit', { refusal = false } = {}) {
    if (outletRotation !== null) return
    if (Date.now() - outletRotateAt < OUTLET_ROTATE_COOLDOWN_MS) return
    outletRotateAt = Date.now()
    outletRotation = rotateOutletExit(why, { refusal })
      .catch(error => logger.debug?.(`our-free-model: outlet re-measure failed (${error?.message ?? error})`))
      .finally(() => { outletRotation = null })
  }

  /** The address the outlet is presenting now, or `''` when that cannot be trusted. */
  async function measureOutletAddress() {
    const before = egressLane()
    const seen = await detectEgress({ timeoutMs: 4_000 }).catch(() => undefined)
    const after = egressLane()
    // A reading the lane answered straight from this machine describes the host,
    // not the exit: keeping it would blame the wrong address.
    if (seen === undefined || after.state === 'direct' || after.direct !== before.direct) return ''
    return typeof seen.ip === 'string' ? seen.ip : ''
  }
  function knownOutletAddress(node) {
    const remembered = outletAddresses.get(node)
    return remembered === undefined ? '' : remembered.address
  }
  function rememberOutletAddress(node, address) {
    if (node === '' || address === '') return
    outletAddresses.set(node, { address, at: Date.now() })
  }

  async function rotateOutletExit(why, { refusal = false } = {}) {
    const relay = outletRelay
    if (relay === null) return
    // A `client` outlet is the one proxy the user named: there is no node list to
    // re-measure and no second exit to step onto. Saying so beats looking like a
    // rotation happened.
    if (relay.managed === null || relay.managed === undefined) {
      logger.info?.(`our-free-model: ${why}; a single-proxy outlet has no other node to measure`)
      return
    }
    const now = Date.now()
    for (const [node, until] of limitedNodes) if (until <= now) limitedNodes.delete(node)
    for (const [block, until] of limitedBlocks) if (until <= now) limitedBlocks.delete(block)
    for (const [node, entry] of outletAddresses) if (entry.at + OUTLET_ADDRESS_TTL_MS <= now) outletAddresses.delete(node)
    const live = await readOutletSelection(relay).catch(() => null)
    const current = live?.node ?? outletNode.node
    const avoid = [...limitedNodes.keys()]
    if (current !== '') avoid.push(current)
    // What the lane just refused is the address this exit presents. Measuring it
    // now and keeping it is the whole difference: by the time the next rotation
    // runs, the exit has moved and nothing remembers which address was blamed.
    const refused = refusal ? await measureOutletAddress() : ''
    const refusedBlock = addressBlock(refused)
    // The node we are leaving is out for the cooldown window whether or not a
    // replacement was found: leaving it out of the ranking is the whole point,
    // and the next rotation is not going to hand it back.
    if (current !== '') {
      limitedNodes.set(current, now + OUTLET_LIMITED_TTL_MS)
      rememberOutletAddress(current, refused)
    }
    if (refusedBlock !== '') limitedBlocks.set(refusedBlock, now + OUTLET_LIMITED_TTL_MS)
    const outcome = await stepOffBlamedAddress(relay, {
      avoid,
      blame: refusedBlock,
      hops: OUTLET_MAX_HOPS,
      addressOf: knownOutletAddress,
      measure: () => measureOutletAddress(),
      onHop: (node, address) => {
        limitedNodes.set(node, Date.now() + OUTLET_LIMITED_TTL_MS)
        rememberOutletAddress(node, address)
        logger.debug?.(`our-free-model: the outlet landed on ${address} again; the lane refuses ${refusedBlock}`)
      },
    })
    const rotated = outcome.rotation
    if (rotated === null) {
      // Every step of the way the group was moved somewhere, so the node the
      // panel shows is re-read rather than assumed to be the one it started on.
      if (outcome.hops > 0) await readOutletStatus().catch(() => {})
      logger.warn?.(refusedBlock === ''
        ? `our-free-model: ${why} and no other measured node is available; staying on it`
        : `our-free-model: ${why}; every measured node sits on ${refusedBlock}, so there is no exit to step onto`)
      return
    }
    if (!rotated.switched) {
      logger.warn?.(`our-free-model: ${why}; re-measured the outlet and "${rotated.node}" is still the only node measured (${rotated.delayMs} ms)`)
      return
    }
    outletNode = { node: rotated.node, delayMs: rotated.delayMs, at: Date.now() }
    // The node left behind is named too: an exit that moved on its own is
    // exactly the one the owner will want to read back.
    const left = current === '' ? rotated.previous : current
    logger.warn?.(
      `our-free-model: ${why}; re-measured the outlet and moved from "${left}" to "${rotated.node}" (${rotated.delayMs} ms, best of ${rotated.candidates})`
      + (refusedBlock === '' ? '' : `; the lane refuses ${refusedBlock}`),
    )
    // The way out changed under every reading the panel and the picker show: the
    // exit IP, its country, and the region-gated verdicts all belong to the old
    // node. This is the same watch the outlet's own start and stop run, and the
    // rotation cooldown is what keeps it from becoming a loop.
    void watchEgress().catch(() => {})
  }

  /**
   * Run one forwarded OpenAI request through the adapter.
   *
   * The caller's spelling is translated into harness messages, and the resulting
   * chunk stream is handed straight back to the caller's callback while an
   * outcome summary accumulates for the non-streaming path.
   */
  async function runForwarded(request, onChunk) {
    const entry = catalog.find(candidate => candidate.id === request.model)
    // OpenAI semantics: a model the roster does not carry is the caller's
    // mistake (404 model_not_found), not the gateway's — a 502 here read as
    // "the plugin is broken" to every client that inspects the status. The same
    // gate as `/v1/models` below: a model the picker hides for having no route
    // must not become dialable just by naming it in a request body.
    if (entry === undefined || !routableModelIds().has(entry.id)) throw httpError(404, `model "${request.model}" not found`)
    const openAi = request.openAi ?? {}
    const messages = fromOpenAiMessages(openAi, request.responses === true, entry.id)
    // The caller's defs reach the adapter in the harness's own flat spelling,
    // and the adapter re-shapes them for the endpoint it picked. Pre-converting
    // them here fed `{type,function:{…}}` wrappers back into that same
    // conversion, which reads `tool.name`: every tool was dropped, the request
    // went upstream with none, and the model answered "no tool is available"
    // instead of calling the one the caller offered.
    const tools = (openAi.tools ?? []).map(normalizeTool).filter(Boolean)
    const handler = typeof onChunk === 'function' ? onChunk : () => {}
    const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }

    const options = {
      provider: ROUTE_MAIN,
      model: entry.id,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      ...typeof openAi.temperature === 'number' ? { temperature: openAi.temperature } : {},
      ...typeof openAi.max_tokens === 'number' ? { maxTokens: openAi.max_tokens } : {},
      ...typeof openAi.reasoning_effort === 'string' ? { reasoningEffort: openAi.reasoning_effort } : {},
      sessionId: `forward:${String(openAi.user ?? openAi.conversation ?? 'shared')}`,
      signal: request.signal,
    }

    for await (const chunk of adapter.stream(options, entry, state())) {
      handler(chunk)
      foldForwardOutcome(outcome, chunk)
    }
    // A max-tokens finish means the adapter judged a tool call unexecutable
    // (arguments cut mid-JSON); keep the OpenAI answer consistent with its
    // finish_reason by not reporting the broken call alongside `length`.
    if (outcome.truncated === true) {
      outcome.toolCalls = outcome.toolCalls.filter(call => {
        try { JSON.parse(call.arguments === '' ? '{}' : call.arguments); return true } catch { return false }
      })
    }
    return outcome
  }

  /** What the picker selects and the forward port may dial — one definition, two surfaces. */
  function routableModelIds() {
    const membership = new Set(state().membership[ROUTE_MAIN] ?? [])
    if (settings.get().exposeRegionModels !== false) for (const id of state().membership[ROUTE_REGION] ?? []) membership.add(id)
    return membership
  }

  function publicModelRows() {
    const membership = routableModelIds()
    return catalog
      .filter(entry => membership.has(entry.id))
      .map(entry => ({
        id: entry.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'our-free-model',
        ...entry.contextWindow === undefined ? {} : { context_window: entry.contextWindow },
      }))
  }

  // ── hot reload + in-app upgrade ─────────────────────────────────────────────
  /**
   * Swap the running plugin for the code on disk. Called for explicit reloads
   * for development. A failed ordinary reload only restores runtime state;
   * it must never overwrite current edits with an unrelated upgrade backup.
   */
  async function reloadFromDisk() {
    const status = updater.status()
    if (status.applying) throw new Error('an upgrade is already running')
    if (status.recoveryRequired) throw new Error('restore the retained upgrade backup before reloading')
    const result = await selfReload(ctx, { logger, packageUrl: PKG_URL.href, entryUrl: ENTRY_URL })
    if (result.ok) return result
    throw new Error(result.error)
  }

  async function applyUpgrade(version) {
    if (managed) throw httpError(409, MANAGED_MESSAGE)
    if (isReloading()) throw new Error('a reload is already in progress')
    const pendingKey = Symbol.for('our-free-model.pending-upgrade')
    let pending
    try {
      const result = await updater.apply({
        version,
        activate: async installed => {
          pending = { version: installed.version }
          globalThis[pendingKey] = pending
          return selfReload(ctx, { logger, packageUrl: PKG_URL.href, entryUrl: ENTRY_URL, expectedVersion: installed.version })
        },
      })
      // Notification uses the successor's stores and hub. The predecessor's
      // effects have already been disposed by the swap.
      try { pending?.notify?.() } catch (error) { logger.warn?.(`our-free-model: upgrade notification failed (${error?.message ?? error})`) }
      return { ...result, reloaded: true }
    } finally {
      if (globalThis[pendingKey] === pending) globalThis[pendingKey] = undefined
    }
  }

  /**
   * Watch the installed package and hot-reload when its files change.
   * Off by default; the settings page flips it for development and demos.
   */
  let watcher = undefined
  function syncWatcher() {
    const wanted = settings.get().autoReloadWatch === true
    if (wanted && watcher === undefined) {
      watcher = watchPackage(PKG_DIR, {
        logger,
        onChange: () => {
          const status = updater.status()
          if (isReloading() || status.applying || status.recoveryRequired) return
          logger.info?.('our-free-model: watched files changed; hot-reloading')
          void reloadFromDisk().catch(error => logger.warn?.(`our-free-model: hot reload failed (${error?.message ?? error})`))
        },
      })
    } else if (!wanted && watcher !== undefined) {
      watcher()
      watcher = undefined
    }
  }

  // ── browser-facing API ──────────────────────────────────────────────────────
  /**
   * Read a service the composition may or may not mount.
   *
   * `ctx.get` is cordis' opportunistic lookup: it answers `undefined` instead of
   * throwing when the service is absent — and also while it is merely not
   * provided yet, which matters because plugins load before the browser half has
   * published anything. So a service read this way is a snapshot: `connection` is
   * therefore resolved per request below, and `webServer` gets its own fiber (see
   * the `ctx.inject` at the end of this section).
   */
  const optional = service => (typeof ctx.get === 'function' ? ctx.get(service) : undefined)
  /**
   * The trust fence's view of the connection service, looked up per request.
   *
   * The browser half publishes `connection` after plugins have loaded, so reading
   * it once here would freeze in "absent" and leave every request on the replica
   * fence for the life of the process. The view takes the service *thunk* rather
   * than the service, and its `admit` answers `undefined` — not a no-op function
   * — while the service is missing, which is what makes the fence fall through to
   * its own structural check instead of reading as "admitted".
   */
  const fenceConnection = connectionAdmissionView(() => optional('connection'))
  // ── the absorbed free-channel pack ──────────────────────────────────────────
  /**
   * The 白嫖 channels — CodeArts (华为云), CodeBuddy / WorkBuddy (腾讯), LobsterAI
   * (有道), Qoder / Qoder CN (阿里系), TRAE (字节), Cline, Loomy (讯飞), Raccoon
   * (商汤), MiniMax Code, ZCode (智谱) and Gemini (Google) — are
   * carried with local integration adaptations from the plugin that shipped them, vendored under
   * `vendor/channel-pack` (provenance in `vendor/channel-pack/NOTICE.md`). Mounting the
   * pack keeps every login flow, account pool, credit claim, model blacklist
   * and its local OpenAI gateway working as they were validated upstream,
   * instead of being re-implemented here and drifting.
   *
   * The pack runs on a fiber of its own, after `credentials`, `commands` and
   * `llm` exist. A composition without them — a headless TUI, the offline test
   * harness — keeps the free lane and loses only the channels, the same trade
   * this plugin makes for every optional service. `channelPack` is the state
   * bit `/summary` reports so the page can say *why* the channel list is empty
   * instead of showing nothing.
   */
  let channelPack = { state: 'pending', error: '' }
  ctx.inject(['credentials', 'commands', 'llm'], scoped => {
    let stopped = false
    scoped.effect(() => () => { stopped = true }, 'our-free-model: channel pack')
    // Dynamic import: the pack's own imports (the kernel's llm and credential
    // modules) are host-provided, and a composition that lacks them must still
    // load this plugin's free lane. `pack.js` is the bundled form of the
    // vendored tree (see scripts/build-channel-pack.mjs) — one file, so the
    // release manifest stays inside its file cap.
    void import('./vendor/channel-pack/pack.js').then(pack => {
      if (stopped) return
      pack.apply(scoped, { disableOpencode: true })
      channelPack = { state: 'ready', error: '' }
      logger.info?.('our-free-model: free-channel pack mounted (CodeArts, CodeBuddy, and 11 more)')
    }).catch(error => {
      if (stopped) return
      channelPack = { state: 'failed', error: String(error?.message ?? error).slice(0, 300) }
      logger.warn?.(`our-free-model: free-channel pack unavailable (${channelPack.error})`)
    })
  })

  const logAdmissionRejection = surface => ({ status, source, reason }) => {
    // Fixed fields only: headers, request URLs and admission errors may contain
    // credentials. JSON API and SSE must report the same admission boundary.
    logger.warn?.(`our-free-model: ${surface} admission rejected status=${status} source=${source} reason=${reason}`)
  }
  const api = createApiRoutes({
    settings, stats, availability, catalog: () => catalog, state,
    refreshCatalog, refreshAvailability, syncForward, syncRelay, syncEgress,
    pool: fetchPoolSnapshot,
    eacAuth,
    // The absorbed channel pack's liveness, for the 白嫖接入 page: the page
    // renders its channel grid from this bit plus the pack's own RPC.
    channels: () => channelPack,
    chanRelay: {
      status: chanRelayStatus,
      apply: async patch => {
        const current = settings.get().chanGateway ?? {}
        const relay = { ...(current.relay ?? {}) }
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        if (patch.enabled !== undefined) relay.enabled = patch.enabled === true
        if (patch.host !== undefined) {
          const host = String(patch.host ?? '').trim()
          if (host !== '' && host !== '127.0.0.1' && host !== 'localhost' && host !== '0.0.0.0' && host !== '::') {
            throw httpError(400, 'host must be one of 127.0.0.1, localhost, 0.0.0.0, ::')
          }
          relay.host = host === 'localhost' ? '127.0.0.1' : host
        }
        if (patch.port !== undefined) {
          const port = Number(patch.port)
          if (!Number.isInteger(port) || port < 0 || port > 65535) throw httpError(400, 'port must be an integer between 0 and 65535')
          relay.port = port
        }
        settings.update({ chanGateway: { ...current, relay } })
        settings.flush()
        await syncChanRelay()
        return chanRelayStatus()
      },
      key: () => chanRelayKey(),
      rotate: rotateChanRelayKey,
    },
    // Whether the co-paid lane is open on this host at all — the settings page's
    // one-bit answer to "why do I see no EAC group" (issue #60). Reads the gate,
    // not the listing: a closed gate and a dead relay are different sentences.
    laneAvailable: () => sealedCredentialOf() !== null,
    forwardInfo: () => ({
      running: forward !== null,
      port: forward?.port ?? 0,
      error: forwardError,
      notice: forwardNotice,
      egress,
      lan: {
        running: relay !== null,
        port: relay?.port ?? 0,
        host: relay?.host ?? '',
        error: relayError,
        addresses: lanAddresses(),
      },
    }),
    // The subscription URL is a credential: only its masked label ever leaves
    // this process. `active` mirrors what egressFetch is actually doing right
    // now (direct until the relay finishes starting, direct again once closed) —
    // and a stranded outlet that has been benched to direct is the third way to
    // be off the relay, which `lane` reports so the page can say so instead of
    // showing a node the traffic is not using.
    egressInfo: () => ({
      running: outletRelay !== null,
      active: outletRelay !== null,
      lane: egressLane(),
      mode: outletRelay?.mode ?? '',
      outlet: outletRelay === null ? '' : outletLabel(outletRelay.url ?? ''),
      // Cached readings: `/summary` is synchronous, so the live controller call
      // lives in `outletStatus` below and only the last answer is echoed here.
      node: outletNode.node,
      nodeDelayMs: outletNode.delayMs,
      nodeAt: outletNode.at,
      latencyMs: gatewayLatency.ms,
      latencyAt: gatewayLatency.at,
      // `dead` is the managed mihomo dying after startup — surfaced through the
      // same field so the settings page shows why traffic fell back to direct.
      error: outletError !== '' ? outletError : (outletRelay?.dead ?? ''),
    }),
    // The settings page polls this while the outlet is on: which node url-test is
    // carrying traffic on is mihomo's own state, and it changes without anything
    // else in this process moving.
    outletStatus: () => readOutletStatus(),
    rotateKey: () => {
      const minted = generateKey()
      settings.update({ forwardKey: minted })
      settings.flush()
      return minted
    },
    rotateLanKey: () => {
      const minted = generateKey()
      settings.update({ forwardLanKey: minted })
      settings.flush()
      return minted
    },
    testModel: async (id, effort) => {
      const entry = catalog.find(candidate => candidate.id === id)
      if (entry === undefined) throw new UpstreamError(`unknown model "${id}"`, CODE.server)
      const started = Date.now()
      let firstFrame
      let sawReasoning = false
      let text = ''
      let usage
      for await (const chunk of adapter.stream({
        provider: ROUTE_MAIN,
        model: entry.id,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        reasoningEffort: effort === undefined || effort === '' ? DEFAULT_LEVEL : effort,
        sessionId: `bench:${entry.id}:${effort ?? DEFAULT_LEVEL}`,
      }, entry, state())) {
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
          if (firstFrame === undefined) firstFrame = Date.now()
          if (chunk.type === 'reasoning-delta') sawReasoning = true
          if (chunk.type === 'text-delta') text += chunk.text
        }
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'tool-calls') {
          throw new UpstreamError(chunk.reason.failure?.message ?? chunk.reason.kind, chunk.reason.failure?.code ?? CODE.server)
        }
      }
      const ms = Date.now() - started
      // Same rule as the recorded calls: the rate divides only by a window that
      // actually covers the tokens in its numerator.
      const measured = decodeWindow(firstFrame === undefined ? 0 : ms - firstFrame, windowTokens(usage, sawReasoning), true)
      return {
        model: entry.id, effort: effort ?? DEFAULT_LEVEL, ok: true,
        totalMs: ms,
        ttftMs: firstFrame === undefined ? ms : firstFrame - started,
        outputTokens: usage?.outputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        tokensPerSecond: measured.tps,
        sample: text.slice(0, 60),
      }
    },
    meta: () => ({
      version: packageVersion,
      distribution,
      generation,
      reloadedAt: settings.get().reloadedAt ?? 0,
      reloadCount: settings.get().reloadCount ?? 0,
      dataDir,
      autoReloadWatch: settings.get().autoReloadWatch === true,
      lastReload: globalThis[Symbol.for('our-free-model.last-reload')] ?? undefined,
      purgeSample: globalThis[Symbol.for('our-free-model.purge-sample')] ?? undefined,
    }),
    announcements: {
      view: feedView,
      /** Persist the complete acked set the caller assembled (full-replace
       *  semantics: the caller decides additions *and* clearings). */
      ack: ids => {
        settings.update({ announcementsAcked: [...ids] })
        settings.flush()
        return feedView()
      },
      refresh: () => feed.poll(),
    },
    update: {
      status: () => managed
        ? { ...updater.status(), managed: true, available: false, latest: '' }
        : { ...updater.status(), notifiedFor: updateNotifiedFor },
      check: async () => {
        if (managed) throw httpError(409, MANAGED_MESSAGE)
        const result = await updater.check()
        pushUpdate(true)
        return result
      },
      apply: applyUpgrade,
    },
    hotReload: () => {
      if (managed) throw httpError(409, MANAGED_MESSAGE)
      return reloadFromDisk()
    },
    /** Fixed for this generation; the settings API cannot flip it (see below). */
    managedDistribution: managed,
    push,
    connection: fenceConnection,
    onAdmissionRejection: logAdmissionRejection('settings API'),
    logger,
  })

  // The dashboard half runs in its own fiber so that a composition without an
  // HTTP server cannot take the model lane down with it.
  //
  // `ctx.inject(deps, callback)` is cordis' "run this once these services exist":
  // the callback pends while `webServer` is absent *or merely not provided yet*,
  // and is re-run if the service is replaced. That pending is the whole point —
  // reading `ctx.get('webServer')` once at apply time answered `undefined` in the
  // real web composition (plugins load before the browser half publishes it), the
  // routes never registered, and the settings page had no data source while a web
  // server was busy serving it.
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/our-free-model', handler: api }), 'our-free-model: api routes')
    // The events stream is an exact route: exact dispatch outranks the prefix, so
    // the hub's handler owns the socket while every other path still lands on the
    // JSON API.
    scoped.effect(() => server.register({ kind: 'exact', path: '/api/our-free-model/events', handler: eventsRoute }), 'our-free-model: events stream')
    logger.info?.('our-free-model: settings API mounted at /api/our-free-model')
  })

  /** Adopt one request as a live push stream, after the trust fence. */
  function eventsRoute(req, res) {
    const rejection = rejectionFor(req, fenceConnection, logAdmissionRejection('events'))
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden')
      return
    }
    push.attach(req, res, helloPayload())
  }

  function helloPayload() {
    return {
      version: packageVersion,
      announcements: { unread: feedView().unread, fetchedAt: feedView().fetchedAt },
      update: { available: updater.status().available, latest: updater.status().latest },
      reloadedAt: settings.get().reloadedAt ?? 0,
    }
  }

  // ── boot + background loop ──────────────────────────────────────────────────
  ctx.effect(() => () => {
    settings.dispose(); stats.dispose(); availability.dispose(); catalogStore.dispose()
  }, 'our-free-model: stores')

  ctx.effect(() => () => {
    void forward?.close().catch(() => {})
    void relay?.close().catch(() => {})
    void chanRelay?.close().catch(() => {})
    void outletRelay?.close().catch(() => {})
  }, 'our-free-model: forward listener')

  ctx.effect(() => () => { registration() }, 'our-free-model: adapter routes')

  ctx.effect(() => () => {
    disposed = true
    eacLoginPoller.reset()
    // The geography-reprobe timer belongs to this generation; without this it
    // outlives teardown and fires a forced probe round after the stores it
    // reads have been disposed (the rejection gets swallowed, quota burned).
    clearTimeout(reprobeTimer)
    push.dispose()
    watcher?.()
  }, 'our-free-model: push + watcher')

  ctx.effect(() => {
    void (async () => {
      attributionUserAgent = await resolveAttributionUserAgent(logger)
      if (disposed) return
      // First: the catalog refresh and its probe round below go through
      // egressFetch, so the outlet must be carrying traffic before they run.
      await syncEgress()
      if (disposed) return
      await refreshCatalog({ probe: true, force: true })
      // Every await here is a chance for teardown to have run underneath this
      // boot: a resumed refresh would start listeners the disposer already
      // closed and force a probe round against stores it disposed.
      if (disposed) return
      await syncForward()
      if (disposed) return
      await syncRelay()
      if (disposed) return
      await syncChanRelay()
      if (disposed) return
      syncWatcher()
      emitTopology()
      push.emit('hello', helloPayload())
    })().catch(error => logger.warn?.(`our-free-model: startup refresh failed (${error?.message ?? error})`))
  }, 'our-free-model: boot refresh')

  // Feed poll: shortly after boot, then on the configured period. Concurrency
  // with a manual refresh is harmless — polls share one in-flight request.
  // A managed install polls nothing: the pack speaks for the plugin.
  ctx.effect(() => {
    if (managed) return
    const first = setTimeout(() => { void feed.poll() }, 12_000)
    first.unref?.()
    return () => clearTimeout(first)
  }, 'our-free-model: first feed poll')

  /**
   * Run one task every `ms` for as long as this generation lives.
   *
   * A plain unref'd timer chain, on purpose. `ctx.interval` is a mixin over the
   * `timer` service, and reading it from a fiber that did not name `timer` in
   * `inject` throws inside the real cordis proxy (`cannot get property "timer"
   * without inject`) instead of answering `undefined` — that one read is what
   * stopped the whole plugin from activating. `timer` is not worth declaring on a
   * headless composition, and the mixin adds nothing here beyond `setTimeout` plus
   * a disposer: it must not hold the process open, and `disposed` ends it when the
   * fiber goes away. Without any loop the availability probe would run once at
   * boot, so a model that throttled, recovered, or moved behind the region gate
   * would keep the picker position it was first given.
   */
  // `ms` may be a function: the period is re-read on every re-arm, so an
  // interval changed on the settings page takes effect from the next cycle
  // instead of echoing a number the running timer will never observe.
  function every(task, ms) {
    const period = () => typeof ms === 'function' ? ms() : ms
    let handle = setTimeout(function tick() {
      if (disposed) return
      task()
      handle = setTimeout(tick, period())
      handle.unref?.()
    }, period())
    handle.unref?.()
    ctx.effect(() => () => clearTimeout(handle), 'our-free-model: interval')
  }

  if (!managed) {
    every(() => {
      void feed.poll()
      const hours = settings.get().updateCheckHours ?? 6
      if (hours > 0) void updater.check().then(() => pushUpdate(false)).catch(() => {})
    }, () => positiveOr(settings.get().feedPollMinutes, 30, 5) * 60_000)
  }
  // The probe period is in minutes, and one minute is the floor — a value of 0 or
  // a negative one would otherwise spin. This used to read `Math.max(60, …)`,
  // which floored every interval below an hour *including the shipped default of
  // 15*, so the number on the settings page was silently ignored.
  every(() => {
    void (async () => {
      await watchEgress()
      await refreshCatalog({ probe: true })
    })().catch(error => logger.warn?.(`our-free-model: periodic refresh failed (${error?.message ?? error})`))
  }, () => positiveOr(settings.get().probeIntervalMinutes, 15, 1) * 60_000)
  /**
   * The clock that catches "the outlet is up, just useless".
   *
   * Every other trigger in this file needs something to have *failed*: a refusal
   * to rotate on, a request that never came back. A node that went from 200 ms to
   * four seconds fails nothing — the turns still finish, just late — and if the
   * owner is not sitting on the settings page, nothing measures it either. So the
   * two-minute loop above takes the reading it has just paid for and acts on a
   * slow one.
   *
   * Deliberately narrow: only a *fresh* slow reading counts. A round where the
   * exit could not be read at all is left alone, because the echo sources are
   * third-party endpoints that get blocked by region and rate-limit on their own
   * — rotating the exit every two minutes over a blocked probe would churn nodes
   * for a fault that is not theirs. An outlet that is genuinely not carrying
   * traffic is the lane's business, per request, within a second.
   */
  const OUTLET_SLOW_MS = 6_000
  function judgeOutletPath() {
    if (outletRelay === null || egressLane().state === 'direct') return
    const reading = gatewayLatency
    // Stale means the measurement above did not happen this round (it is
    // throttled, and it leaves the last value alone when the call fails): acting
    // on it would re-blame a path that has already changed.
    if (reading.at === 0 || Date.now() - reading.at > 130_000) return
    if (reading.ms < OUTLET_SLOW_MS) return
    scheduleOutletRotation(`reaching the gateway through the outlet took ${(reading.ms / 1000).toFixed(1)}s`)
  }

  // A failing egress watch means the network is down, which is worth one line —
  // and only the first of a streak, or a dead link would write every two minutes
  // until the next restart. A success resets the flag for the next outage.
  let egressWarned = false
  every(() => {
    void watchEgress()
      .then(async () => {
        egressWarned = false
        // url-test re-ranks on its own one-minute cycle; the node shown on the
        // settings page follows the same cadence as the exit reading.
        await readOutletStatus().catch(() => {})
        judgeOutletPath()
      })
      .catch(error => {
        if (!egressWarned) logger.warn?.(`our-free-model: egress watch failed (${error?.message ?? error})`)
        egressWarned = true
      })
  }, 120_000)
  // The first update check waits for the boot refresh to settle, then runs once
  // even when the periodic poll is disabled (hours === 0 means opt out fully).
  // Managed installs check nothing — the pack that installed them decides.
  ctx.effect(() => {
    if (managed) return
    const first = setTimeout(() => {
      const hours = settings.get().updateCheckHours ?? 6
      if (hours <= 0) return
      void updater.check().then(() => pushUpdate(false)).catch(() => {})
    }, 40_000)
    first.unref?.()
    return () => clearTimeout(first)
  }, 'our-free-model: first update check')

  // Keep the module-level "notified" marker in sync with the stored one so a
  // reload does not re-toast the same version.
  refreshUpdatePush = () => pushUpdate(false)

  function emitTopology() {
    try { ctx.emit?.('llm/adapters-updated') } catch { /* no listener surface */ }
    registration.replace(routes())
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * An error the settings API presents with its own status line, not a bare 500.
 * Used where a refusal is the *correct* answer — a managed install declining to
 * update itself — so the page can say why instead of blaming a fault.
 */
function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/**
 * A period that cannot become a hot loop.
 *
 * `setTimeout(fn, NaN)` is `setTimeout(fn, 1)` in Node, and a settings file the
 * user edits by hand (the only way in on a headless composition) can carry
 * anything. Both timers below take their period from a stored number, so the
 * guard belongs here rather than in each caller.
 */function positiveOr(value, fallback, floor = 1) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(floor, Math.trunc(number))
}

/**
 * Coerce the settings a timer or the wire reads.
 *
 * The settings page's own cleared input field posts `0`: on the output ceiling
 * that read as `min(model capacity, 0)` and every turn came back capped at the
 * 512-token floor, and on a period it asked for a probe round a minute. A value
 * that is not a positive number is "the user did not set one", so it falls back
 * to what ships rather than being clamped into an extreme.
 */
function sanitizeSettings(patch, current) {
  const next = { ...patch }
  const positive = (key, fallback) => {
    if (next[key] === undefined) return
    const value = Number(next[key])
    next[key] = Number.isFinite(value) && value > 0 ? Math.trunc(value) : (Number(current[key]) || fallback)
  }
  positive('probeIntervalMinutes', 15)
  positive('feedPollMinutes', 30)
  positive('defaultMaxTokens', 32768)
  if (next.updateCheckHours !== undefined) {
    // Zero is a real answer here: it means "stop checking for updates".
    const hours = Number(next.updateCheckHours)
    next.updateCheckHours = Number.isFinite(hours) && hours >= 0 ? Math.trunc(hours) : (Number(current.updateCheckHours) || 6)
  }
  return next
}

/**
 * Which route advertises which model, given the last probe.
 *
 * Region-gated models move to their dedicated route, and only while the user
 * wants them shown. Everything else sits on the main route, including models a
 * probe could not reach this round — a call that never got an answer is not a
 * verdict, and a flaky network must not empty the picker.
 *
 * A model the gateway named in its listing but refused to route at all is the
 * exception: it cannot answer any prompt, so advertising it trades the user's
 * turn for a guaranteed failure. Those come out of both routes until a later
 * probe reverses the verdict, which the periodic re-probe does by itself if the
 * lane brings the id back.
 *
 * A catalog entry with no verdict at all is normal, not an edge case: a fresh
 * install has no probe history until the boot round lands (one ping per model,
 * two at a time, each with a 45 second budget), and a model the listing just
 * added has none until the next one does. Such an entry is advertised — not
 * knowing is not the same as knowing it is refused.
 *
 * The one thing that may never happen is an empty result. Every model failing
 * the same way means the lane or the client fingerprint is broken, not that the
 * whole roster went away, and a picker with no models at all is worse than one
 * with a stale entry — so a round that refused everything is ignored, geography
 * grouping and all.
 */
function computeMembership(catalog, availabilitySnapshot, settings) {
  const results = availabilitySnapshot?.results ?? {}
  const expose = settings?.exposeRegionModels !== false
  const verdictOf = entry => results[entry.id]?.state
  // Only the free lane is ever probed, so "the round refused everything" is a
  // verdict about that lane alone. The absorbed channels carry no verdict at
  // all; counting them among the refused would keep the fallback from firing
  // (usable could never empty), and a lane-wide refusal would then quietly drop
  // the whole free roster from the picker while the channels stayed listed.
  const probeable = catalog.filter(entry => !entry.channel)
  const refusedAll = probeable.length > 0 && probeable.every(entry => verdictOf(entry) === STATE.unavailable)
  let usable = catalog.filter(entry => verdictOf(entry) !== STATE.unavailable)
  if (refusedAll) usable = catalog
  const main = []
  const region = []
  for (const entry of usable) {
    const verdict = verdictOf(entry)
    if (verdict !== STATE.regionBlocked) main.push(entry.id)
    else if (expose) region.push(entry.id)
  }
  const membership = {}
  if (main.length > 0) membership[ROUTE_MAIN] = main
  if (region.length > 0) membership[ROUTE_REGION] = region
  return membership
}

function materializeCatalog(ids) {
  const rebuilt = buildCatalog(ids)
  return rebuilt.length > 0 ? rebuilt : FALLBACK_CATALOG
}

/**
 * Resolve an image attachment into a data URL the provider can accept.
 *
 * The attachment service exposes a host path, not bytes; reading it here keeps the
 * plugin free of a second credential path. An unresolvable image is reported as a
 * warning and dropped — the runtime has already text-projected files, and a
 * text-only model never sees an image block in the first place.
 */
function imageResolver(ctx, logger) {
  if (typeof ctx.get !== 'function') return undefined
  const cache = new Map()
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  return ref => {
    // Looked up per call, not once at apply time: this is the third instance of
    // the same cordis trap the release note describes for `webServer` and
    // `connection` — a service that plugins load before is not provided yet, so a
    // one-shot read silently cost the whole feature (here: image attachments,
    // with nothing in the log to say so).
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
    const id = String(ref?.attachmentId ?? '')
    if (id === '') return undefined
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    try {
      const hostPath = attachments.imageHostPath(ref)
      if (typeof hostPath !== 'string' || hostPath === '') return undefined
      const size = fs.statSync(hostPath).size
      if (size > MAX_IMAGE_BYTES) { logger.warn?.(`our-free-model: image ${id} is ${size} bytes, above the ${MAX_IMAGE_BYTES} send limit`); return undefined }
      const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png'
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`
      if (cache.size > 48) cache.clear()
      cache.set(id, url)
      return url
    } catch (error) {
      logger.warn?.(`our-free-model: could not read image ${id} (${error?.message ?? error})`)
      return undefined
    }
  }
}

/** OpenAI request messages -> harness messages, for the forward listener.
 *  Exported for the suite, which pins the assistant `source` shape the v4
 *  session format requires (issue #62). */
export function fromOpenAiMessages(body, isResponses, modelId) {
  const out = []
  const rows = isResponses
    ? normaliseResponsesInput(body.input)
    : (Array.isArray(body.messages) ? body.messages : [])
  for (const row of rows) {
    const role = row.role ?? 'user'
    const content = []
    if (typeof row.content === 'string') {
      if (row.content !== '') content.push({ type: 'text', text: row.content })
    } else if (Array.isArray(row.content)) {
      for (const part of row.content) {
        if (typeof part === 'string') { if (part !== '') content.push({ type: 'text', text: part }); continue }
        const text = part?.text ?? part?.input_text ?? part?.output_text
        if (typeof text === 'string' && text !== '') content.push({ type: 'text', text })
        const image = part?.image_url?.url ?? part?.image_url
        if (typeof image === 'string' && image !== '') {
          content.push({ type: 'image', attachment: { attachmentId: `url:${image.slice(0, 64)}`, mediaType: 'image/png', bytes: 0, width: 0, height: 0, url: image } })
        }
      }
    }
    if (role === 'tool') {
      out.push({ role: 'tool', content: [{ type: 'text', text: typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '') }], toolCallId: row.tool_call_id ?? '', source: { kind: 'tool', callId: row.tool_call_id ?? '' } })
      continue
    }
    if (role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        content.push({ type: 'tool-call', id: call.id ?? '', name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' })
      }
    }
    if (content.length === 0) continue
    out.push({
      role: role === 'developer' ? 'developer' : role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
      content,
      // The v4 session format admits a `model` source only with its provider
      // and model named (dsh-session refuses a bare one on restore), so the
      // synthesized assistant rows carry the route they will stream through.
      ...role === 'assistant' ? { source: { kind: 'model', provider: ROUTE_MAIN, model: String(modelId ?? '') } } : {},
    })
  }
  return out
}

function normaliseResponsesInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  return input.map(row => {
    if (typeof row === 'string') return { role: 'user', content: row }
    if (row.type === 'function_call') return { role: 'assistant', content: [], tool_calls: [{ id: row.call_id, function: { name: row.name, arguments: row.arguments } }] }
    if (row.type === 'function_call_output') return { role: 'tool', content: String(row.output ?? ''), tool_call_id: row.call_id }
    return row
  })
}

function normalizeTool(tool) {
  const name = tool?.name ?? tool?.function?.name
  if (typeof name !== 'string' || name.trim() === '') return null
  const parameters = tool?.parameters ?? tool?.function?.parameters ?? { type: 'object', properties: {} }
  return { name, description: String(tool?.description ?? tool?.function?.description ?? ''), parameters }
}

function foldForwardOutcome(outcome, chunk) {
  switch (chunk.type) {
    case 'text-delta': outcome.text += chunk.text; break
    case 'tool-call-delta': {
      let call = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
      if (call === undefined) { call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' }; outcome.toolCalls.push(call) }
      else call.arguments += chunk.argumentsDelta ?? ''
      if (chunk.name) call.name = chunk.name
      if (chunk.id) call.id = chunk.id
      break
    }
    case 'block-end':
      if (chunk.block?.type === 'tool-call') {
        const existing = outcome.toolCalls.find(candidate => candidate.id === chunk.block.id)
        if (existing === undefined) outcome.toolCalls.push({ slot: chunk.index, id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
      }
      break
    case 'usage': outcome.usage = toOpenAiUsage(chunk.usage); break
    case 'finish':
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      // An aborted turn carries the same in-body nothing as an errored one; both
      // are the caller's failure to report, not an empty completion.
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') outcome.error = chunk.reason.failure?.message
      break
    default: break
  }
  return outcome
}

/**
 * The settings page's HTTP surface.
 *
 * Every route runs the trust fence first: the connection service's own
 * admission when the composition mounts it (the same check the kernel applies
 * to `/api`), otherwise the structural replica in src/trust.js. The plugin's
 * prefix outranks `/api` in webServer's longest-prefix dispatch, so without
 * this fence these routes would answer callers the app itself would refuse.
 */
/** The fixed failure classes the pool proxy may surface to the client. */
const POOL_REASONS = new Set(['no-lane', 'gateway-status', 'malformed', 'unreachable'])

function createApiRoutes(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/our-free-model/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const rejection = rejectionFor(req, deps.connection, deps.onAdmissionRejection)
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    if (rejection !== undefined) return send(rejection, {
      error: rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden',
    })
    try {
      if (method === 'GET' && routePath === '/summary') {
        return send(200, buildSummary(deps))
      }
      if (method === 'GET' && routePath === '/stats') {
        return send(200, buildStats(deps.stats.get(), deps.catalog()))
      }
      if (method === 'GET' && routePath === '/outlet') {
        return send(200, await deps.outletStatus())
      }
      if (method === 'GET' && routePath === '/meta') {
        return send(200, { ...deps.meta(), feed: { fetchedAt: deps.announcements.view().fetchedAt, source: deps.announcements.view().source, error: deps.announcements.view().error }, update: deps.update.status() })
      }
      if (method === 'POST' && routePath === '/eac/login/start') {
        const started = await deps.eacAuth.start()
        return send(started.error === undefined ? 200 : 404, started.error === undefined ? started : { error: started.error })
      }
      if (method === 'GET' && routePath === '/eac/login/poll') {
        const polled = await deps.eacAuth.poll(url.searchParams.get('link') ?? '')
        const status = polled.error === undefined ? 200 : polled.error === 'bad-link' ? 400 : polled.error === 'no-lane' ? 404 : 502
        return send(status, polled)
      }
      if (method === 'POST' && routePath === '/eac/login/cancel') {
        const cancelled = deps.eacAuth.cancel(url.searchParams.get('link') ?? '')
        return send(cancelled.error === undefined ? 200 : 400, cancelled)
      }
      if (method === 'GET' && routePath === '/eac/status') {
        return send(200, await deps.eacAuth.status())
      }
      if (method === 'POST' && routePath === '/eac/logout') {
        return send(200, await deps.eacAuth.logout())
      }
      if (method === 'GET' && routePath === '/pool') {
        try { return send(200, await deps.pool()) } catch (error) {
          const reason = POOL_REASONS.has(error?.reason) ? error.reason : 'unreachable'
          deps.logger?.warn?.(`our-free-model: pool snapshot unavailable (${reason})`)
          return send(404, { error: `pool unavailable (${reason})` })
        }
      }
      if (method === 'GET' && routePath === '/announcement') {
        // A managed install also stands down the owner's onboarding copy: the
        // pack, not the plugin, speaks for what is new.
        const acknowledged = deps.managedDistribution === true || deps.settings.get().announcementAck === ANNOUNCEMENT_VERSION
        return send(200, { version: ANNOUNCEMENT_VERSION, acknowledged })
      }
      if (method === 'POST' && routePath === '/announcement/ack') {
        // Bounded like every other write to this file: the query string is
        // caller-controlled, and the comparison downstream only ever matches a
        // version id — nothing needs the whole string.
        deps.settings.update({ announcementAck: String(url.searchParams.get('version') ?? ANNOUNCEMENT_VERSION).slice(0, 64) })
        deps.settings.flush()
        return send(200, { ok: true })
      }
      if (method === 'GET' && routePath === '/announcements') {
        const view = deps.announcements.view()
        return send(200, { ...view, acked: [...ackedSet(deps)], notifyOs: deps.settings.get().notifyOs === true })
      }
      if (method === 'POST' && routePath === '/announcements/ack') {
        const body = await readJson(req)
        const acked = ackedSet(deps)
        if (body.all === true) {
          // "mark all read": every announcement currently in the feed.
          for (const item of deps.announcements.view().items) acked.add(item.id)
        }
        if (typeof body.id === 'string' && body.id !== '') acked.add(body.id)
        deps.announcements.ack(acked)
        return send(200, { ok: true, view: deps.announcements.view() })
      }
      if (method === 'POST' && routePath === '/announcements/refresh') {
        // Managed installs poll no feed; a manual refresh is a polite no-op
        // rather than a network round the pack never asked for.
        if (deps.managedDistribution !== true) await deps.announcements.refresh()
        return send(200, { ok: true, view: deps.announcements.view() })
      }
      if (method === 'GET' && routePath === '/update/status') {
        return send(200, deps.update.status())
      }
      if (method === 'POST' && routePath === '/update/check') {
        const result = await deps.update.check()
        return send(200, { ...result, status: deps.update.status() })
      }
      if (method === 'POST' && routePath === '/update/apply') {
        const body = await readJson(req)
        const result = await deps.update.apply(body?.version === undefined ? undefined : String(body.version))
        return send(200, { ok: true, ...result })
      }
      if (method === 'POST' && routePath === '/reload') {
        // A managed install does not swap its own bytes; the pack owns them.
        if (deps.managedDistribution === true) return send(409, { error: 'this installation is managed; updates are handled by the pack that installed it' })
        const status = deps.update.status()
        if (status.applying || status.recoveryRequired) return send(409, {
          error: status.applying ? 'an upgrade is already running' : 'restore the retained upgrade backup before reloading',
        })
        // Answer first, then swap: the response rides an already-accepted
        // socket, but the client should not wait on the reload finishing. The
        // swap closure is `deps.hotReload`, applied inside `apply` — this
        // module-level handler has no access to the fiber's own context.
        send(202, { ok: true, note: 'hot reload started' })
        setTimeout(() => {
          Promise.resolve()
            .then(() => deps.hotReload())
            .catch(error => deps.logger?.warn?.(`our-free-model: hot reload failed (${error?.message ?? error})`))
        }, 50).unref?.()
        return
      }
      if (method === 'POST' && routePath === '/settings') {
        const patch = await readJson(req)
        const current = deps.settings.get()
        const next = sanitizeSettings({ ...current, ...pick(patch, ['enabled', 'exposeRegionModels', 'probeIntervalMinutes', 'defaultMaxTokens', 'announcementAck', 'feedUrl', 'feedPollMinutes', 'notifyOs', 'updateCheckHours', 'autoReloadWatch']) }, current)
        if (patch.forward !== undefined) {
          const forward = { ...(current.forward ?? {}), ...pick(patch.forward, ['enabled', 'host', 'port']) }
          // The listener spends this machine's lane, and a routable bind address
          // would let the whole subnet spend it too. Refused here so the settings
          // page says why, and again in `syncForward` for a hand-edited file.
          if (forward.enabled === true && !isLoopbackHost(forward.host ?? '127.0.0.1')) {
            return send(400, { error: 'the forward listener binds a loopback address only' })
          }
          if (forward.port !== undefined) {
            const port = Number(forward.port)
            forward.port = Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.trunc(port) : (current.forward?.port ?? 0)
          }
          // The LAN relay is a second door on the same feature, so it travels in
          // the same `forward` patch — but it does *not* inherit the loopback
          // rule, because reaching another machine is its entire purpose.
          if (patch.forward.lan !== undefined) {
            const lan = { ...(current.forward?.lan ?? {}), ...pick(patch.forward.lan, ['enabled', 'port']) }
            if (lan.port !== undefined) {
              const port = Number(lan.port)
              // Zero asks the OS to choose, which is the sane default here: the
              // local port is frequently taken on a machine that already runs
              // something else.
              lan.port = Number.isFinite(port) && port >= 0 && port <= 65535 ? Math.trunc(port) : (current.forward?.lan?.port ?? 0)
            }
            forward.lan = lan
          }
          next.forward = forward
        }
        if (patch.egress !== undefined) {
          const egressPatch = pick(patch.egress, ['enabled', 'mode', 'url', 'mihomoPath'])
          if (egressPatch.mode !== undefined && egressPatch.mode !== 'subscription' && egressPatch.mode !== 'client') {
            return send(400, { error: 'the egress mode is "subscription" or "client"' })
          }
          for (const key of ['url', 'mihomoPath']) {
            if (egressPatch[key] !== undefined) {
              const value = String(egressPatch[key]).trim()
              if (value.length > 2048) return send(400, { error: `the egress ${key} is too long` })
              egressPatch[key] = value
            }
          }
          const egress = { ...(current.egress ?? {}), ...egressPatch }
          if (egress.enabled === true && String(egress.url ?? '') === '') {
            return send(400, { error: 'the outlet needs a subscription or proxy URL' })
          }
          next.egress = egress
        }
        deps.settings.update(next)
        deps.settings.flush()
        await deps.syncForward()
        await deps.syncRelay()
        await deps.syncEgress()
        return send(200, { ok: true, settings: publicSettings(deps.settings.get(), deps.forwardInfo(), deps.egressInfo()) })
      }
      if (method === 'POST' && routePath === '/refresh') {
        await deps.refreshCatalog({ probe: true, force: true })
        return send(200, { ok: true, ...buildSummary(deps) })
      }
      if (method === 'POST' && routePath === '/reprobe') {
        await deps.refreshAvailability(true)
        return send(200, { ok: true, ...buildSummary(deps) })
      }
      if (method === 'GET' && routePath === '/forward/key') {
        return send(200, { key: deps.settings.get().forwardKey ?? '' })
      }
      if (method === 'POST' && routePath === '/forward/rotate') {
        return send(200, { key: deps.rotateKey() })
      }
      // The channels' gateway relay (the pack's loopback OpenAI endpoint,
   // re-exposed under this plugin's own key). Status never carries a secret;
      // the key routes are read by the same fence as every other route here.
      if (method === 'GET' && routePath === '/chan-gateway') {
        return send(200, deps.chanRelay.status())
      }
      if (method === 'POST' && routePath === '/chan-gateway/apply') {
        const body = await readJson(req)
        return send(200, await deps.chanRelay.apply(body))
      }
      if (method === 'GET' && routePath === '/chan-gateway/key') {
        return send(200, { key: deps.chanRelay.key() })
      }
      if (method === 'POST' && routePath === '/chan-gateway/rotate') {
        return send(200, { key: deps.chanRelay.rotate() })
      }
      if (method === 'GET' && routePath === '/forward/lan/key') {
        return send(200, { key: deps.settings.get().forwardLanKey ?? '' })
      }
      if (method === 'POST' && routePath === '/forward/lan/rotate') {
        return send(200, { key: deps.rotateLanKey() })
      }
      // The subscription/proxy URL is a credential, so it lives outside every
      // routine payload and leaves the process only when the settings page asks
      // for it — the same shape as the forward keys above.
      if (method === 'GET' && routePath === '/egress/url') {
        return send(200, { url: deps.settings.get().egress?.url ?? '' })
      }
      if (method === 'POST' && routePath === '/bench') {
        const body = await readJson(req)
        const result = await deps.testModel(String(body.model ?? ''), body.effort === undefined ? undefined : String(body.effort))
        return send(200, result)
      }
      return send(404, { error: 'not found' })
    } catch (error) {
      const status = Number(error?.statusCode)
      return send(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, { error: String(error?.message ?? error) })
    }
  }
}

function ackedSet(deps) {
  const value = deps.settings.get().announcementsAcked
  return new Set(Array.isArray(value) ? value : [])
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) if (source?.[key] !== undefined) out[key] = source[key]
  return out
}

/** The most a browser-API request body may weigh. The settings patch and the
 *  announcement acks are the largest real payloads here by orders of magnitude;
 *  without a cap, any caller past the fence could buffer unbounded bytes into
 *  the host process — a different standard than the forward listener's 8 MB. */
const MAX_API_BODY_BYTES = 1024 * 1024

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_API_BODY_BYTES) throw httpError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(text) } catch (error) {
    // A body that was sent but is not JSON is a client bug, not "no body":
    // answering {} made POST /settings a silent 200 no-op. Empty bodies stay
    // legal ({} above) because no-body POSTs are real routes here.
    throw httpError(400, `invalid JSON body (${error?.message ?? error})`)
  }
}

function publicSettings(settings, forwardInfo, egressInfo) {
  return {
    enabled: settings.enabled !== false,
    exposeRegionModels: settings.exposeRegionModels !== false,
    probeIntervalMinutes: settings.probeIntervalMinutes ?? 15,
    defaultMaxTokens: settings.defaultMaxTokens ?? 32768,
    announcementAck: settings.announcementAck ?? '',
    feedUrl: typeof settings.feedUrl === 'string' ? settings.feedUrl : '',
    feedPollMinutes: settings.feedPollMinutes ?? 30,
    notifyOs: settings.notifyOs === true,
    updateCheckHours: settings.updateCheckHours ?? 6,
    autoReloadWatch: settings.autoReloadWatch === true,
    reloadedAt: settings.reloadedAt ?? 0,
    reloadCount: settings.reloadCount ?? 0,
    forward: {
      ...(settings.forward ?? {}),
      running: forwardInfo.running,
      actualPort: forwardInfo.port,
      error: forwardInfo.error,
      notice: forwardInfo.notice ?? '',
      lan: {
        ...(settings.forward?.lan ?? {}),
        running: forwardInfo.lan?.running === true,
        actualPort: forwardInfo.lan?.port ?? 0,
        host: forwardInfo.lan?.host ?? '',
        error: forwardInfo.lan?.error ?? '',
        addresses: forwardInfo.lan?.addresses ?? [],
      },
    },
    // A subscription link is not an endpoint, it is a bearer credential: the
    // path of the URL *is* the token, which is why it is handled like the
    // forward keys and not like `feedUrl`. Stored as given, but never echoed —
    // `urlLabel` is the masked host for the panel, `hasUrl` says whether one is
    // set at all, and the value itself is served only by `GET /egress/url`, on
    // the settings page's own ask (see src/egress.js `outletLabel`).
    egress: {
      ...pick(settings.egress ?? {}, ['enabled', 'mode', 'mihomoPath']),
      hasUrl: String(settings.egress?.url ?? '') !== '',
      urlLabel: outletLabel(settings.egress?.url ?? ''),
      outlet: egressInfo?.outlet ?? '',
      running: egressInfo?.running === true,
      active: egressInfo?.active === true,
      // The node url-test is carrying traffic on, its last measured delay, and
      // how long reaching the gateway took. All three are readings, not state.
      node: egressInfo?.node ?? '',
      nodeDelayMs: egressInfo?.nodeDelayMs ?? 0,
      latencyMs: egressInfo?.latencyMs ?? 0,
      latencyAt: egressInfo?.latencyAt ?? 0,
      // Which path requests are actually on, as opposed to which node is
      // selected: `direct` is the stranded-outlet bypass, `probing` the request
      // that tests it, `strained` the strike that has not benched it yet.
      lane: {
        state: egressInfo?.lane?.state ?? 'off',
        reason: egressInfo?.lane?.reason ?? '',
        until: egressInfo?.lane?.benchUntil ?? 0,
        direct: egressInfo?.lane?.direct ?? 0,
      },
      error: egressInfo?.error ?? '',
    },
  }
}

function buildSummary(deps) {
  const state = deps.state()
  const snapshot = deps.availability.get()
  const forwardInfo = deps.forwardInfo()
  const update = deps.update.status()
  const feedView = deps.announcements.view()
  const defaultMaxTokens = deps.settings.get().defaultMaxTokens
  return {
    catalog: state.catalog.map(entry => ({
      ...entry,
      // The absorbed channels are not probed: their presence in the roster is
      // the verdict — the listing round named them after the round succeeded.
      availability: isEacEntry(entry) || isKiloEntry(entry) ? STATE.available : (snapshot.results?.[entry.id]?.state ?? STATE.unknown),
      detail: isEacEntry(entry) || isKiloEntry(entry) ? '' : (snapshot.results?.[entry.id]?.detail ?? ''),
      probedAt: isEacEntry(entry) || isKiloEntry(entry) ? 0 : (snapshot.results?.[entry.id]?.at ?? 0),
      ttftMs: isEacEntry(entry) || isKiloEntry(entry) ? undefined : snapshot.results?.[entry.id]?.ttftMs,
      latencyMs: isEacEntry(entry) || isKiloEntry(entry) ? undefined : snapshot.results?.[entry.id]?.latencyMs,
      // What each rung of the effort menu will really put on the wire for this
      // model, so the page never shows a 32K "output ceiling" beside a call that
      // was cut off at 8K. A model with no effort menu has no ladder to show.
      ...(entry.reasoning === true ? { budgets: budgetLadder(entry, undefined, defaultMaxTokens) } : {}),
      // `null` here is what the picker does not advertise; the roster still lists
      // those models, because "the probe refused it" is the user's only evidence.
      route: (state.membership[ROUTE_MAIN] ?? []).includes(entry.id) ? ROUTE_MAIN
        : (state.membership[ROUTE_REGION] ?? []).includes(entry.id) ? ROUTE_REGION : null,
    })),
    settings: publicSettings(deps.settings.get(), forwardInfo, deps.egressInfo()),
    egress: forwardInfo.egress ?? snapshot.egress ?? null,
    outlet: deps.egressInfo(),
    probedAt: snapshot.at ?? 0,
    announcementVersion: ANNOUNCEMENT_VERSION,
    version: deps.meta().version,
    distribution: deps.meta().distribution,
    announcements: { unread: feedView.unread, fetchedAt: feedView.fetchedAt },
    // One bit for the settings page: false with an empty EAC group means the
    // gate never opened (a host the kernel gave no profile context), which is a
    // different sentence from "the relay is down" (issue #60).
    laneAvailable: deps.laneAvailable?.() === true,
    // The last GitHub-authorization verdict (the settings page refreshes it via
    // /eac/status on mount). `authorized: false` with the lane available is the
    // one state the model cards badge as locked.
    eacAuth: deps.eacAuth?.cached?.() ?? null,
    // Whether the absorbed free-channel pack is live on this host, and its
    // failure reason when it is not (see the mount in `apply`).
    channels: deps.channels?.() ?? { state: 'unknown', error: '' },
    update: { available: update.available, latest: update.latest, current: update.current, checkedAt: update.checkedAt, applying: update.applying, managed: update.managed === true },
  }
}

export function buildStats(stats, catalog) {
  const days = stats.days ?? {}
  const series = Object.keys(days).sort().map(day => ({
    day,
    total: days[day].total ?? 0,
    models: Object.entries(days[day].models ?? {}).map(([model, value]) => ({ model, ...value })),
  }))
  const totals = {}
  for (const entry of series) for (const row of entry.models) {
    const previous = totals[row.model] ?? {
      model: row.model, input: 0, output: 0, reasoning: 0, calls: 0, failed: 0,
      ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
    }
    totals[row.model] = {
      ...previous,
      input: previous.input + row.input,
      output: previous.output + row.output,
      reasoning: previous.reasoning + row.reasoning,
      calls: previous.calls + row.calls,
      failed: previous.failed + row.failed,
      ttftMs: previous.ttftMs + (row.ttftMs ?? 0),
      ttftSamples: previous.ttftSamples + (row.ttftSamples ?? 0),
      decodeMs: previous.decodeMs + (row.decodeMs ?? 0),
      decodeTokens: previous.decodeTokens + (row.decodeTokens ?? 0),
    }
  }
  const logical = stats.logical ?? {}
  const logicalModels = logical.models ?? {}
  const logicalReady = Number.isSafeInteger(logical.turns)
  const lifetimeModels = stats.models ?? {}
  const empty = model => ({
    model, input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0,
    ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
  })
  const modelIds = new Set([...Object.keys(totals), ...Object.keys(lifetimeModels)])
  const named = [...modelIds].map(model => {
    const row = totals[model] ?? empty(model)
    const lifetime = lifetimeModels[model] ?? {}
    const physical = {
      ...row,
      input: Number.isSafeInteger(lifetime.input) ? lifetime.input : row.input,
      output: Number.isSafeInteger(lifetime.output) ? lifetime.output : row.output,
      reasoning: Number.isSafeInteger(lifetime.reasoning) ? lifetime.reasoning : row.reasoning,
      cacheRead: Number.isSafeInteger(lifetime.cacheRead) ? lifetime.cacheRead : row.cacheRead,
      calls: Number.isSafeInteger(lifetime.calls) ? lifetime.calls : row.calls,
      failed: Number.isSafeInteger(lifetime.failed) ? lifetime.failed : row.failed,
    }
    return {
      ...physical,
      turns: logicalModels[model]?.turns ?? (logicalReady ? 0 : row.calls),
      failedTurns: logicalModels[model]?.failed ?? (logicalReady ? 0 : row.failed),
      recoveredTurns: logicalModels[model]?.recovered ?? 0,
      name: catalog.find(entry => entry.id === model)?.name ?? model,
      // A rate over too few measurable calls is a rounding error with a unit on it.
      tps: row.decodeMs >= MIN_DECODE_MS ? Math.round(row.decodeTokens / (row.decodeMs / 1000)) : null,
      avgTtftMs: row.ttftSamples > 0 ? Math.round(row.ttftMs / row.ttftSamples) : null,
    }
  })
  const physicalFailed = named.reduce((sum, row) => sum + row.failed, 0)
  const turns = logicalReady ? logical.turns : named.reduce((sum, row) => sum + row.turns, 0)
  const failedTurns = Number.isSafeInteger(logical.failed) ? logical.failed : named.reduce((sum, row) => sum + row.failedTurns, 0)
  const recoveredTurns = Number.isSafeInteger(logical.recovered) ? logical.recovered : named.reduce((sum, row) => sum + row.recoveredTurns, 0)
  const hasLifetimeFailures = Number.isSafeInteger(stats.failedRequests)
  return {
    requests: stats.requests ?? 0,
    requestFailures: hasLifetimeFailures ? stats.failedRequests : physicalFailed,
    requestFailuresEstimated: stats.failedRequestsEstimated === true || !hasLifetimeFailures,
    logicalEstimated: logical.estimated === true,
    turns,
    failedTurns,
    recoveredTurns,
    days: series,
    models: named,
    samples: (stats.samples ?? []).slice(-200),
    grand: {
      input: named.reduce((sum, row) => sum + row.input, 0),
      output: named.reduce((sum, row) => sum + row.output, 0),
      reasoning: named.reduce((sum, row) => sum + row.reasoning, 0),
      calls: named.reduce((sum, row) => sum + row.calls, 0),
      failed: hasLifetimeFailures ? stats.failedRequests : physicalFailed,
      turns,
      failedTurns,
      recoveredTurns,
    },
  }
}
