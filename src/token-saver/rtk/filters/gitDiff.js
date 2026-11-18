/** Scan unified diff records with per-hunk and overall output limits. */
import { GIT_DIFF_HUNK_MAX_LINES } from '../constants.js'

export function gitDiff(input, maxLines = 500) {
  const output = []
  let file = '', added = 0, removed = 0, shown = 0, omitted = 0
  let inHunk = false, truncated = false, offset = 0
  while (offset <= input.length) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    const boundary = row.startsWith('diff --git') ? 'file' : row.startsWith('@@') ? 'hunk' : ''
    if (boundary) {
      if (omitted) { output.push(`  ... (${omitted} lines truncated)`); truncated = true; omitted = 0 }
      shown = 0
      inHunk = boundary === 'hunk'
      if (inHunk) output.push(`  ${row}`)
      else {
        if (file && (added || removed)) output.push(`  +${added} -${removed}`)
        const separator = row.indexOf(' b/')
        file = separator < 0 ? 'unknown' : row.slice(separator + 3)
        output.push(`\n${file}`)
        added = removed = 0
      }
    } else if (inHunk) {
      const addition = row[0] === '+' && !row.startsWith('+++')
      const deletion = row[0] === '-' && !row.startsWith('---')
      if (addition) added++
      if (deletion) removed++
      if (addition || deletion) {
        if (shown < GIT_DIFF_HUNK_MAX_LINES) { output.push(`  ${row}`); shown++ }
        else omitted++
      } else if (shown > 0 && shown < GIT_DIFF_HUNK_MAX_LINES && row[0] !== '\\') {
        output.push(`  ${row}`)
        shown++
      }
    }
    if (output.length >= maxLines) { output.push('\n... (more changes truncated)'); truncated = true; break }
    if (newline < 0) break
    offset = newline + 1
  }
  if (omitted) { output.push(`  ... (${omitted} lines truncated)`); truncated = true }
  if (file && (added || removed)) output.push(`  +${added} -${removed}`)
  if (truncated) output.push('[diff truncated by OFM; disable tool-output compression and request the diff again]')
  return output.join('\n')
}

gitDiff.filterName = 'git-diff'
