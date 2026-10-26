/**
 * Offline tests for the five local optimizations (src/local-optimize.js).
 *
 * Each optimization is a request shape Claude Code sends whose answer is
 * already in the body; the suite pins both directions of every detector — the
 * request that must be answered locally, and the near-miss that must be left
 * for the provider — plus the command parsing the prefix and filepath mocks
 * are built on, the injection refusal, and the response wrapper.
 *
 * The requests below are shaped the way the harness sends them: Anthropic
 * Messages bodies with a system block list, content blocks, and a tool list
 * exactly where Claude Code includes one.
 *
 * Run: node scripts/local-optimize-test.mjs
 */
import assert from 'node:assert/strict'
import {
  OPTIMIZATIONS,
  detectOptimization,
  extractCommandPrefix,
  extractFilepathsFromCommand,
  toMessagesResponse,
  tryOptimizations,
} from '../src/local-optimize.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

/** A body shaped like the ones Claude Code sends to the Messages endpoint. */
const claudeRequest = (overrides = {}) => ({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 8192,
  system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: 'user', content: 'Fix the failing test in src/forward.js' }],
  ...overrides,
})

const READ_TOOL = { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }

// ── the exported surface ─────────────────────────────────────────────────────
check('OPTIMIZATIONS is the evaluation order', () => {
  assert.deepEqual(OPTIMIZATIONS, ['quota', 'prefix', 'title', 'suggestion', 'filepath'])
})

// ── quota probe ──────────────────────────────────────────────────────────────
const quotaRequest = claudeRequest({ max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] })

check('a max_tokens=1 probe that says quota is answered locally', () => {
  assert.deepEqual(tryOptimizations(quotaRequest), {
    kind: 'quota',
    text: 'Quota check passed.',
    usage: { input: 10, output: 5 },
    model: 'claude-sonnet-4-5-20250929',
  })
})

check('the quota word is matched case-insensitively', () => {
  const request = claudeRequest({ max_tokens: 1, messages: [{ role: 'user', content: 'Check the QUOTA for this session' }] })
  assert.equal(tryOptimizations(request)?.kind, 'quota')
})

check('a real turn is not a quota probe even when it mentions quota', () => {
  assert.equal(tryOptimizations(claudeRequest({ messages: [{ role: 'user', content: 'we hit the quota, add a retry' }] })), null)
  assert.equal(tryOptimizations(claudeRequest({ max_tokens: 1024, messages: [{ role: 'user', content: 'quota' }] })), null)
})

check('a quota probe with a second user turn is forwarded', () => {
  const request = claudeRequest({
    max_tokens: 1,
    messages: [{ role: 'user', content: 'quota' }, { role: 'user', content: 'and another thing' }],
  })
  assert.equal(tryOptimizations(request), null)
})

// ── fast prefix detection ────────────────────────────────────────────────────
const PREFIX_CONTENT = `<policy_spec>
The following commands may run without asking:
  Bash(git status:*)
  Bash(git diff:*)
</policy_spec>

<transcript>
user: what changed?
</transcript>

Command: git status --short
`
const prefixRequest = claudeRequest({ messages: [{ role: 'user', content: PREFIX_CONTENT }] })

check('a policy spec with a Command section answers the command prefix', () => {
  assert.deepEqual(tryOptimizations(prefixRequest), {
    kind: 'prefix',
    text: 'git status',
    usage: { input: 100, output: 5 },
    model: 'claude-sonnet-4-5-20250929',
  })
})

check('the last Command: marker wins, so a quoted one in the policy spec is skipped', () => {
  const request = claudeRequest({
    messages: [{ role: 'user', content: '<policy_spec>\nExample line: Command: rm -rf /\n</policy_spec>\n\nCommand: npm test\n' }],
  })
  assert.equal(tryOptimizations(request)?.text, 'npm test')
})

check('a command line without a policy spec is forwarded', () => {
  assert.equal(tryOptimizations(claudeRequest({ messages: [{ role: 'user', content: 'Command: git status' }] })), null)
  assert.equal(tryOptimizations(claudeRequest({ messages: [{ role: 'user', content: '<policy_spec>nothing else</policy_spec>' }] })), null)
})

check('a prefix request with two user turns is forwarded', () => {
  const request = claudeRequest({
    messages: [{ role: 'user', content: PREFIX_CONTENT }, { role: 'user', content: 'one more' }],
  })
  assert.equal(tryOptimizations(request), null)
})

