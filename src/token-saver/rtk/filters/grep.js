/** Summarize validated search hits with bounded samples per file. */
import { GREP_PER_FILE_MAX } from '../constants.js'
import { splitGrepHit } from '../hitLine.js'

export function grep(input) {
  const groups = new Map()
  let total = 0
  let offset = 0
  while (offset <= input.length) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    if (row.trim()) {
      const hit = splitGrepHit(row)
      if (!hit || !hit.file.trim() || !/^\d+$/.test(hit.line)) return input
      total++
      let group = groups.get(hit.file)
      if (!group) {
        group = { count: 0, samples: [] }
        groups.set(hit.file, group)
      }
      group.count++
      if (group.samples.length < GREP_PER_FILE_MAX) {
        group.samples.push(`  ${hit.line.padStart(4)}: ${hit.content.trim()}\n`)
      }
    }
    if (newline < 0) break
    offset = newline + 1
  }
  if (!total) return input
  const output = [`${total} matches in ${groups.size}F:\n\n`]
  for (const file of [...groups.keys()].sort()) {
    const { count, samples } = groups.get(file)
    output.push(`[file] ${file} (${count}):\n`, ...samples)
    if (count > samples.length) output.push(`  +${count - samples.length}\n`)
    output.push('\n')
  }
  return output.join('')
}

grep.filterName = 'grep'
