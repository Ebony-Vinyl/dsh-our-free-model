/**
 * Free-lane transport and request adaptation.
 *
 * Request shaping is loaded from the generated src/o2a.js bundle. The source
 * modules and OFM-authored context/tool descriptions live in src/o2a/; see
 * SYNC.md for the replacement status and verification boundaries.
 * Historical reference markers remain exported for caller compatibility.
 * Their presence does not mean the new implementation mirrors that release.
 *
 * @module src/upstream.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR_NAME, resolveDshHome } from './store.js'
// 发布形态唯一导入点：src/o2a.js 由 scripts/build-legacy-payload.mjs 把
// src/o2a/ 八个模块（OFM 资产内联）打成单文件；开发/测试直接跑仓库里的产物。
import {
  BASE62_ALPHABET,
  CANONICAL_SESSION_RE,
  CLIENT_UA,
  DESCENDING_TIME_RE,
  O2A_VERSION,
  ToolRenameMap,
  canonicalSessionID,
  ensureChatUsage,
  ensureV2CompletionLimit,
  gatewayHeaders as o2aGatewayHeaders,
  injectOfficialPrompt,
  isOfficialSessionID,
  officialTool,
  phaseAgeMs,
  randomID,
  randomProjectID,
  renameAndCompleteTools,
  renamableToolName,
  sessionPhaseMs,
} from './o2a.js'

/**
 * Overridable so the selftest can point the adapter at a dead port and exercise
 * the transport-failure path without touching the real free lane's quota.
 */
export const UPSTREAM_BASE = process.env.OUR_FREE_MODEL_BASE ?? 'https://opencode.ai'

export { CLIENT_UA }

/** Historical reference version retained for callers; see src/o2a/SYNC.md. */
export const O2A_PORTED_VERSION = O2A_VERSION

const MAX_SESSION_LENGTH = 256
const MAX_TOOL_NAME_LEN = 128
const BASE62 = BASE62_ALPHABET

/**
 * The names the v2 gate validates verbatim. The full official set now ships
 * alongside them (see `src/o2a/official-tools.js`); these two are the ones the
 * gate's tool check is known to read.
 */
export const FINGERPRINT_TOOLS = ['read', 'shell']

/** Models served by /responses instead of /chat/completions. */
const RESPONSES_MODELS = new Set(['muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free'])
/** Models served by the Anthropic-shaped /messages endpoint. */
const MESSAGES_MODELS = new Set(['union-alpha'])

export const SESSION_RE = CANONICAL_SESSION_RE

export const SESSION_DESCENDING_RE = DESCENDING_TIME_RE

/** Whether `id` is a session the upstream free tier will accept as-is. */
export function isCanonicalSession(id) {
  return typeof id === 'string' && SESSION_RE.test(id.trim()) && SESSION_DESCENDING_RE.test(id.trim().slice(4, 16))
}

/**
 * Re-encode any session signal into the canonical layout the gate accepts,
 * keeping one signal on one session for the life of the process
 * (`o2a/identity.canonicalSessionID`): official sessions pass through, and a
 * synthesized one carries a slow-clock timestamp inside the window the
 * upstream accepts, salted per process so a restart re-mints.
 */
export function canonicalizeSession(signal) {
  return canonicalSessionID(signal)
}

/** Render `bytes` as base62, one character per byte (`base62From`). */
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
 * Kept for bookkeeping and tests: the free lane mints through
 * {@link canonicalizeSession} now. The encoding is the gate's:
 * `~(ts_ms * 0x1000 + counter)`, whose low 12 bits land at `0xfff - counter`.
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
 * Mint a `msg_`-shaped id for local bookkeeping (turn/recovery records).
 *
 * ⚠️ 这个值**不再上线**：`x-opencode-request` 是 v1 专用头，v2 收到即 403（见
 * {@link gatewayHeaders}）。保留铸造器是因为恢复记录与测试仍用它做一次性标识。
 */
export function mintRequestId(timestamp = Date.now()) {
  const value = BigInt(timestamp) * 0x1000n + 1n
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `msg_${hex}${base62From(crypto.randomBytes(14))}`
}

/**
 * The phase age a kept session may carry. The wire's time part is a 36-bit
 * millisecond phase (~795-day cycle, see o2a/identity.js), and the slow clock
 * mints phases at most 30 days old; a 60-day ceiling accepts every id this
 * lane mints (active conversations keep theirs indefinitely) while re-minting
 * the pre-port ids, whose hash-derived phase landed uniformly across the whole
 * cycle.
 */
