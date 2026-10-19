/**
 * Upstream wire for the免密 free lane.
 *
 * ⚠️ 2026-10-18: the `/inference/v1` gate began answering 403 FreeTierError for
 * every free id even with the v2 fingerprint below. A live probe showed the
 * legacy `/zen/v1` origin still accepts the pre-2.x (v1.3.7) shape — it
 * answered 429 FreeUsageLimitError, which means the gate passed and only the
 * per-IP quota was exhausted. The module therefore speaks v1.3.7 again:
 * `opencode/1.18.31 (<os> <arch>; <runtime>)`, `x-opencode-request`, a
 * `prj_<24hex>` project id, and lightweight `bash`/`edit`/`glob`/`grep`/`read`
 * stubs. The v2 facts below are retained as history.
 *
 * Every fact encoded here was verified against the live gateway on 2026-09-24
 * by direct request: the public pooled
 * credential, the client fingerprint headers, the per-model endpoint split, the
 * free-tier tool-fingerprint gate (403 FreeTierError without it), the
 * per-session quota accounting (429 FreeUsageLimitError when a fresh session is
 * minted per request), and the regional gate (403 RegionError).
 *
 * Re-verified 2026-10-14 after the lane moved: the free models now answer on
 * `/inference/v1` (the old `/zen/v1` chat path answers 403 FreeTierError for
 * every one of them), a request must send `x-opencode-session-id` next to
 * `x-opencode-session`, and the session id has to be minted rather than derived.
 * Details and the measurements: docs/free-lane-wire.md.
 *
 * Re-verified 2026-10-16 against the **v2** client fingerprint (the shape the
 * official client has sent since 2026-10-14, and the one this module now
 * mirrors). Four facts changed together, and each of them is a 403
 * FreeTierError on its own:
 *
 * | 项 | v1（旧） | v2（现在） |
 * |---|---|---|
 * | User-Agent | `opencode/1.18.31` | `opencode/latest/2.0.26/cli` |
 * | 请求头 | 带 `x-opencode-request` | **不带**（v1 专用头，带了即 403）；另加 `x-session-affinity` / `x-session-id` |
 * | 工具闸门 | `bash`/`glob`/`grep`/`read` 四个名字，各带至少一个 property | **`read` 与 `shell` 两个名字，且 description 与参数 schema 必须与官方客户端逐字一致** |
 * | `tool_choice` | 无工具时补 `none` | **`none` 即 403**，绝不下发 |

 * The v2 gate compares the declared definitions themselves, so the old "stub
 * with a placeholder property" trick is refused: the definitions below are
 * verbatim from the v2.0.26 CLI and must not be reworded or reformatted.
 * Source of the shape (live-probed upstream by that project, and the reference
 * this port follows): 9router `open-sse/utils/opencodeFingerprint.js` +
 * `open-sse/executors/opencode.js` at v0.5.104.
 *
 * Re-verified 2026-10-17 after every request started answering 403: the gate
 * also validates the session id's *encoding*, not only its `ses_…` shape. The
 * twelve hex digits must be the descending `~(ts_ms << 12 | counter)` value with
 * counter 1–63 (low 12 bits `0xfc0–0xfff`); an ascending `ts << 12` value or a
 * sha256 digest is refused with 403 FreeTierError. See
 * {@link SESSION_DESCENDING_RE} and {@link canonicalizeSession}, and the
 * reference implementation at https://github.com/jasonxu114514/opencode2api
 * (`internal/identity/request.go`). A live control on the same egress IP showed
 * that the official 2.0.32 CLI's exact bytes pass while a fresh ascending id
 * 403s, so this is an identity check and not IP rate limiting.
 *
 * @module src/upstream.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR_NAME, resolveDshHome } from './store.js'

/**
 * Overridable so the selftest can point the adapter at a dead port and exercise
 * the transport-failure path without touching the real free lane's quota.
 */
export const UPSTREAM_BASE = process.env.OUR_FREE_MODEL_BASE ?? 'https://opencode.ai'

