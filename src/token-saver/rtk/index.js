/** Transform tool output at the request boundary; preserve other message content. */
import { RAW_CAP, MIN_COMPRESS_SIZE } from './constants.js'
import { autoDetectFilter } from './autodetect.js'
import { safeApply } from './applyFilter.js'

export function compressText(text, stats, shape) {
  const before = text.length
  stats.bytesBefore += before
  let result = text
  if (before >= MIN_COMPRESS_SIZE && before <= RAW_CAP) {
    const filter = autoDetectFilter(text)
    if (filter) {
      const candidate = safeApply(filter, text)
      if (candidate.length > 0 && candidate.length < before) {
        result = candidate
        stats.hits.push({ shape, filter: filter.filterName || filter.name, saved: before - candidate.length })
      }
    }
  }
  stats.bytesAfter += result.length
  return result
}

// Shared by actual protocol variants: validate external content once here.
function transform(owner, key, partType, stringShape, arrayShape, stats) {
  const content = owner[key]
  if (typeof content === 'string') owner[key] = compressText(content, stats, stringShape)
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && (partType === null || part.type === partType) && typeof part.text === 'string') {
        part.text = compressText(part.text, stats, arrayShape)
      }
    }
  }
}

function walk(items, mode, stats) {
  if (!Array.isArray(items)) return
  for (const item of items) {
    if (!item) continue
    if ((mode === 'auto' || mode === 'responses') && item.type === 'function_call_output') {
      transform(item, 'output', 'input_text', 'openai-responses-string', 'openai-responses-array', stats)
    } else if ((mode === 'auto' || mode === 'chat') && item.role === 'tool') {
      transform(item, 'content', 'text', 'openai-tool', 'openai-tool-array', stats)
    } else if ((mode === 'auto' || mode === 'messages') && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === 'tool_result' && block.is_error !== true) {
          transform(block, 'content', 'text', 'claude-string', 'claude-array', stats)
        }
      }
    }
  }
}

function walkKiro(message, stats) {
  const results = message?.userInputMessage?.userInputMessageContext?.toolResults
  if (!Array.isArray(results)) return
  for (const result of results) {
    if (result.status !== 'error' && Array.isArray(result.content)) {
      transform(result, 'content', null, '', 'kiro-tool-result', stats)
    }
  }
}

export function compressMessages(body, enabled) {
  if (!enabled || !body) return null
  const state = body.conversationState
  const items = Array.isArray(body.messages) ? body.messages : body.input
  if (!state && !Array.isArray(items)) return null
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] }
  try {
    if (state) {
      if (Array.isArray(state.history)) for (const message of state.history) walkKiro(message, stats)
      if (state.currentMessage) walkKiro(state.currentMessage, stats)
    } else walk(items, 'auto', stats)
    return stats
  } catch (error) {
    console.warn('[RTK] compressMessages error:', error.message)
    return null
  }
}

export function compressRequest(payload, wire, options = true) {
  const enabled = options !== false && (options === null || typeof options !== 'object' || options.enabled !== false)
  const stats = { enabled, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] }
  if (enabled && payload !== null && typeof payload === 'object') {
    try {
      if (wire === 'chat' || wire === 'messages') walk(payload.messages, wire, stats)
      else if (wire === 'responses') walk(payload.input, wire, stats)
    } catch (error) {
      console.warn('[rtk] compressRequest error:', error?.message ?? error)
      stats.bytesAfter = stats.bytesBefore - stats.hits.reduce((sum, hit) => sum + hit.saved, 0)
    }
  }
  stats.saved = stats.bytesBefore - stats.bytesAfter
  return { payload, stats }
}

export function formatRtkLog(stats) {
  if (!stats?.hits?.length) return null
  const filters = [...new Set(stats.hits.map(hit => hit.filter))].join(',')
  const saved = stats.bytesBefore - stats.bytesAfter
  const percentage = stats.bytesBefore > 0 ? (100 * saved / stats.bytesBefore).toFixed(1) : '0'
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${percentage}%) via [${filters}] hits=${stats.hits.length}`
}

export function describeSavings(stats) {
  if (!stats || stats.enabled === false) return null
  const before = Number.isFinite(stats.bytesBefore) ? stats.bytesBefore : 0
  const after = Number.isFinite(stats.bytesAfter) ? stats.bytesAfter : 0
  const hits = Array.isArray(stats.hits) ? stats.hits : []
  const prefix = `[token-saver] ${humanBytes(before)} -> ${humanBytes(after)}`
  if (!hits.length) return `${prefix} (0%) — no tool output compacted`
  const percent = before > 0 ? Math.round(100 * (before - after) / before) : 0
  return `${prefix} (${percent}%) via ${[...new Set(hits.map(hit => hit.filter))].join(', ')} (${hits.length} blocks)`
}

function humanBytes(size) {
  for (const [unit, threshold] of [['MB', 1048576], ['KB', 1024]]) {
    if (size >= threshold) return `${(size / threshold).toFixed(1)} ${unit}`
  }
  return `${size} B`
}
