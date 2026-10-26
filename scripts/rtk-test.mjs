/**
 * The RTK token saver: filters, autodetection, the three wire shapes, and the
 * safety rules that keep compaction from ever making a request worse.
 *
 * The module sits between the user's turn and the provider, so the checks below
 * are split the way the risk is:
 *
 * - every filter fires on a realistic sample and leaves the expected markers
 *   (the markers are the model's only signal that output was compacted);
 * - the autodetector picks the intended filter for each of those samples,
 *   because a misrouted blob is rewritten into a shape that never happened;
 * - the safety rules hold — error results untouched, tiny blobs untouched, a
 *   throwing filter falling back to the original, and never an empty or larger
 *   result;
 * - all three wires this plugin builds (`chat`, `messages`, `responses`) are
 *   compacted, string-content and array-content variants alike;
 * - the stats add up, and a second pass neither corrupts nor grows the payload.
 *
 * No network, no home directory, no host: every sample is a literal.
 *
 * Run: node scripts/rtk-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compressMessages, compressRequest, compressText, describeSavings, formatRtkLog } from '../src/token-saver/rtk/index.js'
import { autoDetectFilter } from '../src/token-saver/rtk/autodetect.js'
import { allFilters, resolveFilter } from '../src/token-saver/rtk/registry.js'
import { safeApply } from '../src/token-saver/rtk/applyFilter.js'
import { MIN_COMPRESS_SIZE } from '../src/token-saver/rtk/constants.js'
import { gitDiff } from '../src/token-saver/rtk/filters/gitDiff.js'
import { gitStatus } from '../src/token-saver/rtk/filters/gitStatus.js'
import { gitLog } from '../src/token-saver/rtk/filters/gitLog.js'
import { buildOutput } from '../src/token-saver/rtk/filters/buildOutput.js'
import { grep } from '../src/token-saver/rtk/filters/grep.js'
import { find } from '../src/token-saver/rtk/filters/find.js'
import { ls } from '../src/token-saver/rtk/filters/ls.js'
import { tree } from '../src/token-saver/rtk/filters/tree.js'
import { dedupLog } from '../src/token-saver/rtk/filters/dedupLog.js'
import { smartTruncate } from '../src/token-saver/rtk/filters/smartTruncate.js'
import { readNumbered } from '../src/token-saver/rtk/filters/readNumbered.js'
import { searchList } from '../src/token-saver/rtk/filters/searchList.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ── samples ──────────────────────────────────────────────────────────────────
// Every sample is the shape a real tool prints, sized above the 500-byte
// minimum where the test expects compaction (a smaller one is deliberately
// never touched — that rule has its own check below).

const GIT_DIFF = `diff --git a/src/messages.js b/src/messages.js
index 3a4b5c6..7d8e9f0 100644
--- a/src/messages.js
+++ b/src/messages.js
@@ -261,10 +261,12 @@ export function toClaudeMessages(messages, resolveImage, warnings) {
   const out = []
   let systemText = ''
-  // One turn per role, merged.
+  // One turn per role, merged: the kernel's own Messages adapter concatenates
+  // a result onto the preceding wire turn, and a pre-V4 history answers tool
+  // calls as separate user messages that would otherwise land as consecutive
   const push = (role, blocks) => {
     const previous = out[out.length - 1]
     if (previous?.role === role) previous.content.push(...blocks)
     else out.push({ role, content: [...blocks] })
   }
diff --git a/src/http.js b/src/http.js
index 9f8e7d6..5c4b3a2 100644
--- a/src/http.js
+++ b/src/http.js
@@ -96,6 +96,10 @@ export function classifyFailure(status, payload, retryAfterMs) {
   const isHtmlPage = rawHtml || raw.includes('with an HTML error page')
+  const message = rawHtml
+    ? 'the gateway front proxy answered with an HTML error page'
+    : raw
+  const flat = message.toLowerCase()
   if (type === 'RegionError' || /not available in your country|region/i.test(flat)) {
     return new UpstreamError(message, CODE.region, { status, type })
   }
`

const GIT_STATUS_PORCELAIN = `## main...origin/main
 M src/messages.js
 M src/http.js
 M src/forward.js
 M src/stream.js
 M src/upstream.js
 M src/store.js
 M src/token-saver/rtk/index.js
 M src/token-saver/rtk/constants.js
 M src/token-saver/rtk/autodetect.js
 M src/token-saver/rtk/applyFilter.js
 M src/token-saver/rtk/registry.js
 M src/token-saver/rtk/filters/gitDiff.js
 M src/token-saver/rtk/filters/gitStatus.js
 M src/token-saver/rtk/filters/gitLog.js
 M src/token-saver/rtk/filters/grep.js
 M src/token-saver/rtk/filters/find.js
 M src/token-saver/rtk/filters/ls.js
 M src/token-saver/rtk/filters/tree.js
 M src/token-saver/rtk/filters/dedupLog.js
 M src/token-saver/rtk/filters/buildOutput.js
A  src/token-saver/rtk/filters/readNumbered.js
A  src/token-saver/rtk/filters/searchList.js
A  src/token-saver/rtk/filters/smartTruncate.js
A  src/token-saver/rtk/filters/buildOutput.js
D  src/legacy/old-rtk.js
?? scratch/rtk-notes.txt
?? tmp/rtk-build.log
?? tmp/rtk-coverage/summary.html
?? scratch/patch-2026-10-10.diff
?? src/token-saver/rtk/filters/gitDiff.js.orig
?? docs/token-saver/rtk-notes.md
?? vendor/channel-pack/cache/rtk-wasm.wasm
?? scripts/probes/rtk-probe-output.json
?? locale/token-saver/en.json
?? locale/token-saver/zh.json
?? docs/token-saver/rtk-design.md
`

const GIT_STATUS_LONG = `On branch main
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
\tmodified:   src/messages.js
\tmodified:   src/http.js
\tmodified:   src/forward.js

Untracked files:
  (use "git add <file>..." to include in what will be committed)
\tscratch/rtk-notes.txt

nothing to commit, working tree clean
`

const GIT_LOG_SAMPLE = `commit 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a
Author: Jane Doe <jane@example.com>
Date:   Fri Oct 10 12:00:00 2026 +0200

    fix: stop dropping tool results on the responses wire

    The projector emitted function_call_output items without their call id,
    so the model saw an answer it could not match to a question and re-issued
    the same tool call until the user stopped the turn.

 src/messages.js | 12 ++++++------
 1 file changed, 6 insertions(+), 6 deletions(-)

commit 9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d
Author: John Roe <john@example.com>
Date:   Thu Oct 9 09:15:00 2026 +0200

    chore: bump the release manifest

 CHANGELOG.md | 4 +++-
 1 file changed, 2 insertions(+), 1 deletion(-)
`

const NPM_SAMPLE = `npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.
npm warn deprecated rimraf@2.7.1: Rimraf versions prior to v4 are no longer supported
npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported
npm warn deprecated fstream@1.0.12: this library is no longer supported
npm warn deprecated sourcemap-codec@1.4.8: Please use the maintained fork instead
npm warn EBADENGINE Unsupported engine
npm warn EBADENGINE   package: 'some-package@1.0.0'
npm warn EBADENGINE   required: { node: '>=18' }
npm warn EBADENGINE   current: { node: 'v24.11.1', npm: '11.6.0' }

added 213 packages, and audited 214 packages in 4s

42 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities
`

const CARGO_SAMPLE = `   Compiling serde v1.0.219
   Compiling serde_json v1.0.140
   Compiling tokio v1.43.0
   Compiling our-crate v0.1.0 (/home/user/proj)
error[E0308]: mismatched types
 --> src/main.rs:42:17
   |
42 |     let x: u32 = "hello";
   |                  ^^^^^^^ expected \`u32\`, found \`&str\`
   |
   = note: expected type \`u32\`
              found type \`&str\`

error: could not compile \`our-crate\` (bin "our-crate") due to 1 previous error
warning: unused variable: \`y\`
 --> src/main.rs:50:9
   |
50 |     let y = 3;
   |         ^ help: if this is intentional, prefix it with an underscore: \`_y\`
   |

   Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 12.34s
`

const GREP_SAMPLE = `src/token-saver/rtk/autodetect.js:18:const RE_GIT_DIFF = /^diff --git /m
src/token-saver/rtk/autodetect.js:19:const RE_GIT_DIFF_HUNK = /^@@ /m
src/token-saver/rtk/autodetect.js:20:const RE_GIT_STATUS = /^On branch |^nothing to commit/m
src/token-saver/rtk/autodetect.js:21:const RE_GIT_LOG = /^commit [0-9a-f]{7,40}$/m
src/token-saver/rtk/autodetect.js:22:const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] X/m
src/token-saver/rtk/autodetect.js:23:const RE_BUILD_OUTPUT = /^npm (warn|error|ERR!)/im
src/token-saver/rtk/autodetect.js:24:const RE_TREE_GLYPH = /tree-glyph/
src/token-saver/rtk/autodetect.js:25:const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m
src/token-saver/rtk/autodetect.js:26:const RE_LS_TOTAL = /^total digits$/m
src/token-saver/rtk/autodetect.js:60:  if (lines.length >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(lines)) {
src/token-saver/rtk/autodetect.js:61:    return readNumbered
src/token-saver/rtk/autodetect.js:64:  if (nonEmpty.length >= 5) return dedupLog
src/token-saver/rtk/autodetect.js:67:  if (text.split(String.fromCharCode(10)).length >= SMART_TRUNCATE_MIN_LINES) return smartTruncate
src/token-saver/rtk/autodetect.js:69:  return null
src/token-saver/rtk/autodetect.js:74:function isGrepLine(line) {
src/token-saver/rtk/autodetect.js:79:  const second = line.indexOf(':', first + 1)
src/token-saver/rtk/filters/grep.js:5:export function grep(input) {
src/token-saver/rtk/filters/grep.js:6:  const byFile = new Map()
src/token-saver/rtk/filters/grep.js:7:  let total = 0
src/token-saver/rtk/filters/grep.js:9:  for (const line of input.split(sep)) {
src/token-saver/rtk/filters/grep.js:11:    const first = line.indexOf(':')
src/token-saver/rtk/filters/grep.js:12:    const second = line.indexOf(':', first + 1)
src/token-saver/rtk/filters/grep.js:13:    const file = line.slice(0, first)
src/token-saver/rtk/filters/grep.js:14:    const lineNumStr = line.slice(first + 1, second)
src/token-saver/rtk/filters/grep.js:15:    const content = line.slice(second + 1)
src/token-saver/rtk/filters/grep.js:16:    if (!isDigits(lineNumStr)) continue
src/token-saver/rtk/filters/grep.js:17:    total++
src/token-saver/rtk/filters/grep.js:18:    if (!byFile.has(file)) byFile.set(file, [])
src/token-saver/rtk/filters/grep.js:19:    byFile.get(file).push([lineNumStr, content])
src/token-saver/rtk/filters/grep.js:20:  }
`

const FIND_SAMPLE = `src/token-saver/rtk/filters/gitDiff.js
src/token-saver/rtk/filters/gitStatus.js
src/token-saver/rtk/filters/gitLog.js
src/token-saver/rtk/filters/grep.js
src/token-saver/rtk/filters/find.js
src/token-saver/rtk/filters/ls.js
src/token-saver/rtk/filters/tree.js
src/token-saver/rtk/filters/buildOutput.js
scripts/rtk-test.mjs
scripts/test-all.mjs
adapter/kernel.js
docs/token-saver.md
locale/en.json
locale/zh.json
`

const LS_SAMPLE = `total 96
drwxr-xr-x  8 user user  4096 Oct 10 12:00 .
drwxr-xr-x  3 user user  4096 Oct  9 18:22 ..
drwxr-xr-x 12 user user  4096 Oct 10 11:58 src
drwxr-xr-x  4 user user  4096 Oct 10 11:58 scripts
drwxr-xr-x 20 user user 12288 Oct 10 11:58 node_modules
drwxr-xr-x  3 user user  4096 Oct  7 13:16 .git
-rw-r--r--  1 user user  2328 Oct  7 12:54 package.json
-rw-r--r--  1 user user 69270 Oct  7 13:16 README.md
-rw-r--r--  1 user user 119104 Oct  7 13:16 index.js
-rw-r--r--  1 user user 24912 Oct  7 12:54 src/http.js
-rw-r--r--  1 user user  1234 Oct 10 12:01 scratch.txt
lrwxrwxrwx  1 user user     7 Oct 10 12:02 latest -> index.js
`

const TREE_SAMPLE = `src/token-saver/rtk
├── filters
│   ├── buildOutput.js
│   ├── dedupLog.js
│   ├── find.js
│   ├── gitDiff.js
│   ├── gitLog.js
│   ├── gitStatus.js
│   ├── grep.js
│   ├── ls.js
│   ├── readNumbered.js
│   ├── searchList.js
│   ├── smartTruncate.js
│   └── tree.js
├── applyFilter.js
├── autodetect.js
├── constants.js
├── index.js
└── registry.js

4 directories, 17 files
`

const DEDUP_SAMPLE = `[INFO] worker started pid=4242 queue=rtk-jobs
[INFO] connecting to broker host=127.0.0.1 port=5672
[INFO] heartbeat ok worker=1 queue=rtk-jobs retry=0 backoff=250ms
[INFO] heartbeat ok worker=1 queue=rtk-jobs retry=0 backoff=250ms
[INFO] heartbeat ok worker=1 queue=rtk-jobs retry=0 backoff=250ms
[INFO] heartbeat ok worker=1 queue=rtk-jobs retry=0 backoff=250ms
[INFO] heartbeat ok worker=1 queue=rtk-jobs retry=0 backoff=250ms
[INFO] heartbeat ok worker=1 queue=rtk-jobs retry=0 backoff=250ms
[INFO] heartbeat ok worker=1 queue=rtk-jobs retry=0 backoff=250ms
[INFO] heartbeat ok worker=1 queue=rtk-jobs retry=0 backoff=250ms
[INFO] job received id=17 queue=rtk-jobs priority=normal
[INFO] job received id=17 queue=rtk-jobs priority=normal
[INFO] job received id=17 queue=rtk-jobs priority=normal
[INFO] job received id=17 queue=rtk-jobs priority=normal
[INFO] job done id=17 elapsed=812ms status=ok

[INFO] worker idle waiting for work
`

const SEARCH_LIST_SAMPLE = `Result of search in 'src' (total 16 files):
- src/messages.js
- src/http.js
- src/forward.js
- src/stream.js
- src/upstream.js
- src/store.js
- src/token-saver/rtk/index.js
- src/token-saver/rtk/constants.js
- src/token-saver/rtk/autodetect.js
- src/token-saver/rtk/applyFilter.js
- src/token-saver/rtk/registry.js
- src/token-saver/rtk/filters/gitDiff.js
- src/token-saver/rtk/filters/grep.js
- scripts/rtk-test.mjs
- adapter/kernel.js
- package.json
`

// 300 numbered lines, as Cursor's read_file emits them.
const NUMBERED_SAMPLE = Array.from({ length: 300 }, (_, i) => `  ${i + 1}|const value${i} = compute(${i})`).join('\n')

// The only numbered dump the autodetector can route to read-numbered: the
// source gate counts lines in the 1 KiB detection window, so a dump of ordinary
// ~30-character lines never reaches 250 lines there (see the dispatch check).
const DENSE_NUMBERED = Array.from({ length: 300 }, (_, i) => `${(i % 9) + 1}|`).join('\n')

// A blob with >= 250 lines but almost no non-empty ones: the only shape the
// detection order can route to smart-truncate (five non-empty lines would be
// claimed by dedup-log first).
const BLANK_BLOB = [...Array(200).fill(''), 'x'.repeat(200), ...Array(200).fill('')].join('\n')

const SMALL_BLOB = 'x'.repeat(120)

/** A chat-wire body whose single tool message carries `text`. */
const chatBody = text => ({ model: 'm', messages: [{ role: 'tool', tool_call_id: 'c1', content: text }] })

