/**
 * The token saver's prompt families and the system-prompt injector.
 *
 * The two modules under test sit between the user's turn and the provider: the
 * prompts change how the model answers, and the injector edits the request body
 * that carries them. Both are checked against the failure modes that would
 * reach a user as a wrong answer or a broken request:
 *
 * - every level returns the exact upstream text — a distinctive substring *and*
 *   the full length are asserted, so a silent truncation or a well-meaning
 *   paraphrase fails here instead of shipping;
 * - `off` returns null, and `activePrompts` composes exactly the active
 *   families;
 * - injection lands in the right place on each of the three wires this plugin
 *   builds (`chat`, `messages`, `responses`), including Anthropic's
 *   string-vs-block `system` and Responses' `instructions`;
 * - a second injection is a no-op, and two different prompts coexist;
 * - `stripInjected` restores the body byte-for-byte, which is what lets the
 *   off switch be honest;
 * - Anthropic's cache breakpoint keeps terminating the block list — the
 *   injected block lands before the last `cache_control`, never after it;
 * - the sealed lane's pacing hint and an injected prompt survive each other;
 * - an unknown wire or a body missing its target field changes nothing and
 *   reports `shape-not-recognised`.
 *
 * No network, no host: every body is a literal.
 *
 * Run: node scripts/prompt-saver-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CAVEMAN_LEVELS, PONYTAIL_LEVELS, activePrompts, cavemanPrompt, ponytailPrompt } from '../src/token-saver/prompts.js'
import { INJECT_MARKER, hasInjected, injectSystem, stripInjected } from '../src/token-saver/inject.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

/** How many times `needle` occurs in `haystack`. */
const occurrences = (haystack, needle) => haystack.split(needle).length - 1

/**
 * The marked segment the injector writes, as documented on `INJECT_MARKER`.
 * Pinned here rather than imported so a change to the layout fails the test
 * instead of silently redefining what "already injected" means.
 */
const segment = text => `${INJECT_MARKER}\n\n${text}\n\n<!-- /ofm-token-saver -->`

/** The two prompts used across the injector checks. */
const CAVEMAN = cavemanPrompt('full')
const PONYTAIL = ponytailPrompt('ultra')

// ── the prompt families ──────────────────────────────────────────────────────
// Expected total lengths, measured against the upstream sources
// (open-sse/rtk/cavemanPrompts.js, open-sse/rtk/ponytailPrompt.js). A length
// check is what catches a silent truncation; the substrings below catch an
// edit that keeps the size but changes the wording.

const CAVEMAN_LENGTHS = { lite: 1736, full: 1834, ultra: 1678, 'wenyan-lite': 1704, wenyan: 1795, 'wenyan-ultra': 1705 }
const PONYTAIL_LENGTHS = { lite: 1560, full: 1566, ultra: 1610 }

/** Each level's opening instruction — the one line its intensifier changes. */
const CAVEMAN_MARKERS = {
  lite: 'Respond tersely. Keep grammar and full sentences but drop filler, hedging and pleasantries',
  full: 'Respond like terse caveman. All technical substance stay exact, only fluff die.',
  ultra: 'Respond ultra-terse. Maximum compression. Telegraphic.',
  'wenyan-lite': 'Respond semi-classical. Drop filler/hedging but keep grammar structure, classical register.',
  wenyan: 'Respond classical Chinese (文言文). Maximum classical terseness. 80-90% character reduction.',
  'wenyan-ultra': 'Respond extreme classical compression (文言文 ultra). Maximum compression, ultra terse.',
}
const PONYTAIL_MARKERS = {
  lite: "Lite: build what's asked, but name the lazier alternative in one line. User picks.",
  full: 'Full: the ladder enforced. Stdlib and native first. Shortest diff, shortest explanation.',
  ultra: 'Ultra: YAGNI extremist. Deletion before addition.',
}

/** Boundaries every level of a family must keep, whatever the intensifier. */
const CAVEMAN_BOUNDARIES = [
  'Code blocks, file paths, commands, errors, URLs: keep exact.',
  'Security warnings, irreversible action confirmations, multi-step ordered sequences: write normal.',
  'Auto-Clarity: drop caveman for security warnings, irreversible actions',
  "Preserve the user's dominant language.",
  'Wenyan/classical-Chinese levels override this language-preservation rule.',
  'No invented abbreviations.',
  'No self-reference. Do not name or announce the style',
  'No decorative emoji.',
  'ACTIVE EVERY RESPONSE.',
]
const PONYTAIL_BOUNDARIES = [
  'You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.',
  '1) Does this need to exist at all? (YAGNI)',
  'Never simplify away: input validation at trust boundaries',
  'ACTIVE EVERY RESPONSE.',
]

