/**
 * Add and remove OFM-owned prompt segments at each wire's system-text boundary.
 * Markers distinguish generated instructions from user text during removal.
 * @module src/token-saver/inject.js
 */

/** Opens the injected region; its presence is what `hasInjected` reports. */
export const INJECT_MARKER = '<!-- ofm-token-saver -->'

/** Closes the region {@link INJECT_MARKER} opens; a cut needs both. */
const MARKER_END = '<!-- /ofm-token-saver -->'

/**
 * Joins prompt segments — the same `\n\n` the project's projectors use
 * (`messages.js` joins system parts with it, and the sealed-lane pacing hint in
 * `adapter.js` appends with it), so one system message reads the same however
 * it was assembled.
 */
const SEP = '\n\n'

const result = (payload, injected, reason) => ({ payload, injected, reason })

/**
 * Put `text` into the body's system text, once.
 *
 * Mutates `payload` in place; the returned object carries the same reference
 * so a caller can chain without reassigning. `reason` is one of:
 * `'injected'`, `'already-injected'`, `'no-text'`, `'shape-not-recognised'`,
 * `'inject-failed'` (a frozen or proxied body refused the write).
 *
 * @param {object} payload - the request body about to be posted
 * @param {'chat'|'messages'|'responses'} wire - which provider shape it is
 * @param {string} text - the prompt text, verbatim from `./prompts.js`
 * @returns {{payload: object, injected: boolean, reason: string}}
 */
export function injectSystem(payload, wire, text) {
  try {
    if (payload === null || typeof payload !== 'object') return result(payload, false, 'shape-not-recognised')
    if (typeof text !== 'string' || text === '') return result(payload, false, 'no-text')
    const segment = `${INJECT_MARKER}${SEP}${text}${SEP}${MARKER_END}`
    if (wire === 'chat') return injectChat(payload, segment)
    if (wire === 'messages') return injectMessages(payload, segment)
    if (wire === 'responses') return injectResponses(payload, segment)
    return result(payload, false, 'shape-not-recognised')
  } catch {
    // Fail-open: a frozen body (or one behind a proxy that throws on set) must
    // never fail the turn over a token-saving nicety.
    return result(payload, false, 'inject-failed')
  }
}

/**
 * Remove every injected region, restoring what `injectSystem` was given.
 *
 * This is the user-facing off switch and the round-trip half of the tests.
 * `reason` is `'stripped'`, `'not-injected'`, `'shape-not-recognised'` or
 * `'strip-failed'`.
 *
 * @param {object} payload
 * @param {'chat'|'messages'|'responses'} wire
 * @returns {{payload: object, stripped: boolean, reason: string}}
 */
export function stripInjected(payload, wire) {
  try {
    if (payload === null || typeof payload !== 'object') return { payload, stripped: false, reason: 'shape-not-recognised' }
    if (wire === 'chat') return stripChat(payload)
    if (wire === 'messages') return stripMessages(payload)
    if (wire === 'responses') return stripResponses(payload)
    return { payload, stripped: false, reason: 'shape-not-recognised' }
  } catch {
    return { payload, stripped: false, reason: 'strip-failed' }
  }
}

/**
 * Does the body carry a complete injected region?
 *
 * A lone marker without its end is not a region — it is text someone else
 * wrote, and neither `stripInjected` nor this predicate will touch it.
 *
 * @param {object} payload
 * @param {'chat'|'messages'|'responses'} wire
 * @returns {boolean}
 */
export function hasInjected(payload, wire) {
  try {
    if (payload === null || typeof payload !== 'object') return false
    if (wire === 'chat') {
      const messages = payload.messages
      if (!Array.isArray(messages)) return false
      return messages.some(message => isSystem(message) && contentHasRegion(message.content))
    }
    if (wire === 'messages') {
      if (!Array.isArray(payload.messages)) return false
      return contentHasRegion(payload.system)
    }
    if (wire === 'responses') {
      if (hasRegion(payload.instructions)) return true
      const input = payload.input
      if (!Array.isArray(input)) return false
      return input.some(item => isResponsesSystem(item) && contentHasRegion(item.content))
    }
    return false
  } catch {
    return false
  }
}

// ── shared helpers ───────────────────────────────────────────────────────────

const isSystem = message => message !== null && typeof message === 'object'
  && (message.role === 'system' || message.role === 'developer')

const isResponsesSystem = item => isSystem(item) && item.type === 'message'

/** Is the exact segment already present in a message's string or block content? */
function contentHasSegment(content, segment) {
  if (typeof content === 'string') return content.includes(segment)
  if (Array.isArray(content)) {
    return content.some(block => block !== null && typeof block === 'object'
      && typeof block.text === 'string' && block.text.includes(segment))
  }
  return false
}

/** Is a complete marker region present in a string or block content? */
function contentHasRegion(content) {
  if (typeof content === 'string') return hasRegion(content)
  if (Array.isArray(content)) {
    return content.some(block => block !== null && typeof block === 'object'
      && typeof block.text === 'string' && hasRegion(block.text))
  }
  return false
}

function hasRegion(text) {
  if (typeof text !== 'string') return false
  const start = text.indexOf(INJECT_MARKER)
  return start !== -1 && text.indexOf(MARKER_END, start + INJECT_MARKER.length) !== -1
}

