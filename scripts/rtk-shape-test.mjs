/**
 * Offline regression coverage for RTK shape safety (#280, #322, #389).
 * Grep cases adapted from PR #285 (9a6733313c45ed29850fcb8f452130b7cf63a513),
 * with whole-output, mixed-filename and source-indentation regressions.
 * No network, stores, credentials, or filesystem writes.
 * Run: node scripts/rtk-shape-test.mjs
 */
import assert from 'node:assert/strict'
import { compressRequest } from '../src/token-saver/rtk/index.js'
import { autoDetectFilter } from '../src/token-saver/rtk/autodetect.js'
import { grep } from '../src/token-saver/rtk/filters/grep.js'
import { DETECT_WINDOW, MIN_COMPRESS_SIZE } from '../src/token-saver/rtk/constants.js'

let failures = 0
let checks = 0
function check(name, fn) {
  checks++
  try { fn(); console.log('ok   ' + name) }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message) }
}
const wires = {
  chat: text => ({ messages: [{ role: 'tool', tool_call_id: 'x', content: text }] }),
  messages: text => ({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: text }] }] }),
  responses: text => ({ input: [{ type: 'function_call_output', call_id: 'x', output: text }] }),
}
function shipped(text, wire) {
  const payload = wires[wire](text)
  const result = compressRequest(payload, wire)
  const output = wire === 'chat' ? payload.messages[0].content
    : wire === 'messages' ? payload.messages[0].content[0].content : payload.input[0].output
  return { output, stats: result.stats }
}
const prose = 'Important webpage text must remain visible to the model. '.repeat(16)
const mixed = {
  'original timestamp': ['title: Welcome to Python.org', 'Python.org · en · charset provider-decoded · 2026-10-15T00:00:00+00:00', '', prose].join('\n'),
  'dotted host and port': ['title: service docs', 'api.example.com:8080: listening', '', prose].join('\n'),
  'source citation in prose': ['title: source tutorial', 'src/main.js:12: example()', '', prose].join('\n'),
  'mixed text must not reach dedup fallback': ['src/main.js:12: example()', ...Array(12).fill('Repeated but important prose'), prose].join('\n'),
  'prose beyond detection window': ['src/main.js:12: ' + 'x'.repeat(DETECT_WINDOW + 10), prose].join('\n'),
  'grep context separator': ['src/a.js:12: match', '--', prose].join('\n'),
}
for (const [name, text] of Object.entries(mixed)) {
  check(name + ': detector and direct filter preserve mixed text', () => {
    assert.ok(text.length > MIN_COMPRESS_SIZE)
    assert.equal(autoDetectFilter(text), null)
    assert.equal(grep(text), text)
  })
  for (const wire of Object.keys(wires)) check(name + ': ' + wire, () => {
    const { output, stats } = shipped(text, wire)
    assert.equal(output, text)
    assert.equal(stats.hits.length, 0)
    assert.equal(stats.saved, 0)
  })
}
const filenames = ['src/normal.js', 'src/my file.js', 'README', 'Makefile', 'C:\\project folder\\a.js', 'C:/project folder/b.js']
const search = filenames.flatMap(file => Array.from({ length: 6 }, (_, i) => file + ':' + (i + 1) + ': UNIQUE_' + i + ' ' + 'search content '.repeat(8))).join('\r\n') + '\r\n'
for (const wire of Object.keys(wires)) check('all mixed filenames and matches survive: ' + wire, () => {
  const { output, stats } = shipped(search, wire)
  assert.ok(stats.saved > 0)
  assert.ok(output.startsWith('36 matches in 6F:'))
  for (const file of filenames) assert.ok(output.includes('[file] ' + file + ' (6):'), file)
  for (let i = 0; i < 6; i++) assert.equal(output.split('UNIQUE_' + i).length - 1, 6)
})
check('drive-absolute search uses grep rather than find', () => {
  const text = Array.from({ length: 24 }, (_, i) => 'C:\\project\\a.js:' + (i + 1) + ': ' + 'match text '.repeat(8)).join('\n')
  assert.equal(autoDetectFilter(text).filterName, 'grep')
  const { output } = shipped(text, 'chat')
  assert.ok(output.startsWith('24 matches in 1F:'))
  assert.ok(output.includes('+14'))
})
check('colon-bearing match content survives', () => {
  const content = 'const url = "https://example.com:8080/path";'
  const output = grep('src/a.js:12:' + content)
  assert.ok(output.includes(content))
})
check('blank lines are accepted around genuine hits', () => {
  assert.ok(grep('\nsrc/a.js:12: match\n\n').startsWith('1 matches in 1F:'))
})
// Conservative detection intentionally leaves these standalone searches intact.
// They must not depend on a preceding ordinary filename to exercise the guard.
for (const file of ['README', 'my file.js']) {
  const text = Array.from({ length: 30 }, (_, i) => file + ':' + (i + 1) + ': MATCH ' + 'search content '.repeat(8)).join('\n')
  check('standalone conservative filename: ' + file + ': detector', () => {
    assert.ok(text.length > MIN_COMPRESS_SIZE)
    assert.equal(autoDetectFilter(text), null)
  })
  for (const wire of Object.keys(wires)) check('standalone conservative filename: ' + file + ': ' + wire, () => {
    const { output, stats } = shipped(text, wire)
    assert.equal(output, text)
    assert.equal(stats.saved, 0)
    assert.equal(stats.hits.length, 0)
  })
}
const longHit = file => file + ':12: MATCH ' + 'search content '.repeat(8)
check('fifth non-empty row at EOF is sampled without a final newline', () => {
  const text = [...Array(4).fill(longHit('README')), longHit('src/a.js')].join('\n')
  assert.equal(autoDetectFilter(text)?.filterName, 'grep')
})
const scanCases = [
  { name: 'fifth non-empty row seeds detection across blank CRLF rows', rows: [...Array(4).fill(longHit('README')), ...Array(21).fill(longHit('src/a.js'))], compress: true },
  { name: 'sixth non-empty row cannot seed detection', rows: [...Array(5).fill(longHit('README')), longHit('src/a.js')], compress: false },
  { name: 'prose after five valid hits still prevents compression', rows: [...Array(5).fill(longHit('src/a.js')), prose], compress: false },
]
for (const { name, rows, compress } of scanCases) {
  // No final newline: exercise both blank-row skipping and the final row.
  const text = '\r\n \t\r\n' + rows.join('\r\n \t\r\n')
  check(name + ': detector', () => {
    assert.ok(text.length > MIN_COMPRESS_SIZE)
    assert.equal(autoDetectFilter(text)?.filterName ?? null, compress ? 'grep' : null)
  })
  for (const wire of Object.keys(wires)) check(name + ': ' + wire, () => {
    const { output, stats } = shipped(text, wire)
    if (compress) {
      assert.ok(stats.saved > 0)
      assert.ok(output.startsWith('25 matches in 2F:'))
    } else {
      assert.equal(output, text)
      assert.equal(stats.saved, 0)
      assert.equal(stats.hits.length, 0)
    }
  })
}
const numberedDumps = [
  { name: 'original four-column numbered source', width: 4, padding: '' },
  { name: 'five-column numbered source', width: 5, padding: '' },
  { name: 'four-column numbered source with long lines', width: 4, padding: 'x'.repeat(140) },
]
for (const { name, width, padding } of numberedDumps) {
  const rows = Array.from({ length: 400 }, (_, i) =>
    String(i + 1).padStart(width, ' ') + '|const value' + (i + 1) + ' = ' + (i + 1) + ';' + padding)
  const text = rows.join('\n') + '\n'
  for (const wire of Object.keys(wires)) check(name + ' cannot become a clean git status (#322): ' + wire, () => {
    const { output, stats } = shipped(text, wire)
    assert.ok(output.includes(rows[0]), 'the first source line must survive')
    assert.ok(output.includes(rows.at(-1)), 'the last source line must survive')
    assert.ok(!stats.hits.some(hit => hit.filter === 'git-status'), 'a numbered file is not a status listing')
  })
}
const indentedSourceRows = Array.from({ length: 60 }, (_, i) => `   const value${i} = compute(${i});`)
for (const wire of Object.keys(wires)) check('three-space source indentation is not porcelain (#389): ' + wire, () => {
  const text = indentedSourceRows.join('\n')
  const { output, stats } = shipped(text, wire)
  assert.equal(output, text, 'unique source lines must stay intact')
  assert.ok(!stats.hits.some(hit => hit.filter === 'git-status'))
})
console.log(checks + ' checks; ' + failures + ' failures')
process.exitCode = failures ? 1 : 0
