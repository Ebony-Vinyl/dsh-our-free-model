/**
 * Satu diagnostik: apakah gateway menerima id polos dan label tampilan?
 *
 * Dua request kecil, berjeda, tanpa tool. Tujuannya memisahkan "model id yang
 * dikirim Zed salah" dari masalah payload lain.
 *
 * Usage: node scripts/ofm-probe-model-id.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.our-free-model', 'settings.json'), 'utf8'))
const key = settings.forwardKey
const url = 'http://127.0.0.1:18900/v1/chat/completions'

const cases = [
  ['id polos', 'deepseek-v4.1-flash-free'],
  ['label tampilan', 'DeepSeek V4.1 Flash (free) · sementara'],
]

for (const [label, model] of cases) {
  const body = {
    model,
    messages: [
      { role: 'system', content: 'Jawab satu kata.' },
      { role: 'user', content: 'Halo' },
    ],
    stream: true,
    max_tokens: 64,
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
  console.log(`\n=== ${label} :: ${JSON.stringify(model)} -> HTTP ${status} (${Date.now() - started}ms) ===`)
  console.log(text.slice(0, 500).replace(/\n/g, '\\n'))
  await new Promise(resolve => setTimeout(resolve, 2500))
}
