import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStandaloneEac } from '../packages/standalone/eac.mjs'
import { openExternal } from '../packages/standalone/open-external.mjs'

for (const url of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'https://user:password@example.com/']) {
  assert.equal(await openExternal(url, { exec: async () => assert.fail('不应执行非网页或带凭据的链接') }), false)
}
const address = "https://github.com/Ebony-Vinyl/dsh-our-free-model?quoted='&a=1"
let launch
assert.equal(await openExternal(address, { platform: 'win32', exec: async (...args) => { launch = args } }), true)
assert.match(launch[0], /powershell\.exe$/)
const script = Buffer.from(launch[1][3], 'base64').toString('utf16le')
assert.ok(script.includes("Start-Process -FilePath 'https://github.com/"))
assert.equal(script, `Start-Process -FilePath '${new URL(address).href.replaceAll("'", "''")}' -ErrorAction Stop`, 'URL 应作为 PowerShell 单个字面量传递')
console.log('ok  系统浏览器只接受 HTTP(S)，特殊字符不进入命令语法')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-desktop-regression-'))
try {
  const order = []
  const eac = createStandaloneEac({
    dataDir: directory,
    credentialOf: () => ({ mode: 'worker', base: 'https://gateway.invalid/eac/v1' }),
    fetch: async url => { assert.match(url, /\/auth\/github\/start\?link=/); order.push('registered'); return new Response(null, { status: 302 }) },
    openExternal: async url => { order.push('opened'); assert.match(url, /^https:\/\/gateway\.invalid\/eac\/auth\/github\/start\?link=/); return true },
  })
  const started = await eac.start()
  assert.equal(started.opened, true, '独立端应在注册会话后自动打开系统浏览器')
  assert.deepEqual(order, ['registered', 'opened'])
  assert.match(started.link, /^[A-Za-z0-9_-]{32}$/)
  eac.dispose()
  console.log('ok  EAC 注册完成后才打开浏览器，返回实际打开状态')

  const fallback = createStandaloneEac({
    dataDir: directory,
    credentialOf: () => ({ mode: 'worker', base: 'https://gateway.invalid/v1' }),
    fetch: async () => new Response(null, { status: 302 }),
    openExternal: async () => { throw new Error('no default browser') },
  })
  const manual = await fallback.start()
  assert.equal(manual.opened, false)
  assert.ok(manual.url && manual.link, '打开失败仍保留可手动打开的授权会话')
  fallback.dispose()
  console.log('ok  浏览器打开失败可手动继续授权')
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
