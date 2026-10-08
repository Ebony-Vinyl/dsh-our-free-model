/**
 * End-to-end tests for the in-app upgrader, against a local HTTP server that
 * stands in for the repository.
 *
 * Covers: version comparison, manifest validation, download + SHA-256 staging,
 * staged verification, backup/restore, the install swap (including cleanup of
 * dropped files and Windows-safe rename), history, and the failure paths — a
 * corrupted download must leave the installed package untouched.
 *
 * Run: node scripts/updater-test.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { parseVersion, compareVersions, parseManifest, fileUrlOf, downloadManifest, PluginUpdater, stageRelease, verifyStaged, backupPackage, restoreBackup, installStaged, verifyInstalled, signManifest, verifyManifestSignature, stableStringify, PINNED_MANIFEST_PUBLIC_KEY } from '../src/updater.js'
import { selfReload } from '../src/reload.js'
const CONTROLLED_DEFAULTS = ['http://127.0.0.1:1/never.json']

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}
const sha = body => crypto.createHash('sha256').update(body).digest('hex')

// ── version comparison ───────────────────────────────────────────────────────
check('parseVersion accepts semver and pre-release', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: null })
  assert.deepEqual(parseVersion('1.2.3-rc.1'), { major: 1, minor: 2, patch: 3, pre: ['rc', '1'] })
  assert.equal(parseVersion('1.2'), null)
  assert.equal(parseVersion('banana'), null)
})
check('compareVersions ordering', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.1.0', '1.0.9'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1, 'numeric pre parts compare numerically')
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
})

// ── manifest validation ──────────────────────────────────────────────────────
const manifestOf = overrides => ({
  version: '1.1.0', base: '../', files: [
    { path: 'index.js', sha256: 'a'.repeat(64), size: 10 },
    { path: 'package.json', sha256: 'b'.repeat(64), size: 10 },
  ], ...overrides,
})
check('manifest requires package.json', () => {
  assert.throws(() => parseManifest(manifestOf({ files: [{ path: 'index.js', sha256: 'a'.repeat(64), size: 1 }] })), /package\.json/)
})
check('manifest rejects path escapes and duplicates', () => {
  assert.throws(() => parseManifest(manifestOf({ files: [{ path: '../escape.js', sha256: 'a'.repeat(64), size: 1 }] })))
  assert.throws(() => parseManifest(manifestOf({ files: [{ path: '/abs.js', sha256: 'a'.repeat(64), size: 1 }] })))
  assert.throws(() => parseManifest(manifestOf({ files: [{ path: 'index.js', sha256: 'a'.repeat(64), size: 1 }, { path: 'index.js', sha256: 'b'.repeat(64), size: 1 }] })))
})
check('manifest rejects missing or malformed hashes', () => {
  assert.throws(() => parseManifest(manifestOf({ files: [{ path: 'index.js', sha256: 'nope', size: 1 }] })))
  assert.throws(() => parseManifest(manifestOf({ files: [{ path: 'index.js', sha256: 'a'.repeat(64), size: -5 }] })))
})
check('manifest base must stay manifest-relative (issue #19)', () => {
  for (const base of ['https://evil.example/', '//evil.example/', '/abs', 'C:\escape']) {
    assert.throws(() => parseManifest(manifestOf({ base })), /relative/, `base "${base}" must be refused`)
  }
  assert.equal(parseManifest(manifestOf({ base: '../' })).base, '../')
  assert.equal(parseManifest(manifestOf()).base, '../', 'absent base falls back to ../')
})
check('fileUrlOf joins base and encodes segments', () => {
  const url = fileUrlOf('https://raw.example/main/feed/manifest.json', parseManifest(manifestOf()), 'src/adapter.js')
  assert.equal(url, 'https://raw.example/main/src/adapter.js')
})

// ── the fake repository ──────────────────────────────────────────────────────
const OLD = '1.0.0'
const NEW = '1.1.0'
const oldFiles = { 'index.js': "export const v = '1.0.0'\n", 'package.json': JSON.stringify({ name: 'fake', version: OLD }), 'client.js': '// old client\n' }
const newFiles = { 'index.js': "export const v = '1.1.0'\n", 'package.json': JSON.stringify({ name: 'fake', version: NEW }), 'client.js': '// new client\n', 'src/new-deep.js': 'export const deep = true\n' }

function serveFrom(files) {
  // Keys are repo-root-relative ("index.js"); the manifest resolves
  // <base>/index.js against /repo/feed/manifest.json -> /repo/index.js.
  const stripped = {}
  for (const [key, body] of Object.entries(files)) stripped[key.replace(/^repo\//, '')] = body
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.replace(/^\/repo\//, ''))
    const body = stripped[rel]
    if (body === undefined) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(body)
  })
}
// Issue #19: the upgrader now refuses manifests it cannot attribute to the
// release key, so every fixture is signed with a throwaway keypair handed to
// the updater in place of the pinned public one.
const { publicKey: testPublicKey, privateKey: testPrivateKey } = crypto.generateKeyPairSync('ed25519')
const TEST_PUBLIC_KEY = testPublicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const manifestFor = files => {
  const unsigned = {
    version: NEW, base: '../', publishedAt: '2026-09-25T00:00:00Z', notes: '<p>fresh</p>',
    files: Object.entries(files).map(([rel, body]) => ({ path: rel, size: Buffer.byteLength(body), sha256: sha(body) })),
  }
  // Sign over the exact shape the verifier reconstructs (parseManifest's output).
  return { ...unsigned, signature: signManifest(parseManifest(unsigned), testPrivateKey) }
}
const newManifest = manifestFor(newFiles)
// The manifest hashes the real release; the corrupt server serves different
// bytes for index.js, so the staged copy can never hash-verify.
const corruptManifest = manifestFor(newFiles)

// Issue #120: emulate GitHub/CDN URLs through an entirely offline fetch seam.
// The mutable ref can move or serve stale bytes; only a resolved SHA is stable.
const SNAPSHOT = 'a'.repeat(40)
const NEXT_SNAPSHOT = 'b'.repeat(40)
const REPOSITORY = 'Ebony-Vinyl/dsh-our-free-model'
const rawSource = `https://raw.githubusercontent.com/${REPOSITORY}/main/feed/manifest.json`
const cdnSource = `https://cdn.jsdelivr.net/gh/${REPOSITORY}@main/feed/manifest.json`
const resolverUrl = `https://api.github.com/repos/${REPOSITORY}/commits/main`
const rawSnapshot = rawSource.replace('/main/', `/${SNAPSHOT}/`)
const cdnSnapshot = cdnSource.replace('@main/', `@${SNAPSHOT}/`)

function snapshotFetch({ source = rawSnapshot, resolver = { sha: SNAPSHOT }, resolverStatus = 200, manifest = newManifest } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url)
    parsed.search = ''
    const clean = parsed.href
    calls.push({ url: clean, options })
    if (clean === resolverUrl) return new Response(JSON.stringify(resolver), { status: resolverStatus })
    if (clean === source) return new Response(JSON.stringify(manifest))
    const prefix = new URL('../', source).href
    if (clean.startsWith(prefix)) {
      const body = newFiles[decodeURIComponent(clean.slice(prefix.length))]
      if (body !== undefined) return new Response(body)
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, calls }
}

for (const [name, source, snapshot] of [['raw', rawSource, rawSnapshot], ['CDN', cdnSource, cdnSnapshot]]) {
  await checkAsync(`${name} stages every file from the manifest's fixed commit, even when main moves`, async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-snapshot-'))
    const fixture = snapshotFetch({ source: snapshot })
    try {
      const result = await downloadManifest([source], { fetchImpl: fixture.fetchImpl, verifyKey: TEST_PUBLIC_KEY })
      assert.equal(result.source, snapshot)
      assert.equal(result.signed, true)
      await stageRelease({ manifest: result.manifest, manifestUrl: result.source, stageDir: data, fetchImpl: fixture.fetchImpl })
      verifyStaged(data, result.manifest)
      assert.equal(fixture.calls.length, 6, 'one resolution, one manifest and four files')
      assert.equal(fixture.calls.some(call => call.url === source), false, 'mutable manifest is never fetched')
      assert.equal(fixture.calls.every(call => call.options.redirect === 'error'), true)
      assert.equal(fixture.calls.filter(call => call.url === resolverUrl).length, 1)
    } finally { fs.rmSync(data, { recursive: true, force: true }) }
  })
}

await checkAsync('raw failure falls back to CDN at the same SHA without re-resolving a moving main', async () => {
  const fixture = snapshotFetch({ source: cdnSnapshot })
  const result = await downloadManifest([rawSource, cdnSource], { fetchImpl: fixture.fetchImpl, verifyKey: TEST_PUBLIC_KEY })
  assert.equal(result.source, cdnSnapshot)
  assert.equal(fixture.calls.filter(call => call.url === resolverUrl).length, 1)
  assert.equal(fixture.calls.some(call => call.url === rawSnapshot), true)
  assert.equal(fixture.calls.some(call => call.url === rawSource || call.url === cdnSource), false)
})

for (const source of [rawSnapshot, cdnSnapshot, 'https://mirror.example/repo/feed/manifest.json', 'http://127.0.0.1:18999/feed/manifest.json']) {
  await checkAsync(`immutable and custom sources need no resolver (${new URL(source).hostname})`, async () => {
    const fixture = snapshotFetch({ source })
    const result = await downloadManifest([source], { fetchImpl: fixture.fetchImpl, verifyKey: TEST_PUBLIC_KEY })
    assert.equal(result.source, source)
    assert.equal(fixture.calls.length, 1)
  })
}

for (const resolver of [{}, { sha: 'main' }, { sha: 'a'.repeat(7) }, { sha: '../escape' }, { sha: `https://evil.example/${SNAPSHOT}` }]) {
  await checkAsync(`an invalid snapshot fails closed (${JSON.stringify(resolver)})`, async () => {
    const fixture = snapshotFetch({ resolver })
    await assert.rejects(() => downloadManifest([cdnSource], { fetchImpl: fixture.fetchImpl, verifyKey: TEST_PUBLIC_KEY }), /full commit SHA/)
    assert.equal(fixture.calls.length, 1, 'no mutable manifest or file is fetched')
  })
}

for (const status of [403, 429, 503]) {
  await checkAsync(`resolver HTTP ${status} refuses a mutable download`, async () => {
    const fixture = snapshotFetch({ resolverStatus: status })
    await assert.rejects(() => downloadManifest([cdnSource], { fetchImpl: fixture.fetchImpl, verifyKey: TEST_PUBLIC_KEY }), new RegExp(`snapshot resolution failed.*HTTP ${status}`))
    assert.equal(fixture.calls.length, 1)
  })
}

await checkAsync('resolver timeout remains bounded and does not fall back to mutable files', async () => {
  let calls = 0
  const fetchImpl = (url, { signal }) => {
    calls++
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  // AbortSignal.timeout is unref'ed; keep this isolated fixture alive.
  const timer = setInterval(() => {}, 1000)
  try {
    await assert.rejects(() => downloadManifest([cdnSource], { fetchImpl, timeoutMs: 20 }), /timed out|timeout/i)
    assert.equal(calls, 1)
  } finally { clearInterval(timer) }
})

await checkAsync('a resolved snapshot still requires a valid release signature', async () => {
  const manifest = { ...newManifest, version: '9.0.0' }
  const fixture = snapshotFetch({ source: cdnSnapshot, manifest })
  await assert.rejects(() => downloadManifest([cdnSource], { fetchImpl: fixture.fetchImpl, verifyKey: TEST_PUBLIC_KEY }), /signature/)
  assert.equal(fixture.calls.length, 2, 'unsigned authority cannot authorize any file')
})

for (const error of [new TypeError('fetch failed'), new Error('HTTP 301'), new Error('HTTP 404')]) {
  await checkAsync(`an unavailable fixed CDN file falls back to gcore at the same SHA (${error.message})`, async () => {
    const fixture = snapshotFetch({ source: cdnSnapshot })
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cdn-fallback-'))
    const calls = []
    const fetchImpl = async (url, opts) => {
      const parsed = new URL(url)
      const target = parsed.pathname.endsWith('/src/new-deep.js')
      calls.push({ url: String(url), opts })
      if (target && parsed.hostname === 'cdn.jsdelivr.net') {
        if (error.message.startsWith('HTTP')) return new Response(null, { status: Number(error.message.slice(5)) })
        throw error
      }
      if (target && parsed.hostname === 'gcore.jsdelivr.net') {
        assert.match(parsed.pathname, new RegExp(`@${SNAPSHOT}/src/new-deep\\.js$`))
        return new Response(newFiles['src/new-deep.js'])
      }
      return fixture.fetchImpl(url, opts)
    }
    try {
      await stageRelease({ manifest: parseManifest(newManifest), manifestUrl: cdnSnapshot, stageDir: data, fetchImpl })
      verifyStaged(data, parseManifest(newManifest))
      assert.equal(calls.length, 5, 'only the failed file uses a second mirror')
      assert.equal(calls.every(call => call.opts.redirect === 'error'), true)
      const pair = calls.filter(call => call.url.includes('/src/new-deep.js'))
      assert.equal(pair[0].opts.signal, pair[1].opts.signal, 'mirror requests share one deadline')
    } finally { fs.rmSync(data, { recursive: true, force: true }) }
  })
}

for (const badBody of ['wrong size', newFiles['src/new-deep.js'].replace('true', 'xxxx')]) {
  await checkAsync('fixed CDN integrity failure never falls back or retries', async () => {
    const fixture = snapshotFetch({ source: cdnSnapshot })
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cdn-reject-'))
    const calls = []
    const fetchImpl = async (url, opts) => {
      calls.push(String(url))
      if (new URL(url).pathname.endsWith('/src/new-deep.js')) return new Response(badBody)
      return fixture.fetchImpl(url, opts)
    }
    try {
      await assert.rejects(() => stageRelease({ manifest: parseManifest(newManifest), manifestUrl: cdnSnapshot, stageDir: data, fetchImpl }), /size|sha256/)
      assert.equal(calls.length, 4)
      assert.equal(calls.some(url => url.includes('gcore')), false)
      assert.equal(fs.existsSync(data), false)
    } finally { fs.rmSync(data, { recursive: true, force: true }) }
  })
}

await checkAsync('gcore cannot authorize corrupt bytes after a transport fallback', async () => {
  const fixture = snapshotFetch({ source: cdnSnapshot })
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cdn-corrupt-'))
  let alternateCalls = 0
  const fetchImpl = async (url, opts) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/src/new-deep.js')) {
      if (parsed.hostname === 'cdn.jsdelivr.net') throw new TypeError('fetch failed')
      alternateCalls++
      return new Response('untrusted bytes')
    }
    return fixture.fetchImpl(url, opts)
  }
  try {
    await assert.rejects(() => stageRelease({ manifest: parseManifest(newManifest), manifestUrl: cdnSnapshot, stageDir: data, fetchImpl }), /size/)
    assert.equal(alternateCalls, 1)
    assert.equal(fs.existsSync(data), false)
  } finally { fs.rmSync(data, { recursive: true, force: true }) }
})

await checkAsync('CDN authorization refusal cannot trigger a mirror fallback', async () => {
  const fixture = snapshotFetch({ source: cdnSnapshot })
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cdn-denied-'))
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push(String(url))
    if (new URL(url).pathname.endsWith('/src/new-deep.js')) return new Response(null, { status: 403 })
    return fixture.fetchImpl(url, opts)
  }
  try {
    await assert.rejects(() => stageRelease({ manifest: parseManifest(newManifest), manifestUrl: cdnSnapshot, stageDir: data, fetchImpl }), /HTTP 403/)
    assert.equal(calls.length, 4)
    assert.equal(calls.some(url => url.includes('gcore')), false)
  } finally { fs.rmSync(data, { recursive: true, force: true }) }
})

const server = serveFrom({ 'repo/feed/manifest.json': JSON.stringify(newManifest), 'repo/index.js': newFiles['index.js'], 'repo/package.json': newFiles['package.json'], 'repo/client.js': newFiles['client.js'], 'repo/src/new-deep.js': newFiles['src/new-deep.js'] })
const corruptServer = serveFrom({ 'repo/feed/manifest.json': JSON.stringify(corruptManifest), 'repo/index.js': 'tampered\n', 'repo/package.json': newFiles['package.json'], 'repo/client.js': newFiles['client.js'], 'repo/src/new-deep.js': newFiles['src/new-deep.js'] })
const badManifestServer = serveFrom({ 'repo/feed/manifest.json': '{"version": "oops"}' })
await Promise.all([server, corruptServer, badManifestServer].map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))))
const [base, corruptBase, badBase] = [server, corruptServer, badManifestServer].map(s => `http://127.0.0.1:${s.address().port}`)

function makePackage(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-pkg-'))
  for (const [rel, body] of Object.entries(version === OLD ? oldFiles : newFiles)) {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
  }
  return dir
}
function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-data-'))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const updaterVersion = pkg => JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version

await checkAsync('apply re-resolves after check and installs only the new immutable snapshot', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const updatedFiles = { ...newFiles, 'index.js': '// second reviewed snapshot\n' }
  const updatedManifest = manifestFor(updatedFiles)
  let resolutions = 0
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push(String(url))
    if (url === resolverUrl) return new Response(JSON.stringify({ sha: ++resolutions === 1 ? SNAPSHOT : NEXT_SNAPSHOT }))
    const prefix = `https://raw.githubusercontent.com/${REPOSITORY}/${resolutions === 1 ? SNAPSHOT : NEXT_SNAPSHOT}/`
    if (url === prefix + 'feed/manifest.json') return new Response(JSON.stringify(resolutions === 1 ? newManifest : updatedManifest))
    const rel = String(url).slice(prefix.length)
    return new Response((resolutions === 1 ? newFiles : updatedFiles)[rel] ?? 'bad ref', { status: String(url).startsWith(prefix) ? 200 : 404 })
  }
  try {
    const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({}), fetchImpl, defaultSources: [rawSource], manifestPublicKey: TEST_PUBLIC_KEY })
    await updater.check()
    assert.equal(updater.manifestUrl, rawSnapshot)
    await updater.apply({ version: NEW })
    assert.equal(resolutions, 2, 'apply obtains a fresh snapshot, not the old check result')
    assert.equal(updater.manifestUrl, rawSource.replace('/main/', `/${NEXT_SNAPSHOT}/`))
    assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), updatedFiles['index.js'])
    assert.equal(requests.some(url => url === rawSource), false)
    assert.equal(requests.filter(url => url.includes(`/${SNAPSHOT}/`)).length, 1, 'old snapshot supplies no file to apply')
    assert.equal(updater.status().lastApplied.ok, true)
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

await checkAsync('stageRelease downloads and verifies', async () => {
  const data = makeDataDir()
  const manifest = parseManifest(newManifest)
  const stats = await stageRelease({ manifest, manifestUrl: `${base}/repo/feed/manifest.json`, stageDir: path.join(data, 'stage'), fetchImpl: fetch })
  assert.equal(stats.files, 4)
  verifyStaged(path.join(data, 'stage'), manifest)
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('a hash mismatch aborts staging', async () => {
  const data = makeDataDir()
  const manifest = parseManifest(corruptManifest)
  await assert.rejects(() => stageRelease({ manifest, manifestUrl: `${corruptBase}/repo/feed/manifest.json`, stageDir: path.join(data, 'stage'), fetchImpl: fetch }), /sha256 mismatch|staging failed/)
  assert.equal(fs.existsSync(path.join(data, 'stage')), false, 'the bad staging copy is removed')
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('stageRelease retries a dropped connection and succeeds', async () => {
  const data = makeDataDir()
  const manifest = parseManifest(newManifest)
  let calls = 0
  const flaky = async (url, opts) => {
    calls += 1
    if (calls === 2) throw new TypeError('fetch failed')
    return fetch(url, opts)
  }
  const stats = await stageRelease({ manifest, manifestUrl: `${base}/repo/feed/manifest.json`, stageDir: path.join(data, 'stage'), fetchImpl: flaky })
  assert.equal(stats.files, 4)
  assert.equal(calls, 5, 'exactly one file was retried once')
  verifyStaged(path.join(data, 'stage'), manifest)
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('an integrity failure never retries', async () => {
  const data = makeDataDir()
  const manifest = parseManifest(corruptManifest)
  let calls = 0
  const counting = (url, opts) => { calls += 1; return fetch(url, opts) }
  await assert.rejects(() => stageRelease({ manifest, manifestUrl: `${corruptBase}/repo/feed/manifest.json`, stageDir: path.join(data, 'stage'), fetchImpl: counting }), /sha256 mismatch|staging failed/)
  assert.equal(calls, 4, 'one attempt per file — the trust chain does not get benefit of the doubt')
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('PluginUpdater.check detects the newer version', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({ feedUrl: `${base}/repo/feed/announcements.json` }), fetchImpl: fetch, defaultSources: [`${base}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY })
  const status = await updater.check()
  assert.deepEqual(status, { available: true, current: OLD, latest: NEW })
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('PluginUpdater rejects an unparsable manifest', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({}), fetchImpl: fetch, defaultSources: [`${badBase}/repo/feed/manifest.json`] })
  await assert.rejects(() => updater.check())
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('a manifest without a signature is refused', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const unsigned = JSON.parse(JSON.stringify(newManifest))
  delete unsigned.signature
  const unsignedServer = serveFrom({ 'repo/feed/manifest.json': JSON.stringify(unsigned) })
  await new Promise(resolve => unsignedServer.listen(0, '127.0.0.1', resolve))
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({}), fetchImpl: fetch, defaultSources: [`http://127.0.0.1:${unsignedServer.address().port}/repo/feed/manifest.json`] })
  await assert.rejects(() => updater.check(), /signature/)
  unsignedServer.close()
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('a manifest tampered after signing is refused', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const tampered = JSON.parse(JSON.stringify(newManifest))
  tampered.version = '9.9.9'
  const tamperedServer = serveFrom({ 'repo/feed/manifest.json': JSON.stringify(tampered) })
  await new Promise(resolve => tamperedServer.listen(0, '127.0.0.1', resolve))
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({}), fetchImpl: fetch, defaultSources: [`http://127.0.0.1:${tamperedServer.address().port}/repo/feed/manifest.json`] })
  await assert.rejects(() => updater.check(), /signature/)
  tamperedServer.close()
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('a manifest signed by another key is refused', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const stranger = crypto.generateKeyPairSync('ed25519').privateKey
  const foreign = { ...JSON.parse(JSON.stringify(newManifest)), signature: signManifest(parseManifest(newManifest), stranger) }
  const foreignServer = serveFrom({ 'repo/feed/manifest.json': JSON.stringify(foreign) })
  await new Promise(resolve => foreignServer.listen(0, '127.0.0.1', resolve))
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({}), fetchImpl: fetch, defaultSources: [`http://127.0.0.1:${foreignServer.address().port}/repo/feed/manifest.json`] })
  await assert.rejects(() => updater.check(), /signature/)
  foreignServer.close()
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('the feedUrl setting no longer redirects update checks', async () => {
  // Issue #19: a settings value that could point the update channel anywhere
  // was one step from arbitrary code execution. The override now reaches the
  // announcements only; this server answers, but the updater must not call it.
  let hits = 0
  const watched = http.createServer(() => { hits += 1 })
  await new Promise(resolve => watched.listen(0, '127.0.0.1', resolve))
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const updater = new PluginUpdater({
    pkgDir: pkg, dataDir: data,
    settings: () => ({ feedUrl: `http://127.0.0.1:${watched.address().port}/repo/feed/announcements.json` }),
    fetchImpl: fetch, defaultSources: [`${base}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY,
  })
  const status = await updater.check()
  assert.equal(status.available, true)
  assert.equal(hits, 0, 'the update check never touched the feed override')
  watched.close()
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
check('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { z: null, y: 'x' }] }), stableStringify({ a: [2, { y: 'x', z: null }], b: 1 }))
})
check('verifyManifestSignature answers false on malformed input', () => {
  assert.equal(verifyManifestSignature(null, TEST_PUBLIC_KEY), false)
  assert.equal(verifyManifestSignature({ version: '1.0.0' }, TEST_PUBLIC_KEY), false)
  assert.equal(verifyManifestSignature({ version: '1.0.0', signature: 'not base64!!' }, TEST_PUBLIC_KEY), false)
  assert.equal(verifyManifestSignature({ ...newManifest }, ''), false, 'an empty pinned key refuses everything')
})
await checkAsync('apply() upgrades the package in place and records history', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({}), fetchImpl: fetch, defaultSources: [`${base}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY })
  const phases = []
  const result = await updater.apply({ onProgress: progress => { if (progress?.phase !== undefined) phases.push(progress.phase) } })
  assert.deepEqual(result, { version: NEW, previous: OLD, files: 4, bytes: Object.values(newFiles).reduce((sum, body) => sum + Buffer.byteLength(body), 0) })
  assert.equal(updater.currentVersion(), NEW)
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version, NEW)
  assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), newFiles['index.js'])
  assert.ok(fs.existsSync(path.join(pkg, 'src', 'new-deep.js')), 'newly added files land')
  assert.deepEqual(phases, ['download', 'install'])
  // the backup holds the previous version
  assert.equal(JSON.parse(fs.readFileSync(path.join(updater.backupDir, 'package.json'), 'utf8')).version, OLD)
  // history is durable
  assert.equal(updater.history.at(-1).ok, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'updates.json'), 'utf8')).applied.at(-1).to, NEW)
  // and the status flips to up-to-date
  assert.equal(updater.status().available, false)
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('apply() drops files the new release removed', async () => {
  const pkg = makePackage(OLD)
  fs.writeFileSync(path.join(pkg, 'obsolete.js'), 'gone soon\n')
  // A development install *is* the git working tree, so the repository's own
  // scaffolding sits beside the shipped files: it is not part of any release,
  // and the sweep that drops obsolete files must not eat the test suite or the
  // history directory. The backup must not copy it either.
  fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'scripts', 'picker-test.mjs'), 'kept\n')
  fs.mkdirSync(path.join(pkg, 'feed'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'feed', 'manifest.json'), '{}\n')
  fs.mkdirSync(path.join(pkg, '.git'), { recursive: true })
  fs.writeFileSync(path.join(pkg, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  // The same protection covers what an ecosystem pack lays down: its catalog
  // records must outlive an in-app upgrade, or the harness's bundle validation
  // loses the ground it stands on. `worker`/`vendor` ship for self-hosters.
  fs.mkdirSync(path.join(pkg, 'catalog'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'catalog', 'dsh-plugin.json'), '{}\n')
  fs.mkdirSync(path.join(pkg, 'worker'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'worker', 'worker.js'), 'kept\n')
  fs.mkdirSync(path.join(pkg, 'vendor'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'vendor', 'lib.js'), 'kept\n')
  const data = makeDataDir()
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({}), fetchImpl: fetch, defaultSources: [`${base}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY })
  await updater.apply({})
  assert.equal(fs.existsSync(path.join(pkg, 'obsolete.js')), false, 'a file absent from the manifest is removed')
  assert.equal(fs.existsSync(path.join(pkg, 'scripts', 'picker-test.mjs')), true, 'the development scaffolding survives')
  assert.equal(fs.existsSync(path.join(pkg, 'feed', 'manifest.json')), true, 'including the feed the manifest is published from')
  assert.equal(fs.existsSync(path.join(pkg, 'catalog', 'dsh-plugin.json')), true, 'the ecosystem pack records survive an upgrade')
  assert.equal(fs.existsSync(path.join(pkg, 'worker', 'worker.js')), true, 'the self-hosted gateway sources survive')
  assert.equal(fs.existsSync(path.join(pkg, 'vendor', 'lib.js')), true, 'vendored sources survive')
  assert.equal(fs.existsSync(path.join(pkg, '.git', 'HEAD')), true, 'and the git history')
  assert.equal(fs.existsSync(path.join(updater.backupDir, '.git', 'HEAD')), false, 'the rollback copy holds the package, not the repository')
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('a failed apply leaves the installed package and history consistent', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  // The corrupt server's bytes never hash-verify, so staging aborts before the
  // installed package is touched; the failure lands in the history log.
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({}), fetchImpl: fetch, defaultSources: [`${corruptBase}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY })
  await assert.rejects(() => updater.apply({}), /staging failed/)
  assert.equal(updater.currentVersion(), OLD)
  assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), oldFiles['index.js'])
  assert.equal(updater.history.at(-1).ok, false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'updates.json'), 'utf8')).applied.at(-1).ok, false)
  assert.equal(fs.existsSync(path.join(data, 'upgrade-stage')), false, 'the rejected staging copy is cleaned up')
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('restoreBackup recovers a mixed install state', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backupDir = path.join(data, 'rollback')
  backupPackage(pkg, backupDir)
  // Simulate a swap that got half-way: some new files in, one overwritten.
  fs.writeFileSync(path.join(pkg, 'index.js'), newFiles['index.js'])
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'src', 'new-deep.js'), newFiles['src/new-deep.js'])
  restoreBackup(backupDir, pkg)
  assert.equal(updaterVersion(pkg), OLD)
  assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), oldFiles['index.js'])
  assert.equal(fs.readFileSync(path.join(pkg, 'client.js'), 'utf8'), oldFiles['client.js'])
  assert.equal(fs.existsSync(path.join(pkg, 'src', 'new-deep.js')), false, 'files the old version never had are gone')
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('restoreBackup refuses to wipe a package with no rollback copy', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  // This install never applied an update, so the rollback directory does not
  // exist — the restore must decline instead of emptying the package.
  const backupDir = path.join(data, 'rollback')
  assert.throws(() => restoreBackup(backupDir, pkg), /no rollback copy/)
  assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), oldFiles['index.js'], 'the installed package is untouched')
  assert.equal(fs.readFileSync(path.join(pkg, 'client.js'), 'utf8'), oldFiles['client.js'], 'no file was deleted')
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('channel runtime bytes are backed up and restored without sweeping vendor sources', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backup = path.join(data, 'rollback')
  const assets = {
    'vendor/channel-pack/pack.js': Buffer.from('export const pack = "old";\n'),
    'vendor/channel-pack/qoder-auth-wasm.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    'vendor/channel-pack/NOTICE.md': Buffer.from('old notice\n'),
    'vendor/channel-pack/LICENSE': Buffer.from('old license\n'),
  }
  try {
    for (const [rel, bytes] of Object.entries(assets)) {
      const file = path.join(pkg, rel)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
    }
    const source = path.join(pkg, 'vendor/channel-pack/src/index.ts')
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, 'development source\n')
    backupPackage(pkg, backup)
    for (const [rel, bytes] of Object.entries(assets)) {
      assert.deepEqual(fs.readFileSync(path.join(backup, rel)), bytes, `${rel} is backed up byte-for-byte`)
      fs.writeFileSync(path.join(pkg, rel), 'new incompatible runtime')
    }
    assert.equal(fs.existsSync(path.join(backup, 'vendor/channel-pack/src/index.ts')), false)
    restoreBackup(backup, pkg)
    for (const [rel, bytes] of Object.entries(assets)) assert.deepEqual(fs.readFileSync(path.join(pkg, rel)), bytes)
    assert.equal(fs.readFileSync(source, 'utf8'), 'development source\n')
    // A release that drops the pack must also drop those runtime files while
    // retaining development scaffolding, even after package.json is replaced.
    const stage = path.join(data, 'stage')
    fs.mkdirSync(stage)
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ version: NEW }))
    await installStaged(stage, pkg, ['package.json'])
    for (const rel of Object.keys(assets)) assert.equal(fs.existsSync(path.join(pkg, rel)), false)
    assert.equal(fs.readFileSync(source, 'utf8'), 'development source\n')
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})
await checkAsync('rollback from a failed 1.x to 2.x swap removes newly added channel runtime', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  try {
    const backup = path.join(data, 'rollback')
    backupPackage(pkg, backup)
    fs.mkdirSync(path.join(pkg, 'vendor/channel-pack'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'vendor/channel-pack/pack.js'), 'new pack')
    fs.writeFileSync(path.join(pkg, 'vendor/channel-pack/qoder-auth-wasm.wasm'), Buffer.from([0, 1, 2]))
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '2.0.0' }))
    restoreBackup(backup, pkg)
    assert.equal(updaterVersion(pkg), OLD)
    assert.equal(fs.existsSync(path.join(pkg, 'vendor/channel-pack/pack.js')), false)
    assert.equal(fs.existsSync(path.join(pkg, 'vendor/channel-pack/qoder-auth-wasm.wasm')), false)
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})
await checkAsync('restoreBackup reports copy failures and still restores the rest', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backupDir = path.join(data, 'rollback')
  backupPackage(pkg, backupDir)
  // A directory squatting where a file belongs makes copyFileSync fail
  // (EISDIR) without depending on platform-specific lock semantics.
  fs.rmSync(path.join(pkg, 'client.js'), { force: true })
  fs.mkdirSync(path.join(pkg, 'client.js'), { recursive: true })
  assert.throws(() => restoreBackup(backupDir, pkg), /rollback incomplete.*client\.js/s)
  assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), oldFiles['index.js'], 'the other files were still put back')
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('restoreBackup replaces a file that refuses the write', async () => {
  if (process.getuid?.() === 0) return // root ignores the read-only bit, so there is nothing to prove
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backupDir = path.join(data, 'rollback')
  backupPackage(pkg, backupDir)
  // The swap already rewrote index.js on a machine where the file carries the
  // read-only attribute (a sync client or an attribute editor leaves it that
  // way). Copying straight over it is denied; the target has to be cleared and
  // tried again — which is what the old delete-everything-first order handed
  // every copy for free, and losing it turned a recoverable rollback into
  // `rollback incomplete`.
  fs.writeFileSync(path.join(pkg, 'index.js'), newFiles['index.js'])
  fs.chmodSync(path.join(pkg, 'index.js'), 0o444)
  restoreBackup(backupDir, pkg)
  assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), oldFiles['index.js'], 'the read-only file was put back')
  assert.equal(fs.readFileSync(path.join(pkg, 'client.js'), 'utf8'), oldFiles['client.js'], 'and the rest of the package with it')
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('installStaged + verifyInstalled accept a good stage', async () => {
  const pkg = makePackage(OLD)
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-stage-'))
  for (const [rel, body] of Object.entries(newFiles)) {
    const target = path.join(stage, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
  }
  const manifest = parseManifest(newManifest)
  await installStaged(stage, pkg, manifest.files.map(file => file.path))
  verifyInstalled(pkg, manifest)
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(stage, { recursive: true, force: true })
})

function fixtureUpdater(pkg, data, runningVersion = OLD) {
  return new PluginUpdater({
    pkgDir: pkg, dataDir: data, runningVersion, settings: () => ({}),
    defaultSources: [`${base}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY,
  })
}

/** Host loader stand-in; the real selfReload still performs every transition. */
function reloadHost(mode) {
  const previous = { apply() {}, version: OLD }
  const replacement = { apply() {}, version: NEW }
  let running = previous
  const parent = { registry: { plugin(callback) {
    running = callback
    return { ctx: { fiber: { await: async () => {
      if (callback === replacement && ['startup-failure', 'restore-failure'].includes(mode)) throw new Error('replacement startup refused')
      if (callback === previous && mode === 'restore-failure') throw new Error('previous runtime restore refused')
    } } } }
  } } }
  const fiber = { uid: 1, parent, _config: {}, await: async () => {} }
  return {
    running: () => running,
    ctx: {
      fiber: { runtime: { callback: previous } },
      registry: {
        get: callback => callback === previous ? { fibers: [fiber] } : undefined,
        delete: callback => { if (running === callback) running = undefined },
      },
      loader: {
        internal: { loadCache: new Map() },
        unwrapExports: value => value,
        import: async () => {
          if (mode === 'import-failure') throw new Error('replacement import refused')
          return mode === 'stale-cache' ? previous : replacement
        },
      },
    },
  }
}

