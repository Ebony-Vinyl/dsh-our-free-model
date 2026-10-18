#!/usr/bin/env node
// Probe berurutan untuk beberapa id, dengan batas waktu per model.
// Berhenti lebih awal bila gateway membalas 429 (kuota).
//
// Pemakaian: node scripts/ofm-probe-batch.mjs <id> [<id> ...]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ids = process.argv.slice(2)
if (ids.length === 0) {
  console.error('pemakaian: node scripts/ofm-probe-batch.mjs <id> [<id> ...]')
  process.exit(1)
}

const DATA_DIR = process.env.OFM_DATA_DIR || path.join(os.homedir(), '.our-free-model')
const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'))
const base = `http://127.0.0.1:${Number(settings.standalonePort) || 18900}`
const TIMEOUT_MS = 45000
// Jeda antar-probe agar tidak memicu rate limit. Bisa diatur lewat PROBE_DELAY_MS.
const DELAY_MS = Number(process.env.PROBE_DELAY_MS ?? 20000)

async function probe(id) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = Date.now()
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.forwardKey}` },
      signal: controller.signal,
      body: JSON.stringify({
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
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        }],
      }),
    })
    const ms = Date.now() - started
    if (!res.ok) {
      const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 140)
      return { id, status: res.status, ms, detail: text }
    }
    const text = await res.text()
    let calls = 0
    let finish = null
    let done = false
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') { done = true; continue }
      try {
        const chunk = JSON.parse(payload)
        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finish = choice.finish_reason
        if (choice.delta?.tool_calls?.length) calls += choice.delta.tool_calls.length
      } catch { /* abaikan baris rusak */ }
    }
    return { id, status: res.status, ms, calls, finish, done }
  } catch (error) {
    return { id, status: 'ERR', ms: Date.now() - started, detail: error.name === 'AbortError' ? `timeout ${TIMEOUT_MS} ms` : String(error.message) }
  } finally {
    clearTimeout(timer)
  }
}

for (const [index, id] of ids.entries()) {
  if (index > 0 && DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS))
  const row = await probe(id)
  if (row.status === 200) {
    console.log(`HIDUP  ${id}  (${row.ms} ms, tool_calls=${row.calls}, finish=${row.finish}, done=${row.done})`)
  } else {
    console.log(`MATI   ${id}  (HTTP ${row.status}, ${row.ms} ms) ${row.detail || ''}`)
    if (row.status === 429) {
      console.log('\nberhenti: kuota/rate limit tercapai')
      break
    }
  }
}
