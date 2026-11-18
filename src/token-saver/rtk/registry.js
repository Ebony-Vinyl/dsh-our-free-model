/** Resolve supported output filters and established command aliases. */
import { gitDiff } from './filters/gitDiff.js'
import { gitStatus } from './filters/gitStatus.js'
import { gitLog } from './filters/gitLog.js'
import { grep } from './filters/grep.js'
import { find } from './filters/find.js'
import { dedupLog } from './filters/dedupLog.js'
import { ls } from './filters/ls.js'
import { tree } from './filters/tree.js'
import { smartTruncate } from './filters/smartTruncate.js'
import { readNumbered } from './filters/readNumbered.js'
import { searchList } from './filters/searchList.js'

const registry = Object.fromEntries([
  gitDiff, gitStatus, gitLog, grep, find, dedupLog, ls, tree,
  smartTruncate, readNumbered, searchList,
].map(filter => [filter.filterName, filter]))

export function resolveFilter(name) {
  if (name === 'rg') return grep
  if (name === 'fd') return find
  return registry[name] || null
}

export function allFilters() {
  return registry
}
