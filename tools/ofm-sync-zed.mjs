#!/usr/bin/env node
// Sync model list from the running Our-Free-Model standalone service into Zed's settings.json.
// Usage:  node ofm-sync-zed.mjs
// Reads port + API key from ~/.our-free-model/settings.json, fetches /v1/models,
// and rewrites the "Our-Free-Local" provider block in Zed settings (JSONC, text-splice).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OFM_HOME = process.env.OFM_HOME || path.join(os.homedir(), '.our-free-model')
const ZED_SETTINGS = process.env.ZED_SETTINGS
  || path.join(os.homedir(), 'AppData', 'Roaming', 'Zed', 'settings.json')

const PROVIDER = 'Our-Free-Local'

const settings = JSON.parse(fs.readFileSync(path.join(OFM_HOME, 'settings.json'), 'utf8'))
const key = settings.forwardKey
const port = settings.standalonePort || 18900
if (!key) throw new Error('forwardKey not found in OFM settings.json')

const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
if (!res.ok) throw new Error(`/v1/models -> HTTP ${res.status}`)
const models = (await res.json()).data

function pretty(id) {
  const parts = id.split('/')
  let base = parts[parts.length - 1]
  if (base === 'free') base = parts[parts.length - 2] || 'free'
  base = base.replace(/:free$/, '').replace(/-free$/, '')
  const name = base.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return id.includes('free') ? `${name} (free)` : name
}
const caps = () => ({
  tools: true, images: false, parallel_tool_calls: true, prompt_cache_key: false,
  chat_completions: true, interleaved_reasoning: false, max_tokens_parameter: true,
})
const newVal = {
  api_url: `http://127.0.0.1:${port}/v1`,
  available_models: models.map(m => ({
    name: m.id,
    display_name: pretty(m.id),
    max_tokens: m.context_window || 128000,
    max_output_tokens: Math.min(32768, m.context_window || 32768),
    capabilities: caps(),
  })),
}

const raw = fs.readFileSync(ZED_SETTINGS, 'utf8')
const keyStr = `"${PROVIDER}"`
const keyIdx = raw.indexOf(keyStr)
if (keyIdx < 0) throw new Error(`provider "${PROVIDER}" not found in ${ZED_SETTINGS}`)

let i = raw.indexOf(':', keyIdx + keyStr.length)
while (raw[i] !== '{') i++
let depth = 0, inStr = false, esc = false, end = -1
for (let j = i; j < raw.length; j++) {
  const c = raw[j]
  if (inStr) {
    if (esc) esc = false
    else if (c === '\\') esc = true
    else if (c === '"') inStr = false
    continue
  }
  if (c === '"') { inStr = true; continue }
  if (c === '{') depth++
  else if (c === '}') { depth--; if (depth === 0) { end = j; break } }
}
if (end < 0) throw new Error('could not find end of provider value')

const indent = '      '
const valText = JSON.stringify(newVal, null, 2)
  .split('\n').map((l, idx) => (idx === 0 ? l : indent + l)).join('\n')

const backup = `${ZED_SETTINGS}.bak-ofm-sync`
fs.copyFileSync(ZED_SETTINGS, backup)
fs.writeFileSync(ZED_SETTINGS, raw.slice(0, i) + valText + raw.slice(end + 1))
console.log(`synced ${models.length} models -> ${PROVIDER} (port ${port}); backup: ${backup}`)
