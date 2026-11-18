/** Group path listings while retaining only the filenames displayed per directory. */
import { FIND_PER_DIR_MAX, FIND_TOTAL_DIR_MAX } from '../constants.js'

export function find(input) {
  const groups = new Map()
  let total = 0
  let start = 0
  while (start <= input.length) {
    const newline = input.indexOf('\n', start)
    const end = newline < 0 ? input.length : newline
    const path = input.slice(start, end)
    if (path.trim()) {
      total++
      const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      const directory = separator < 0 ? '.' : path.slice(0, separator) || '/'
      let group = groups.get(directory)
      if (!group) {
        group = { count: 0, names: [] }
        groups.set(directory, group)
      }
      group.count++
      if (group.names.length < FIND_PER_DIR_MAX) group.names.push(path.slice(separator + 1))
    }
    if (newline < 0) break
    start = newline + 1
  }
  if (!total) return input
  const directories = [...groups.keys()].sort()
  const output = [`${total} files in ${directories.length} dirs:\n\n`]
  for (const directory of directories.slice(0, FIND_TOTAL_DIR_MAX)) {
    const { count, names } = groups.get(directory)
    output.push(`${directory.replace(/\\/g, '/')}/  (${count})\n`)
    for (const name of names) output.push(`  ${name}\n`)
    if (count > names.length) output.push(`  +${count - names.length}\n`)
  }
  if (directories.length > FIND_TOTAL_DIR_MAX) output.push(`\n+${directories.length - FIND_TOTAL_DIR_MAX} more dirs\n`)
  return output.join('')
}

find.filterName = 'find'
