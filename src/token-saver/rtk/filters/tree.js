/** Retain tree structure with bounded storage; count omitted rows exactly. */
import { TREE_MAX_LINES } from '../constants.js'

export function tree(input) {
  const retained = []
  let count = 0
  let lastContent = 0
  let offset = 0
  while (offset <= input.length) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    const content = row.trim() !== ''
    if (!(row.includes('director') && row.includes('file')) && (count > 0 || content)) {
      count++
      if (content) lastContent = count
      if (retained.length < TREE_MAX_LINES) retained.push(row)
    }
    if (newline < 0) break
    offset = newline + 1
  }
  retained.length = Math.min(retained.length, lastContent)
  if (lastContent > TREE_MAX_LINES) retained.push(`... +${lastContent - TREE_MAX_LINES} more lines`)
  return retained.join('\n')
}

tree.filterName = 'tree'
