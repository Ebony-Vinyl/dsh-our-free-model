/**
 * Semver comparison shared by the self-updater and the extension platform.
 * Lives apart from updater.js because the standalone package deliberately
 * ships without the updater — the extension runtime still needs to compare a
 * registry entry's minHost against the host version.
 */

/** Parse `1.2.3` / `1.2.3-rc.4` into a comparable tuple; `null` when malformed. */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(value ?? '').trim())
  if (match === null) return null
  const pre = match[4] === undefined ? null : match[4].split('.')
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/** -1 | 0 | 1 in semver precedence; a pre-release sorts before its release. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return a === b ? 0 : a > b ? 1 : -1
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  const width = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < width; i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
