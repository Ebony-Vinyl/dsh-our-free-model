#!/usr/bin/env node
// Register the "Our-Free-Local" openai_compatible provider in Zed's settings.json.
// Inserts an empty stub so `node ofm-sync-zed.mjs` can then populate its model list.
// Idempotent: does nothing if the provider block already exists.
// Usage:  node ofm-register-zed-provider.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ZED_SETTINGS = process.env.ZED_SETTINGS
  || path.join(os.homedir(), 'AppData', 'Roaming', 'Zed', 'settings.json')

const PROVIDER = 'Our-Free-Local'
const ANCHOR = '"openai_compatible"'

const raw = fs.readFileSync(ZED_SETTINGS, 'utf8')
if (raw.includes(`"${PROVIDER}"`)) {
  console.log(`provider "${PROVIDER}" already present in ${ZED_SETTINGS}`)
  process.exit(0)
}

const ai = raw.indexOf(ANCHOR)
if (ai < 0) throw new Error(`${ANCHOR} not found in ${ZED_SETTINGS}`)

const brace = raw.indexOf('{', ai + ANCHOR.length)
if (brace < 0) throw new Error('could not find "openai_compatible" object')

// Match the indentation used by the first key inside the object.
const nl = raw.indexOf('\n', brace)
let indent = '      '
if (nl >= 0) {
  const line = raw.slice(nl + 1, raw.indexOf('\n', nl + 1))
  const m = line.match(/^(\s*)"/)
  if (m) indent = m[1]
}

const backup = `${ZED_SETTINGS}.bak-ofm-register`
fs.copyFileSync(ZED_SETTINGS, backup)
const stub = `\n${indent}"${PROVIDER}": {},`
fs.writeFileSync(ZED_SETTINGS, raw.slice(0, brace + 1) + stub + raw.slice(brace + 1))
console.log(`registered "${PROVIDER}" in ${ZED_SETTINGS}; backup: ${backup}`)
