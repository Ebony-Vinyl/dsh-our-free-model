// Compare the replacement filters with the pre-rewrite contract on identical input.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const baseline = '4530975'
const cases = {
  buildOutput: Array.from({ length: 100000 }, (_, i) => `npm warn deprecated package${i}`).join('\n') + '\nadded 100000 packages',
  gitLog: Array.from({ length: 100000 }, (_, i) => `${i.toString(16).padStart(7, '0')} commit subject ${i}`).join('\n'),
  ls: Array.from({ length: 100000 }, (_, i) => `-rw-r--r-- 1 user staff 1024 Jan 17 12:00 file${i}.js`).join('\n'),
  gitDiff: 'diff --git a/file.js b/file.js\n@@ -1,1 +1,100000 @@\n' + Array.from({ length: 100000 }, (_, i) => `+line ${i}`).join('\n'),
  gitStatus: '## main\n' + Array.from({ length: 100000 }, (_, i) => ` M src/file${i}.js`).join('\n'),
  dedupLog: Array.from({ length: 100000 }, (_, i) => `log group ${Math.floor(i / 100)}`).join('\n'),
  find: Array.from({ length: 100000 }, (_, i) => `/src/group${i % 50}/file${i}.js`).join('\n'),
  grep: Array.from({ length: 100000 }, (_, i) => `/src/group${i % 50}.js:${i + 1}: matching content`).join('\n'),
  searchList: "Result of search in '/src' (total 100000 files):\n" + Array.from({ length: 100000 }, (_, i) => `- /src/group${i % 50}/file${i}.js`).join('\n'),
  tree: Array.from({ length: 100000 }, (_, i) => `├── file${i}.js`).join('\n'),
  smartTruncate: Array.from({ length: 100000 }, (_, i) => `${i}: tool output`).join('\n'),
  readNumbered: Array.from({ length: 100000 }, (_, i) => `${i + 1}|source content`).join('\n'),
}

function medianMs(fn, input) {
  for (let i = 0; i < 5; i++) fn(input)
  const samples = []
  for (let i = 0; i < 20; i++) {
    const start = performance.now()
    fn(input)
    samples.push(performance.now() - start)
  }
  return samples.sort((a, b) => a - b)[10]
}

// Load the entire old module tree so baseline imports cannot use rewritten helpers.
const snapshot = mkdtempSync(join(tmpdir(), 'ofm-compression-baseline-'))
try {
  const archive = execFileSync('git', ['archive', baseline, 'src/token-saver/rtk'])
  execFileSync('tar', ['-xf', '-', '-C', snapshot], { input: archive })
  writeFileSync(join(snapshot, 'package.json'), '{"type":"module"}')
  for (const [name, input] of Object.entries(cases)) {
    const path = `src/token-saver/rtk/filters/${name}.js`
    const url = new URL(`../${path}`, import.meta.url)
    const original = (await import(pathToFileURL(join(snapshot, path)).href))[name]
    const replacement = (await import(url))[name]
    // The former hint required an RTK CLI that OFM does not install.
    const expected = name === 'gitDiff'
      ? original(input).replace('[full diff: rtk git diff --no-compact]', '[diff truncated by OFM; disable tool-output compression and request the diff again]')
      : original(input)
    assert.equal(replacement(input), expected, `${name}: output compatibility`)
    const before = medianMs(original, input)
    const after = medianMs(replacement, input)
    console.log(JSON.stringify({ name, baseline, inputBytes: Buffer.byteLength(input), beforeMs: before, afterMs: after, reductionPercent: (1 - after / before) * 100 }))
  }
} finally {
  rmSync(snapshot, { recursive: true, force: true })
}
