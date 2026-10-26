/** Text-test validation adapted from upstream PR #491; timing, cancellation and persistence complete issue #462. */
import { CODE, UpstreamError } from './http.js'
import { decodeWindow } from './store.js'
import { windowTokens } from './stream.js'

export const MODEL_TEST_TIMEOUT_MS = 300_000

/** Only a nonempty, normally finished tool-free answer establishes a successful text test. */
export async function measureModelTest(stream, now = Date.now) {
  const started = now()
  let firstFrame
  let sawReasoning = false
  let finished = false
  let text = ''
  let usage
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      if (typeof chunk.text === 'string' && chunk.text.length > 0 && firstFrame === undefined) firstFrame = now()
      if (chunk.type === 'reasoning-delta' && chunk.text?.length > 0) sawReasoning = true
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
    }
    if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call'))
      throw new UpstreamError('Text test returned an unexpected tool call', CODE.server)
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') {
      if (chunk.upstreamFinish !== undefined && !['stop', 'end_turn', 'stop_sequence'].includes(chunk.upstreamFinish))
        throw new UpstreamError('Text test did not finish normally: ' + String(chunk.upstreamFinish), CODE.server)
      if (chunk.reason?.kind !== 'stop')
        throw new UpstreamError(chunk.reason?.failure?.message ?? chunk.reason?.kind ?? 'Text test did not finish normally', chunk.reason?.failure?.code ?? CODE.server)
      finished = true
    }
  }
  if (!finished) throw new UpstreamError('Text test ended without a normal finish', CODE.empty)
  if (!text.trim()) throw new UpstreamError('Text test returned no response text', CODE.empty)
  const ended = now()
  const measured = decodeWindow(firstFrame === undefined ? 0 : ended - firstFrame, windowTokens(usage, sawReasoning), true)
  return {
    totalMs: ended - started, latencyMs: ended - started,
    ttftMs: firstFrame === undefined ? ended - started : firstFrame - started,
    outputTokens: usage?.outputTokens ?? 0, reasoningTokens: usage?.reasoningTokens ?? 0,
    tokensPerSecond: measured.tps, sample: text.slice(0, 60), text: text.slice(0, 2000),
  }
}

/** Bound the whole test, including a route chain's retries, not just an individual upstream request. */
export async function runModelTest(createStream, { signal, timeoutMs = MODEL_TEST_TIMEOUT_MS, now = Date.now } = {}) {
  const controller = new AbortController()
  const cancellation = () => signal?.reason instanceof Error ? signal.reason : new UpstreamError('Text test cancelled', CODE.aborted)
  const forwardAbort = () => controller.abort(cancellation())
  let timer
  let onAbort
  let iterator
  if (signal?.aborted) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    controller.signal.throwIfAborted()
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    timer = setTimeout(() => controller.abort(new UpstreamError('Text test exceeded its total time budget', CODE.timeout)), timeoutMs)
    iterator = createStream(controller.signal)
    return await Promise.race([measureModelTest(iterator, now), aborted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    // Adapter.return() aborts its pending next() before awaiting generator cleanup.
    if (controller.signal.aborted) {
      try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* the original error wins */ }
    }
  }
}

/** Keep manual samples apart from the automatic round so an older probe cannot erase them. */
export function modelAvailability(id, snapshot, listed = false) {
  // 旧出口的测量仍保留在磁盘，但不再作为当前出口的可用性判定。
  const probeRow = listed ? undefined : snapshot?.results?.[id]
  const manualRow = snapshot?.manualResults?.[id]
  const probe = probeRow?.stale === true ? undefined : probeRow
  const manual = manualRow?.stale === true ? undefined : manualRow
  // Compare a probe's request time with the completed manual measurement, so
  // an older in-flight probe cannot supersede it merely by finishing later.
  // Older saved snapshots have only `at`, which retains their previous order.
  const measured = manual && (!probe || manual.at >= (probe.startedAt ?? probe.at)) ? manual : probe
  return {
    availabilitySource: measured === manual && manual ? 'manual' : listed ? 'listing' : 'probe',
    availability: measured?.state ?? 'unknown',
    detail: measured?.detail ?? '', probedAt: measured?.at ?? 0,
    ttftMs: measured?.ttftMs, latencyMs: measured?.latencyMs,
  }
}
