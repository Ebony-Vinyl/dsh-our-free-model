/**
 * Subagent model-route synchronisation.
 *
 * `@deepseek-ai/dsh-tool-subagent` gates every explicit child LLM choice
 * behind an allowlist it reads from the `subagent-model-selection-settings`
 * row in the profile patch. A provider being *registered* on `ctx.llm` is
 * therefore not the same thing as being *reachable* from a child: this
 * plugin registers 19 routes and 700+ models, and until the user edits the
 * YAML by hand, every one of them is refused at delegation time with
 *
 *     child LLM route "cline/anthropic/claude-opus-5.5" is not allowed
 *     for this Session
 *
 * This module closes that gap by deriving the allowlist from the one source
 * that is already live and authoritative — the LLM runtime itself — and
 * writing it back through the kernel's own configuration editor.
 *
 * Why `configEditor` and not a direct file write: `ConfigEditor.edit()`
 * validates the next config against the entry's resolved schema, persists it
 * atomically under the profile lock, and then reconciles the Loader so the
 * change is live without a restart. A hand-written YAML edit gets the file
 * right and the runtime stale, and a hand-run `yaml.dump` would flatten the
 * user's comments and reformat 44 unrelated rows.
 *
 * What it deliberately does NOT do:
 * - It never removes a route the user added by hand. The union is
 *   additive: hand-maintained entries survive a sync, and a provider that
 *   disappears from the runtime is kept, because the user's own note about
 *   why they allowed it outlives one restart.
 * - It never touches `enabled`. Turning the feature off is the user's call,
 *   and a sync that re-enabled it would be a surprise.
 * - It writes nothing when the composition has no `configEditor` (a headless
 *   or SDK profile). The caller reports "unavailable" instead of throwing,
 *   because failing sync must not take the settings page down with it.
 *
 * @module src/subagent-routes.js
 */

/**
 * The row this feature edits. A literal string rather than a lookup by name,
 * because a profile may legitimately patch the same plugin twice under
 * different ids and the id is what the loader addresses.
 */
const SELECTION_ROW_ID = 'subagent-model-selection-settings'

/** Route shape the allowlist schema requires. */
function route(provider, model) {
  return { provider, model }
}

/** `cli/foo/bar` under provider `cli` is model `foo/bar`, not provider `cli/foo`. */
function splitRoute(id, provider) {
  if (provider !== undefined && id.startsWith(`${provider}/`)) {
    return { provider, model: id.slice(provider.length + 1) }
  }
  const at = id.indexOf('/')
  if (at === -1) return { provider: id, model: id }
  return { provider: id.slice(0, at), model: id.slice(at + 1) }
}

/**
 * Everything currently registered on the LLM runtime, as exact routes.
 *
 * This is the same enumeration `list_subagent_models` performs, read from the
 * same service, so what a sync offers is exactly what a child can dial.
 * Provider listing is synchronous; model listing is per-provider and may
 * reject, so one dead provider must not abort the whole read.
 *
 * @param {{listProviders?: () => Array<{id?: string}>, listModels?: (p: string) => Promise<Array<{id?: string}>>}} llm
 * @param {(provider: string, error: unknown) => void} [onProviderError]
 * @returns {Promise<{routes: Array<{provider: string, model: string}>, providers: string[], byProvider: Map<string, number>, failures: Array<{provider: string, message: string}>}>}
 */
export async function collectRegisteredRoutes(llm, onProviderError) {
  const empty = { routes: [], providers: [], byProvider: new Map(), failures: [] }
  if (typeof llm?.listProviders !== 'function') return empty

  let providers = []
  try {
    providers = llm.listProviders() ?? []
  } catch (error) {
    onProviderError?.('listProviders', error)
    return empty
  }

  const ids = providers
    .map(entry => (typeof entry?.id === 'string' ? entry.id : ''))
    .filter(id => id !== '')
  if (ids.length === 0) return empty

  const routes = []
  const byProvider = new Map()
  const failures = []
  const seen = new Set()

  await Promise.all(ids.map(async provider => {
    let models = []
    try {
      models = typeof llm.listModels === 'function' ? (await llm.listModels(provider)) ?? [] : []
    } catch (error) {
      onProviderError?.(provider, error)
      failures.push({ provider, message: String(error?.message ?? error) })
      return
    }
    let count = 0
    for (const model of models) {
      const id = typeof model?.id === 'string' ? model.id : ''
      if (id === '') continue
      const key = `${provider}\0${id}`
      if (seen.has(key)) continue
      seen.add(key)
      routes.push(route(provider, id))
      count += 1
    }
    // A provider that registers but advertises nothing still counts as
    // present: it is a route the user may select by an unlisted id, and the
    // tool documentation says adapters may accept such ids.
    byProvider.set(provider, count)
  }))

  routes.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
  return { routes, providers: [...ids].sort(), byProvider, failures }
}

/**
 * Merge registered routes into an existing allowlist without losing anything.
 *
 * `current` is the user's live config — hand edits and earlier syncs both.
 * The result is `current` followed by every registered route it lacks, so a
 * re-run is a no-op and a stable diff never churns.
 *
 * @param {{routes: Array<{provider: string, model: string}>}} registered
 * @param {Array<{provider: string, model: string}>} [current]
 * @returns {{routes: Array<{provider: string, model: string}>, added: number, skipped: Array<{provider: string, model: string}>}}
 */
