/**
 * Diagnostik bentuk pesan & batas token yang dikirim Zed.
 *
 * Tiga request kecil, berjeda:
 *   1. content sebagai array part (bentuk yang dipakai Zed)
 *   2. max_tokens = 1000000 (nilai "max_tokens" di settings Zed)
 *   3. riwayat assistant dengan field reasoning_content
 *
 * Usage: node scripts/ofm-probe-zed-messages.mjs [model]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.our-free-model', 'settings.json'), 'utf8'))
const key = settings.forwardKey
const url = 'http://127.0.0.1:18900/v1/chat/completions'
const model = process.argv[2] ?? 'deepseek-v4.1-flash-free'

const cases = [
  ['content array part', {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are a coding agent. Answer briefly.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Sebutkan satu kata saja.' }] },
    ],
    stream: true,
    max_tokens: 128,
  }],
  ['max_tokens 1000000', {
    messages: [
      { role: 'system', content: 'You are a coding agent. Answer briefly.' },
      { role: 'user', content: 'Sebutkan satu kata saja.' },
    ],
    stream: true,
    max_tokens: 1000000,
  }],
  ['riwayat reasoning_content', {
    messages: [
      { role: 'system', content: 'You are a coding agent. Answer briefly.' },
      { role: 'user', content: 'Halo' },
      { role: 'assistant', content: 'Hai.', reasoning_content: 'The user greeted me.' },
      { role: 'user', content: 'Sebutkan satu kata saja.' },
    ],
    stream: true,
    max_tokens: 128,
  }],
]

for (const [label, extra] of cases) {
  const body = { model, ...extra }
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
  console.log(`\n=== ${label} -> HTTP ${status} (${Date.now() - started}ms) ===`)
  console.log(text.slice(0, 600).replace(/\n/g, '\\n'))
  await new Promise(resolve => setTimeout(resolve, 3000))
}