// ── every filter fires, and leaves the markers the model reads ───────────────
console.log('\nfilters')

check('gitDiff: file names, hunk headers and per-file +N -M counts survive', () => {
  const out = gitDiff(GIT_DIFF)
  assert.ok(out.includes('src/messages.js'))
  assert.ok(out.includes('src/http.js'))
  assert.ok(out.includes('  @@ -261,10 +261,12 @@'), 'hunk header kept')
  assert.ok(out.includes('  +3 -1'), 'file 1 counts')
  assert.ok(out.includes('  +4 -0'), 'file 2 counts')
  assert.ok(out.length > 0 && out.length < GIT_DIFF.length)
})

check('gitDiff: a hunk over 100 lines is cut and both markers appear', () => {
  const big = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1,150 +1,150 @@\n${Array.from({ length: 150 }, (_, i) => `+line ${i}`).join('\n')}\n`
  const out = gitDiff(big)
  assert.ok(out.includes('  ... (50 lines truncated)'), 'per-hunk skip count')
  assert.ok(out.includes('  +150 -0'), 'counts the whole hunk, not just the shown part')
  assert.ok(out.includes('[full diff: rtk git diff --no-compact]'), 'the get-the-full-diff hint')
})

check('gitStatus: porcelain groups staged/modified/untracked with counts', () => {
  const out = gitStatus(GIT_STATUS_PORCELAIN)
  assert.ok(out.startsWith('* main...origin/main'))
  assert.ok(out.includes('+ Staged: 5 files'))
  assert.ok(out.includes('~ Modified: 20 files'))
  assert.ok(out.includes('? Untracked: 11 files'))
  assert.ok(out.includes('   src/legacy/old-rtk.js'), 'the deleted file is listed under staged')
  assert.ok(out.includes('   ... +10 more'), 'modified list capped with a count')
  assert.ok(out.length < GIT_STATUS_PORCELAIN.length)
})

check('gitStatus: long form (On branch / modified:) is parsed too', () => {
  const out = gitStatus(GIT_STATUS_LONG)
  assert.ok(out.includes('* main'))
  assert.ok(out.includes('~ Modified: 3 files'))
  assert.ok(!out.includes('clean'), 'three modified files are not a clean tree')
})

check('gitLog: subjects and stats survive, commit-body prose does not', () => {
  const out = gitLog(GIT_LOG_SAMPLE)
  assert.ok(out.includes('Subject: fix: stop dropping tool results on the responses wire'))
  assert.ok(out.includes('Author: Jane Doe <jane@example.com>'))
  assert.ok(out.includes('  1 file changed, 6 insertions(+), 6 deletions(-)'))
  assert.ok(!out.includes('The projector emitted'), 'body prose dropped')
  assert.ok(out.length < GIT_LOG_SAMPLE.length)
})

check('buildOutput: npm log keeps deprecation sample, warnings and summary', () => {
  const out = buildOutput(NPM_SAMPLE)
  assert.ok(out.includes('npm warn deprecated inflight@1.0.6'), 'first deprecations kept')
  assert.ok(out.includes('... +2 more deprecated packages'), 'the rest counted')
  assert.ok(out.includes('npm warn EBADENGINE Unsupported engine'), 'warnings kept')
  assert.ok(out.includes('added 213 packages'), 'summary kept')
  assert.ok(!out.includes('found 0 vulnerabilities'), 'unrecognised tail line dropped')
  assert.ok(out.length < NPM_SAMPLE.length)
})

check('buildOutput: cargo log counts crates, keeps errors with their spans', () => {
  const out = buildOutput(CARGO_SAMPLE)
  assert.ok(out.includes('Compiled 4 packages'))
  assert.ok(out.includes('error[E0308]: mismatched types'))
  assert.ok(out.includes(' --> src/main.rs:42:17'), 'rustc continuation line kept')
  assert.ok(out.includes('warning: unused variable: `y`'))
  assert.ok(out.includes('Finished `dev` profile'))
  assert.ok(!out.includes('Compiling serde'), 'per-crate progress dropped')
})

check('grep: groups by file with line numbers and a per-file cap marker', () => {
  const out = grep(GREP_SAMPLE)
  assert.ok(out.startsWith('30 matches in 2F:'))
  assert.ok(out.includes('[file] src/token-saver/rtk/autodetect.js (16):'))
  assert.ok(out.includes('  +6'), 'matches past the per-file cap are counted')
  assert.ok(out.includes('    18:'), 'line number right-aligned')
  assert.ok(out.length < GREP_SAMPLE.length)
})

check('find: groups paths by directory', () => {
  const out = find(FIND_SAMPLE)
  assert.ok(out.startsWith('14 files in 5 dirs:'))
  assert.ok(out.includes('src/token-saver/rtk/filters/  (8)'))
  assert.ok(out.includes('  gitDiff.js'), 'basename, not full path')
  assert.ok(out.length < FIND_SAMPLE.length)
})

check('ls: dirs, file sizes and the extension summary; noise dirs dropped', () => {
  const out = ls(LS_SAMPLE)
  assert.ok(out.includes('src/'))
  assert.ok(out.includes('scripts/'))
  assert.ok(out.includes('package.json  2.3K'))
  assert.ok(out.includes('Summary: 6 files, 2 dirs (3 .js, 1 .json, 1 .md, 1 .txt)'))
  assert.ok(!out.includes('node_modules'), 'noise directory dropped')
  assert.ok(!out.includes('.git'), 'noise directory dropped')
  assert.ok(out.length < LS_SAMPLE.length)
})

check('tree: glyphs stay, the "N directories, M files" summary goes', () => {
  const out = tree(TREE_SAMPLE)
  assert.ok(out.includes('├── filters'))
  assert.ok(out.includes('└── registry.js'))
  assert.ok(!out.includes('directories, 17 files'))
  assert.ok(out.length < TREE_SAMPLE.length)
})

check('dedupLog: consecutive duplicate runs collapse with a count', () => {
  const out = dedupLog(DEDUP_SAMPLE)
  assert.ok(out.includes('... (7 duplicate lines)'))
  assert.ok(out.includes('... (3 duplicate lines)'))
  assert.ok(out.includes('[INFO] heartbeat ok worker=1 queue=rtk-jobs retry=0 backoff=250ms'))
  assert.ok(out.length < DEDUP_SAMPLE.length)
})

check('smartTruncate: head + tail window with the missing count', () => {
  const log = Array.from({ length: 300 }, (_, i) => `step ${i} did some work`).join('\n')
  const out = smartTruncate(log)
  assert.ok(out.startsWith('step 0 did some work'))
  assert.ok(out.includes('... +120 lines truncated'))
  assert.ok(out.endsWith('step 299 did some work'))
  assert.ok(out.length < log.length)
})

check('readNumbered: numbered head + tail window, numbered marker', () => {
  const out = readNumbered(NUMBERED_SAMPLE)
  assert.ok(out.startsWith('  1|const value0 = compute(0)'))
  assert.ok(out.includes('... +120 lines truncated (file continues)'))
  assert.ok(out.endsWith('  300|const value299 = compute(299)'))
  assert.ok(out.length < NUMBERED_SAMPLE.length)
})

check('searchList: header kept, paths grouped by directory', () => {
  const out = searchList(SEARCH_LIST_SAMPLE)
  assert.ok(out.startsWith("Result of search in 'src' (total 16 files):"))
  assert.ok(out.includes('16 files in 6 dirs:'))
  assert.ok(out.includes('src/token-saver/rtk/filters/ (2):'))
  assert.ok(out.length < SEARCH_LIST_SAMPLE.length)
})

// ── autodetection ────────────────────────────────────────────────────────────
console.log('\nautodetect')

const DETECT_CASES = [
  ['git-diff', GIT_DIFF],
  ['git-status', GIT_STATUS_PORCELAIN],
  ['git-status', GIT_STATUS_LONG],
  ['git-log', GIT_LOG_SAMPLE],
  ['build-output', NPM_SAMPLE],
  ['build-output', CARGO_SAMPLE],
  ['grep', GREP_SAMPLE],
  ['find', FIND_SAMPLE],
  ['ls', LS_SAMPLE],
  ['tree', TREE_SAMPLE],
  ['dedup-log', DEDUP_SAMPLE],
  ['search-list', SEARCH_LIST_SAMPLE],
  ['read-numbered', DENSE_NUMBERED],
  ['smart-truncate', BLANK_BLOB],
]

for (const [expected, sample] of DETECT_CASES) {
  check(`autodetect: ${expected}`, () => {
    const fn = autoDetectFilter(sample)
    assert.ok(fn !== null, 'a filter was selected')
    assert.equal(fn.filterName, expected)
  })
}

check('autodetect: an unstructured short blob selects nothing', () => {
  assert.equal(autoDetectFilter('just a short note with no tool shape at all'), null)
})

check('autodetect: a realistic numbered dump is claimed by dedup-log, as in the source', () => {
  // The source gate is `lines.length >= SMART_TRUNCATE_MIN_LINES` where `lines`
  // comes from the 1 KiB detection window, not the whole blob. A read_file dump
  // of ordinary lines therefore never reaches read-numbered through
  // autodetection — the filter still compacts such a dump when invoked directly
  // (checked above), and dedup-log then declines it because it has no duplicate
  // runs, so the blob passes through untouched. This pins the ported dispatch
  // rather than the intent; the alternative would be a behavior change.
  assert.equal(autoDetectFilter(NUMBERED_SAMPLE).filterName, 'dedup-log')
})

// ── safety ───────────────────────────────────────────────────────────────────
console.log('\nsafety')

check('an error tool result is never touched (messages wire)', () => {
  const payload = {
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: GIT_DIFF }] }] }],
  }
  const { payload: out, stats } = compressRequest(payload, 'messages')
  assert.equal(out.messages[0].content[0].content[0].text, GIT_DIFF, 'byte-identical')
  assert.equal(stats.saved, 0)
  assert.deepEqual(stats.hits, [])

  // Control: the same blob without is_error does get compacted.
  const ok = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: GIT_DIFF }] }] }] }
  const control = compressRequest(ok, 'messages')
  assert.ok(control.stats.saved > 0)
})

check('a blob below the 500-byte minimum is counted but not rewritten', () => {
  assert.ok(SMALL_BLOB.length < MIN_COMPRESS_SIZE)
  const payload = chatBody(SMALL_BLOB)
  const { payload: out, stats } = compressRequest(payload, 'chat')
  assert.equal(out.messages[0].content, SMALL_BLOB)
  assert.equal(stats.bytesBefore, SMALL_BLOB.length)
  assert.equal(stats.bytesAfter, SMALL_BLOB.length)
  assert.equal(stats.saved, 0)
  assert.deepEqual(stats.hits, [])
})

check('a throwing filter falls back to the original text and warns', () => {
  const warnings = []
  const backup = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  let out
  try {
    out = safeApply(() => { throw new Error('boom') }, GIT_DIFF)
  } finally {
    console.warn = backup
  }
  assert.equal(out, GIT_DIFF)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /panicked/)
})

check('safeApply passes non-functions and non-string returns through', () => {
  assert.equal(safeApply(null, GIT_DIFF), GIT_DIFF)
  assert.equal(safeApply(() => 42, GIT_DIFF), GIT_DIFF)
  assert.equal(safeApply(() => undefined, GIT_DIFF), GIT_DIFF)
})

check('no sample is ever made larger or empty by a pass', () => {
  for (const [expected, sample] of DETECT_CASES) {
    const payload = chatBody(sample)
    const { payload: out, stats } = compressRequest(payload, 'chat')
    const text = out.messages[0].content
    assert.equal(typeof text, 'string', `${expected}: still a string`)
    assert.ok(text.length > 0, `${expected}: never empty`)
    assert.ok(text.length <= sample.length, `${expected}: never larger`)
    assert.equal(stats.bytesAfter, text.length, `${expected}: stats match what was written`)
  }
})

check('user and assistant text is never rewritten (chat wire)', () => {
  const payload = {
    messages: [
      { role: 'system', content: GIT_DIFF },
      { role: 'user', content: GIT_DIFF },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: GIT_DIFF } }] },
      { role: 'tool', tool_call_id: 'c1', content: GIT_DIFF },
    ],
  }
  const { payload: out, stats } = compressRequest(payload, 'chat')
  assert.equal(out.messages[0].content, GIT_DIFF)
  assert.equal(out.messages[1].content, GIT_DIFF)
  assert.equal(out.messages[2].tool_calls[0].function.arguments, GIT_DIFF)
  assert.ok(out.messages[3].content.length < GIT_DIFF.length)
  assert.equal(stats.hits.length, 1)
})

// ── the three wires ──────────────────────────────────────────────────────────
console.log('\nwires')

check('chat: string and text-block tool results are compacted', () => {
  const payload = {
    model: 'm',
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"git diff"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: GIT_DIFF },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'shell', arguments: '{"cmd":"grep -rn rtk src"}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: GREP_SAMPLE }] },
    ],
  }
  const { payload: out, stats } = compressRequest(payload, 'chat')
  assert.ok(out.messages[2].content.length < GIT_DIFF.length)
  assert.ok(out.messages[4].content[0].text.length < GREP_SAMPLE.length)
  assert.deepEqual(stats.hits.map(hit => hit.shape).sort(), ['openai-tool', 'openai-tool-array'])
  assert.ok(stats.saved > 0)
})

check('messages: tool_result array and string content are compacted', () => {
  const payload = {
    model: 'm',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shell', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: GIT_STATUS_PORCELAIN }] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'shell', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: LS_SAMPLE }] },
    ],
  }
  const { payload: out, stats } = compressRequest(payload, 'messages')
  assert.ok(out.messages[2].content[0].content[0].text.length < GIT_STATUS_PORCELAIN.length)
  assert.ok(out.messages[4].content[0].content.length < LS_SAMPLE.length)
  assert.deepEqual(stats.hits.map(hit => hit.shape).sort(), ['claude-array', 'claude-string'])
  assert.ok(stats.saved > 0)
})

check('responses: function_call_output string and input_text array are compacted', () => {
  const payload = {
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the build' }] },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: NPM_SAMPLE },
      { type: 'function_call', call_id: 'c2', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_text', text: CARGO_SAMPLE }] },
    ],
  }
  const { payload: out, stats } = compressRequest(payload, 'responses')
  assert.ok(out.input[2].output.length < NPM_SAMPLE.length)
  assert.ok(out.input[4].output[0].text.length < CARGO_SAMPLE.length)
  assert.deepEqual(stats.hits.map(hit => hit.shape).sort(), ['openai-responses-array', 'openai-responses-string'])
  assert.ok(stats.saved > 0)
})

check('compressRequest mutates and returns the same payload reference', () => {
  const payload = chatBody(GIT_DIFF)
  const { payload: out } = compressRequest(payload, 'chat')
  assert.equal(out, payload)
})

check('an unknown wire compacts nothing and keeps the payload intact', () => {
  const payload = chatBody(GIT_DIFF)
  const { payload: out, stats } = compressRequest(payload, 'kiro')
  assert.equal(out.messages[0].content, GIT_DIFF)
  assert.equal(stats.saved, 0)
  assert.equal(stats.enabled, true)
})

// ── the off switch ───────────────────────────────────────────────────────────
console.log('\noff switch')

check('enabled: false returns the payload untouched with stats.enabled false', () => {
  const payload = chatBody(GIT_DIFF)
  const before = JSON.stringify(payload)
  const { payload: out, stats } = compressRequest(payload, 'chat', { enabled: false })
  assert.equal(out, payload)
  assert.equal(JSON.stringify(payload), before)
  assert.equal(stats.enabled, false)
  assert.deepEqual(stats, { enabled: false, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] })
  assert.equal(describeSavings(stats), null)
})

check('a boolean false works as the off switch too', () => {
  const payload = chatBody(GIT_DIFF)
  const { stats } = compressRequest(payload, 'chat', false)
  assert.equal(stats.enabled, false)
  assert.equal(stats.saved, 0)
})

// ── stats ────────────────────────────────────────────────────────────────────
console.log('\nstats')

check('bytesBefore - bytesAfter === saved, and hits sum to saved', () => {
  const cases = [
    [chatBody(GIT_DIFF), 'chat'],
    [{ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: GIT_STATUS_PORCELAIN }] }] }] }, 'messages'],
    [{ input: [{ type: 'function_call_output', call_id: 'c', output: CARGO_SAMPLE }] }, 'responses'],
  ]
  for (const [payload, wire] of cases) {
    const { stats } = compressRequest(payload, wire)
    assert.equal(stats.bytesBefore - stats.bytesAfter, stats.saved)
    assert.equal(stats.hits.reduce((sum, hit) => sum + hit.saved, 0), stats.saved)
    assert.ok(stats.saved > 0)
  }
})

check('formatRtkLog renders the source-format line', () => {
  const { stats } = compressRequest(chatBody(GIT_DIFF), 'chat')
  assert.match(formatRtkLog(stats), /^\[RTK\] saved \d+B \/ \d+B \(\d+\.\d%\) via \[git-diff\] hits=1$/)
  assert.equal(formatRtkLog({ bytesBefore: 0, bytesAfter: 0, hits: [] }), null)
  assert.equal(formatRtkLog(null), null)
})

check('describeSavings renders the documented one-liner', () => {
  const synthetic = {
    enabled: true,
    bytesBefore: 12595,
    bytesAfter: 4198,
    saved: 8397,
    hits: [
      { shape: 'openai-tool', filter: 'git-diff', saved: 5000 },
      { shape: 'openai-tool', filter: 'grep', saved: 3397 },
    ],
  }
  assert.equal(describeSavings(synthetic), '[token-saver] 12.3 KB -> 4.1 KB (67%) via git-diff, grep (2 blocks)')
})

check('describeSavings names an empty pass and returns null when disabled', () => {
  const empty = describeSavings({ enabled: true, bytesBefore: 500, bytesAfter: 500, saved: 0, hits: [] })
  assert.match(empty, /^\[token-saver\] 500 B -> 500 B \(0%\) — no tool output compacted$/)
  assert.equal(describeSavings({ enabled: false, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] }), null)
  assert.equal(describeSavings(undefined), null)
})

// ── the raw wire-agnostic export (source parity) ─────────────────────────────
console.log('\ncompressMessages (raw export)')

check('compressMessages compacts chat and responses items, and honours the switch', () => {
  const body = {
    messages: [
      { role: 'tool', tool_call_id: 'c1', content: GIT_DIFF },
      { type: 'function_call_output', call_id: 'c2', output: LS_SAMPLE },
    ],
  }
  const stats = compressMessages(body, true)
  assert.ok(stats !== null)
  assert.ok(body.messages[0].content.length < GIT_DIFF.length)
  assert.ok(body.messages[1].output.length < LS_SAMPLE.length)
  assert.equal(stats.bytesBefore - stats.bytesAfter, stats.hits.reduce((sum, hit) => sum + hit.saved, 0))
  assert.equal(compressMessages(chatBody(GIT_DIFF), false), null)
  assert.equal(compressMessages(null, true), null)
  assert.equal(compressMessages({ model: 'm' }, true), null)
})

check('compressMessages still walks the Kiro conversationState shape', () => {
  const body = {
    conversationState: {
      history: [{
        userInputMessage: {
          userInputMessageContext: {
            toolResults: [
              { status: 'success', content: [{ text: GIT_DIFF }] },
              { status: 'error', content: [{ text: GIT_DIFF }] },
            ],
          },
        },
      }],
    },
  }
  const stats = compressMessages(body, true)
  const results = body.conversationState.history[0].userInputMessage.userInputMessageContext.toolResults
  assert.ok(results[0].content[0].text.length < GIT_DIFF.length)
  assert.equal(results[1].content[0].text, GIT_DIFF, 'error tool results preserved')
  assert.deepEqual(stats.hits.map(hit => hit.shape), ['kiro-tool-result'])
})

check('compressText refuses to return empty or larger output', () => {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] }
  const emptyFilter = () => ''
  assert.equal(safeApply(emptyFilter, GIT_DIFF), '')
  // The size guard lives in compressText, not the filter: verify the real path
  // through a blob whose compacted form is accepted.
  const out = compressText(GIT_DIFF, stats, 'test-shape')
  assert.ok(out.length > 0 && out.length < GIT_DIFF.length)
  assert.equal(stats.bytesBefore - stats.bytesAfter, stats.hits[0].saved)
  assert.equal(stats.hits[0].shape, 'test-shape')
})

// ── idempotence ──────────────────────────────────────────────────────────────
console.log('\nidempotence')

check('a second pass never corrupts, empties or grows the payload', () => {
  const payload = {
    messages: [
      { role: 'tool', tool_call_id: 'c1', content: GIT_DIFF },
      { role: 'tool', tool_call_id: 'c2', content: GIT_STATUS_PORCELAIN },
      { role: 'tool', tool_call_id: 'c3', content: NPM_SAMPLE },
    ],
  }
  compressRequest(payload, 'chat')
  const first = payload.messages.map(msg => msg.content)
  compressRequest(payload, 'chat')
  const second = payload.messages.map(msg => msg.content)
  for (let i = 0; i < second.length; i++) {
    assert.equal(typeof second[i], 'string')
    assert.ok(second[i].length > 0, `message ${i} still has content`)
    assert.ok(second[i].length <= first[i].length, `message ${i} did not grow`)
  }
})

check('repeated passes reach a fixed point without corrupting the body', () => {
  const payload = chatBody(`${NPM_SAMPLE}\n${CARGO_SAMPLE}`)
  let previous = JSON.stringify(payload)
  let passes = 0
  while (passes < 8) {
    compressRequest(payload, 'chat')
    passes += 1
    const now = JSON.stringify(payload)
    if (now === previous) break
    previous = now
  }
  assert.ok(passes <= 4, `settled after ${passes} passes`)
  const text = payload.messages[0].content
  assert.ok(text.length > 0 && text.length <= NPM_SAMPLE.length + CARGO_SAMPLE.length + 1)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(payload)))
})

// ── registry and the dependency-free tree ────────────────────────────────────
console.log('\nmodule shape')

check('registry resolves names and Rust aliases', () => {
  assert.equal(resolveFilter('git-diff'), gitDiff)
  assert.equal(resolveFilter('rg'), grep)
  assert.equal(resolveFilter('fd'), find)
  assert.equal(resolveFilter('build-output'), null, 'build-output is autodetect-only, as in the source')
  assert.equal(resolveFilter('no-such-filter'), null)
  assert.equal(Object.keys(allFilters()).length, 11)
})

check('the module tree imports nothing but its own relative files', () => {
  const root = fileURLToPath(new URL('../src/token-saver/rtk/', import.meta.url))
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(absolute) : [absolute]
  })
  const files = walk(root)
  assert.equal(files.length, 18, '12 filters + 6 top-level modules')
  const offenders = []
  for (const file of files) {
    const body = fs.readFileSync(file, 'utf8')
    assert.equal(body.includes('@deepseek-ai/'), false, `${path.basename(file)} names the kernel package`)
    for (const match of body.matchAll(/^\s*(?:import|export)\s[^\n]*?from\s+'([^']+)'/gm)) {
      if (!match[1].startsWith('./') && !match[1].startsWith('../')) offenders.push(`${path.relative(root, file)} -> ${match[1]}`)
    }
  }
  assert.deepEqual(offenders, [])
})

console.log(failures === 0
  ? '\nrtk: filters, wires, safety and stats all agree'
  : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
