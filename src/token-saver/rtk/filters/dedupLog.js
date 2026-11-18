/** Scan consecutive log runs, emitting each unique row and its duplicate count. */
import { DEDUP_LINE_MAX } from '../constants.js'

export function dedupLog(input) {
  const output = []
  let offset = 0
  let previous
  let duplicates = 0
  let blank = false
  while (offset <= input.length) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    const empty = row.trim() === ''
    if (!empty && row === previous) duplicates++
    else {
      if (empty && !blank) output.push(row)
      if (duplicates) output.push(`  ... (${duplicates} duplicate lines)`)
      duplicates = 0
      previous = empty ? undefined : row
      if (!empty) {
        output.push(row)
        if (output.length >= DEDUP_LINE_MAX) {
          output.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`)
          return output.join('\n')
        }
      }
    }
    blank = empty
    if (newline < 0) break
    offset = newline + 1
  }
  if (duplicates) output.push(`  ... (${duplicates} duplicate lines)`)
  return output.join('\n')
}

dedupLog.filterName = 'dedup-log'
