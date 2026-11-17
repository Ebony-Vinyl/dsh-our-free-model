/** Summarize glob listings with bounded samples and complete counts. */
import { SEARCH_LIST_PER_DIR_MAX, SEARCH_LIST_TOTAL_DIR_MAX } from '../constants.js'

export const SEARCH_LIST_HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/

export function searchList(input) {
  const firstBreak = input.indexOf('\n')
  if (firstBreak < 0) return input
  const groups = new Map()
  let total = 0
  let offset = firstBreak + 1
  while (offset <= input.length) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end).trim()
    if (row.startsWith('- ')) {
      const path = row.slice(2)
      const slash = path.lastIndexOf('/')
      const directory = slash < 0 ? '.' : path.slice(0, slash) || '/'
      let group = groups.get(directory)
      if (!group) {
        group = { count: 0, names: [] }
        groups.set(directory, group)
      }
      total++
      group.count++
      if (group.names.length < SEARCH_LIST_PER_DIR_MAX) group.names.push(path.slice(slash + 1))
    }
    if (newline < 0) break
    offset = newline + 1
  }
  if (!total) return input
  const output = [input.slice(0, firstBreak), `${total} files in ${groups.size} dirs:`, '']
  for (const directory of [...groups.keys()].sort().slice(0, SEARCH_LIST_TOTAL_DIR_MAX)) {
    const { count, names } = groups.get(directory)
    output.push(`${directory}/ (${count}):`)
    for (const name of names) output.push(`  ${name}`)
    if (count > names.length) output.push(`  +${count - names.length}`)
    output.push('')
  }
  if (groups.size > SEARCH_LIST_TOTAL_DIR_MAX) output.push(`+${groups.size - SEARCH_LIST_TOTAL_DIR_MAX} more dirs`)
  return output.join('\n').replace(/\n+$/, '')
}

searchList.filterName = 'search-list'
