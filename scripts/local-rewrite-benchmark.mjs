import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { tryOptimizations } from '../src/local-optimize.js'

const source = execFileSync('git', ['show', '4530975:src/local-optimize.js'], { encoding: 'utf8' })
const original = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).tryOptimizations
const requests = [
  { max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] },
  { system: 'Return a sentence-case title', messages: [{ role: 'user', content: 'hello' }] },
  { messages: [{ role: 'user', content: '<policy_spec> Command: FOO=1 git status' }] },
  { messages: [{ role: 'user', content: '[SUGGESTION MODE: test]' }] },
  { messages: [{ role: 'user', content: 'filepaths Command: cat "a b.txt"\nOutput: test' }] },
]
for (const request of requests) assert.deepEqual(tryOptimizations(request), original(request))
const functions = [original, tryOptimizations], samples = [[], []]
for (const fn of functions) for (let i = 0; i < 20000; i++) fn(requests[i % requests.length])
for (let round = 0; round < 12; round++) {
  for (const index of round % 2 ? [1, 0] : [0, 1]) {
    const fn = functions[index], start = performance.now()
    for (let i = 0; i < 100000; i++) fn(requests[i % requests.length])
    samples[index].push(performance.now() - start)
  }
}
const [beforeMs, afterMs] = samples.map(times => times.sort((a, b) => a - b)[6])
console.log(JSON.stringify({ requests: 100000, beforeMs, afterMs, reductionPercent: (1 - afterMs / beforeMs) * 100 }))