const SESSION_PLAUSIBILITY_MS = 60 * 24 * 60 * 60 * 1000

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
    fs.writeFileSync(temp, JSON.stringify({ version: 2, at: Date.now(), sessions: Object.fromEntries(sessions) }, undefined, 2))
    fs.renameSync(temp, file)
  } catch { /* non-fatal: the id still works, it just will not survive a restart */ }
}

/**
 * Whether a canonical session's embedded time phase is inside the accepted
 * window. The wire carries a 36-bit millisecond phase (see
 * `o2a/identity.js`), not an absolute date, so plausibility is "dated within
 * the last month of the current phase cycle" — exactly what the slow clock
 * mints and what a hash-derived 1970 landing (the pre-port ids) almost never
 * satisfies.
 */
function plausibleSession(id) {
  const phase = sessionPhaseMs(id)
  return phase !== null && phaseAgeMs(phase) < SESSION_PLAUSIBILITY_MS
}

/**
 * Map one downstream conversation onto one stable upstream session.
 *
 * Mint once and persist the result. Never rotate IDs on retries or model
 * errors. A caller's canonical OC ID is kept. Since the o2a port, a minted id
 * carries a slow-clock date inside the window the upstream accepts, and a
 * remembered id whose date has left that window — an id carried over from the
 * pre-port era, whose hash-derived timestamp landed outside it and answered
 * 429 (live A/B, 2026-10-28) — is re-minted instead of replayed.
 */
