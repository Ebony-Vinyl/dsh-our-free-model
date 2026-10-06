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
import { parseVersion, compareVersions, parseManifest, fileUrlOf, PluginUpdater, stageRelease, verifyStaged, backupPackage, restoreBackup, installStaged, verifyInstalled, signManifest, verifyManifestSignature, stableStringify, PINNED_MANIFEST_PUBLIC_KEY } from '../src/updater.js'
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
  // `tsconfig.json` is protected today by being a name in REPOSITORY_SCAFFOLDING,
  // not by a rule. This pins the membership so the name stays reviewable.
  fs.writeFileSync(path.join(pkg, 'tsconfig.json'), '{}\n')
  const data = makeDataDir()
  const updater = new PluginUpdater({ pkgDir: pkg, dataDir: data, settings: () => ({}), fetchImpl: fetch, defaultSources: [`${base}/repo/feed/manifest.json`], manifestPublicKey: TEST_PUBLIC_KEY })
  await updater.apply({})
  assert.equal(fs.existsSync(path.join(pkg, 'obsolete.js')), false, 'a file absent from the manifest is removed')
  assert.equal(fs.existsSync(path.join(pkg, 'scripts', 'picker-test.mjs')), true, 'the development scaffolding survives')
  assert.equal(fs.existsSync(path.join(pkg, 'feed', 'manifest.json')), true, 'including the feed the manifest is published from')
  assert.equal(fs.existsSync(path.join(pkg, 'catalog', 'dsh-plugin.json')), true, 'the ecosystem pack records survive an upgrade')
  assert.equal(fs.existsSync(path.join(pkg, 'worker', 'worker.js')), true, 'the self-hosted gateway sources survive')
  assert.equal(fs.existsSync(path.join(pkg, 'vendor', 'lib.js')), true, 'vendored sources survive')
  assert.equal(fs.existsSync(path.join(pkg, 'tsconfig.json')), true, 'the type-check configuration survives')
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

for (const closer of [server, corruptServer, badManifestServer]) closer.close()
if (failures === 0) console.log('updater-test: OK')
else { console.error(`updater-test: ${failures} failure(s)`); process.exit(1) }
