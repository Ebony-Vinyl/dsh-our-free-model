import { createChannel } from './channel.js'
import { CODE, UpstreamError } from './http.js'

export const isSubscriptionEntry = entry => entry?.channel === 'subscription'

/** Keep private account data out of the shared catalog, even with an injected runtime. */
export function subscriptionCatalog(runtime) {
  if (typeof runtime?.catalog !== 'function' || typeof runtime?.complete !== 'function') return []
  const capacity = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback
  const wires = {
    chat: 'chat', responses: 'responses', messages: 'messages',
    'openai-chat': 'chat', 'openai-responses': 'responses', 'anthropic-messages': 'messages',
    'gemini-code-assist': 'chat',
  }
  return runtime.catalog().filter(row => typeof row?.id === 'string' && row.id.startsWith('subscription:')).map(row => ({
    id: row.id,
    name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
    channel: 'subscription',
    subscriptionId: row.subscriptionId,
    subscriptionProvider: row.subscriptionProvider,
    contextWindow: capacity(row.contextWindow, 131072),
    maxOutput: capacity(row.maxOutput, 8192),
    wire: wires[row.wire] ?? ({ codex: 'responses', claude: 'messages' })[row.subscriptionProvider] ?? 'chat',
    vision: row.vision === true,
    reasoning: row.reasoning === true,
    ...(Array.isArray(row.efforts) && row.efforts.length ? {
      efforts: [...new Set(row.efforts.filter(level => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level)))],
    } : {}),
  }))
}

/**
 * Deliver callback chunks as they arrive. Abort and iterator return cancel the
 * producer; observing its promise must not block a caller if a provider hangs.
 */
export async function* subscriptionChunks(runtime, request) {
  if (typeof runtime?.complete !== 'function') {
    throw new UpstreamError('Subscription runtime is unavailable', CODE.client)
  }
  const controller = new AbortController()
  const channel = createChannel()
  const abortError = () => new UpstreamError('Subscription completion aborted', CODE.aborted)
  const abort = () => {
    controller.abort()
    channel.push(abortError())
  }
  if (request.signal?.aborted) throw abortError()
  request.signal?.addEventListener('abort', abort, { once: true })
  let active = true
  let outcome
  let queued = 0
  const pending = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw abortError()
    return runtime.complete({ ...request, signal: controller.signal }, chunk => {
      if (!active || controller.signal.aborted) return
      if (++queued > 4096) {
        channel.push(new UpstreamError('Subscription stream buffer exceeded', CODE.server))
        controller.abort()
        return
      }
      channel.push(chunk)
    })
  }).then(value => {
    outcome = value
    channel.push(undefined)
  }, error => {
    channel.push(error instanceof Error ? error : new UpstreamError('Subscription completion failed', CODE.server))
  })
  try {
    for await (const chunk of channel.read()) {
      queued--
      if (controller.signal.aborted) throw abortError()
      yield chunk
    }
    return outcome
  } finally {
    active = false
    request.signal?.removeEventListener('abort', abort)
    controller.abort()
    void pending.catch(() => {})
  }
}
