/** Extract bounded commit summaries from plain, graph and full Git histories. */
import { GIT_LOG_MAX_LINES } from '../constants.js'

export function gitLog(text, maxLines = GIT_LOG_MAX_LINES) {
  if (!text) return ''
  const input = String(text)
  const output = []
  let inCommit = false, subject = false, skipped = 0, offset = 0
  while (offset <= input.length) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end).trimEnd()
    const trimmed = row.trim()
    let selected
    if (/^(?:commit [0-9a-f]{7,40}$|[*|/\\ ]+commit [0-9a-f]{7,40})/i.test(trimmed)) {
      inCommit = true
      subject = false
      selected = row
    } else if (inCommit) {
      if (/^[*|/\\ ]*(?:Author|Date):/i.test(trimmed)) selected = trimmed
      else if (trimmed) {
        if (!subject && /^[*|/\\ ]*    \S/.test(row)) {
          selected = `  Subject: ${trimmed}`
          subject = true
        } else if (/^\d+ file\w* changed/.test(trimmed)) selected = `  ${trimmed}`
        else if (trimmed.startsWith('diff --git ')) selected = '  ... diff body omitted'
      }
    } else {
      const graph = /^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i.exec(trimmed)
      if (graph) selected = graph[1]
      else if (!/^[*|/\\ ]+$/.test(trimmed) || !/[*|/\\]/.test(trimmed)) selected = trimmed
    }
    if (selected !== undefined) {
      if (output.length < maxLines) output.push(selected)
      else skipped++
    }
    if (newline < 0) break
    offset = newline + 1
  }
  if (skipped) output.push(`... (${skipped} more lines)`)
  const result = output.join('\n')
  return result && result.length <= input.length ? result : input
}

gitLog.filterName = 'git-log'
