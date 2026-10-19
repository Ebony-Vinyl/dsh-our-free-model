/**
 * Diagnostik riwayat tool call dengan nama ber-titik dua.
 *
 * Satu request: deklarasi + riwayat assistant tool_calls + tool result memakai
 * nama `mcp:rea:*`. Gateway harus menulis ulang ketiganya.
 *
 * Usage: node scripts/ofm-probe-colon-history.mjs [model]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.our-free-model', 'settings.json'), 'utf8'))
const key = settings.forwardKey
const url = 'http://127.0.0.1:18900/v1/chat/completions'
const model = process.argv[2] ?? 'deepseek-v4.1-flash-free'

const tools = [{
  type: 'function',
  function: {
    name: 'mcp:rea:inspect_artifact',
    description: 'Inspect an active archive in one call.',
    parameters: {
      type: 'object',
      properties: { detail: { type: 'string', enum: ['complete', 'summary'] } },
      required: ['detail'],
      additionalProperties: false,
    },
  },
}]

const body = {
  model,
  messages: [
    { role: 'system', content: 'You are a coding agent. Answer briefly.' },
    { role: 'user', content: 'Periksa artefak.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_colon_1',
        type: 'function',
        function: { name: 'mcp:rea:inspect_artifact', arguments: '{"detail":"summary"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_colon_1', content: '{"ok":true}' },
    { role: 'user', content: 'Sebutkan satu kata saja.' },
  ],
  tools,
  tool_choice: 'auto',
  stream: true,
  max_tokens: 128,
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
console.log(`\n=== riwayat colon -> HTTP ${status} (${Date.now() - started}ms) ===`)
console.log(text.slice(0, 700).replace(/\n/g, '\\n'))
