/** Parse search locations without mistaking a Windows drive prefix for a field. */
export function splitGrepHit(row) {
  const drive = /^[A-Za-z]:[\\/]/.test(row)
  const delimiter = row.indexOf(':', drive ? 2 : 0)
  const valueStart = delimiter < 0 ? -1 : row.indexOf(':', delimiter + 1)
  return valueStart < 0 ? null : {
    file: row.substring(0, delimiter),
    line: row.substring(delimiter + 1, valueStart),
    content: row.substring(valueStart + 1),
  }
}

export function isGrepHit(row) {
  const hit = splitGrepHit(row)
  return hit !== null && /^\d+$/.test(hit.line) && /[\\/.]/.test(hit.file) && !/\s/.test(hit.file)
}

export function parseGrepOutput(text) {
  const hits = []
  let offset = 0
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset)
    const end = newline < 0 ? text.length : newline
    const row = text.slice(offset, end)
    if (row.trim()) {
      const hit = splitGrepHit(row)
      if (hit === null || !hit.file.trim() || !/^\d+$/.test(hit.line)) return null
      hits.push(hit)
    }
    if (newline < 0) break
    offset = newline + 1
  }
  return hits.length ? hits : null
}