/**
 * The client User-Agent the legacy `/zen/v1` gate fingerprints.
 *
 * 2026-10-18: `/inference/v1` started answering 403 FreeTierError for every
 * request even with the v2 fingerprint, while `/zen/v1` still accepted the
 * pre-2.x OpenCode 1.18.x shape. A live probe on that date returned 429
 * FreeUsageLimitError (the gate passed; only the per-IP quota was exhausted),
 * so the lane speaks v1.3.7 again: `opencode/<version> (<os> <arch>; <runtime>)`.
 *
 * Keep the string self-contained: attribution text is not appended on this lane.
 */
function legacyUserAgent() {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  return `opencode/1.18.31 (${os} ${arch}; go1.25.0)`
}

export const CLIENT_UA = legacyUserAgent()
const MAX_SESSION_LENGTH = 256
const MAX_TOOL_NAME_LEN = 128
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * The tools the legacy free-tier gate requires, as v1.3.7 lightweight stubs.
 *
 * The legacy `/zen/v1` gate only checks the *names*: `bash` and `read` are
 * mandatory and a stub with an empty `properties` object passes. It does not
 * compare descriptions or schemas, so the v2 byte-for-byte definitions no
 * longer apply (and keeping them would only add tokens to every request).
 */
export const FINGERPRINT_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read']

/**
 * The note appended when a fingerprint tool had to be injected.
 *
 * The stubs exist only to satisfy the gate. Tell the model they do nothing so a
 * turn does not waste a step calling them, while leaving the caller's own tools
 * usable.
 */