check('every caveman level returns the exact upstream text', () => {
  for (const level of CAVEMAN_LEVELS) {
    if (level === 'off') {
      assert.equal(cavemanPrompt(level), null, 'off must not carry a prompt')
      continue
    }
    const text = cavemanPrompt(level)
    assert.equal(typeof text, 'string', `${level} must resolve to text`)
    assert.equal(text.length, CAVEMAN_LENGTHS[level],
      `${level} length changed — the prompt was edited or truncated`)
    assert.ok(text.includes(CAVEMAN_MARKERS[level]), `${level} lost its opening instruction`)
    for (const boundary of CAVEMAN_BOUNDARIES) {
      assert.ok(text.includes(boundary), `${level} lost a shared boundary: ${boundary}`)
    }
    assert.ok(!text.includes('\n'), `${level} must stay a single line — the injector appends it as one segment`)
  }
})

check('every ponytail level returns the exact upstream text', () => {
  for (const level of PONYTAIL_LEVELS) {
    if (level === 'off') {
      assert.equal(ponytailPrompt(level), null, 'off must not carry a prompt')
      continue
    }
    const text = ponytailPrompt(level)
    assert.equal(typeof text, 'string', `${level} must resolve to text`)
    assert.equal(text.length, PONYTAIL_LENGTHS[level],
      `${level} length changed — the prompt was edited or truncated`)
    assert.ok(text.includes(PONYTAIL_MARKERS[level]), `${level} lost its opening instruction`)
    for (const boundary of PONYTAIL_BOUNDARIES) {
      assert.ok(text.includes(boundary), `${level} lost a shared boundary: ${boundary}`)
    }
    assert.ok(!text.includes('\n'), `${level} must stay a single line`)
  }
})

check('a level outside the menu resolves to null, not to undefined text', () => {
  assert.equal(cavemanPrompt('bogus'), null)
  assert.equal(cavemanPrompt(undefined), null)
  assert.equal(cavemanPrompt(42), null)
  assert.equal(cavemanPrompt('wenyan-full'), null, 'the source names it wenyan, not wenyan-full')
  assert.equal(ponytailPrompt('wenyan'), null, 'wenyan is caveman-only')
  assert.ok(cavemanPrompt('wenyan-lite') !== null, 'hyphenated levels must stay addressable')
})

check('activePrompts composes the active families in injection order', () => {
  const active = activePrompts({ caveman: 'lite', ponytail: 'ultra' })
  assert.deepEqual(active.map(entry => [entry.id, entry.level]), [['caveman', 'lite'], ['ponytail', 'ultra']])
  assert.equal(active[0].text, cavemanPrompt('lite'))
  assert.equal(active[1].text, ponytailPrompt('ultra'))
})

check('activePrompts is empty when nothing is switched on', () => {
  assert.deepEqual(activePrompts({}), [])
  assert.deepEqual(activePrompts(), [])
  assert.deepEqual(activePrompts({ caveman: 'off', ponytail: 'off' }), [])
  assert.deepEqual(activePrompts({ caveman: 'off', ponytail: 'full' }).map(entry => entry.id), ['ponytail'])
  assert.deepEqual(activePrompts({ caveman: 'nonsense' }), [], 'an unknown level must contribute nothing')
})

// ── injection, wire by wire ──────────────────────────────────────────────────

check('chat: a body with no system message gains one at index 0', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }
  const out = injectSystem(body, 'chat', CAVEMAN)
  assert.equal(out.payload, body, 'the payload is mutated in place')
  assert.equal(out.injected, true)
  assert.equal(out.reason, 'injected')
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, segment(CAVEMAN))
})

check('chat: an existing system string is appended to, not replaced', () => {
  const body = { messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }] }
  injectSystem(body, 'chat', CAVEMAN)
  assert.equal(body.messages.length, 2, 'no second system message may be added')
  assert.equal(body.messages[0].content, `You are helpful.\n\n${segment(CAVEMAN)}`)
})

