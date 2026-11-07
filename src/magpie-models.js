import { createSubscriptionRuntime } from './subscription-completion.js'
import { loopbackFetch } from './loopback-fetch.js'
import { deniedModel } from './magpie-policy.js'

const PREFIX = 'subscription:magpie/'

/**
 * Engine inference rides the host's replaceable `globalThis.fetch` — the same
 * transport the imported sidecar subscriptions already use — so local proxy
 * plugins that swap `globalThis.fetch` to re-serialize outgoing bodies can see
 * engine turns again, as they could before the 2026-10-24 private-transport
 * quarantine. Startup, health, management and catalog reads keep the private
 * loopback transport: a broken fetch replacement must never keep the workspace
 * from becoming ready. An explicit `fetchImpl` (tests, embedded hosts) still
 * governs both paths, and OFM_ENGINE_PRIVATE_FETCH=1 forces inference back
 * onto the private transport.
 */
function defaultInferenceTransport() {
  return process.env.OFM_ENGINE_PRIVATE_FETCH === '1' ? loopbackFetch : globalThis.fetch
}

/** Expose the engine's live catalog through the existing DSH stream adapter. */
export function createMagpieModels({ engine, stats, logger, onChanged = () => {}, fetchImpl = loopbackFetch, inferenceFetch, extensionRuntime } = {}) {
  let models = []
  let pending
  let closed = false
  let owner
  // An explicit fetchImpl governs inference and catalog alike (the historical
  // contract); otherwise inference is the replaceable transport and only the
  // catalog read stays private.
  const catalogFetch = fetchImpl
  const inferenceTransport = inferenceFetch ?? (fetchImpl !== loopbackFetch ? fetchImpl : defaultInferenceTransport())
  const runtime = createSubscriptionRuntime({
    stats, logger,
    fetchImpl: inferenceTransport,
    // Enhancement extensions get the same fail-open body seam the harness lane
    // gives them: one plain-object pass, microseconds, no gateway hop.
    onPayload: async (payload, meta) => {
      const source = typeof extensionRuntime === 'function' ? extensionRuntime() : extensionRuntime
      if (source?.applyRequestHooks === undefined) return payload
      return source.applyRequestHooks(payload, { ...meta, lane: 'magpie' })
    },
    subscriptions: {
      list: () => [{
        id: 'magpie', provider: 'magpie', enabled: engine.status().state === 'ready',
        format: 'chat', models: models.map(row => row.id),
      }],
      resolve: async (id, { signal } = {}) => {
        if (signal?.aborted) throw Object.assign(new Error('Request aborted'), { code: 'ABORTED' })
        const model = id.slice(PREFIX.length)
        if (!id.startsWith(PREFIX) || !models.some(row => row.id === model)) {
          throw Object.assign(new Error('Model not found'), { code: 'NOT_FOUND' })
        }
        const gateway = engine.gateway()
        return {
          id: 'magpie', provider: 'magpie', model, wire: 'chat',
          endpoint: `${gateway.url.replace(/\/$/, '')}/v1/chat/completions`,
          headers: { authorization: `Bearer ${gateway.key}` },
        }
      },
    },
  })
  const refresh = () => owner.refresh().catch(() => {})
  const timer = setInterval(refresh, 15000)
  timer.unref?.()
  owner = {
    ...runtime,
    async complete(request, emit) {
      try { return await runtime.complete(request, emit) }
      catch (error) {
        if (error.code === 'AUTH_REQUIRED') {
          throw Object.assign(new Error('The model workspace upstream refused access. Check the provider connection and network status in the workspace.'), {
            code: 'PROVIDER_ERROR', status: error.status ?? 502,
          })
        }
        throw error
      }
    },
    handles: id => typeof id === 'string' && id.startsWith(PREFIX),
    catalog: () => runtime.catalog().map(row => {
      const source = models.find(model => PREFIX + model.id === row.id)
      return { ...row, name: source?.name ?? source?.id ?? row.name,
        contextWindow: source?.context_window, maxOutput: source?.max_output_tokens,
        vision: source?.vision === true, reasoning: source?.reasoning === true,
        efforts: source?.efforts }
    }),
    refresh() {
      if (closed) return Promise.resolve()
      if (engine.status().state !== 'ready') {
        if (models.length) { models = []; onChanged() }
        return Promise.resolve()
      }
      if (pending) return pending
      pending = (async () => {
        const gateway = engine.gateway()
        const response = await catalogFetch(`${gateway.url.replace(/\/$/, '')}/v1/models`, {
          headers: { authorization: `Bearer ${gateway.key}` },
          signal: AbortSignal.timeout(15000), redirect: 'error',
        })
        if (!response.ok) throw new Error('Model catalog unavailable')
        const payload = await response.json()
        if (!Array.isArray(payload?.data)) throw new Error('Invalid model catalog')
        const next = []
        const seen = new Set()
        for (const row of payload.data) {
          if (typeof row?.id !== 'string' || !row.id || /[\r\n\0]/.test(row.id) || seen.has(row.id)) continue
          // A model the engine serves through a channel this build does not
          // offer stays out, whether the plugin was installed before or after.
          if (deniedModel(row)) continue
          seen.add(row.id)
          next.push({
            id: row.id, name: typeof row.display_name === 'string' ? row.display_name
              : typeof row.name === 'string' ? row.name : row.id,
            context_window: row.context_window, max_output_tokens: row.max_output_tokens,
            vision: row.vision === true || row.modalities?.input?.includes('image') === true,
            reasoning: row.reasoning === true,
            efforts: (Array.isArray(row.reasoning_levels) ? row.reasoning_levels : [])
              .filter(level => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level)),
          })
        }
        if (!closed && JSON.stringify(models) !== JSON.stringify(next)) {
          models = next
          onChanged()
        }
      })().finally(() => { pending = undefined })
      return pending
    },
    close() { closed = true; models = []; clearInterval(timer) },
  }
  return owner
}

export function combineSubscriptionRuntimes(...runtimes) {
  const active = runtimes.filter(Boolean)
  return {
    catalog: () => active.flatMap(runtime => runtime.catalog()),
    routingQuota: () => Object.assign({}, ...active.map(runtime => runtime.routingQuota?.() ?? {})),
    complete(request, onChunk) {
      // Specific namespaces take priority over the legacy subscription catch-all.
      const runtime = active.find(candidate => candidate.handles(request.model))
      if (!runtime) throw Object.assign(new Error('Subscription model not found'), { code: 'NOT_FOUND' })
      return runtime.complete(request, onChunk)
    },
  }
}
