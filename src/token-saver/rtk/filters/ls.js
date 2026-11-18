/** Summarize long directory listings, preserving names, sizes and type counts. */
import { LS_EXT_SUMMARY_TOP, LS_NOISE_DIRS } from '../constants.js'

const excluded = new Set(LS_NOISE_DIRS)
const dateColumn = /\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{4}|\d{2}:\d{2})\s+/

export function ls(input) {
  let directories = '', files = '', directoryCount = 0, fileCount = 0
  const extensions = new Map()
  let offset = 0
  while (offset <= input.length) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    const date = row.startsWith('total ') ? null : dateColumn.exec(row)
    if (date) {
      const name = row.slice(date.index + date[0].length)
      const columns = row.slice(0, date.index).trim().split(/\s+/)
      if (columns.length >= 4 && name !== '.' && name !== '..' && !excluded.has(name)) {
        const type = columns[0][0]
        if (type === 'd') { directories += `${name}/\n`; directoryCount++ }
        else if (type === '-' || type === 'l') {
          let bytes = 0
          for (let index = columns.length - 1; index >= 0; index--) {
            const number = Number(columns[index])
            if (Number.isInteger(number) && String(number) === columns[index]) { bytes = number; break }
          }
          const size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}M`
            : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}K` : `${bytes}B`
          files += `${name}  ${size}\n`
          fileCount++
          const dot = name.lastIndexOf('.')
          const extension = dot > 0 ? name.slice(dot) : 'no ext'
          extensions.set(extension, (extensions.get(extension) ?? 0) + 1)
        }
      }
    }
    if (newline < 0) break
    offset = newline + 1
  }
  if (!directoryCount && !fileCount) return input
  let summary = `\nSummary: ${fileCount} files, ${directoryCount} dirs`
  if (extensions.size) {
    const ranked = [...extensions].sort((a, b) => b[1] - a[1])
    const labels = ranked.slice(0, LS_EXT_SUMMARY_TOP).map(([extension, count]) => `${count} ${extension}`)
    if (ranked.length > LS_EXT_SUMMARY_TOP) labels.push(`+${ranked.length - LS_EXT_SUMMARY_TOP} more`)
    summary += ` (${labels.join(', ')})`
  }
  return directories + files + summary
}

ls.filterName = 'ls'