check('chat: block content receives the prompt as a text block', () => {
  const body = { messages: [{ role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] }, { role: 'user', content: 'hi' }] }
  injectSystem(body, 'chat', CAVEMAN)
  assert.equal(body.messages[0].content.length, 2)
  assert.deepEqual(body.messages[0].content[1], { type: 'text', text: segment(CAVEMAN) })
})

check('messages: a string system gains the prompt as its own segment', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], system: 'Be careful.', stream: true }
  injectSystem(body, 'messages', CAVEMAN)
  assert.equal(body.system, `Be careful.\n\n${segment(CAVEMAN)}`)
})

check('messages: a block system gains a new block', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], system: [{ type: 'text', text: 'Be careful.' }] }
  injectSystem(body, 'messages', CAVEMAN)
  assert.equal(body.system.length, 2)
  assert.deepEqual(body.system[1], { type: 'text', text: segment(CAVEMAN) })
})

check('messages: an absent system field is filled with the segment', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }
  injectSystem(body, 'messages', CAVEMAN)
  assert.equal(body.system, segment(CAVEMAN))
})

check('responses: instructions takes the prompt when present', () => {
  const body = {
    model: 'm',
    instructions: 'be brief',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  }
  injectSystem(body, 'responses', CAVEMAN)
  assert.equal(body.instructions, `be brief\n\n${segment(CAVEMAN)}`)
  assert.equal(body.input.length, 1, 'input must not gain an item while instructions exist')
})

check('responses: an existing system item is appended to', () => {
  const body = { input: [
    { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'be brief' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ] }
  injectSystem(body, 'responses', CAVEMAN)
  assert.equal(body.input.length, 2, 'no second system item may be added')
  assert.equal(body.input[0].content.length, 2)
  assert.deepEqual(body.input[0].content[1], { type: 'input_text', text: segment(CAVEMAN) })
})

check('responses: a body with no system item gains one at index 0', () => {
  const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }
  injectSystem(body, 'responses', CAVEMAN)
  assert.equal(body.input.length, 2)
  assert.deepEqual(body.input[0], { type: 'message', role: 'system', content: [{ type: 'input_text', text: segment(CAVEMAN) }] })
})

// ── idempotency and coexistence ──────────────────────────────────────────────

check('injecting the same prompt twice does not duplicate it', () => {
  const cases = [
    ['chat', { messages: [{ role: 'user', content: 'hi' }] }, body => body.messages[0].content],
    ['messages', { messages: [{ role: 'user', content: 'hi' }], system: 'Be careful.' }, body => body.system],
    ['responses', { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, body => body.input[0].content[0].text],
  ]
  for (const [wire, body, read] of cases) {
    const first = injectSystem(body, wire, CAVEMAN)
    const second = injectSystem(body, wire, CAVEMAN)
    assert.equal(first.injected, true, `${wire}: the first injection must land`)
    assert.equal(second.injected, false, `${wire}: the second injection must be a no-op`)
    assert.equal(second.reason, 'already-injected')
    assert.equal(occurrences(read(body), CAVEMAN), 1, `${wire}: the text must appear once`)
    assert.equal(occurrences(read(body), INJECT_MARKER), 1, `${wire}: one region, not two`)
  }
})

check('two different prompts coexist in one body', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] }
  injectSystem(body, 'chat', CAVEMAN)
  injectSystem(body, 'chat', PONYTAIL)
  const content = body.messages[0].content
  assert.equal(occurrences(content, CAVEMAN), 1)
  assert.equal(occurrences(content, PONYTAIL), 1)
  assert.equal(occurrences(content, INJECT_MARKER), 2)
  // Re-injecting either one is still a no-op.
  assert.equal(injectSystem(body, 'chat', CAVEMAN).injected, false)
  assert.equal(occurrences(content, CAVEMAN), 1)
  assert.equal(occurrences(content, PONYTAIL), 1)
})

// ── round trip ───────────────────────────────────────────────────────────────

/** Bodies whose exact JSON must survive inject + strip, one per shape. */
const ROUND_TRIP = [
  ['chat', () => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true })],
  ['chat', () => ({ messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }] })],
  ['chat', () => ({ messages: [{ role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] }, { role: 'user', content: 'hi' }] })],
  ['messages', () => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], system: 'Be careful.', stream: true })],
  ['messages', () => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true })],
  ['messages', () => ({
    model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true,
    system: [{ type: 'text', text: 'Be careful.' }, { type: 'text', text: 'More.', cache_control: { type: 'ephemeral' } }],
  })],
  ['responses', () => ({ model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] })],
  ['responses', () => ({
    model: 'm', instructions: 'be brief',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  })],
  ['responses', () => ({ model: 'm', input: [
    { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'be brief' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ] })],
]

