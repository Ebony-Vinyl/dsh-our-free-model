/** Count status categories while retaining only their displayed path samples. */
import { STATUS_MAX_FILES, STATUS_MAX_UNTRACKED } from '../constants.js'

export function gitStatus(input) {
  if (!input.includes('\n') && !input.trim()) return 'Clean working tree'
  const sections = [
    { label: '+ Staged', limit: STATUS_MAX_FILES, count: 0, paths: [] },
    { label: '~ Modified', limit: STATUS_MAX_FILES, count: 0, paths: [] },
    { label: '? Untracked', limit: STATUS_MAX_UNTRACKED, count: 0, paths: [] },
  ]
  let branch = ''
  let conflicts = 0
  let offset = 0
  while (offset <= input.length) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    const heading = /^On branch (\S+)/.exec(row)
    const categories = []
    let path = ''
    if (heading) branch = heading[1]
    else if (row.startsWith('##')) branch = row.slice(2).trimStart()
    else if (/^[ MADRCU?!][ MADRCU?!] /.test(row)) {
      path = row.slice(3)
      if (row.startsWith('??')) categories.push(2)
      else {
        if ('MADRC'.includes(row[0])) categories.push(0)
        else if (row[0] === 'U') conflicts++
        if (row[1] === 'M' || row[1] === 'D') categories.push(1)
      }
    } else {
      const detail = /^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/.exec(row)
      if (detail) {
        path = detail[2].trim()
        if (detail[1] === 'both modified') conflicts++
        else categories.push(detail[1] === 'modified' || detail[1] === 'deleted' ? 1 : 0)
      }
    }
    for (const index of categories) {
      const section = sections[index]
      section.count++
      if (section.paths.length < section.limit) section.paths.push(path)
    }
    if (newline < 0) break
    offset = newline + 1
  }
  const output = branch ? [`* ${branch}`] : []
  for (const { label, count, paths } of sections) {
    if (!count) continue
    output.push(`${label}: ${count} files`)
    for (const path of paths) output.push(`   ${path}`)
    if (count > paths.length) output.push(`   ... +${count - paths.length} more`)
  }
  if (conflicts) output.push(`conflicts: ${conflicts} files`)
  if (!conflicts && sections.every(section => section.count === 0)) output.push('clean — nothing to commit')
  return output.join('\n')
}

gitStatus.filterName = 'git-status'