function placeholderNote(names) {
  const list = names.map(name => `\`${name}\``).join(' or ')
  return names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`
}

/** Models served by /responses instead of /chat/completions. */
const RESPONSES_MODELS = new Set(['muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free'])
/** Models served by the Anthropic-shaped /messages endpoint. */
const MESSAGES_MODELS = new Set(['union-alpha'])

/**
 * The tool-name alphabet the legacy gate accepts.
 *
 * Measured 2026-10-19 against `/zen/v1/chat/completions`: declaring a tool named
 * `mcp:rea:read_file` is answered with **HTTP 400 and an empty body**, while the
 * same request with the colon spelled `_` streams normally (and a 128-character
 * name is accepted). The gate publishes no schema, so the allow-list stays the
 * conservative [OI] function-name alphabet. Anything outside it is rewritten
 * before the request leaves and restored on the way out, so a caller's own
 * spelling — Zed's `mcp:rea:*` tools are the common case — keeps working.
 */
const TOOL_NAME_SAFE = /^[A-Za-z0-9_-]+$/

/** Rewrite one tool name into the gate's alphabet, keeping it recognisable. */
export function sanitizeToolName(name) {
  const raw = String(name ?? '').trim()
  if (raw === '') return 'tool'
  const flattened = raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  const bounded = (flattened === '' ? 'tool' : flattened).slice(0, MAX_TOOL_NAME_LEN)
  return bounded === '' ? 'tool' : bounded
}

function nameHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 6)
}

/**
 * Assign every name that will travel upstream a spelling the gate accepts.
 *
 * Valid names keep their spelling and are reserved **first**, so a rewritten name
 * can never steal one that the caller really declared. Two rewritten names that
 * flatten to the same base are separated by a digest suffix: the suffix is
 * derived from the original, so the same tool maps to the same wire name on every
 * request — history that refers to a call must keep resolving to it.
 *
 * @returns {Map<string, string>} original spelling -> wire spelling (identity
 *   names included, so callers can look every name up)
 */
function planToolNames(names) {
  const claimed = new Map()
  const planned = new Map()
  for (const name of names) {
    if (name.length <= MAX_TOOL_NAME_LEN && TOOL_NAME_SAFE.test(name)) claimed.set(name, name)
  }
  for (const name of names) {
    if (planned.has(name)) continue
    if (name.length <= MAX_TOOL_NAME_LEN && TOOL_NAME_SAFE.test(name)) {
      planned.set(name, name)
      continue
    }
    const base = sanitizeToolName(name)
    let candidate = base
    let owner = claimed.get(candidate)
    if (owner !== undefined && owner !== name) {
      let suffix = `_${nameHash(name)}`
      candidate = `${base.slice(0, Math.max(1, MAX_TOOL_NAME_LEN - suffix.length))}${suffix}`
      let n = 2
      while (claimed.has(candidate) && claimed.get(candidate) !== name) {
        suffix = `_${nameHash(name)}${n}`
        candidate = `${base.slice(0, Math.max(1, MAX_TOOL_NAME_LEN - suffix.length))}${suffix}`
        n += 1
      }
    }
    claimed.set(candidate, name)
    planned.set(name, candidate)
  }
  return planned
}

/** Every tool name a history already refers to, in wire order. */
function historyToolNames(body, { claude, flat }) {
  const names = []
  if (claude) {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') names.push(block.name)
      }
    }
    return names
  }
  if (flat) {
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (item?.type === 'function_call' && typeof item.name === 'string') names.push(item.name)
    }
    return names
  }
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.function?.name === 'string') names.push(call.function.name)
    }
  }
  return names
}

/** Rewrite the names a history refers to, so a call and its declaration agree. */
function rewriteHistoryToolNames(body, { claude, flat }, forward) {
  const rename = value => forward.get(value) ?? value
  if (claude) {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') block.name = rename(block.name)
      }
    }
    return
  }
  if (flat) {
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (item?.type === 'function_call' && typeof item.name === 'string') item.name = rename(item.name)
    }
    return
  }
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.function?.name === 'string') call.function.name = rename(call.function.name)
    }
  }
}

/** The tool name a `tool_choice` pins, when it pins one. */
function choiceToolName(body, { claude, flat }) {
  const choice = body.tool_choice
  if (choice === null || typeof choice !== 'object') return ''
  if (claude || flat) return typeof choice.name === 'string' ? choice.name : ''
  return typeof choice.function?.name === 'string' ? choice.function.name : ''
}

/** Keep a pinned `tool_choice` pointing at the tool it named. */
function rewriteChoiceToolName(body, { claude, flat }, forward) {
  const choice = body.tool_choice
  if (choice === null || typeof choice !== 'object') return
  if (claude || flat) {
    if (typeof choice.name === 'string') choice.name = forward.get(choice.name) ?? choice.name
    return
  }
  if (typeof choice.function?.name === 'string') choice.function.name = forward.get(choice.function.name) ?? choice.function.name
}

export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * The time half of a canonical session id the upstream free tier actually accepts.
 *
 * ⚠️ 形状对还不够（2026-10-17 实测）：官方客户端用 `Identifier.descending()`
 * 铸造时间戳 —— 48 位的 `~(ts_ms << 12 | counter)`，取反把低 12 位变成
 * `0xFFF - counter`。上游只放行 counter 1–63，即低 12 位落在 `0xfc0–0xfff`
 * （前 9 位任意 hex，第 10 位 `c`–`f`，后两位任意）。任何其它编码 —— 包括
 * `ts_ms << 12` 这种升序写法、以及 sha256 摘要 —— 即使 `ses_` 形状完全正确，
 * 也会被 403 FreeTierError 拒掉。参考实现：
 * https://github.com/jasonxu114514/opencode2api `internal/identity/request.go`
 * （`descendingTimePartPattern`）。
 */
export const SESSION_DESCENDING_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

/** Whether `id` is a session the upstream free tier will accept as-is. */
export function isCanonicalSession(id) {
  return typeof id === 'string' && SESSION_RE.test(id.trim()) && SESSION_DESCENDING_RE.test(id.trim().slice(4, 16))
}

/**
 * Re-encode any session id into the descending layout the gate accepts, keeping
 * one conversation pinned to one upstream session.
 *
 * The digest is the same `ses\0<signal>` sha256 the reference gateway uses, so a
 * given downstream conversation always maps to the same upstream id. Counter 1
 * keeps the low 12 bits at `0xffe`, inside the accepted window.
 */
export function canonicalizeSession(signal) {
  const digest = crypto.createHash('sha256').update(`ses\0${signal}`).digest()
  const current = ((BigInt(digest[0]) << 28n | BigInt(digest[1]) << 20n | BigInt(digest[2]) << 12n |
    BigInt(digest[3]) << 4n | BigInt(digest[4]) >> 4n) << 12n) | 1n
  const inverted = ~current & 0xffffffffffffn
  const timeHex = inverted.toString(16).padStart(12, '0')
  return `ses_${timeHex}${base62Fixed(digest.subarray(6, 16), 14)}`
}

/** Render `bytes` as exactly `width` base62 characters (big-endian). */
function base62Fixed(bytes, width) {
  let n = 0n
  for (const byte of bytes) n = (n << 8n) | BigInt(byte)
  const base = 62n
  const out = new Array(width)
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62[Number(n % base)]
    n /= base
  }
  return out.join('')
}

const ANTHROPIC_API_VERSION = '2023-06-01'

function base62From(bytes) {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

let lastStamp = 0
let seq = 0

/**
 * Mint a gateway-shaped canonical session id (time-prefixed, monotonic counter).
 *
 * The encoding is the gate's: `~(ts_ms * 0x1000 + counter)`, whose low 12 bits
 * land at `0xfff - counter`. The counter resets every millisecond, so a burst of
 * mints inside one millisecond stays inside the accepted 1–63 window.
 */
export function mintSessionId(timestamp = Date.now()) {
  if (timestamp !== lastStamp) { lastStamp = timestamp; seq = 0 }
  seq += 1
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(seq))
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `ses_${hex}${base62From(crypto.randomBytes(14))}`
}

/**
 * Mint a `msg_`-shaped id for the legacy `x-opencode-request` header.
 *
 * The legacy `/zen/v1` gate expects this header again (2026-10-18); the
 * `/inference` gate used to reject it, which is why the v2 section above says
 * it must not be sent.
 */
export function mintRequestId(timestamp = Date.now()) {
  const value = BigInt(timestamp) * 0x1000n + 1n
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `msg_${hex}${base62From(crypto.randomBytes(14))}`
}

const SESSION_MAP_FILE = 'session-map.json'
let sessions

function sessionStorePath() {
  try { return path.join(path.resolve(resolveDshHome(), DATA_DIR_NAME), SESSION_MAP_FILE) } catch { return undefined }
}

function loadSessions() {
  if (sessions !== undefined) return sessions
  sessions = new Map()
  try {
    const file = sessionStorePath()
    if (file === undefined) return sessions
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const [seed, id] of Object.entries(parsed?.sessions ?? {})) {
      if (typeof id === 'string' && SESSION_RE.test(id)) sessions.set(seed, id)
    }
  } catch { /* first run or unreadable store: start empty */ }
  return sessions
}

function rememberSession(seed, id) {
  loadSessions().set(seed, id)
  try {
    const file = sessionStorePath()
    if (file === undefined) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ version: 1, at: Date.now(), sessions: Object.fromEntries(sessions) }, undefined, 2))
    fs.renameSync(temp, file)
  } catch { /* non-fatal: the id still works, it just will not survive a restart */ }
}

/**
 * Map one downstream conversation onto one stable upstream session.
 *
 * Free-tier quota is accounted per session, so a fresh id per request exhausts
 * it and surfaces as 429 with growing retry-after. The gateway also checks the
 * id's *encoding*, not just its shape: the twelve hex digits must carry the
 * descending timestamp layout `mintSessionId()` produces, with a counter in the
 * accepted 1–63 window (measured 2026-10-17; the reference gateway's
 * `descendingTimePartPattern` documents the same window). A sha256 digest, an
 * ascending `ts << 12` value, or any other random hex is refused with 403
 * FreeTierError even when every other header is right.
 *
 * ⇒ A downstream-supplied id is only forwarded verbatim when it already carries
 * the accepted encoding ({@link isCanonicalSession}); anything else is
 * deterministically re-encoded into the descending layout, so a conversation
 * keeps one stable upstream session instead of drawing 403s.
 */
export function sessionForConversation(sessionId) {
  if (typeof sessionId === 'string' && isCanonicalSession(sessionId)) return sessionId.trim()
  const seed = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'global'
  const remembered = loadSessions().get(seed)
  if (remembered !== undefined && isCanonicalSession(remembered)) return remembered
  const minted = canonicalizeSession(seed)
  rememberSession(seed, minted)
  return minted
}

/** Strip a trailing "(level)" thinking suffix so lookups hit the base id. */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

function isMuseSpark(modelId) {
  const clean = baseModelId(modelId)
  const base = clean.includes('/') ? clean.split('/').pop() : clean
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base)
}

export function isResponsesModel(modelId) {
  return RESPONSES_MODELS.has(baseModelId(modelId)) || isMuseSpark(modelId)
}

export function isMessagesModel(modelId) {
  return MESSAGES_MODELS.has(baseModelId(modelId))
}

/**
 * Which upstream path serves this model. Since 2026-10-18 the keyless lane is
 * served again by the legacy `/zen/v1` gate (the `/inference/v1` gate answers
 * 403 FreeTierError for every free id), matching the v1.3.7 request shape.
 */
export function endpointFor(modelId) {
  if (isResponsesModel(modelId)) return '/zen/v1/responses'
  if (isMessagesModel(modelId)) return '/zen/v1/messages'
  return '/zen/v1/chat/completions'
}

/** The wire shape one endpoint speaks; drives request encoding and response parsing. */
export function wireFor(modelId) {
  const path = endpointFor(modelId)
  if (path === '/zen/v1/responses') return 'responses'
  if (path === '/zen/v1/messages') return 'messages'
  return 'chat'
}

/** A canonical `prj_<24hex>` id, the shape the legacy gate expects. */
function projectIdFor(session) {
  const digest = crypto.createHash('sha256').update(`prj\0${session}`).digest('hex')
  return `prj_${digest.slice(0, 24)}`
}

/**
 * The headers the gateway fingerprints a genuine client by.
 * `Authorization: Bearer public` is the pooled免密 credential — there is no
 * per-user secret on this lane.
 *
 * ⚠️ v1.3.7 shape (restored 2026-10-18 for the legacy `/zen/v1` gate):
 * - `x-opencode-request` is sent again (the v1 request-correlation header);
 * - `x-opencode-project` carries the canonical `prj_<24hex>` shape;
 * - `x-opencode-session` + `x-session-affinity` + `x-session-id` mirror the
 *   same descending-encoded id; `x-opencode-session-id` is not sent on this
 *   lane (it belongs to the `/inference` gate).
 */
export function gatewayHeaders({ session, stream, accept, request }) {
  return {
    'content-type': 'application/json',
    'authorization': 'Bearer public',
    'user-agent': CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-request': request ?? mintRequestId(),
    'x-opencode-project': projectIdFor(session),
    'accept': accept ?? (stream ? 'text/event-stream' : '*/*'),
  }
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return ''
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  const fn = tool.function
  if (fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string') return fn.name.trim()
  return ''
}

/** The gate's stub declaration, in the shape the wire expects. */
function fingerprintTool(name, { claude, flat }) {
  const description = `Agent tool ${name}`
  const parameters = { type: 'object', properties: {} }
  if (claude) return { name, description, input_schema: parameters }
  if (flat) return { type: 'function', name, description, parameters }
  return { type: 'function', function: { name, description, parameters } }
}

/** Tell the model the injected fingerprint tools are placeholders (see {@link placeholderNote}). */
function noteInjectedTools(body, { claude, flat }, names) {
  const note = placeholderNote(names)
  if (flat) {
    body.instructions = typeof body.instructions === 'string' && body.instructions.trim() !== ''
      ? `${body.instructions}\n\n${note}`
      : note
    return
  }
  if (claude) {
    body.system = typeof body.system === 'string' && body.system !== '' ? `${body.system}\n\n${note}` : note
    return
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const first = messages[0]
  if (first?.role === 'system' && typeof first.content === 'string') {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...messages.slice(1)]
    return
  }
  body.messages = [{ role: 'system', content: note }, ...messages]
}

/**
 * Satisfy the legacy free-tier fingerprint gate on `body.tools`, and give every
 * name that travels upstream a spelling the gate accepts.
 *
 * ## v1.3.7 rules
 *
 * 1. `bash`, `edit`, `glob`, `grep` and `read` must be declared; the gate only
 *    checks names and accepts lightweight stubs (`{type:'object', properties:{}}`).
 * 2. The caller's tools keep their definitions. A tool the caller really declared
 *    under a gate name is not duplicated.
 * 3. Missing gate names are appended as stubs and the model is told they do
 *    nothing.
 * 4. A name outside the gate's alphabet is rewritten, not dropped: `mcp:rea:*`
 *    is a 400 with an empty body, so the declaration, the history that refers to
 *    it and any pinned `tool_choice` are rewritten together, and the returned map
 *    restores the caller's spelling on the response.
 *
 * @param {object} body - request body, mutated in place
 * @param {boolean|'claude'} style - true 为 Responses，false 为 Chat，claude 为 Messages
 * @returns {Map<string, string>} wire spelling -> caller spelling, for
 *   {@link restoreToolName}; empty when no name had to be rewritten
 */
export function applyFingerprint(body, style) {
  const flat = style === true
  const claude = style === 'claude'
  const shape = { claude, flat }
  const tools = Array.isArray(body.tools) ? body.tools : []

  // Every spelling the request will mention, in a deterministic order: declared
  // tools first, then what the history already refers to, then a pinned choice.
  const order = []
  const seen = new Set()
  const add = name => {
    const value = String(name ?? '').trim()
    if (value === '' || seen.has(value)) return
    seen.add(value)
    order.push(value)
  }
  for (const tool of tools) add(toolNameOf(tool))
  for (const name of historyToolNames(body, shape)) add(name)
  add(choiceToolName(body, shape))

  const forward = planToolNames(order)
  const renameMap = new Map()
  for (const [original, wire] of forward) if (wire !== original) renameMap.set(wire, original)

  for (const tool of tools) {
    const name = toolNameOf(tool)
    if (name === '') continue
    const wire = forward.get(name) ?? name
    if (wire === name) continue
    if (claude || flat || tool.function === undefined) tool.name = wire
    else tool.function.name = wire
  }
  rewriteHistoryToolNames(body, shape, forward)
  rewriteChoiceToolName(body, shape, forward)

  const present = new Set(tools.map(toolNameOf).filter(name => FINGERPRINT_TOOLS.includes(name)))
  const out = [...tools]
  const injected = []

  for (const name of FINGERPRINT_TOOLS) {
    if (present.has(name)) continue
    out.push(fingerprintTool(name, shape))
    injected.push(name)
  }

  body.tools = out
  if (injected.length > 0) noteInjectedTools(body, shape, injected)
  return renameMap
}

/** Restore the caller's tool spelling in a streaming delta or a final payload. */
export function restoreToolName(name, map) {
  if (!map || map.size === 0) return name
  return map.get(name) ?? name
}

/** Session-scoped identity used to pick a decoy out of a real tool call. */
export function declaredToolNames(body) {
  const names = new Set()
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const n = toolNameOf(tool)
    if (n) names.add(n)
  }
  return names
}

function truncateSession(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > MAX_SESSION_LENGTH ? trimmed.slice(0, MAX_SESSION_LENGTH) : trimmed
}

export { truncateSession, ANTHROPIC_API_VERSION, MAX_TOOL_NAME_LEN }
