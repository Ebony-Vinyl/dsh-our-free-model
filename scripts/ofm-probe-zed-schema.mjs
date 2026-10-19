/**
 * Diagnostik bentuk payload Zed: jumlah tool vs skema kompleks.
 *
 * Dua request kecil, berjeda:
 *   1. 150 tool dengan skema sederhana  -> menguji batas jumlah tool
 *   2. 1 tool dengan union/anyOf/prefixItems -> menguji validasi skema
 *
 * Usage: node scripts/ofm-probe-zed-schema.mjs [model]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.our-free-model', 'settings.json'), 'utf8'))
const key = settings.forwardKey
const url = 'http://127.0.0.1:18900/v1/chat/completions'
const model = process.argv[2] ?? 'deepseek-v4.1-flash-free'

function simpleTool(index) {
  return {
    type: 'function',
    function: {
      name: `probe_tool_${index}`,
      description: `Probe tool number ${index}.`,
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'A value.' },
        },
        required: ['value'],
        additionalProperties: false,
      },
    },
  }
}

const manyTools = Array.from({ length: 150 }, (_, index) => simpleTool(index))

const complexTools = [{
  type: 'function',
  function: {
    name: 'probe_complex',
    description: 'A tool whose schema uses the same constructs Zed emits.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: ['string', 'null'], description: 'Optional path.' },
        mode: { type: 'string', enum: ['fast', 'slow'], default: 'fast' },
        target: {
          anyOf: [
            { type: 'string' },
            { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
          ],
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { kind: { type: 'string' }, value: { type: ['string', 'number', 'null'] } },
            required: ['kind'],
            additionalProperties: false,
          },
        },
        tuple: {
          type: 'array',
          prefixItems: [{ type: 'string' }, { type: 'integer' }],
          minItems: 2,
          maxItems: 2,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
}]

const cases = [
  ['150 tool sederhana', manyTools],
  ['skema kompleks', complexTools],
]

for (const [label, tools] of cases) {
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a coding agent. Answer briefly.' },
      { role: 'user', content: 'Sebutkan satu kata saja.' },
    ],
    tools,
    tool_choice: 'auto',
    stream: true,
    max_tokens: 256,
  }
  const started = Date.now()
  let status = 0
  let text = ''
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
    status = response.status
    text = await response.text()
  } catch (error) {
    text = `fetch error: ${error?.message ?? error}`
  }
  console.log(`\n=== ${label} (${tools.length} tool) -> HTTP ${status} (${Date.now() - started}ms) ===`)
  console.log(text.slice(0, 600).replace(/\n/g, '\\n'))
  await new Promise(resolve => setTimeout(resolve, 3000))
}
