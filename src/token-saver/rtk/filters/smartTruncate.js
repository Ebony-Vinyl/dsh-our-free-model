/** Keep the first and last lines without allocating an array for the entire input. */
import { SMART_TRUNCATE_HEAD, SMART_TRUNCATE_TAIL, SMART_TRUNCATE_MIN_LINES } from '../constants.js'

export function truncateWindow(input, suffix) {
  let count = 1
  let headEnd = input.length
  let position = input.indexOf('\n')
  while (position !== -1) {
    if (count === SMART_TRUNCATE_HEAD) headEnd = position
    count++
    position = input.indexOf('\n', position + 1)
  }
  if (count < SMART_TRUNCATE_MIN_LINES) return input
  let tailStart = input.length
  for (let line = 0; line < SMART_TRUNCATE_TAIL; line++) {
    tailStart = input.lastIndexOf('\n', tailStart - 1)
  }
  const removed = count - SMART_TRUNCATE_HEAD - SMART_TRUNCATE_TAIL
  return `${input.slice(0, headEnd)}\n... +${removed} lines truncated${suffix}\n${input.slice(tailStart + 1)}`
}

export function smartTruncate(input) {
  return truncateWindow(input, '')
}

smartTruncate.filterName = 'smart-truncate'
