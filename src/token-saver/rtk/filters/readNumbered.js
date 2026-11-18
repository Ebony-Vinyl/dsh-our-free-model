/** Preserve numbered head and tail windows using the shared truncation scan. */
import { truncateWindow } from './smartTruncate.js'

export const READ_NUMBERED_LINE_RE = /^\s*\d+\|/

export function readNumbered(input) {
  return truncateWindow(input, ' (file continues)')
}

readNumbered.filterName = 'read-numbered'
