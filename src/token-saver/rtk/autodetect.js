/** Classify external tool output; ambiguous search-like prose remains untouched. */
import { DETECT_WINDOW, READ_NUMBERED_MIN_HIT_RATIO, SMART_TRUNCATE_MIN_LINES } from './constants.js'
import { gitDiff } from './filters/gitDiff.js'
import { gitStatus } from './filters/gitStatus.js'
import { gitLog } from './filters/gitLog.js'
import { buildOutput } from './filters/buildOutput.js'
import { grep } from './filters/grep.js'
import { find } from './filters/find.js'
import { dedupLog } from './filters/dedupLog.js'
import { ls } from './filters/ls.js'
import { tree } from './filters/tree.js'
import { smartTruncate } from './filters/smartTruncate.js'
import { readNumbered, READ_NUMBERED_LINE_RE } from './filters/readNumbered.js'
import { searchList, SEARCH_LIST_HEADER_RE } from './filters/searchList.js'
import { pytest } from './filters/pytest.js'
import { tsc } from './filters/tsc.js'
import { isGrepHit, splitGrepHit, parseGrepOutput } from './hitLine.js'

export function autoDetectFilter(text) {
  const head = text.slice(0, DETECT_WINDOW)
  if (/^[*|/\\ ]*commit [0-9a-f]{7,40}$/m.test(head)) return gitLog
  if (/^(?:diff --git |@@ )/m.test(head)) return gitDiff
  if (/^(?:On branch |nothing to commit|Changes (?:not |to be )|Untracked files:)/m.test(head)) return gitStatus
  if (/^(?:npm (?:warn|error|ERR!)|yarn (?:warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (?:SUCCESS|FAILED)|\s*Finished\s+|Successfully (?:installed|built)|ERROR:)/im.test(head)) return buildOutput
  if (/^(?:=+ .*\b\d+ (?:passed|failed|error|errors|skipped)[^=\n]* in [\d.]+s.*=+|(?:FAILED|ERROR) \S+)/m.test(text)) return pytest
  if (/error TS\d+:/m.test(head)) return tsc

  const lines = head.split('\n')
  let nonempty = 0, porcelain = 0, paths = 0, listings = 0, numbered = 0, sample = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const trimmed = line.trim()
    if (index < 100 && line.length) {
      sample++
      if (READ_NUMBERED_LINE_RE.test(line)) numbered++
    }
    if (/^[-dlbcps][rwx-]{9}/.test(line)) listings++
    if (!trimmed) continue
    nonempty++
    if (/^(?!  )[ MADRCU?!][ MADRCU?!] \S/.test(line)) porcelain++
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || (!trimmed.includes(':') && (trimmed.startsWith('.') || trimmed.includes('/')))) paths++
  }
  if (nonempty >= 3 && porcelain / nonempty >= 0.6) return gitStatus

  let sampled = 0, candidate = false, pathCandidate = false
  for (let offset = 0; offset < text.length && sampled < 5;) {
    const newline = text.indexOf('\n', offset)
    const end = newline < 0 ? text.length : newline
    const line = text.slice(offset, end)
    if (line.trim()) {
      sampled++
      const hit = splitGrepHit(line)
      if (hit && /^\d+$/.test(hit.line)) candidate = true
      if (isGrepHit(line)) pathCandidate = true
    }
    offset = end + 1
  }
  if (candidate) return pathCandidate && parseGrepOutput(text) !== null ? grep : null
  if (nonempty >= 3 && paths === nonempty) return find
  if (/[├└]──|│  /.test(head)) return tree
  if (/^total \d+$/m.test(head) || listings >= 3) return ls
  if (SEARCH_LIST_HEADER_RE.test(head)) return searchList
  if (lines.length >= SMART_TRUNCATE_MIN_LINES && sample >= 5 && numbered / sample >= READ_NUMBERED_MIN_HIT_RATIO) return readNumbered
  if (nonempty >= 5) return dedupLog

  // Only a threshold is needed: stop counting once truncation is applicable.
  let count = 1, position = -1
  while (count < SMART_TRUNCATE_MIN_LINES) {
    position = text.indexOf('\n', position + 1)
    if (position < 0) return null
    count++
  }
  return smartTruncate
}