check('a substituted command reports the injection instead of a prefix', () => {
  for (const command of ['echo $(id)', 'echo `id`', 'git status $(rm -rf /)']) {
    const request = claudeRequest({ messages: [{ role: 'user', content: `<policy_spec>\n</policy_spec>\n\nCommand: ${command}\n` }] })
    assert.equal(tryOptimizations(request)?.text, 'command_injection_detected', command)
  }
})

// ── title generation skip ────────────────────────────────────────────────────
const TITLE_SYSTEM = 'Generate a concise, sentence-case title (3-7 words) that captures the main topic of this coding session or conversation. Return JSON with a single "title" field.'

check('a sentence-case title prompt is answered with a canned title', () => {
  const request = claudeRequest({
    system: [{ type: 'text', text: TITLE_SYSTEM }],
    messages: [{ role: 'user', content: 'user: fix the failing test\nassistant: looking into it' }],
  })
  assert.deepEqual(tryOptimizations(request), {
    kind: 'title',
    text: 'Conversation',
    usage: { input: 100, output: 5 },
    model: 'claude-sonnet-4-5-20250929',
  })
})

check('the JSON title-field prompt is recognised too', () => {
  const request = claudeRequest({
    system: 'Read the transcript and return JSON with a single "title" field describing what happened in this session.',
    messages: [{ role: 'user', content: 'transcript follows' }],
  })
  assert.equal(tryOptimizations(request)?.kind, 'title')
})

check('a title prompt that declares tools is never skipped', () => {
  const request = claudeRequest({
    system: [{ type: 'text', text: TITLE_SYSTEM }],
    tools: [READ_TOOL],
  })
  assert.equal(tryOptimizations(request), null)
})

check('title text without either prompt shape is forwarded', () => {
  const noBranch = claudeRequest({ system: 'Do not invent a title for the file; return JSON with a field.' })
  assert.equal(tryOptimizations(noBranch), null)
  const noTitle = claudeRequest({ system: 'Return JSON with a single "title" field about this session.'.replace('"title"', '"label"') })
  assert.equal(tryOptimizations(noTitle), null)
})

check('the title detector reads the system text, not the turn count', () => {
  // Carried over from the Python gateway: only the no-tools rule constrains the
  // request, so a title prompt with several turns is still answered locally.
  const request = claudeRequest({
    system: TITLE_SYSTEM,
    messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
  })
  assert.equal(tryOptimizations(request)?.kind, 'title')
})

// ── suggestion mode skip ─────────────────────────────────────────────────────
check('a suggestion-mode turn is answered with nothing', () => {
  const request = claudeRequest({
    messages: [{
      role: 'user',
      content: 'The user is typing a new message. Predict the next thing they will type.\n\n[SUGGESTION MODE: suggest the next keystrokes]\n\ntranscript: ...',
    }],
  })
  assert.deepEqual(tryOptimizations(request), {
    kind: 'suggestion',
    text: '',
    usage: { input: 100, output: 1 },
    model: 'claude-sonnet-4-5-20250929',
  })
})

check('the suggestion marker is found in any user turn', () => {
  const request = claudeRequest({
    messages: [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: '[SUGGESTION MODE: continue]' },
    ],
  })
  assert.equal(tryOptimizations(request)?.kind, 'suggestion')
})

check('a turn without the suggestion marker is forwarded', () => {
  assert.equal(tryOptimizations(claudeRequest({ messages: [{ role: 'user', content: 'SUGGESTION MODE without the bracket' }] })), null)
})

// ── filepath extraction mock ─────────────────────────────────────────────────
const FILEPATH_INSTRUCTION = 'Extract any file paths that this command reads or writes, one per line, in a <filepaths> block.'

check('a Command/Output pair naming filepaths answers with the block', () => {
  const request = claudeRequest({
    messages: [{
      role: 'user',
      content: `${FILEPATH_INSTRUCTION}\n\nCommand: cat src/local-optimize.js\nOutput: /**\n * The five requests Claude Code asks.\n */\nexport const OPTIMIZATIONS = ['quota']`,
    }],
  })
  assert.deepEqual(tryOptimizations(request), {
    kind: 'filepath',
    text: '<filepaths>\nsrc/local-optimize.js\n</filepaths>',
    usage: { input: 100, output: 10 },
    model: 'claude-sonnet-4-5-20250929',
  })
})