for (const mode of ['import-failure', 'startup-failure', 'restore-failure', 'stale-cache', 'success']) {
  await checkAsync(`upgrade includes real hot reload outcome: ${mode}`, async () => {
    const pkg = makePackage(OLD)
    const data = makeDataDir()
    const updater = fixtureUpdater(pkg, data)
    const host = reloadHost(mode)
    let successor
    try {
      const operation = updater.apply({ activate: async () => {
        successor = fixtureUpdater(pkg, data, NEW)
        assert.equal(successor.status().applying, true, 'the successor sees the same in-flight upgrade')
        assert.equal(successor.status().lastApplied, undefined, 'no premature success record')
        await assert.rejects(() => successor.apply(), /already running/)
        return selfReload(host.ctx, { logger: {}, expectedVersion: NEW })
      } })
      if (mode === 'success') {
        await operation
        assert.equal(host.running().version, NEW)
        assert.equal(updaterVersion(pkg), NEW)
        assert.equal(successor.status().lastApplied.ok, true, 'the successor observes the committed history')
        assert.equal(successor.status().lastApplied.activated, true)
        assert.equal(successor.status().recoveryRequired, false)
      } else {
        await assert.rejects(() => operation, /replacement|restore failed|activation version mismatch/)
        assert.equal(updaterVersion(pkg), OLD)
        assert.equal(updater.status().lastApplied.ok, false)
        assert.equal(updater.status().recoveryRequired, mode === 'restore-failure')
        if (mode !== 'restore-failure') assert.equal(host.running().version, OLD)
        assert.equal(updater.status().applying, false)
      }
    } finally {
      fs.rmSync(pkg, { recursive: true, force: true })
      fs.rmSync(data, { recursive: true, force: true })
    }
  })
}