export function mergeRoutes(registered, current) {
  const base = Array.isArray(current) ? current : []
  const seen = new Set()
  for (const entry of base) {
    if (typeof entry?.provider !== 'string' || typeof entry?.model !== 'string') continue
    if (entry.provider === '' || entry.model === '') continue
    seen.add(`${entry.provider}\0${entry.model}`)
  }

  const routes = [...base]
  const skipped = []
  let added = 0
  for (const entry of registered.routes) {
    const key = `${entry.provider}\0${entry.model}`
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ provider: entry.provider, model: entry.model })
    added += 1
  }
  return { routes, added, skipped }
}

/**
 * Describe what a sync would do, without performing it.
 *
 * @param {{routes: Array<{provider: string, model: string}>}} registered
 * @param {Array<{provider: string, model: string}>} [current]
 */
export function planSync(registered, current) {
  const base = Array.isArray(current) ? current : []
  const present = new Set(base.map(e => `${e?.provider}\0${e?.model}`))
  const additions = registered.routes.filter(r => !present.has(`${r.provider}\0${r.model}`))
  const stale = base.filter(e => {
    const p = `${e?.provider}`
    return e?.provider !== undefined && !registered.byProvider.has(p)
  })
  return {
    current: base.length,
    registered: registered.routes.length,
    providers: registered.providers.length,
    additions: additions.length,
    stale: stale.length,
    /** Providers in the runtime the allowlist never names. */
    absentProviders: registered.providers.filter(p => !base.some(e => e?.provider === p)),
  }
}

/**
 * Perform a sync through the kernel's configuration editor.
 *
 * The whole change happens in one `edit()` call: the callback receives the
 * live config and returns the next one, so the write, the schema validation
 * and the reload are one operation. Whatever the callback throws surfaces to
 * the caller as a rejection with the original message.
 *
 * @param {object} args
 * @param {{entries: () => Array<object>, configuration: () => Array<{entry: object, inherited: Record<string, unknown>, override: Record<string, unknown>}>, edit: (entry: object, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => Promise<void>}} args.configEditor
 * @param {{routes: Array<{provider: string, model: string}>}} args.registered
 * @param {string} [args.rowId]
 * @param {{logger?: {info?: (m: string) => void, warn?: (m: string) => void}}} [args.logger]
 * @returns {Promise<{ok: boolean, rowId?: string, added?: number, total?: number, reason?: string}>}
 */
export async function syncSubagentRoutes(configEditor, registered, { rowId = SELECTION_ROW_ID, logger } = {}) {
  if (configEditor === undefined || typeof configEditor.edit !== 'function') {
    return { ok: false, reason: 'config-editor-unavailable' }
  }

  let entry
  try {
    entry = configEditor.entries().find(candidate => candidate?.options?.id === rowId)
  } catch (error) {
    return { ok: false, reason: `entries-failed: ${String(error?.message ?? error)}` }
  }
  if (entry === undefined) {
    return { ok: false, reason: `row-not-found: ${rowId}` }
  }

  let current = []
  try {
    const configuration = configEditor.configuration()
    current = configuration.find(row => row?.entry === entry)?.override?.allowedModels ?? []
  } catch (error) {
    // Fall through with an empty current: the editor hands the change
    // callback the live value anyway, so this read is an optimisation.
    logger?.warn?.(`our-free-model: subagent route sync could not pre-read the allowlist (${String(error?.message ?? error)})`)
  }

  try {
    await configEditor.edit(entry, (live, inherited) => {
      const merged = mergeRoutes(registered, Array.isArray(live?.allowedModels) ? live.allowedModels : current)
      const allowedModels = merged.routes.length > 0 ? merged.routes : inherited?.allowedModels
      return {
        // `enabled` is the user's decision; a sync must never flip it, and
        // an inherited `true` is only honoured when the override already had
        // the field, so a first sync never silently turns the feature on.
        ...live,
        enabled: typeof live?.enabled === 'boolean' ? live.enabled : inherited?.enabled ?? live?.enabled,
        allowedModels,
      }
    })
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }

  const added = mergeRoutes(registered, current).added
  logger?.info?.(`our-free-model: synced subagent routes (+${added}), ${registered.routes.length} registered across ${registered.providers.length} providers`)
  return { ok: true, rowId, added, total: registered.routes.length }
}

/**
 * Create the sync façade the settings page and the periodic task share.
 *
 * The configuration editor is not injectable from this plugin's own fiber
 * (`configEditor` publishes `loader`), so it arrives late — through a nested
 * fiber — and is attached with `bind` once it exists. Until then `inspect`
 * still reports the live route table and what a sync would add, which is the
 * half that does not need the editor, and `sync` reports
 * `config-editor-unavailable` instead of throwing.
 *
 * @param {object} args
 * @param {{listProviders?: Function, listModels?: Function}} args.llm
 * @param {object} [args.configEditor]
 * @param {{info?: Function, warn?: Function}} [args.logger]
 */
export function createSubagentRouteSync({ llm, configEditor, logger } = {}) {
  let editor = configEditor

  /** Attach the editor once its fiber publishes it. Idempotent. */
  function bind(next) {
    if (next === undefined || typeof next.edit !== 'function') return false
    editor = next
    return true
  }

  return {
    bind,
    /** Read the live route table and what a sync would add. Writes nothing. */
    async inspect() {
      const registered = await collectRegisteredRoutes(llm)
      return { ...registered, ...planSync(registered, currentAllowlist()) }
    },
    /** Derive the allowlist from the runtime and persist it. */
    async sync() {
      const registered = await collectRegisteredRoutes(llm)
      return await syncSubagentRoutes(editor, registered, { logger })
    },
  }

  function currentAllowlist() {
    try {
      const configuration = editor?.configuration?.()
      const row = configuration?.find(r => r?.entry?.options?.id === SELECTION_ROW_ID)
      return row?.override?.allowedModels ?? []
    } catch {
      return []
    }
  }
}
