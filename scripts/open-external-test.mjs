import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createApiRoutes } from '../index.js'
import { externalUrl, MAX_EXTERNAL_URL_LENGTH, openExternal } from '../src/open-external.js'

const invalid = [
  undefined, null, {}, '', 'not a URL', 'https://', 'file:///C:/Windows/win.ini',
  'javascript:alert(1)', 'https://user@example.invalid/', 'https://user:password@example.invalid/',
  `https://example.invalid/${'a'.repeat(MAX_EXTERNAL_URL_LENGTH)}`,
]
for (const value of invalid) {
  assert.equal(externalUrl(value), null)
  assert.equal(await openExternal(value, { exec: () => assert.fail('invalid URL launched') }), false)
}
const prefix = 'https://example.invalid/'
const atLimit = prefix + 'a'.repeat(MAX_EXTERNAL_URL_LENGTH - prefix.length)
assert.equal(externalUrl(atLimit), atLimit)
assert.equal(externalUrl(`${atLimit}a`), null)
assert.equal(externalUrl(prefix + '\u00e9'.repeat(400)), null, 'normalization must not bypass the limit')

const url = "https://example.invalid/authorize?client_id=fixture&state=a'b&redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback"
let launch
assert.equal(await openExternal(url, { platform: 'win32', exec: async (...args) => { launch = args } }), true)
assert.match(launch[0], /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/)
assert.deepEqual(launch[1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
const script = Buffer.from(launch[1][3], 'base64').toString('utf16le')
assert.equal(script, `Start-Process -FilePath '${new URL(url).href.replaceAll("'", "''")}' -ErrorAction Stop`)
assert.equal(launch[2].windowsHide, true)
assert.ok(launch[2].timeout > 0)
for (const [platform, command] of [['darwin', '/usr/bin/open'], ['linux', 'xdg-open']]) {
  assert.equal(await openExternal(url, { platform, exec: async (...args) => { launch = args } }), true)
  assert.equal(launch[0], command)
  assert.deepEqual(launch[1], [new URL(url).href])
}
let failLaunch
const pendingLaunch = openExternal(url, { exec: () => new Promise((_, reject) => { failLaunch = reject }) })
failLaunch(new Error('fixture launcher failure'))
assert.equal(await pendingLaunch, false)
assert.equal(await openExternal(url, { exec: () => { throw new Error('fixture spawn failure') } }), false)
console.log('ok  opener validation, literal PowerShell encoding, native arguments and asynchronous failure')

async function request(handler, body, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = '/api/our-free-model/open-external'
  req.headers = { host: '127.0.0.1:18900', origin: 'http://127.0.0.1:18900', ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  let status, result
  await handler(req, { writeHead: value => { status = value }, end: value => { result = JSON.parse(value) } })
  return { status, result }
}
const calls = []
let opened = true, throws = false, release
const handler = createApiRoutes({
  openExternal: async target => {
    calls.push(target)
    if (throws) throw new Error('fixture launcher failure')
    if (release === null) return new Promise(resolve => { release = resolve })
    return opened
  },
})
for (const value of invalid) {
  assert.equal((await request(handler, { url: value })).status, 400)
}
assert.equal(calls.length, 0)
assert.equal((await request(handler, { url }, { origin: 'https://evil.invalid' })).status, 403)
assert.equal(calls.length, 0, 'admission must precede browser launching')
const denied = createApiRoutes({
  connection: { admit: () => ({ rejection: 401 }) },
  openExternal: () => assert.fail('host authentication denial launched a browser'),
})
assert.equal((await request(denied, { url })).status, 401)
release = null
let answered = false
const pending = request(handler, { url }).then(value => { answered = true; return value })
await new Promise(resolve => setImmediate(resolve))
assert.equal(answered, false, 'route must await the actual launch result')
release(true)
assert.deepEqual(await pending, { status: 200, result: { ok: true, opened: true } })
opened = false
assert.deepEqual((await request(handler, { url })).result, { ok: true, opened: false })
throws = true
assert.deepEqual((await request(handler, { url })).result, { ok: true, opened: false })
assert.ok(calls.every(target => target === new URL(url).href))
console.log('ok  open-external API admission, invalid bodies, awaited result and failure fallback')