check('a system prompt asking for paths triggers the mock without the word in the turn', () => {
  const request = claudeRequest({
    system: 'Extract any file paths that this command reads or writes, then answer.',
    messages: [{ role: 'user', content: 'Command: head -20 src/forward.js\nOutput: import http from ...' }],
  })
  assert.equal(tryOptimizations(request)?.text, '<filepaths>\nsrc/forward.js\n</filepaths>')
})

check('a listing command extracts no paths, and the mock still answers', () => {
  // The Python detector matches the request shape, not the command: the answer
  // is an empty block, which is still cheaper than a provider round trip.
  const request = claudeRequest({
    messages: [{ role: 'user', content: `${FILEPATH_INSTRUCTION}\n\nCommand: ls -la\nOutput: total 0\ndrwxr-xr-x 1 user 0 Jan 1 00:00 src` }],
  })
  assert.deepEqual(tryOptimizations(request), {
    kind: 'filepath',
    text: '<filepaths>\n</filepaths>',
    usage: { input: 100, output: 10 },
    model: 'claude-sonnet-4-5-20250929',
  })
})

check('a filepath ask without an Output section is forwarded', () => {
  const request = claudeRequest({
    messages: [{ role: 'user', content: `${FILEPATH_INSTRUCTION}\n\nCommand: cat src/forward.js` }],
  })
  assert.equal(tryOptimizations(request), null)
})

check('a filepath ask that declares tools is never mocked', () => {
  const request = claudeRequest({
    tools: [READ_TOOL],
    messages: [{ role: 'user', content: `${FILEPATH_INSTRUCTION}\n\nCommand: cat src/forward.js\nOutput: body` }],
  })
  assert.equal(tryOptimizations(request), null)
})

check('a Command/Output pair with no filepaths hint anywhere is forwarded', () => {
  const request = claudeRequest({
    system: 'Summarise the command output.',
    messages: [{ role: 'user', content: 'Command: cat src/forward.js\nOutput: body' }],
  })
  assert.equal(tryOptimizations(request), null)
})

// ── order, detection and disabling ───────────────────────────────────────────
const overlapRequest = claudeRequest({
  max_tokens: 1,
  messages: [{ role: 'user', content: '<policy_spec>\nquota\n</policy_spec>\n\nCommand: git status\n' }],
})

check('the first matching optimization in order wins', () => {
  assert.equal(tryOptimizations(overlapRequest)?.kind, 'quota')
  assert.equal(tryOptimizations(overlapRequest, { enabled: { quota: false } })?.kind, 'prefix')
  assert.equal(tryOptimizations(overlapRequest, { enabled: { quota: false } })?.text, 'git status')
})

check('detectOptimization names the same optimization as tryOptimizations', () => {
  assert.equal(detectOptimization(overlapRequest), 'quota')
  assert.equal(detectOptimization(prefixRequest), 'prefix')
  assert.equal(detectOptimization(claudeRequest()), null)
  assert.equal(detectOptimization(overlapRequest, { quota: false }), 'prefix')
})

check('disabling one optimization lets its request through', () => {
  const cases = [
    ['quota', quotaRequest],
    ['prefix', prefixRequest],
    ['title', claudeRequest({ system: TITLE_SYSTEM })],
    ['suggestion', claudeRequest({ messages: [{ role: 'user', content: '[SUGGESTION MODE: go]' }] })],
    ['filepath', claudeRequest({ messages: [{ role: 'user', content: `${FILEPATH_INSTRUCTION}\n\nCommand: cat a.js\nOutput: body` }] })],
  ]
  for (const [kind, request] of cases) {
    assert.equal(tryOptimizations(request)?.kind, kind, `${kind} must fire when enabled`)
    assert.equal(tryOptimizations(request, { enabled: { [kind]: false } }), null, `${kind} must not fire when disabled`)
    assert.equal(detectOptimization(request, { [kind]: false }), null, `${kind} detection must respect the switch`)
  }
})