/**
 * Remove every marker-delimited region from a string.
 *
 * Returns `null` when there is no complete region (nothing to do); otherwise
 * the string with each `INJECT_MARKER … MARKER_END` span gone, including the
 * `\n\n` that joined it to its neighbours — that separator is what makes
 * `stripInjected` restore the body byte-for-byte. A lone marker is left alone:
 * it is not provably ours, and cutting to an assumed boundary could eat user
 * text.
 */
function cutMarked(content) {
  let next = content
  let cut = false
  for (;;) {
    const start = next.indexOf(INJECT_MARKER)
    if (start === -1) break
    const end = next.indexOf(MARKER_END, start + INJECT_MARKER.length)
    if (end === -1) break
    let from = start
    let to = end + MARKER_END.length
    if (next.startsWith(SEP, to)) to += SEP.length
    else if (next.endsWith(SEP, from)) from -= SEP.length
    next = next.slice(0, from) + next.slice(to)
    cut = true
  }
  return cut ? next : null
}

// ── chat (OpenAI Chat Completions) ───────────────────────────────────────────

function injectChat(payload, segment) {
  if (!Array.isArray(payload.messages)) return result(payload, false, 'shape-not-recognised')
  let target
  for (const message of payload.messages) {
    if (!isSystem(message)) continue
    if (contentHasSegment(message.content, segment)) return result(payload, false, 'already-injected')
    target ??= message
  }
  if (!target) payload.messages.unshift({ role: 'system', content: segment })
  else if (Array.isArray(target.content)) target.content.push({ type: 'text', text: segment })
  else target.content = typeof target.content === 'string' && target.content ? `${target.content}${SEP}${segment}` : segment
  return result(payload, true, 'injected')
}

/** Strip marked text in place; blocks retain identity and cache annotations. */
function stripContent(owner, key) {
  const value = owner[key]
  if (typeof value === 'string') {
    const cut = cutMarked(value)
    if (cut === null) return false
    owner[key] = cut
    return true
  }
  if (!Array.isArray(value)) return false
  let changed = false, write = 0
  for (const block of value) {
    if (block && typeof block === 'object' && typeof block.text === 'string') {
      const cut = cutMarked(block.text)
      if (cut !== null) {
        changed = true
        if (!cut) continue
        block.text = cut
      }
    }
    value[write++] = block
  }
  if (changed) value.length = write
  return changed
}

function stripRows(rows, predicate) {
  let stripped = false, write = 0
  for (const row of rows) {
    if (predicate(row) && stripContent(row, 'content')) {
      stripped = true
      if (row.content.length === 0) continue
    }
    rows[write++] = row
  }
  if (stripped) rows.length = write
  return stripped
}

function stripChat(payload) {
  if (!Array.isArray(payload.messages)) return { payload, stripped: false, reason: 'shape-not-recognised' }
  const stripped = stripRows(payload.messages, isSystem)
  return { payload, stripped, reason: stripped ? 'stripped' : 'not-injected' }
}

// ── messages (Anthropic Messages) ────────────────────────────────────────────

function injectMessages(payload, segment) {
  if (!Array.isArray(payload.messages)) return result(payload, false, 'shape-not-recognised')
  const system = payload.system
  if (contentHasSegment(system, segment)) return result(payload, false, 'already-injected')
  if (Array.isArray(system)) {
    let position = system.length
    // Keep the new instructions inside the final cache breakpoint.
    for (let i = system.length - 1; i >= 0; i--) {
      if (system[i]?.cache_control) { position = i; break }
    }
    system.splice(position, 0, { type: 'text', text: segment })
  } else if (system == null || typeof system === 'string') {
    payload.system = system ? `${system}${SEP}${segment}` : segment
  } else return result(payload, false, 'shape-not-recognised')
  return result(payload, true, 'injected')
}

function stripMessages(payload) {
  if (!Array.isArray(payload.messages)) return { payload, stripped: false, reason: 'shape-not-recognised' }
  const stripped = stripContent(payload, 'system')
  if (stripped && payload.system === '') delete payload.system
  return { payload, stripped, reason: stripped ? 'stripped' : 'not-injected' }
}

// ── responses (OpenAI Responses) ─────────────────────────────────────────────

function injectResponses(payload, segment) {
  if (typeof payload.instructions === 'string') {
    if (payload.instructions.includes(segment)) return result(payload, false, 'already-injected')
    payload.instructions = payload.instructions ? `${payload.instructions}${SEP}${segment}` : segment
    return result(payload, true, 'injected')
  }
  if (!Array.isArray(payload.input)) return result(payload, false, 'shape-not-recognised')
  let target
  for (const item of payload.input) {
    if (!isResponsesSystem(item)) continue
    if (contentHasSegment(item.content, segment)) return result(payload, false, 'already-injected')
    target ??= item
  }
  const block = { type: 'input_text', text: segment }
  if (!target) payload.input.unshift({ type: 'message', role: 'system', content: [block] })
  else if (Array.isArray(target.content)) target.content.push(block)
  else if (typeof target.content === 'string') target.content = target.content ? `${target.content}${SEP}${segment}` : segment
  else target.content = [block]
  return result(payload, true, 'injected')
}

function stripResponses(payload) {
  let stripped = typeof payload.instructions === 'string' && stripContent(payload, 'instructions')
  if (stripped && payload.instructions === '') delete payload.instructions
  if (Array.isArray(payload.input)) stripped = stripRows(payload.input, isResponsesSystem) || stripped
  const reason = stripped ? 'stripped' : typeof payload.instructions !== 'string' && !Array.isArray(payload.input)
    ? 'shape-not-recognised' : 'not-injected'
  return { payload, stripped, reason }
}
