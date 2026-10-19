/**
 * Diagnostik replay body Zed yang tertangkap di debug/last-upstream.json.
 *
 * Memutar ulang body persis (atau versi yang dipotong) lewat gateway lokal,
 * lalu mencetak status upstream + potongan respons. Dipakai untuk memisahkan
 * "payload terlalu besar" dari "ada field yang ditolak".
 *
 * Usage:
 *   node scripts/ofm-probe-replay-size.mjs exact
 *   node scripts/ofm-probe-replay-size.mjs fewtools 10
 *   node scripts/ofm-probe-replay-size.mjs lastmsgs 6
 *   node scripts/ofm-probe-replay-size.mjs notools
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mode = process.argv[2] ?? 'exact'
const count = Number(process.argv[3] ?? 10)

const debugFile = process.env.OFM_DEBUG_FILE
  ?? path.join(os.homedir(), '.our-free-model', 'debug', 'last-upstream.json')
const dump = JSON.parse(fs.readFileSync(debugFile, 'utf8'))
const body = JSON.parse(dump.body)

if (mode === 'notools') {
  delete body.tools
} else if (mode === 'fewtools') {
  body.tools = (body.tools ?? []).slice(0, count)
} else if (mode === 'lastmsgs') {
  body.messages = (body.messages ?? []).slice(-count)
} else if (mode === 'thin') {
  body.tools = (body.tools ?? []).map(tool => ({
    type: 'function',
    function: {
      name: tool.function?.name,
      description: String(tool.function?.description ?? '').slice(0, 40),
      parameters: { type: 'object', properties: {} },
    },
  }))
} else if (mode === 'thinone') {
  const target = process.argv[3]
  body.tools = (body.tools ?? []).map(tool =>
    tool.function?.name === target
      ? {
          type: 'function',
          function: {
            name: tool.function.name,
            description: String(tool.function?.description ?? '').slice(0, 200),
            parameters: { type: 'object', properties: {} },
          },
        }
      : tool,
  )
} else if (mode === 'budget') {
  const target = Number(process.argv[3] ?? 400000)
  const base = { ...body, tools: [] }
  const baseBytes = JSON.stringify(base).length
  const kept = []
  for (const tool of body.tools ?? []) {
    const candidate = JSON.stringify({ ...base, tools: [...kept, tool] }).length
    if (candidate > target) continue
    kept.push(tool)
  }
  body.tools = kept
  console.log(`budget=${target} base=${baseBytes} kept=${kept.length}`)
} else if (mode === 'messagesonly') {
  delete body.tools
} else if (mode !== 'exact') {
  console.error(`unknown mode "${mode}"`)
  process.exit(2)
}

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.our-free-model', 'settings.json'), 'utf8'))
const key = settings.forwardKey
if (!key) {
  console.error('settings.forwardKey tidak ada')
  process.exit(2)
}

const payload = JSON.stringify(body)
console.log(
  `mode=${mode} bytes=${payload.length} tools=${body.tools?.length ?? 0} messages=${body.messages?.length ?? 0} max_tokens=${body.max_tokens} effort=${body.reasoning_effort}`,
)

const controller = new AbortController()
const started = Date.now()
const timer = setTimeout(() => controller.abort(), 30000)
let status = 0
let head = ''

try {
  const response = await fetch('http://127.0.0.1:18900/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: payload,
    signal: controller.signal,
  })
  status = response.status
  const reader = response.body?.getReader()
  if (reader) {
    const decoder = new TextDecoder()
    while (head.length < 1200) {
      const { value, done } = await reader.read()
      if (done) break
      head += decoder.decode(value, { stream: true })
    }
    await reader.cancel().catch(() => {})
  }
  console.log(`status=${status} ms=${Date.now() - started}`)
  console.log(`body=${head.slice(0, 900).replace(/\s+/g, ' ')}`)
} catch (error) {
  console.log(`status=${status} ms=${Date.now() - started} error=${error?.name}: ${error?.message}`)
  if (head) console.log(`body=${head.slice(0, 900).replace(/\s+/g, ' ')}`)
} finally {
  clearTimeout(timer)
}