check('stripInjected restores every body byte-for-byte', () => {
  for (const [wire, make] of ROUND_TRIP) {
    const body = make()
    const before = JSON.parse(JSON.stringify(body))
    injectSystem(body, wire, CAVEMAN)
    assert.equal(hasInjected(body, wire), true, `${wire}: the body must look injected after inject`)
    const out = stripInjected(body, wire)
    assert.equal(out.payload, body, `${wire}: strip mutates in place`)
    assert.equal(out.stripped, true, `${wire}: strip must report the removal`)
    assert.equal(hasInjected(body, wire), false, `${wire}: no region may survive the strip`)
    assert.deepEqual(body, before, `${wire}: strip must restore the exact body`)
  }
})

check('stripInjected removes every injected prompt at once', () => {
  const body = { messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }] }
  const before = JSON.parse(JSON.stringify(body))
  injectSystem(body, 'chat', CAVEMAN)
  injectSystem(body, 'chat', PONYTAIL)
  stripInjected(body, 'chat')
  assert.deepEqual(body, before)
})

// ── the Anthropic cache breakpoint ───────────────────────────────────────────

check('the injected block lands before the last cache_control breakpoint', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], system: [
    { type: 'text', text: 'stable prefix' },
    { type: 'text', text: 'cached tail', cache_control: { type: 'ephemeral' } },
  ] }
  injectSystem(body, 'messages', CAVEMAN)
  assert.equal(body.system.length, 3)
  assert.equal(body.system[1].text, segment(CAVEMAN), 'the new block goes before the breakpoint')
  assert.deepEqual(body.system.at(-1).cache_control, { type: 'ephemeral' }, 'the cache marker still terminates the array')
})

check('with no breakpoint the injected block is appended last', () => {
  const body = { messages: [], system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }
  injectSystem(body, 'messages', CAVEMAN)
  assert.equal(body.system.at(-1).text, segment(CAVEMAN))
})

check('the last of several breakpoints is the anchor', () => {
  const body = { messages: [], system: [
    { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'b' },
    { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
  ] }
  injectSystem(body, 'messages', CAVEMAN)
  assert.deepEqual(body.system.map(block => block.text), ['a', 'b', segment(CAVEMAN), 'c'])
})

// ── composition with the sealed lane ─────────────────────────────────────────
// `applySealedPacingHint` is private to src/adapter.js, so the test replicates
// the one mutation it makes (append to the system message, or add one). The
// hint text is pinned to the source so the replica cannot drift silently.

const PACING_HINT = 'Avoid overthinking: keep your reasoning brief and proportionate to the task.'

check('the adapter still carries the pacing hint this composition test replicates', () => {
  const source = fs.readFileSync(new URL('../src/adapter.js', import.meta.url), 'utf8')
  assert.ok(source.includes(PACING_HINT), 'src/adapter.js no longer carries the sealed-lane pacing hint')
})

check('a prompt injected after the pacing hint leaves both texts intact', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }
  // What applySealedPacingHint does when the body has no system message yet.
  body.messages.unshift({ role: 'system', content: PACING_HINT })
  const hinted = JSON.parse(JSON.stringify(body))
  injectSystem(body, 'chat', CAVEMAN)
  injectSystem(body, 'chat', PONYTAIL)
  const content = body.messages[0].content
  assert.ok(content.startsWith(PACING_HINT), 'the hint keeps the position it was appended at')
  assert.equal(occurrences(content, PACING_HINT), 1, 'the hint must survive, exactly once')
  assert.equal(occurrences(content, CAVEMAN), 1)
  assert.equal(occurrences(content, PONYTAIL), 1)
  injectSystem(body, 'chat', CAVEMAN)
  assert.equal(occurrences(content, CAVEMAN), 1, 'a re-injection must not duplicate anything')
  // The off switch returns the hinted body exactly — the hint is not ours to remove.
  stripInjected(body, 'chat')
  assert.deepEqual(body, hinted)
})