for (const returnedVersion of [OLD, undefined]) {
  await checkAsync(`activation cannot commit an unconfirmed target version (${returnedVersion ?? 'missing'})`, async () => {
    const pkg = makePackage(OLD)
    const data = makeDataDir()
    const updater = fixtureUpdater(pkg, data)
    try {
      await assert.rejects(() => updater.apply({ activate: async () => ({ ok: true, version: returnedVersion }) }),
        /activation version mismatch/)
      assert.equal(updaterVersion(pkg), OLD)
      assert.equal(updater.status().lastApplied.ok, false)
      assert.equal(updater.status().phase, 'recovery-required', 'an unknown runtime cannot be declared restored')
      assert.equal(updater.status().recoveryRequired, true)
    } finally {
      fs.rmSync(pkg, { recursive: true, force: true })
      fs.rmSync(data, { recursive: true, force: true })
    }
  })
}

await checkAsync('reload and rollback failures remain visible across instances and restarts', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const updater = fixtureUpdater(pkg, data)
  const host = reloadHost('import-failure')
  const original = fs.copyFileSync
  try {
    fs.copyFileSync = (from, to, ...args) => {
      if (String(from).startsWith(updater.backupDir + path.sep) && to === path.join(pkg, 'package.json')) {
        throw Object.assign(new Error('EPERM: restoration refused'), { code: 'EPERM' })
      }
      return original(from, to, ...args)
    }
    await assert.rejects(() => updater.apply({ activate: () => selfReload(host.ctx, { logger: {} }) }),
      /replacement import refused.*rollback also failed.*EPERM/)
    const status = fixtureUpdater(pkg, data).status()
    assert.equal(status.current, OLD)
    assert.equal(status.installedVersion, NEW)
    assert.equal(status.versionMismatch, true)
    assert.equal(status.recoveryRequired, true)
    assert.equal(status.applying, false, 'a terminated attempt is not permanently busy')
    assert.equal(status.lastApplied.ok, false)
    assert.equal(status.lastApplied.to, NEW)
    assert.match(status.error, /rollback also failed/)
    assert.equal(updaterVersion(updater.backupDir), OLD, 'the repair material is retained')
    await assert.rejects(() => fixtureUpdater(pkg, data).apply(), /requires recovery/)
  } finally {
    fs.copyFileSync = original
  }
  // A manual restore followed by a fresh old runtime and a check is sufficient
  // to clear the blocker, but only when every retained byte matches.
  try {
    restoreBackup(updater.backupDir, pkg)
    const restarted = fixtureUpdater(pkg, data)
    await restarted.check()
    assert.equal(restarted.status().recoveryRequired, false)
    assert.equal(restarted.status().phase, 'rolled-back')
    await restarted.apply({ activate: async () => ({ ok: true, version: NEW }) })
    assert.equal(restarted.status().lastApplied.ok, true)
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

for (const denyRollback of [false, true]) {
  await checkAsync(`partial installation failure verifies rollback (denied=${denyRollback})`, async () => {
    const pkg = makePackage(OLD)
    const data = makeDataDir()
    const updater = fixtureUpdater(pkg, data)
    const original = fs.copyFileSync
    try {
      fs.copyFileSync = (from, to, ...args) => {
        if (to === path.join(pkg, 'client.js.ofm-new')
          || (denyRollback && to === path.join(pkg, 'package.json') && String(from).startsWith(updater.backupDir + path.sep))) {
          throw Object.assign(new Error('EPERM: injected file refusal'), { code: 'EPERM' })
        }
        return original(from, to, ...args)
      }
      await assert.rejects(() => updater.apply(), denyRollback ? /rollback also failed/ : /previous files restored/)
      assert.equal(updaterVersion(pkg), denyRollback ? NEW : OLD)
      assert.equal(updater.status().recoveryRequired, denyRollback)
      assert.equal(updater.status().lastApplied.ok, false)
      assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), oldFiles['index.js'])
    } finally {
      fs.copyFileSync = original
      fs.rmSync(pkg, { recursive: true, force: true })
      fs.rmSync(data, { recursive: true, force: true })
    }
  })
}

