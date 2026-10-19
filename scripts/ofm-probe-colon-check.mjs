/**
 * One live check of the colon-tool fix, through the local gateway.
 *
 * Before the fix a request carrying `mcp:rea:*` tool names was answered with
 * HTTP 400 and an empty upstream body. After it, the gateway rewrites the names
 * to the gate's alphabet, so the same request either streams (200) or draws the
 * lane's IP refusal (403 with a body) — never the empty 400.
 *
 * Deliberately sends exactly one request: the lane counts rapid probing as
 * abusive traffic.
 *
 * Usage: node scripts/ofm-probe-colon-check.mjs [model]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.our-free-model', 'settings.json'), 'utf8'))
const key = settings.forwardKey
const model = process.argv[2] ?? 'deepseek-v4.1-flash-free'

const tools = [
  ['mcp:rea:read_file', 'Reads the content of the given file in the project.', { path: { type: 'string', description: 'The relative path of the file to read.' } }, ['path']],
  ['mcp:rea:inspect_artifact', 'Inspect an active archive in one call.', { detail: { type: 'string', enum: ['complete', 'summary'] } }, ['detail']],
  ['mcp:rea:analyze_function', 'Build a dossier for one native function.', { procedure: { type: 'string', description: 'A procedure name or address.' } }, ['procedure']],
].map(([name, description, properties, required]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
}))

const body = {
  model,
  messages: [
    { role: 'system', content: 'You are a coding agent. Answer briefly.' },
    { role: 'user', content: 'Sebutkan satu kata saja.' },
  ],
  tools,
  tool_choice: 'auto',
  stream: true,
  max_tokens: 512,
}

const started = Date.now()
const response = await fetch('http://127.0.0.1:18900/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
})
const text = await response.text()
console.log(`HTTP ${response.status} (${Date.now() - started}ms)`)
console.log(text.slice(0, 600).replace(/\n/g, '\\n'))
if (response.status === 400) {
  console.log('\nSTILL BROKEN: the upstream rejected the payload.')
  process.exitCode = 1
}
