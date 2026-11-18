import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { renameAndCompleteTools } from '../src/o2a/toolshape.js'

const baseline = '4530975'
const snapshot = mkdtempSync(join(tmpdir(), 'ofm-toolshape-baseline-'))
try {
  execFileSync('tar', ['-xf', '-', '-C', snapshot], {
    input: execFileSync('git', ['archive', baseline, 'src/o2a']),
  })
  writeFileSync(join(snapshot, 'package.json'), '{"type":"module"}')
  const original = (await import(pathToFileURL(join(snapshot, 'src/o2a/toolshape.js')))).renameAndCompleteTools
  const tools = Array.from({ length: 40 }, (_, i) => ({ type: 'function', function: {
    name: `client_action_${i}`, description: `Action ${i}`, parameters: { type: 'object', properties: {} },
  } }))
  const request = { tools, messages: Array.from({ length: 100 }, (_, i) => ({
    role: 'assistant', tool_calls: [{ id: `call_${i}`, type: 'function', function: {
      name: `client_action_${i % tools.length}`, arguments: '{}',
    } }],
  })) }
  const before = structuredClone(request), after = structuredClone(request)
  const oldMap = original(before, 'chat'), newMap = renameAndCompleteTools(after, 'chat')
  assert.deepEqual(after.messages, before.messages)
  assert.deepEqual(after.tools.slice(0, tools.length), before.tools.slice(0, tools.length))
  assert.deepEqual(newMap.injected, oldMap.injected)
  assert.deepEqual([...newMap.known], [...oldMap.known])
  // Injected descriptions deliberately differ; compare caller routing, not prose.
  const functions = [original, renameAndCompleteTools], samples = [[], []]
  for (const fn of functions) for (let i = 0; i < 200; i++) fn(structuredClone(request), 'chat')
  for (let round = 0; round < 12; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const requests = Array.from({ length: 1000 }, () => structuredClone(request))
      const start = performance.now()
      for (const body of requests) functions[index](body, 'chat')
      samples[index].push(performance.now() - start)
    }
  }
  const [beforeMs, afterMs] = samples.map(values => values.sort((a, b) => a - b)[6])
  console.log(JSON.stringify({ baseline, shape: 'chat', requests: 1000, tools: 40, historyCalls: 100,
    beforeMs, afterMs, reductionPercent: (1 - afterMs / beforeMs) * 100 }))
} finally {
  rmSync(snapshot, { recursive: true, force: true })
}