await checkAsync('failed backup creation preserves the existing verified backup and installed bytes', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const updater = fixtureUpdater(pkg, data)
  backupPackage(pkg, updater.backupDir)
  const original = fs.copyFileSync
  try {
    fs.copyFileSync = (from, to, ...args) => {
      if (String(to).includes('rollback.pending-') && String(to).endsWith('client.js')) throw new Error('backup copy refused')
      return original(from, to, ...args)
    }
    await assert.rejects(() => updater.apply(), /backup copy refused/)
    assert.equal(updaterVersion(pkg), OLD)
    assert.equal(updaterVersion(updater.backupDir), OLD)
    assert.equal(fs.readFileSync(path.join(updater.backupDir, 'client.js'), 'utf8'), oldFiles['client.js'])
    assert.equal(fs.existsSync(updater.stateFile), false, 'no install intent was issued')
  } finally {
    fs.copyFileSync = original
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

await checkAsync('damaged rollback receipt or bytes never cause installed-file deletion', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backup = path.join(data, 'rollback')
  try {
    backupPackage(pkg, backup)
    fs.writeFileSync(path.join(pkg, 'index.js'), 'keep this edit\n')
    fs.writeFileSync(path.join(backup, 'client.js'), 'damaged backup\n')
    assert.throws(() => restoreBackup(backup, pkg), /rollback hash drift/)
    assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), 'keep this edit\n')
    fs.writeFileSync(path.join(backup, '.ofm-backup.json'), '{"files":[{"path":"../escape"}]}')
    assert.throws(() => restoreBackup(backup, pkg), /invalid rollback receipt/)
    assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), 'keep this edit\n')
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

