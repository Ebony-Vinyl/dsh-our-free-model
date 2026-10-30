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
import { pathToFileURL } from 'node:url'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { parseVersion, compareVersions, parseManifest, fileUrlOf, downloadManifest, parseUploadPackRefs, PluginUpdater, stageRelease, verifyStaged, backupPackage, restoreBackup, installStaged, verifyInstalled, signManifest, verifyManifestSignature, stableStringify, DEFAULT_MANIFEST_SOURCES, PINNED_MANIFEST_PUBLIC_KEY, packageUsesHardLinks, installationIsManaged } from '../src/updater.js'
import { entryUrlOf, packageUrlOf, selfReload } from '../src/reload.js'
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
await checkAsync('package-manager hard links are treated as managed installations', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-hardlink-'))
  try {
    const store = path.join(directory, 'store.js')
    const packageDir = path.join(directory, 'node_modules', 'dsh-our-free-model')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(store, 'shared package bytes')
    for (const rel of ['package.json', 'index.js', 'client.js']) fs.linkSync(store, path.join(packageDir, rel))
    assert.equal(packageUsesHardLinks(packageDir), true)
    assert.equal(installationIsManaged(packageDir), true)
    const copied = path.join(directory, 'copied')
    fs.mkdirSync(copied)
    for (const rel of ['package.json', 'index.js', 'client.js']) fs.copyFileSync(store, path.join(copied, rel))
    assert.equal(packageUsesHardLinks(copied), false)
    assert.equal(installationIsManaged(copied), false)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
check('default update sources do not probe the removed master ref', () => {
  assert.equal(DEFAULT_MANIFEST_SOURCES.some(source => source.includes('/master/')), false)
  assert.ok(DEFAULT_MANIFEST_SOURCES.some(source => source.includes('/main/')))
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
check('signed engine packages fit without raising the ordinary file size limit', () => {
  const engine = { path: 'vendor/magpie/bin/magpie-win32-x64.exe', sha256: 'c'.repeat(64), size: 68 * 1024 * 1024 }
  const files = [...manifestOf().files, engine,
    ...Array.from({ length: 87 }, (_, i) => ({ path: `src/part-${i}.js`, sha256: 'd'.repeat(64), size: 20 }))]
  assert.equal(parseManifest(manifestOf({ files })).files.length, 90)
  for (const path of ['src/oversize.js', 'vendor/magpie/bin/other.exe', 'vendor/magpie/bin/magpie-win32-x64.exe.js']) {
    assert.throws(() => parseManifest(manifestOf({ files: [...manifestOf().files, { ...engine, path }] })), /size/)
  }
  assert.throws(() => parseManifest(manifestOf({ files: [...manifestOf().files, { ...engine, size: 128 * 1024 * 1024 + 1 }] })), /size/)
  const tooMany = [...files, ...Array.from({ length: 39 }, (_, i) => ({ path: `src/extra-${i}.js`, sha256: 'e'.repeat(64), size: 10 }))]
  assert.throws(() => parseManifest(manifestOf({ files: tooMany })), /cap/)
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
const gcoreSource = `https://gcore.jsdelivr.net/gh/${REPOSITORY}@main/feed/manifest.json`
// A raw.githubusercontent.com proxy, added for networks where both origins above
// are slow or intermittently unreachable. It must be pinned to the same commit
// as the direct origin — never left as a mutable-branch install source.
const proxySource = `https://gh-proxy.com/https://raw.githubusercontent.com/${REPOSITORY}/main/feed/manifest.json`
const resolverUrl = `https://api.github.com/repos/${REPOSITORY}/commits/main`
const rawSnapshot = rawSource.replace('/main/', `/${SNAPSHOT}/`)
const cdnSnapshot = cdnSource.replace('@main/', `@${SNAPSHOT}/`)
const gcoreSnapshot = gcoreSource.replace('@main/', `@${SNAPSHOT}/`)
const proxySnapshot = proxySource.replace('/main/', `/${SNAPSHOT}/`)

function snapshotFetch({ source = rawSnapshot, resolver = { sha: SNAPSHOT }, resolverStatus = 200, manifest = newManifest, files = newFiles } = {}) {
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
      const body = files[decodeURIComponent(clean.slice(prefix.length))]
      if (body !== undefined) return new Response(body)
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, calls }
}

for (const [name, source, snapshot] of [['raw', rawSource, rawSnapshot], ['CDN', cdnSource, cdnSnapshot], ['gcore', gcoreSource, gcoreSnapshot], ['raw proxy', proxySource, proxySnapshot]]) {
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

// The resolver asks GitHub for the bare-SHA media type: the default JSON
// envelope carries the commit's full patch list, and a big merge's envelope
// blew past the snapshot size cap — every update check failed against exactly
// the releases a big merge produced. The bare spelling must be requested and
// parsed; the JSON envelope stays accepted for a hop that rewrote the header.
await checkAsync('snapshot resolution requests the bare-SHA media type', async () => {
  const fixture = snapshotFetch()
  await downloadManifest([rawSource], { fetchImpl: fixture.fetchImpl, verifyKey: TEST_PUBLIC_KEY })
  const resolverCall = fixture.calls.find(call => call.url === resolverUrl)
  assert.equal(resolverCall.options.headers.accept, 'application/vnd.github.sha')
})

await checkAsync('a bare-SHA resolver answer resolves without the JSON envelope', async () => {
  const calls = []
  const bareFetch = async (url, options) => {
    const parsed = new URL(url)
    parsed.search = ''
    calls.push({ url: parsed.href, options })
    if (parsed.href === resolverUrl) return new Response(SNAPSHOT, { status: 200 })
    if (parsed.href === rawSnapshot) return new Response(JSON.stringify(newManifest))
    return new Response('not found', { status: 404 })
  }
  const result = await downloadManifest([rawSource], { fetchImpl: bareFetch, verifyKey: TEST_PUBLIC_KEY })
  assert.equal(result.source, rawSnapshot)
  assert.equal(calls.find(call => call.url === resolverUrl).options.headers.accept, 'application/vnd.github.sha')
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
    assert.equal(fixture.calls.length, 3, 'all resolvers fail without fetching mutable files')
  })
}

for (const status of [403, 429, 503]) {
  await checkAsync(`resolver HTTP ${status} refuses a mutable download`, async () => {
    const fixture = snapshotFetch({ resolverStatus: status })
    await assert.rejects(() => downloadManifest([cdnSource], { fetchImpl: fixture.fetchImpl, verifyKey: TEST_PUBLIC_KEY }), new RegExp(`snapshot resolution failed.*HTTP ${status}`))
    assert.equal(fixture.calls.length, 3)
  })
}

await checkAsync('GitHub rate limiting is diagnosed and not repeated for mirrors of the same ref (issue #384)', async () => {
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    return new Response(null, { status: 403, headers: {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792238400', 'retry-after': '60',
    } })
  }
  await assert.rejects(() => downloadManifest([rawSource, cdnSource, proxySource], { fetchImpl, verifyKey: TEST_PUBLIC_KEY }), error => {
    assert.match(error.message, /HTTP 403/)
    assert.match(error.message, /GitHub API rate limit exceeded/)
    assert.match(error.message, /x-ratelimit-remaining=0/)
    assert.match(error.message, /x-ratelimit-reset=1792238400/)
    assert.match(error.message, /retry-after=60/)
    return true
  })
  assert.deepEqual(calls, [resolverUrl, `https://github.com/${REPOSITORY}/info/refs?service=git-upload-pack`,
    `https://github.com/${REPOSITORY}/commits/main.atom`], 'resolver failures are shared across mirrors')
})

const pkt = payload => {
  const body = Buffer.from(payload)
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body])
}
const refAdvertisement = (rows = [[SNAPSHOT, 'refs/heads/main']]) => Buffer.concat([
  pkt('# service=git-upload-pack\n'), Buffer.from('0000'),
  ...rows.map(([sha, ref], index) => pkt(`${sha} ${ref}${index === 0 ? '\0multi_ack symref=HEAD:refs/heads/main' : ''}\n`)),
  Buffer.from('0000'),
])
check('git refs use byte lengths, preserve Unicode refs, and read later refs', () => {
  const refs = parseUploadPackRefs(refAdvertisement([[NEXT_SNAPSHOT, 'refs/heads/中文'], [SNAPSHOT, 'refs/heads/main']]))
  assert.equal(refs.get('refs/heads/中文'), NEXT_SNAPSHOT)
  assert.equal(refs.get('refs/heads/main'), SNAPSHOT)
  for (const body of ['zzzz', '0003', '0010short', '000']) assert.throws(() => parseUploadPackRefs(body), /packet/)
  const malformed = Buffer.from(refAdvertisement())
  for (let index = 0; index < 4; index++) malformed[index] |= 0x80
  assert.throws(() => parseUploadPackRefs(malformed), /packet/, 'high-bit header bytes cannot become ASCII digits')
  assert.throws(() => parseUploadPackRefs(refAdvertisement().subarray(0, -4)), /incomplete/, 'a truncated advertisement cannot select a commit')
})

for (const stalled of ['api', 'refs']) {
  await checkAsync(`a stalled ${stalled} resolver leaves time for a healthy fallback and manifest`, async () => {
    const calls = []
    const fixture = snapshotFetch({ source: cdnSnapshot })
    const fetchImpl = async (url, options) => {
      const target = String(url)
      calls.push(target)
      const isApi = target === resolverUrl
      const isRefs = target.includes('/info/refs?')
      if ((stalled === 'api' && isApi) || (stalled === 'refs' && isRefs)) {
        return new Promise((_, reject) => {
          if (options.signal.aborted) reject(options.signal.reason)
          else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
      }
      if (isApi) return new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
      if (isRefs) return new Response(refAdvertisement())
      if (target.endsWith('.atom')) return new Response(`<feed><entry><id>tag:github.com,2008:Grit::Commit/${SNAPSHOT}</id></entry></feed>`)
      return fixture.fetchImpl(url, options)
    }
    const keepAlive = setInterval(() => {}, 1000)
    try {
      const result = await downloadManifest([rawSource, cdnSource], { fetchImpl, timeoutMs: 240, verifyKey: TEST_PUBLIC_KEY })
      assert.equal(result.source, cdnSnapshot)
      assert.equal(calls.filter(url => url === resolverUrl).length, 1, 'completed API failures are not retried per mirror')
      assert.equal(calls.filter(url => url.includes('/info/refs?')).length, 1)
      assert.equal(calls.some(url => url.endsWith('.atom')), stalled === 'refs')
    } finally { clearInterval(keepAlive) }
  })
}

for (const route of ['refs', 'feed']) {
  await checkAsync(`API rate limiting falls back to ${route} and stages one immutable signed release`, async () => {
    const calls = []
    const fixture = snapshotFetch({ source: cdnSnapshot })
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options })
      if (String(url) === resolverUrl) return new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
      if (String(url).includes('/info/refs?')) return route === 'refs'
        ? new Response(refAdvertisement()) : new Response('0010short')
      if (String(url).endsWith('.atom')) return new Response(`<feed><entry><id>tag:github.com,2008:Grit::Commit/${SNAPSHOT}</id></entry></feed>`)
      return fixture.fetchImpl(url, options)
    }
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ref-fallback-'))
    try {
      const result = await downloadManifest([rawSource, cdnSource], { fetchImpl, verifyKey: TEST_PUBLIC_KEY })
      assert.equal(result.source, cdnSnapshot)
      await stageRelease({ manifest: result.manifest, manifestUrl: result.source, stageDir: data, fetchImpl })
      verifyStaged(data, result.manifest)
      assert.equal(calls.filter(call => call.url === resolverUrl).length, 1)
      assert.equal(calls.filter(call => call.url.includes('/info/refs?')).length, 1)
      assert.ok(calls.every(call => call.options.redirect === 'error'))
      assert.ok(calls.every(call => call.url !== rawSource && !call.url.startsWith(cdnSource)))
    } finally { fs.rmSync(data, { recursive: true, force: true }) }
  })
}

await checkAsync('ref fallback uses a peeled annotated tag before its tag object', async () => {
  const source = rawSource.replace('/main/', '/v1.1.0/')
  const fixture = snapshotFetch()
  const fetchImpl = (url, options) => String(url).includes('api.github.com')
    ? Promise.resolve(new Response(null, { status: 429 }))
    : String(url).includes('/info/refs?')
      ? Promise.resolve(new Response(refAdvertisement([[NEXT_SNAPSHOT, 'refs/tags/v1.1.0'], [SNAPSHOT, 'refs/tags/v1.1.0^{}']])))
      : fixture.fetchImpl(url, options)
  assert.equal((await downloadManifest([source], { fetchImpl, verifyKey: TEST_PUBLIC_KEY })).source, rawSnapshot)
})

await checkAsync('a fallback-resolved manifest still rejects a forged signature', async () => {
  const fixture = snapshotFetch({ manifest: { ...newManifest, version: '9.9.9' } })
  const fetchImpl = (url, options) => String(url).includes('api.github.com')
    ? Promise.resolve(new Response(null, { status: 429 }))
    : String(url).includes('/info/refs?')
      ? Promise.resolve(new Response(refAdvertisement()))
      : fixture.fetchImpl(url, options)
  await assert.rejects(() => downloadManifest([rawSource], { fetchImpl, verifyKey: TEST_PUBLIC_KEY }), /signature/)
})

await checkAsync('a generic resolver 403 is not misreported as rate limiting', async () => {
  const fixture = snapshotFetch({ resolverStatus: 403 })
  await assert.rejects(() => downloadManifest([rawSource], { fetchImpl: fixture.fetchImpl, verifyKey: TEST_PUBLIC_KEY }), error => {
    assert.match(error.message, /HTTP 403/)
    assert.doesNotMatch(error.message, /rate limit exceeded/)
    return true
  })
})

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
    assert.ok(calls >= 1 && calls <= 3, 'the source deadline stops resolution within its three bounded attempts')
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

await checkAsync('a release file jsDelivr refuses by size falls back to raw at the same SHA', async () => {
  // Measured 2026-10-25: the 65 MB vendored engine binary answers 403 on every
  // jsDelivr edge while ordinary files on the same commit answer 200. That is a
  // structural refusal, not an authorization one, so the pinned commit's raw
  // transport is the fallback — and only for the engine binary's own path.
  const enginePath = 'vendor/magpie/bin/magpie-win32-x64.exe'
  const engineBody = 'engine-binary-fixture'
  const withEngine = manifestFor({ ...newFiles, [enginePath]: engineBody })
  const fixture = snapshotFetch({ source: cdnSnapshot })
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cdn-oversized-'))
  const calls = []
  const fetchImpl = async (url, opts) => {
    const parsed = new URL(url)
    calls.push(String(url))
    if (parsed.pathname.endsWith(`/${enginePath}`)) {
      if (parsed.hostname === 'cdn.jsdelivr.net' || parsed.hostname === 'gcore.jsdelivr.net') {
        return new Response(null, { status: 403 })
      }
      assert.match(parsed.pathname, new RegExp(`/${SNAPSHOT}/${enginePath}$`), 'the fallback stays on the pinned commit')
      return new Response(engineBody)
    }
    return fixture.fetchImpl(url, opts)
  }
  try {
    await stageRelease({ manifest: parseManifest(withEngine), manifestUrl: cdnSnapshot, stageDir: data, fetchImpl })
    verifyStaged(data, parseManifest(withEngine))
    const attempts = calls.filter(url => url.endsWith(enginePath))
    assert.ok(attempts.some(url => url.includes('raw.githubusercontent.com')), 'raw is tried at the same SHA')
    assert.equal(fs.readFileSync(path.join(data, ...enginePath.split('/')), 'utf8'), engineBody)
  } finally { fs.rmSync(data, { recursive: true, force: true }) }
})

await checkAsync('a gcore-sourced manifest gets the same oversized-file fallback', async () => {
  // A manifest discovered on the gcore edge composes gcore file URLs; those must
  // recognize their own origin and reach the same pinned commit on raw.
  const enginePath = 'vendor/magpie/bin/magpie-win32-x64.exe'
  const engineBody = 'engine-binary-fixture'
  const withEngine = manifestFor({ ...newFiles, [enginePath]: engineBody })
  const fixture = snapshotFetch({ source: gcoreSnapshot })
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-gcore-oversized-'))
  const calls = []
  const fetchImpl = async (url, opts) => {
    const parsed = new URL(url)
    calls.push(String(url))
    if (parsed.pathname.endsWith(`/${enginePath}`)) {
      if (parsed.hostname === 'cdn.jsdelivr.net' || parsed.hostname === 'gcore.jsdelivr.net') {
        return new Response(null, { status: 403 })
      }
      assert.match(parsed.pathname, new RegExp(`/${SNAPSHOT}/${enginePath}$`), 'the fallback stays on the pinned commit')
      return new Response(engineBody)
    }
    return fixture.fetchImpl(url, opts)
  }
  try {
    await stageRelease({ manifest: parseManifest(withEngine), manifestUrl: gcoreSnapshot, stageDir: data, fetchImpl })
    verifyStaged(data, parseManifest(withEngine))
    const attempts = calls.filter(url => url.endsWith(enginePath))
    assert.ok(attempts.some(url => url.includes('raw.githubusercontent.com')), 'gcore also falls back to raw')
    assert.equal(fs.readFileSync(path.join(data, ...enginePath.split('/')), 'utf8'), engineBody)
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
  assert.equal(stats.reused, false, 'an empty stage is a real download')
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
// Issue #475: a retry after a late-phase failure (the backup rename throwing
// EPERM, for one) must not re-download the release that already verified —
// each wipe-and-redownload of ~4.8 MB on a CN egress is the "stuck on loading"
// users see. Reuse is only ever granted against this manifest's hashes.
await checkAsync('stageRelease reuses a verified stage instead of re-downloading (issue #475)', async () => {
  const data = makeDataDir()
  const stage = path.join(data, 'stage')
  const manifest = parseManifest(newManifest)
  const source = `${base}/repo/feed/manifest.json`
  let calls = 0
  const counting = (url, opts) => { calls += 1; return fetch(url, opts) }
  try {
    const first = await stageRelease({ manifest, manifestUrl: source, stageDir: stage, fetchImpl: counting })
    assert.equal(first.reused, false)
    const downloaded = calls
    const retry = await stageRelease({ manifest, manifestUrl: source, stageDir: stage, fetchImpl: counting })
    assert.equal(retry.reused, true, 'the verified copy is kept')
    assert.equal(calls, downloaded, 'the retry fetched nothing')
    assert.equal(retry.bytes, manifest.files.reduce((sum, file) => sum + file.size, 0))
    verifyStaged(stage, manifest)
  } finally {
    fs.rmSync(data, { recursive: true, force: true })
  }
})
await checkAsync('a drifted or incomplete stage is re-downloaded, never trusted (issue #475)', async () => {
  const data = makeDataDir()
  const stage = path.join(data, 'stage')
  const manifest = parseManifest(newManifest)
  const source = `${base}/repo/feed/manifest.json`
  let calls = 0
  const counting = (url, opts) => { calls += 1; return fetch(url, opts) }
  try {
    await stageRelease({ manifest, manifestUrl: source, stageDir: stage, fetchImpl: counting })
    // Someone (or a torn write) changed a staged byte: reuse must be refused,
    // and the retry must fetch the whole release again instead of installing it.
    fs.writeFileSync(path.join(stage, 'index.js'), "export const v = 'tampered-in-place'\n")
    calls = 0
    const redone = await stageRelease({ manifest, manifestUrl: source, stageDir: stage, fetchImpl: counting })
    assert.equal(redone.reused, false, 'a drifted stage is not reused')
    assert.equal(calls, manifest.files.length, 'every file is fetched again')
    assert.equal(fs.readFileSync(path.join(stage, 'index.js'), 'utf8'), newFiles['index.js'])
    // A truncated stage — one file missing — is likewise refused.
    fs.rmSync(path.join(stage, 'client.js'), { force: true })
    calls = 0
    const repaired = await stageRelease({ manifest, manifestUrl: source, stageDir: stage, fetchImpl: counting })
    assert.equal(repaired.reused, false, 'an incomplete stage is not reused')
    assert.equal(calls, manifest.files.length)
    verifyStaged(stage, manifest)
  } finally {
    fs.rmSync(data, { recursive: true, force: true })
  }
})
await checkAsync('PluginUpdater.check detects the newer version', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({ feedUrl: `${base}/repo/feed/announcements.json` }), fetchImpl: fetch, defaultSources: [`${base}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY })
  const status = await updater.check()
  assert.equal(status.available, true)
  assert.equal(status.current, OLD)
  assert.equal(status.latest, NEW)
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
  fs.writeFileSync(path.join(pkg, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n')
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
  assert.equal(fs.readFileSync(path.join(pkg, 'tsconfig.json'), 'utf8'), '{"compilerOptions":{"strict":true}}\n', 'TypeScript configuration survives an update')
  assert.equal(fs.existsSync(path.join(updater.backupDir, 'tsconfig.json')), false, 'development configuration is not a runtime rollback file')
  assert.equal(fs.existsSync(path.join(pkg, '.git', 'HEAD')), true, 'and the git history')
  assert.equal(fs.existsSync(path.join(updater.backupDir, '.git', 'HEAD')), false, 'the rollback copy holds the package, not the repository')
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
for (const rollback of [false, true]) {
  await checkAsync(`linked development installs never traverse, back up or delete desktop caches (rollback=${rollback})`, async () => {
    const pkg = makePackage(OLD)
    const data = makeDataDir()
    const cache = path.join(pkg, 'packages')
    const sentinels = {
      'packages/desktop/src-tauri/target/debug/build/example/build_script_build.pdb': 'rust-cache-must-stay-on-original-drive',
      'packages/desktop/src-tauri/target/release/ofm-desktop.exe': 'desktop-program',
      'packages/standalone/service.mjs': 'independent-product-source',
    }
    const originalReadDir = fs.readdirSync
    try {
      for (const [rel, value] of Object.entries(sentinels)) {
        const file = path.join(pkg, ...rel.split('/'))
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, value)
      }
      fs.readdirSync = (directory, ...args) => {
        if (path.resolve(String(directory)) === cache || path.resolve(String(directory)).startsWith(cache + path.sep)) {
          throw new Error('the updater must not even enumerate separate products or Rust cache')
        }
        return originalReadDir(directory, ...args)
      }
      const updater = fixtureUpdater(pkg, data)
      if (rollback) {
        const result = await updater.apply({ activate: async () => ({
          ok: false, restored: true, restartRequired: true, error: 'controlled activation refusal',
        }) })
        assert.equal(result.restartRequired, true)
        assert.equal(updater.currentVersion(), NEW)
        assert.equal(updater.status().restartRequired, true)
      } else {
        await updater.apply({})
        assert.equal(updater.currentVersion(), NEW)
      }
      assert.equal(fs.existsSync(path.join(updater.backupDir, 'packages')), false)
      for (const [rel, value] of Object.entries(sentinels)) {
        assert.equal(fs.readFileSync(path.join(pkg, ...rel.split('/')), 'utf8'), value)
      }
    } finally {
      fs.readdirSync = originalReadDir
      fs.rmSync(pkg, { recursive: true, force: true })
      fs.rmSync(data, { recursive: true, force: true })
    }
  })
}

await checkAsync('legacy rollback receipts containing Rust caches restore only plugin runtime files', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backup = path.join(data, 'rollback')
  const rel = 'packages/desktop/src-tauri/target/debug/legacy-cache.pdb'
  try {
    await backupPackage(pkg, backup)
    const cached = Buffer.from('retained historical cache')
    const backupFile = path.join(backup, ...rel.split('/'))
    fs.mkdirSync(path.dirname(backupFile), { recursive: true })
    fs.writeFileSync(backupFile, cached)
    const receiptFile = path.join(backup, '.ofm-backup.json')
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    receipt.files.push({ path: rel, size: cached.length, sha256: crypto.createHash('sha256').update(cached).digest('hex') })
    fs.writeFileSync(receiptFile, JSON.stringify(receipt))
    const currentCache = path.join(pkg, ...rel.split('/'))
    fs.mkdirSync(path.dirname(currentCache), { recursive: true })
    fs.writeFileSync(currentCache, 'current Rust cache must stay untouched')
    fs.writeFileSync(path.join(pkg, 'index.js'), 'broken candidate')
    restoreBackup(backup, pkg)
    assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), oldFiles['index.js'])
    assert.equal(fs.readFileSync(currentCache, 'utf8'), 'current Rust cache must stay untouched')
    assert.deepEqual(fs.readFileSync(backupFile), cached, 'historical cache is retained without deletion or restoration')
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
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
  await backupPackage(pkg, backupDir)
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
    await backupPackage(pkg, backup)
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
    await backupPackage(pkg, backup)
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
  await backupPackage(pkg, backupDir)
  // A directory squatting where a file belongs makes copyFileSync fail
  // (EISDIR) without depending on platform-specific lock semantics.
  fs.rmSync(path.join(pkg, 'client.js'), { force: true })
  fs.mkdirSync(path.join(pkg, 'client.js'), { recursive: true })
  assert.throws(() => restoreBackup(backupDir, pkg), /rollback incomplete.*client\.js/s)
  assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), oldFiles['index.js'], 'the other files were still put back')
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })
})
await checkAsync('rollback restores a read-only file without deleting the remaining installed copy', async () => {
  if (process.getuid?.() === 0) return
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backupDir = path.join(data, 'rollback')
  const target = path.join(pkg, 'index.js')
  try {
    await backupPackage(pkg, backupDir)
    fs.writeFileSync(target, newFiles['index.js'])
    fs.chmodSync(target, 0o444)
    const mode = fs.statSync(target).mode
    restoreBackup(backupDir, pkg)
    assert.equal(fs.readFileSync(target, 'utf8'), oldFiles['index.js'])
    assert.equal(fs.readFileSync(path.join(pkg, 'client.js'), 'utf8'), oldFiles['client.js'])
    assert.equal(fs.statSync(target).mode, mode, 'successful recovery must restore the original file permissions')
  } finally {
    fs.chmodSync(target, 0o644)
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})
await checkAsync('failed permission retry restores the original file mode and keeps installed bytes', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backupDir = path.join(data, 'rollback')
  const target = path.join(pkg, 'index.js')
  const copy = fs.copyFileSync
  try {
    await backupPackage(pkg, backupDir)
    fs.writeFileSync(target, newFiles['index.js'])
    fs.chmodSync(target, 0o555)
    const mode = fs.statSync(target).mode
    let attempts = 0
    fs.copyFileSync = (source, destination, ...args) => {
      if (destination === target) {
        const code = ++attempts === 1 ? 'EACCES' : 'EBUSY'
        throw Object.assign(new Error(code), { code })
      }
      return copy(source, destination, ...args)
    }
    assert.throws(() => restoreBackup(backupDir, pkg), /rollback incomplete.*EBUSY/)
    assert.equal(attempts, 2)
    assert.equal(fs.statSync(target).mode, mode, 'unsuccessful recovery must not leave new permission bits')
    assert.equal(fs.readFileSync(target, 'utf8'), newFiles['index.js'])
    assert.equal(fs.readFileSync(path.join(pkg, 'client.js'), 'utf8'), oldFiles['client.js'])
  } finally {
    fs.copyFileSync = copy
    fs.chmodSync(target, 0o644)
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
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

function fixtureUpdater(pkg, data, runningVersion = OLD, processEpoch) {
  return new PluginUpdater({
    pkgDir: pkg, dataDir: data, runningVersion, processEpoch, settings: () => ({}),
    defaultSources: [`${base}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY,
  })
}

await checkAsync('a verified same-version content update is available and installs after safe restart-required activation (issue #602)', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const files = { ...newFiles, 'package.json': JSON.stringify({ name: 'fake', version: OLD }), 'index.js': "export const v = 'same-version content update'\n" }
  const unsigned = { ...manifestFor(files), version: OLD }
  const manifest = { ...unsigned, signature: signManifest(parseManifest(unsigned), testPrivateKey) }
  const fixture = snapshotFetch({ manifest, files })
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, runningVersion: OLD, settings: () => ({}), fetchImpl: fixture.fetchImpl, defaultSources: [rawSnapshot], manifestPublicKey: TEST_PUBLIC_KEY })
  try {
    assert.equal((await updater.check()).available, true)
    assert.equal(updater.status().available, true)
    const result = await updater.apply({ activate: async () => ({ ok: false, restored: true, restartRequired: true, error: 'safe restart' }) })
    assert.equal(result.restartRequired, true)
    assert.equal(result.activated, false)
    assert.equal(updaterVersion(pkg), OLD, 'version remains stable while bytes advance')
    assert.match(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), /same-version content update/)
    assert.equal(updater.status().restartRequired, true)
    assert.equal(updater.status().available, false)
    const restarted = new PluginUpdater({ pkgDir: pkg, dataDir: data, runningVersion: OLD, processEpoch: 'next-process', settings: () => ({}), fetchImpl: fixture.fetchImpl, defaultSources: [rawSnapshot], manifestPublicKey: TEST_PUBLIC_KEY })
    const activeAfterRestart = new PluginUpdater({ pkgDir: pkg, dataDir: data, runningVersion: OLD, processEpoch: 'next-process', settings: () => ({}), fetchImpl: fixture.fetchImpl, defaultSources: [rawSnapshot], manifestPublicKey: TEST_PUBLIC_KEY })
    assert.equal(activeAfterRestart.status().restartRequired, false, 'a new host process makes the installed bytes current')
  } finally { fs.rmSync(pkg, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }) }
})

