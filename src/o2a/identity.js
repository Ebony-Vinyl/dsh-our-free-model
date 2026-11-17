/** Session encoding compatible with persisted OFM conversation identifiers. */
import { createHash, randomBytes } from 'node:crypto'

export const CANONICAL_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
export const DESCENDING_TIME_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/
export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const SESSION_TIMESTAMP_WINDOW_MS = 2592000000
export const SESSION_PHASE_MS = 68719476736n
const processSalt = randomBytes(16)

export function isOfficialSessionID(value) {
  return typeof value === 'string' && CANONICAL_SESSION_RE.test(value) && DESCENDING_TIME_RE.test(value.slice(4, 16))
}

export function canonicalSessionID(signal, now = Date.now()) {
  if (isOfficialSessionID(signal)) return signal
  const digest = createHash('sha256').update('ses\0').update(processSalt).update('\0').update(String(signal)).digest()
  return `ses_${descendingTimePart(now, digest)}${base62Fixed(digest.subarray(6, 16), 14)}`
}

export function sessionPhaseMs(id) {
  if (!isOfficialSessionID(id)) return null
  return Number((0xffffffffffffn - BigInt(`0x${id.slice(4, 16)}`)) / 4096n)
}

export function currentTimePhaseMs(now = Date.now()) {
  return now % Number(SESSION_PHASE_MS)
}

export function phaseAgeMs(phase, now = Date.now()) {
  const period = Number(SESSION_PHASE_MS)
  return ((currentTimePhaseMs(now) - phase) % period + period) % period
}

export function descendingTimePart(now = Date.now(), hash) {
  const prefix = hash[0] * 16777216 + hash[1] * 65536 + hash[2] * 256 + hash[3]
  const timestamp = Math.floor(now / 86400000) * 86400000 - prefix % SESSION_TIMESTAMP_WINDOW_MS
  const encoded = (BigInt(timestamp) * 4096n + 1n) & 0xffffffffffffn
  return (0xffffffffffffn - encoded).toString(16).padStart(12, '0')
}

export function base62Fixed(bytes, width) {
  let value = 0n, result = ''
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  for (let index = 0; index < width; index++) {
    result = BASE62_ALPHABET[Number(value % 62n)] + result
    value /= 62n
  }
  return result
}

export function randomID(prefix, size) {
  return prefix + '_' + randomBytes(size).toString('hex')
}

export function randomProjectID() {
  return randomBytes(20).toString('hex')
}
