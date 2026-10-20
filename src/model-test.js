/** Measure a tool-free text test only after a nonempty, normally finished response. */
import { CODE, UpstreamError } from './http.js'
import { decodeWindow } from './store.js'
import { windowTokens } from './stream.js'

/**
 * Consume the adapter stream without retrying or changing its route.
 * @param {AsyncIterable<object>} stream - normalized adapter chunks
 * @param {() => number} now - timestamp source for elapsed measurements
 * @returns {Promise<object>} text response and measured timing; rejects incomplete responses
 */
export async function measureModelTest(stream, now = Date.now) {
  const started = now()
  let firstFrame
  let sawReasoning = false
  let finished = false
  let text = ''
  let usage
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      if (chunk.text?.length > 0 && firstFrame === undefined) firstFrame = now()
      if (chunk.type === 'reasoning-delta') sawReasoning = true
      if (chunk.type === 'text-delta') text += chunk.text
    }
    if (chunk.type === 'tool-call-delta')
      throw new UpstreamError('Text test returned an unexpected tool call', CODE.server)
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') {
      if (chunk.reason.kind !== 'stop')
        throw new UpstreamError(chunk.reason.failure?.message ?? chunk.reason.kind, chunk.reason.failure?.code ?? CODE.server)
      finished = true
    }
  }
  if (!finished) throw new UpstreamError('Text test ended without a normal finish', CODE.server)
  if (!text.trim()) throw new UpstreamError('Text test returned no response text', CODE.server)
  const ended = now()
  const measured = decodeWindow(firstFrame === undefined ? 0 : ended - firstFrame, windowTokens(usage, sawReasoning), true)
  return {
    totalMs: ended - started,
    ttftMs: firstFrame === undefined ? ended - started : firstFrame - started,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    tokensPerSecond: measured.tps,
    sample: text.slice(0, 60),
  }
}
