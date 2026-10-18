#!/usr/bin/env node
// Probe satu model lewat gateway lokal: kirim 1 tool `read_file` dan laporkan
// apakah model benar-benar menghasilkan tool_calls.
//
// Pemakaian: node scripts/ofm-probe-model.mjs <model-id>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const id = process.argv[2]
if (!id) {
  console.error('pemakaian: node scripts/ofm-probe-model.mjs <model-id>')
  process.exit(1)
}

const DATA_DIR = process.env.OFM_DATA_DIR || path.join(os.homedir(), '.our-free-model')
const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'))
const base = `http://127.0.0.1:${Number(settings.standalonePort) || 18900}`

const body = {
  model: id,
  stream: true,
  messages: [
    { role: 'system', content: 'You are a coding agent. Use tools when asked.' },
    { role: 'user', content: 'Baca file package.json lalu sebutkan nama paketnya.' },
  ],
  tools: [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  }],
}

const started = Date.now()
const res = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${settings.forwardKey}`,
  },
  body: JSON.stringify(body),
})

console.log(`HTTP ${res.status} (${Date.now() - started} ms)`)
if (!res.ok) {
  console.log(await res.text())
  process.exit(0)
}

const text = await res.text()
let events = 0
let reasoning = 0
let content = ''
let toolCalls = 0
let finish = null
let done = false
let toolName = null
let toolArgs = ''

for (const line of text.split('\n')) {
  if (!line.startsWith('data:')) continue
  const payload = line.slice(5).trim()
  if (payload === '[DONE]') { done = true; continue }
  events += 1
  let chunk
  try { chunk = JSON.parse(payload) } catch { continue }
  const choice = chunk.choices?.[0]
  if (!choice) continue
  if (choice.finish_reason) finish = choice.finish_reason
  const delta = choice.delta || {}
  if (delta.reasoning_content) reasoning += delta.reasoning_content.length
  if (delta.content) content += delta.content
  for (const call of delta.tool_calls || []) {
    if (call.function?.name) { toolName = call.function.name; toolCalls += 1 }
    if (call.function?.arguments) toolArgs += call.function.arguments
  }
}

console.log(`events         : ${events}`)
console.log(`reasoning chars: ${reasoning}`)
console.log(`content chars  : ${content.length}`)
console.log(`tool_calls     : ${toolCalls}${toolName ? ` -> ${toolName}` : ''}`)
if (toolArgs) console.log(`tool_args      : ${toolArgs.slice(0, 160)}`)
console.log(`finish_reason  : ${finish}`)
console.log(`[DONE]         : ${done}`)