check('a hint appended after an injection is preserved by the off switch', () => {
  const body = { messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }] }
  injectSystem(body, 'chat', CAVEMAN)
  // What applySealedPacingHint does when a system message already exists.
  body.messages[0].content = `${body.messages[0].content}\n\n${PACING_HINT}`
  stripInjected(body, 'chat')
  assert.equal(body.messages[0].content, `You are helpful.\n\n${PACING_HINT}`)
})

// ── fail-open ────────────────────────────────────────────────────────────────

check('an unknown wire changes nothing and reports the reason', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] }
  const before = JSON.parse(JSON.stringify(body))
  for (const wire of ['kiro', 'gemini', 'CHAT', '', undefined, null]) {
    const out = injectSystem(body, wire, CAVEMAN)
    assert.equal(out.payload, body)
    assert.equal(out.injected, false, `wire ${String(wire)} must not inject`)
    assert.equal(out.reason, 'shape-not-recognised')
    assert.deepEqual(body, before)
  }
})

check('a body missing its target field changes nothing', () => {
  const cases = [
    ['chat', {}],
    ['chat', { messages: 'not a list' }],
    ['messages', {}],
    ['messages', { system: 'Be careful.' }], // a Messages body is identified by its messages list
    ['responses', {}],
    ['responses', { input: 'a bare string' }],
    ['responses', { instructions: 42, input: 'a bare string' }],
  ]
  for (const [wire, body] of cases) {
    const before = JSON.parse(JSON.stringify(body))
    const out = injectSystem(body, wire, CAVEMAN)
    assert.equal(out.injected, false, `${wire}: ${JSON.stringify(body)} must not be injected`)
    assert.equal(out.reason, 'shape-not-recognised')
    assert.deepEqual(body, before)
  }
})

check('a non-object payload and a missing text are refused without a throw', () => {
  assert.deepEqual(injectSystem(null, 'chat', CAVEMAN), { payload: null, injected: false, reason: 'shape-not-recognised' })
  assert.equal(injectSystem({}, 'chat', '').reason, 'no-text')
  assert.equal(injectSystem({}, 'chat', undefined).reason, 'no-text')
  assert.equal(injectSystem({}, 'chat', 42).reason, 'no-text')
})

check('strip on a body that was never injected is a no-op', () => {
  for (const [wire, body] of ROUND_TRIP.map(([wire, make]) => [wire, make()])) {
    const before = JSON.parse(JSON.stringify(body))
    const out = stripInjected(body, wire)
    assert.equal(out.payload, body)
    assert.equal(out.stripped, false, `${wire}: nothing was injected, nothing may be stripped`)
    assert.equal(out.reason, 'not-injected')
    assert.deepEqual(body, before)
  }
  assert.equal(stripInjected({ messages: [] }, 'kiro').reason, 'shape-not-recognised')
  assert.equal(stripInjected(null, 'chat').reason, 'shape-not-recognised')
})

check('a lone marker is left alone rather than cut to a guess', () => {
  const body = { messages: [{ role: 'system', content: `You are helpful. ${INJECT_MARKER} not ours` }, { role: 'user', content: 'hi' }] }
  const before = JSON.parse(JSON.stringify(body))
  assert.equal(hasInjected(body, 'chat'), false, 'an unterminated marker is not a region')
  assert.equal(stripInjected(body, 'chat').stripped, false)
  assert.deepEqual(body, before)
})

check('hasInjected reports each wire and shape', () => {
  assert.equal(hasInjected(null, 'chat'), false)
  assert.equal(hasInjected({}, 'messages'), false)
  assert.equal(hasInjected({ messages: [] }, 'kiro'), false)
  const chat = { messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(hasInjected(chat, 'chat'), false)
  injectSystem(chat, 'chat', CAVEMAN)
  assert.equal(hasInjected(chat, 'chat'), true)
  const messages = { messages: [], system: [{ type: 'text', text: 'a' }] }
  assert.equal(hasInjected(messages, 'messages'), false)
  injectSystem(messages, 'messages', CAVEMAN)
  assert.equal(hasInjected(messages, 'messages'), true)
  const responses = { input: [] }
  assert.equal(hasInjected(responses, 'responses'), false)
  injectSystem(responses, 'responses', CAVEMAN)
  assert.equal(hasInjected(responses, 'responses'), true)
})

if (failures > 0) console.error(`prompt-saver-test: ${failures} failure(s)`)
else console.log('prompt-saver-test: the prompt families are verbatim and the injector is reversible')
process.exitCode = failures > 0 ? 1 : 0
