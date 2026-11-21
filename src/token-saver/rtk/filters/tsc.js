/**
 * Keep only TypeScript compiler errors and their count.
 * @module src/token-saver/rtk/filters/tsc.js
 */

const ERROR = /error TS\d+:/

export function tsc(input) {
  const errors = input.split('\n').filter((line) => ERROR.test(line))
  if (errors.length === 0) return input
  const kept = errors.slice(0, 100)
  const more = errors.length > kept.length ? `\n... +${errors.length - kept.length} more errors` : ''
  return `${kept.join('\n')}${more}\nFound ${errors.length} error(s)`
}

tsc.filterName = 'tsc'