export function sessionForConversation(sessionId) {
  if (typeof sessionId === 'string' && isCanonicalSession(sessionId)) return sessionId.trim()
  const seed = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'global'
  const remembered = loadSessions().get(seed)
  if (remembered !== undefined && isCanonicalSession(remembered) && plausibleSession(remembered)) return remembered
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
 * Which upstream path serves this model.
 *
 * The 2.1 client groups `/inference` routes by provider family, so the family
 * segment sits between the origin and the protocol path (a 2.0.32 client
 * posted the protocol path directly, and that flat route still answers — the
 * reference gateway sends the family form, so this lane does too). Anthropic
 * endpoints additionally carry the beta query the client appends.
 */
export function endpointFor(modelId) {
  if (isResponsesModel(modelId)) return '/inference/openai/v1/responses'
  if (isMessagesModel(modelId)) return '/inference/anthropic/v1/messages?beta=true'
  return '/inference/openai/v1/chat/completions'
}

/** The wire shape one endpoint speaks; drives request encoding and response parsing. */
export function wireFor(modelId) {
  if (isResponsesModel(modelId)) return 'responses'
  if (isMessagesModel(modelId)) return 'messages'
  return 'chat'
}

/**
 * The headers the gateway fingerprints a genuine client by — the v2 set
 * (`o2a/headers.js`), with the pooled免密 credential `Bearer public`.
 *
 * @param {object} options
 * @param {string} options.session - canonical session (all four session headers)
 * @param {boolean} [options.stream] - drives the default `accept`
 * @param {string} [options.accept] - explicit `accept` override
 * @param {string} [options.project] - caller project signal; **defaults to a
 *   fresh 40-hex id per request**, the quota-spread the reference mints when
 *   the client names no project (the old shared `global` bucket arrived
 *   pre-burned). A literal `global` or 40-hex commit passes through verbatim.
 * @param {string} [options.childSession] - child session for
 *   `x-opencode-session-id`; defaults to `session`
 * @param {boolean} [options.anthropic] - add the Messages-lane beta header
 */
export function gatewayHeaders(options) {
  return o2aGatewayHeaders(options)
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return ''
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  const fn = tool.function
  if (fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string') return fn.name.trim()
  return ''
}

/** The shape name one `style` argument speaks. */
function shapeOf(style) {
  return style === true ? 'flat' : style === 'claude' ? 'claude' : 'chat'
}

/** Does this entry carry the verbatim official definition for `name`?
 *
 * Compared against the **rendered** official tool — the shell description is
 * platform-aware (`v2ShellDescription`), so on a Windows host a verbatim
 * official shell says powershell while the raw asset says bash. */
function carriesOfficialDefinition(entry, name, shape) {
  const own = definitionOf(entry, shape)
  if (own === null) return false
  const rendered = officialTool(shape, name)
  const wrapper = shape === 'chat' ? rendered.function : rendered
  if (!wrapper) return false
  return own.description === wrapper.description
    && JSON.stringify(own.schema) === JSON.stringify(wrapper.parameters)
}

/** Where a tool's description and parameter schema sit for one wire shape. */
function definitionOf(entry, shape) {
  if (!entry || typeof entry !== 'object') return null
  const wrapper = shape === 'chat' ? entry.function : entry
  if (wrapper === null || wrapper === undefined || typeof wrapper !== 'object') return null
  const schema = shape === 'claude' ? wrapper.input_schema : wrapper.parameters
  return { description: wrapper.description, schema }
}

/**
 * The note appended when official tools had to be injected.
 *
 * ⚠️ v2 的定义是**真工具**（描述与 schema 都来自官方客户端），模型会真的去调它
 * —— 实测把 `read` 用在「/etc 里有什么文件」这种问题上。本插件的宿主并不实现
 * 官方工具集，注入项必须用提示词压住。措辞是实测选出来的：写成「不可用」会让
 * 模型连调用方自己的 `Read`/`Bash` 也一起拒绝；「占位、请用别的工具」才既压住
 * 注入项、又不误伤调用方的工具。（参考实现不发这条 —— 它的下游是真 CLI ——
 * 这是本适配层的既列偏差，见 src/o2a/SYNC.md。）
 */
function placeholderNote(names) {
  const list = names.map(name => `\`${name}\``).join(', ')
  return `The tools ${list} are part of the host CLI's own toolset and are placeholders in this session; they do nothing here. Use the other tools you have been given instead.`
}

/** Add free-lane context without replacing the caller's system text or blocks. */
function appendSystemContext(body, shape, note) {
  if (shape === 'flat') {
    body.instructions = typeof body.instructions === 'string' && body.instructions.trim() !== ''
      ? `${body.instructions}\n\n${note}`
      : note
    return
  }
  if (shape === 'claude') {
    body.system = Array.isArray(body.system)
      ? [...body.system, { type: 'text', text: note }]
      : typeof body.system === 'string' && body.system !== '' ? `${body.system}\n\n${note}` : note
    return
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const first = messages[0]
  if (first?.role === 'system' && typeof first.content === 'string') {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...messages.slice(1)]
    return
  }
  if (first?.role === 'system' && Array.isArray(first.content)) {
    body.messages = [{ ...first, content: [...first.content, { type: 'text', text: note }] }, ...messages.slice(1)]
    return
  }
  body.messages = [{ role: 'system', content: note }, ...messages]
}

/** Tell the model the injected officials are placeholders; never replace caller blocks. */
function noteInjectedTools(body, shape, names) {
  appendSystemContext(body, shape, placeholderNote(names))
}

/**
 * Current free-lane requests need environment context as well as tool definitions.
 * Reversible live controls (2026-10-28) returned 429 without it and PONG with it.
 * Use truthful process metadata, not a copied OC persona or a user workspace guess.
 * A caller's existing environment block takes precedence and is kept unchanged.
 *
 * Kept for its standalone contract (and the escaping guarantee); the shaping
 * pass now injects the full official prompt — which carries the same env block
 * — instead of this bare one.
 */
export function ensureFreeLaneEnvironment(body, style, environment = {}) {
  const shape = shapeOf(style)
  const textOf = value => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(part => part?.text ?? '').join('\n') : ''
  const existing = shape === 'flat' ? textOf(body.instructions)
    : shape === 'claude' ? textOf(body.system)
      : (Array.isArray(body.messages) ? body.messages : []).filter(message => message?.role === 'system' || message?.role === 'developer').map(message => textOf(message.content)).join('\n')
  if (/<env>[\s\S]*?<\/env>/i.test(existing)) return
  const line = value => String(value).replace(/[\r\n<>]/g, ' ')
  const cwd = environment.directory ?? process.cwd()
  const platform = environment.platform ?? process.platform
  appendSystemContext(body, shape, `Here is some useful information about the environment you are running in:\n<env>\n  Working directory: ${line(cwd)}\n  Platform: ${line(platform)}\n</env>`)
}

/**
 * The request shapes the free tier reads as a conversation-title generator
 * (`title.IsTitleRequest`, opencode2api v1.4.7): no tools declared, one to
 * three turns, no assistant/tool/function turn, and a title marker in the
 * system or leading text.
 *
 * The reference stopped shaping these bodies in v1.4.7 with a measured reason:
 * the free tier answers an agent-shaped tool list on a toolless title call
 * with 403/429. This lane injects the full official prompt and 13-tool set on
 * every body, so the harness's title round-trips used to ship exactly that
 * shape whenever the local title answer was switched off. A title request now
 * ships as the caller wrote it — no prompt injection, no tool append, no
 * renames.
 */
const TITLE_MARKERS = /generate a title|write a title|create a title|come up with a title|title (?:for|of) (?:this|the) (?:conversation|chat|session|exchange|request)|conversation title|summarize (?:this|the) conversation/i

export function isTitleRequest(body, style) {
  if (!body || typeof body !== 'object') return false
  if (body.tool_choice !== undefined || (Array.isArray(body.tools) && body.tools.length)
    || (Array.isArray(body.functions) && body.functions.length)) return false
  const shape = shapeOf(style)
  const rows = shape === 'flat' ? body.input : body.messages
  if (!Array.isArray(rows)) return false
  const containsTitle = value => {
    if (typeof value === 'string') return TITLE_MARKERS.test(value)
    if (!Array.isArray(value)) return false
    return TITLE_MARKERS.test(value.map(block => block?.text ?? '').join('\n'))
  }
  let matches = containsTitle(shape === 'flat' ? body.instructions : shape === 'claude' ? body.system : '')
  let count = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object' || (shape === 'flat' && typeof row.role !== 'string')) continue
    if (++count > 3 || !['user', 'system', 'developer'].includes(row.role)) return false
    matches = containsTitle(row.content) || matches
  }
  return count > 0 && matches
}

/**
 * Adapt a request to the free-lane wire contract using OFM-authored prompts
 * and tool schemas. Rename declarations and references together, then restore
 * names on the response path. Title-only requests keep their original shape.
 * @param {object} body - request body, mutated in place
 * @param {boolean|'claude'} style - Responses, Chat or Messages
 * @returns {ToolRenameMap} response-name restoration map
 */
export function applyFingerprint(body, style) {
  const shape = shapeOf(style)
  if (!body || typeof body !== 'object') return new ToolRenameMap()

  // 0. Title requests ship unshaped: an agent-shaped tool list on a toolless
  // title call is a 403/429 the reference measured (see isTitleRequest).
  if (isTitleRequest(body, style)) return new ToolRenameMap()

  // 1. Official system prompt (the reference injects before shaping tools).
  injectOfficialPrompt(body, shape)

  // 2.+3. Tool pass: rename client tools, append the official set. Tools that
  // already carry the verbatim official definition are declared officials —
  // kept as-is and not duplicated — so repeated shaping stays a no-op.
  const tools = Array.isArray(body.tools) ? body.tools : []
  const keep = new Set()
  for (const tool of tools) {
    const name = renamableToolName(shape, tool)
    if (name !== null && carriesOfficialDefinition(tool, name, shape)) {
      keep.add(name)
    }
  }
  const { renames, injected } = renameAndCompleteTools(body, shape, { keep })

  // 4b. The injected officials need the placeholder note.
  if (injected.length > 0) noteInjectedTools(body, shape, injected)

  // 5. Never ship tool_choice none; default the Responses wire to auto.
  if (body.tool_choice === 'none'
    || (body.tool_choice !== null && typeof body.tool_choice === 'object' && body.tool_choice.type === 'none')) {
    delete body.tool_choice
  }
  if (shape === 'flat' && !body.tool_choice) body.tool_choice = 'auto'

  // 6. The chat body's own constants.
  ensureChatUsage(body, shape)
  ensureV2CompletionLimit(body, shape)
  return renames
}

/** Restore the caller's tool spelling in a streaming delta or a final payload. */
export function restoreToolName(name, map) {
  if (!map) return name
  if (typeof map.resolve === 'function') return map.resolve(name)
  if (map.size === 0) return name
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

/** The Anthropic API version the Messages lane sends. */
const ANTHROPIC_API_VERSION = '2023-06-01'

export { truncateSession, randomID, randomProjectId, MAX_TOOL_NAME_LEN, ANTHROPIC_API_VERSION }

/**
 * A fresh per-request project id, exposed for callers that want to pin the
 * same id across a retried turn. The lane default is one per request.
 */
function randomProjectId() {
  return randomProjectID()
}
