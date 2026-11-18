/** Preserve build diagnostics and summaries, counting repetitive progress rows. */
const summaryPattern = /^(?:(?:added|removed|changed|audited|installed)\s+\d+\s+package|Finished\s+|BUILD SUCCESS|\d+\s+(?:vulnerabilities|packages?|warnings?|errors?)|Successfully (?:installed|built)|To address .* issues|Run `npm (?:audit|fund)`)|packages are looking for funding/i

export function buildOutput(input) {
  const errors = [], warnings = [], deprecated = [], summaries = []
  let warningCount = 0, deprecatedCount = 0, compiled = 0, downloaded = 0
  let diagnostic = false, offset = 0
  while (offset <= input.length) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    const text = row.trim()
    const continuation = diagnostic && text !== '' && /^\s*(?:-->|\||\d+\s*\||=)/.test(row)
    if (continuation) errors.push(row)
    else {
      diagnostic = false
      if (/^(?:npm (?:ERR!|error)|yarn error|\[ERROR\]|BUILD FAILED)/i.test(text)) errors.push(row)
      else if (/^npm warn deprecated/i.test(text)) {
        deprecatedCount++
        if (deprecated.length < 3) deprecated.push(row)
      } else if (/^(?:npm warn|yarn warn|\[WARNING\])/i.test(text)) {
        warningCount++
        if (warnings.length < 5) warnings.push(row)
      } else if (/^error(?:\[|:)/i.test(text) || text.startsWith('error -->')) {
        errors.push(row)
        diagnostic = true
      } else if (/^warning(?:\[|:)/i.test(text) || text.startsWith('warning -->')) {
        warningCount++
        if (warnings.length < 5) warnings.push(row)
        diagnostic = true
      } else if (/^Compiling\s+\S+/i.test(text)) compiled++
      else if (/^(?:Downloading\s+\S+|Fetching\s+)/i.test(text)) downloaded++
      else if (summaryPattern.test(text)) summaries.push(row)
    }
    if (newline < 0) break
    offset = newline + 1
  }
  const output = deprecated
  if (deprecatedCount > 3) output.push(`... +${deprecatedCount - 3} more deprecated packages`)
  if (compiled) output.push(`Compiled ${compiled} packages`)
  if (downloaded) output.push(`Downloaded ${downloaded} packages`)
  // Do not spread unbounded diagnostic arrays into a function argument list.
  let result = output.join('\n')
  for (const row of errors) result += `${result ? '\n' : ''}${row}`
  for (const row of warnings) result += `${result ? '\n' : ''}${row}`
  if (warningCount > 5) result += `${result ? '\n' : ''}... +${warningCount - 5} more warnings`
  for (const row of summaries) result += `${result ? '\n' : ''}${row}`
  return result || input
}

buildOutput.filterName = 'build-output'
