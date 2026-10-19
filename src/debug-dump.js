/**
 * Local, last-write-wins diagnostics for the forward listener.
 *
 * The free lane answers some refusals with an empty 400 body, so the only way
 * to correlate a failure with the request that caused it is to keep the last
 * request and the last failure on disk. Files are overwritten, never appended,
 * and live under `~/.our-free-model/debug/`.
 *
 * Nothing here throws: diagnostics must not interrupt a request.
 *
 * @module src/debug-dump.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = process.env.OFM_DEBUG_DIR || path.join(os.homedir(), '.our-free-model', 'debug')
const MAX_TEXT = 4 * 1024 * 1024

let ready = false

function ensureDir() {
  if (ready) return true
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
    ready = true
    return true
  } catch {
    return false
  }
}

function trim(value) {
  if (typeof value !== 'string') return value
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n…[truncated ${value.length - MAX_TEXT} chars]` : value
}

/** Atomically replace one diagnostic file with `value` as JSON. */
export function dumpJson(name, value) {
  if (!ensureDir()) return
  try {
    const target = path.join(DIR, name)
    const temp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temp, target)
  } catch {
    // Best effort only.
  }
}

/** Dump the raw caller body exactly as received (before any rewrite). */
export function dumpIncoming(req, body) {
  dumpJson('last-incoming.json', {
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    body: trim(JSON.stringify(body)),
  })
}

/** Dump the final upstream body plus the upstream failure, when there is one. */
export function dumpUpstream(pathname, body, status, responseText, headers) {
  dumpJson('last-upstream.json', {
    at: new Date().toISOString(),
    path: pathname,
    status,
    response: trim(responseText ?? ''),
    headers: headers && typeof headers === 'object' ? headers : undefined,
    body: trim(JSON.stringify(body)),
  })
}