check('a normal coding request is forwarded untouched', () => {
  const request = claudeRequest({
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    messages: [
      { role: 'user', content: 'Fix the failing test in src/local-optimize.js' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/local-optimize.js' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'the file body' }] },
    ],
    tools: [READ_TOOL],
  })
  assert.equal(tryOptimizations(request), null)
  assert.equal(detectOptimization(request), null)
})

check('every optimization can be switched off at once', () => {
  const enabled = { quota: false, prefix: false, title: false, suggestion: false, filepath: false }
  assert.equal(tryOptimizations(quotaRequest, { enabled }), null)
  assert.equal(tryOptimizations(prefixRequest, { enabled }), null)
  assert.equal(tryOptimizations(overlapRequest, { enabled }), null)
})

check('the answer is attributed to the caller model when one is given', () => {
  assert.equal(tryOptimizations(quotaRequest, { model: 'deepseek-ai/deepseek-v4.1-flash' })?.model, 'deepseek-ai/deepseek-v4.1-flash')
  assert.equal(tryOptimizations(quotaRequest)?.model, 'claude-sonnet-4-5-20250929')
})

// ── extractCommandPrefix ─────────────────────────────────────────────────────
check('the two-word commands keep their operation', () => {
  const cases = [
    ['git status', 'git status'],
    ['npm install', 'npm install'],
    ['docker compose up -d', 'docker compose'],
    ['kubectl get pods', 'kubectl get'],
    ['cargo build --release', 'cargo build'],
    ['go test ./...', 'go test'],
    ['pip install -r requirements.txt', 'pip install'],
    ['yarn add lodash', 'yarn add'],
  ]
  for (const [command, expected] of cases) {
    assert.equal(extractCommandPrefix(command), expected, command)
  }
})

check('a flag in the second word leaves a one-word prefix', () => {
  assert.equal(extractCommandPrefix('git --version'), 'git')
  assert.equal(extractCommandPrefix('npm -v'), 'npm')
  assert.equal(extractCommandPrefix('docker'), 'docker')
})

check('single-word commands keep the first word, flags and all', () => {
  assert.equal(extractCommandPrefix('ls -la'), 'ls')
  assert.equal(extractCommandPrefix('pwd'), 'pwd')
  assert.equal(extractCommandPrefix('  tree   --depth 2  '), 'tree')
})

check('an empty or all-env command has no prefix', () => {
  assert.equal(extractCommandPrefix(''), 'none')
  assert.equal(extractCommandPrefix('   '), 'none')
  assert.equal(extractCommandPrefix('FOO=1'), 'none')
})

check('leading env assignments are recognised as such', () => {
  assert.equal(extractCommandPrefix('FOO=bar ls -la'), 'FOO=bar ls')
  assert.equal(extractCommandPrefix('BAR=1 BAZ=2 npm run build'), 'npm run')
})

check('substitutions never become a prefix', () => {
  assert.equal(extractCommandPrefix('echo $(id)'), 'command_injection_detected')
  assert.equal(extractCommandPrefix('echo `id`'), 'command_injection_detected')
  assert.equal(extractCommandPrefix('git status && echo $(date)'), 'command_injection_detected')
})

check('quoted words are unquoted before the prefix is chosen', () => {
  assert.equal(extractCommandPrefix('git commit -m "a message with spaces"'), 'git commit')
  assert.equal(extractCommandPrefix("cat 'my file.txt'"), 'cat')
})

check('a command the shell would refuse falls back to its first word', () => {
  assert.equal(extractCommandPrefix('cat "unclosed'), 'cat')
  assert.equal(extractCommandPrefix('cat foo\\'), 'cat')
})

check('the two-word table is case-sensitive, like the Python set', () => {
  assert.equal(extractCommandPrefix('Git status'), 'Git')
})

// ── extractFilepathsFromCommand ──────────────────────────────────────────────
const EMPTY = '<filepaths>\n</filepaths>'
const block = (...paths) => `<filepaths>\n${paths.join('\n')}\n</filepaths>`

check('reading commands contribute their non-flag arguments', () => {
  assert.equal(extractFilepathsFromCommand('cat src/index.js', ''), block('src/index.js'))
  assert.equal(extractFilepathsFromCommand('head -20 src/forward.js', ''), block('src/forward.js'))
  assert.equal(extractFilepathsFromCommand('tail -f /var/log/app.log', ''), block('/var/log/app.log'))
  assert.equal(extractFilepathsFromCommand('cat -n a.txt b.txt', ''), block('a.txt', 'b.txt'))
  assert.equal(extractFilepathsFromCommand('type C:\\notes\\todo.md', ''), block('C:\\notes\\todo.md'))
})

check('listing commands extract nothing', () => {
  for (const command of ['ls -la', 'dir /b', 'find . -name "*.js"', 'tree', 'pwd', 'cd src', 'mkdir build', 'rmdir empty', 'rm -rf node_modules']) {
    assert.equal(extractFilepathsFromCommand(command, ''), EMPTY, command)
  }
})

check('a reading command with no path argument extracts nothing', () => {
  assert.equal(extractFilepathsFromCommand('cat', ''), EMPTY)
  assert.equal(extractFilepathsFromCommand('cat -n', ''), EMPTY)
})

check('a command outside both tables extracts nothing', () => {
  assert.equal(extractFilepathsFromCommand('npm test', ''), EMPTY)
  // A wrapper hides the reader: the Python table has no `sudo`, so nothing is
  // extracted rather than the wrapped path being guessed at.
  assert.equal(extractFilepathsFromCommand('sudo cat /etc/hosts', ''), EMPTY)
})

check('an absolute path to a reader is recognised by its basename', () => {
  assert.equal(extractFilepathsFromCommand('/usr/bin/cat /etc/hosts', ''), block('/etc/hosts'))
})

check('leading env assignments are stripped before the command is read', () => {
  assert.equal(extractFilepathsFromCommand('FOO=bar cat x.txt', ''), block('x.txt'))
  assert.equal(extractFilepathsFromCommand('FOO=bar', ''), EMPTY)
})

check('quoted paths arrive unquoted', () => {
  assert.equal(extractFilepathsFromCommand('cat "my file.txt"', ''), block('my file.txt'))
})

check('grep skips the pattern and keeps the paths', () => {
  assert.equal(extractFilepathsFromCommand('grep -r TODO src/', ''), block('src/'))
  assert.equal(extractFilepathsFromCommand('grep -rn TODO src/ lib/', ''), block('src/', 'lib/'))
  assert.equal(extractFilepathsFromCommand('grep TODO', ''), EMPTY)
})

check('grep pattern flags are consumed, not treated as paths', () => {
  assert.equal(extractFilepathsFromCommand('grep -e TODO -r src/', ''), block('src/'))
  assert.equal(extractFilepathsFromCommand('grep --regexp TODO -n src/', ''), block('src/'))
  assert.equal(extractFilepathsFromCommand('grep --regexp=TODO -r src/', ''), block('src/'))
})

check('grep flags with arguments consume the argument, not the pattern', () => {
  assert.equal(extractFilepathsFromCommand('grep -A 2 TODO file.txt', ''), block('file.txt'))
  assert.equal(extractFilepathsFromCommand('grep -m 5 TODO file.txt other.txt', ''), block('file.txt', 'other.txt'))
})

check('an unbalanced quote leaves nothing to extract', () => {
  assert.equal(extractFilepathsFromCommand('cat "unclosed', ''), EMPTY)
})

// ── toMessagesResponse ───────────────────────────────────────────────────────
check('a local answer becomes a complete Messages response', () => {
  const response = toMessagesResponse(tryOptimizations(quotaRequest), { id: 'msg_test', model: 'claude-sonnet-4-5' })
  assert.deepEqual(response, {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'Quota check passed.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
})

check('the id is generated and the model falls back to the answer', () => {
  const response = toMessagesResponse(tryOptimizations(prefixRequest))
  assert.match(response.id, /^msg_[0-9a-f]{32}$/)
  assert.equal(response.model, 'claude-sonnet-4-5-20250929')
  assert.equal(response.content[0].text, 'git status')
})

check('an empty suggestion answer still carries a text block', () => {
  const suggestion = tryOptimizations(claudeRequest({ messages: [{ role: 'user', content: '[SUGGESTION MODE: go]' }] }))
  const response = toMessagesResponse(suggestion)
  assert.deepEqual(response.content, [{ type: 'text', text: '' }])
  assert.equal(response.usage.output_tokens, 1)
})

if (failures > 0) console.error(`local-optimize-test: ${failures} failure(s)`)
else console.log('local-optimize-test: the five local optimizations answer what they should, and only that')
process.exitCode = failures > 0 ? 1 : 0
