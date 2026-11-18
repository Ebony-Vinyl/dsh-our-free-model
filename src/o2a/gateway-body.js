/** Apply Chat-only defaults while leaving explicit caller limits intact. */
import { V2_COMPLETION_LIMIT } from './version.js'

export function ensureChatUsage(payload, shape) {
  if (shape !== 'chat' || payload.stream !== true) return false
  const options = payload.stream_options
  const object = options !== null && typeof options === 'object' && !Array.isArray(options)
  if (object && options.include_usage === true) return false
  payload.stream_options = object ? { ...options, include_usage: true } : { include_usage: true }
  return true
}

export function ensureV2CompletionLimit(payload, shape) {
  if (shape !== 'chat' || payload.max_tokens !== undefined || payload.max_completion_tokens !== undefined) return false
  payload.max_completion_tokens = V2_COMPLETION_LIMIT
  return true
}
