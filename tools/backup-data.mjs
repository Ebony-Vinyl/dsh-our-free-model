import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const src = path.join(os.homedir(), '.our-free-model')
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const dst = path.join(os.homedir(), `.our-free-model.backup-${ts}`)

fs.cpSync(src, dst, { recursive: true })
console.log(`Backup created: ${dst}`)