await checkAsync('rollback reports a denied obsolete-file deletion rather than false success', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backup = path.join(data, 'rollback')
  backupPackage(pkg, backup)
  const obsolete = path.join(pkg, 'obsolete.js')
  fs.writeFileSync(obsolete, 'not in the old installation\n')
  const original = fs.rmSync
  try {
    fs.rmSync = (target, options) => {
      if (target === obsolete) throw new Error('obsolete deletion refused')
      return original(target, options)
    }
    assert.throws(() => restoreBackup(backup, pkg), /rollback incomplete.*obsolete/)
  } finally {
    fs.rmSync = original
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

await checkAsync('interrupted or unreadable transaction state is blocked rather than reported as current', async () => {
  const pkg = makePackage(NEW)
  const data = makeDataDir()
  try {
    for (const text of [JSON.stringify({ phase: 'activating', from: OLD, to: NEW }), '{', 'null']) {
      fs.writeFileSync(path.join(data, 'upgrade-state.json'), text)
      const updater = fixtureUpdater(pkg, data, NEW)
      assert.equal(updater.status().recoveryRequired, true)
      assert.equal(updater.status().applying, false)
      await assert.rejects(() => updater.apply(), /requires recovery/)
      assert.equal(updaterVersion(pkg), NEW)
    }
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

for (const closer of [server, corruptServer, badManifestServer]) closer.close()
if (failures === 0) console.log('updater-test: OK')
else { console.error(`updater-test: ${failures} failure(s)`); process.exit(1) }