await checkAsync('a failed recheck retains the known target and a successful retry clears the error (issue #148)', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  let unavailable = false
  const updater = new PluginUpdater({
    pkgDir: pkg, dataDir: data, runningVersion: OLD, settings: () => ({}),
    defaultSources: [`${base}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY,
    fetchImpl: (url, options) => unavailable
      ? Promise.resolve(new Response(null, { status: 503 })) : fetch(url, options),
  })
  try {
    await updater.check()
    unavailable = true
    await assert.rejects(() => updater.apply(), /HTTP 503/)
    assert.equal(updater.status().lastApplied.to, NEW)
    assert.equal(updater.status().lastApplied.ok, false)
    assert.equal(updaterVersion(pkg), OLD)
    unavailable = false
    await updater.apply({ activate: async () => ({ ok: true, version: NEW }) })
    assert.equal(updater.status().lastApplied.ok, true)
    assert.equal(updater.status().error, '')
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

/** Host loader stand-in; the real selfReload still performs every transition. */
function reloadHost(mode, pkgDir) {
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
        internal: { loadCache: new Map([[pathToFileURL(path.join(pkgDir, 'index.js')).href, { source: 'reload fixture cache' }]]) },
        unwrapExports: value => value,
        import: async () => {
          if (mode === 'import-failure') throw new Error('replacement import refused')
          if (mode === 'stale-cache') return previous
          return replacement
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
    const host = reloadHost(mode, pkg)
    let successor
    try {
      const operation = updater.apply({ activate: async () => {
        successor = fixtureUpdater(pkg, data, NEW)
        assert.equal(successor.status().applying, true, 'the successor sees the same in-flight upgrade')
        assert.equal(successor.status().lastApplied, undefined, 'no premature success record')
        await assert.rejects(() => successor.apply(), /already running/)
        return selfReload(host.ctx, { logger: {}, packageUrl: packageUrlOf(pathToFileURL(path.join(pkg, 'index.js')).href), entryUrl: entryUrlOf(pathToFileURL(path.join(pkg, 'index.js')).href), expectedVersion: NEW })
      } })
      if (mode === 'success') {
        await operation
        assert.equal(host.running().version, NEW)
        assert.equal(updaterVersion(pkg), NEW)
        assert.equal(successor.status().lastApplied.ok, true, 'the successor observes the committed history')
        assert.equal(successor.status().lastApplied.activated, true)
        assert.equal(successor.status().recoveryRequired, false)
      } else if (mode === 'restore-failure') {
        await assert.rejects(() => operation, /replacement|restore failed|activation version mismatch/)
        assert.equal(updaterVersion(pkg), OLD)
        assert.equal(updater.status().lastApplied.ok, false)
        assert.equal(updater.status().recoveryRequired, true)
        assert.equal(updater.status().applying, false)
      } else {
        const result = await operation
        assert.equal(result.restartRequired, true)
        assert.equal(result.activated, false)
        assert.equal(updaterVersion(pkg), NEW, 'verified new files stay installed for host restart')
        assert.equal(updater.status().lastApplied.ok, true)
        assert.equal(updater.status().restartRequired, true)
        assert.equal(updater.status().recoveryRequired, false)
        assert.equal(host.running().version, OLD, 'the live old generation stays intact')
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
      assert.equal(updater.status().phase, 'recovery-required', 'an unconfirmed old runtime still requires recovery')
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
  const host = reloadHost('import-failure', pkg)
  const original = fs.copyFileSync
  try {
    fs.copyFileSync = (from, to, ...args) => {
      if (String(from).startsWith(updater.backupDir + path.sep) && to === path.join(pkg, 'package.json')) {
        throw Object.assign(new Error('EPERM: restoration refused'), { code: 'EPERM' })
      }
      return original(from, to, ...args)
    }
    const outcome = await updater.apply({ activate: () => selfReload(host.ctx, { logger: {}, packageUrl: packageUrlOf(pathToFileURL(path.join(pkg, 'index.js')).href), entryUrl: entryUrlOf(pathToFileURL(path.join(pkg, 'index.js')).href) }) })
    assert.equal(outcome.restartRequired, true)
    const status = fixtureUpdater(pkg, data, OLD, updater.deps.processEpoch).status()
    assert.equal(status.current, OLD)
    assert.equal(status.installedVersion, NEW)
    assert.equal(status.versionMismatch, true)
    assert.equal(status.restartRequired, true)
    assert.equal(status.recoveryRequired, false)
    assert.equal(status.applying, false, 'a terminated attempt is not permanently busy')
    assert.equal(status.lastApplied.ok, true)
    assert.equal(status.lastApplied.to, NEW)
    assert.equal(updaterVersion(updater.backupDir), OLD, 'the retained prior copy remains available if needed')
    await assert.rejects(() => fixtureUpdater(pkg, data).apply(), /restart the host/)
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
  await backupPackage(pkg, updater.backupDir)
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

// Issue #475: the backup directory renames move a tree that was just written,
// which is exactly when a Windows scanner or indexer holds it open. They now
// share the file swap's `renameWithRetry` seam instead of throwing on the first
// transient EPERM — before the installed package was even touched.
await checkAsync('backupPackage retries a transient EPERM on the rollback rename (issue #475)', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backup = path.join(data, 'rollback')
  const original = fs.renameSync
  let attempts = 0
  try {
    fs.renameSync = (from, to, ...args) => {
      if (String(from).includes('rollback.pending-') && to === backup) {
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('EPERM: operation not permitted, rename (scan hold)'), { code: 'EPERM' })
      }
      return original(from, to, ...args)
    }
    assert.equal(await backupPackage(pkg, backup), 3)
    assert.equal(attempts, 2, 'the second attempt lands the backup')
    assert.equal(updaterVersion(backup), OLD)
  } finally {
    fs.renameSync = original
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

await checkAsync('a permanently denied backup rename keeps the previous verified backup in place (issue #475)', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backup = path.join(data, 'rollback')
  await backupPackage(pkg, backup)
  fs.writeFileSync(path.join(backup, 'client.js'), 'the retained rollback copy\n')
  const original = fs.renameSync
  let attempts = 0
  try {
    fs.renameSync = (from, to, ...args) => {
      if (String(from).includes('rollback.pending-')) {
        attempts += 1
        throw Object.assign(new Error('EPERM: operation not permitted, rename (locked by scanner)'), { code: 'EPERM' })
      }
      return original(from, to, ...args)
    }
    await assert.rejects(() => backupPackage(pkg, backup), /EPERM/)
    assert.equal(attempts, 5, 'renameWithRetry exhausts its five attempts before surfacing the error')
    assert.equal(fs.readFileSync(path.join(backup, 'client.js'), 'utf8'), 'the retained rollback copy\n')
    assert.equal(updaterVersion(backup), OLD, 'the move-aside was undone, so a verified rollback copy still stands')
    assert.equal(fs.readdirSync(data).filter(name => name.startsWith('rollback.')).length, 0, 'no pending or previous scratch trees remain')
  } finally {
    fs.renameSync = original
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

await checkAsync('the retry after a failed backup skips re-downloading the verified stage (issue #475)', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  let calls = 0
  const counting = (url, opts) => { calls += 1; return fetch(url, opts) }
  const updater = new PluginUpdater({
    pkgDir: pkg, dataDir: data, runningVersion: OLD, settings: () => ({}), fetchImpl: counting,
    defaultSources: [`${base}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY,
  })
  const original = fs.renameSync
  let locked = true
  try {
    fs.renameSync = (from, to, ...args) => {
      if (locked && String(from).includes('rollback.pending-')) throw Object.assign(new Error('EPERM: rollback rename locked'), { code: 'EPERM' })
      return original(from, to, ...args)
    }
    await assert.rejects(() => updater.apply(), /EPERM/)
    assert.equal(fs.existsSync(updater.stageDir), true, 'the hash-verified stage is kept for the next retry')
    assert.equal(updaterVersion(pkg), OLD, 'nothing was installed')
    const firstRun = calls
    calls = 0
    locked = false
    await updater.apply({ activate: async () => ({ ok: true, version: NEW }) })
    assert.ok(calls < firstRun, 'the retry re-checks the manifest but serves files from the stage')
    assert.equal(updaterVersion(pkg), NEW)
    assert.equal(updater.status().lastApplied.reused, true)
    assert.equal(fs.existsSync(updater.stageDir), false, 'a completed transaction cleans the stage')
  } finally {
    fs.renameSync = original
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

await checkAsync('damaged rollback receipt or bytes never cause installed-file deletion', async () => {
  const pkg = makePackage(OLD)
  const data = makeDataDir()
  const backup = path.join(data, 'rollback')
  try {
    await backupPackage(pkg, backup)
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
  await backupPackage(pkg, backup)
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
