/** 使用未经修改的历史升级器，验证当前真实发布目录而非微型假包。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { publishedBytes } from './lib/published-bytes.mjs'
import { parseManifest, signManifest, verifyManifestSignature, PINNED_MANIFEST_PUBLIC_KEY } from '../src/updater.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-legacy-'))
const production = process.argv.includes('--production')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const files = new Map()
function collect(rel) {
  const absolute = path.join(root, rel)
  if (fs.statSync(absolute).isDirectory()) {
    for (const name of fs.readdirSync(absolute)) if (!name.startsWith('.') && name !== 'node_modules') collect(`${rel}/${name}`)
  } else {
    assert(!files.has(rel), `重复发布文件：${rel}`)
    files.set(rel, publishedBytes(fs.readFileSync(absolute)))
  }
}
for (const rel of ['package.json', ...pkg.files]) collect(rel)
const rows = [...files].map(([path, body]) => ({ path, size: body.length, sha256: sha(body) })).sort((a, b) => a.path.localeCompare(b.path))
assert(rows.length <= 80, `旧版最多 80 个文件，当前 ${rows.length}`)
assert(rows.every(row => row.size > 0 && row.size <= 4 * 1024 * 1024), '有文件超过旧版 4 MiB 上限')
const keys = crypto.generateKeyPairSync('ed25519')
const testKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
let manifest = { version: pkg.version, base: '../', publishedAt: new Date().toISOString(), notes: '旧版兼容回归', files: rows }
if (production) {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'feed/manifest.json'), 'utf8'))
  assert.deepEqual(manifest.files, rows)
  assert.equal(manifest.version, pkg.version)
  assert(verifyManifestSignature(parseManifest(manifest), PINNED_MANIFEST_PUBLIC_KEY), '生产清单签名无效')
} else manifest.signature = signManifest(parseManifest(manifest), keys.privateKey)
const verifyKey = production ? PINNED_MANIFEST_PUBLIC_KEY : testKey
const old = [
  { version: '1.3.1', revision: 'f14d261557ae98e5d28eaa33f4471302cc7f35ad' },
  { version: '2.5.9', revision: '313eaa45c3abc769cd4169326b9b4e7161d141a9' },
]
let requestCount = 0
let tamperedPath = ''
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://fixture').pathname)
  if (pathname === '/feed/manifest.json') { res.end(JSON.stringify(manifest)); return }
  const rel = pathname.slice(1)
  const body = files.get(rel)
  if (!body) { res.writeHead(404); res.end(); return }
  requestCount++
  res.end(rel === tamperedPath ? Buffer.alloc(body.length) : body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/feed/manifest.json`
let checks = 0
const check = async (name, run) => { await run(); console.log(`ok ${++checks} - ${name}`) }
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 })
let installed
try {
  for (const historical of old) {
    const fixture = fs.readFileSync(new URL(`./fixtures/updater-${historical.version}.mjs`, import.meta.url))
    assert.deepEqual(fixture, git('show', `${historical.revision}:src/updater.js`), '历史升级器夹具已被修改')
    historical.module = await import(`./fixtures/updater-${historical.version}.mjs`)
    const oldManifest = JSON.parse(git('show', `${historical.revision}:feed/manifest.json`))
    const archive = path.join(scratch, `${historical.version}.tar`)
    git('archive', '--format=tar', `--output=${archive}`, historical.revision, '--', ...oldManifest.files.map(row => row.path))
    historical.pkgDir = path.join(scratch, historical.version, 'node_modules/dsh-our-free-model')
    historical.dataDir = path.join(scratch, historical.version, 'private-data')
    fs.mkdirSync(historical.pkgDir, { recursive: true })
    fs.mkdirSync(historical.dataDir, { recursive: true })
    execFileSync('tar', ['-xf', archive, '-C', historical.pkgDir], { windowsHide: true })
    fs.writeFileSync(path.join(historical.dataDir, 'user-settings.json'), '保留用户数据\n')
    await check(`${historical.version} 原版拒绝旧问题夹具，并接受当前 ${rows.length} 文件`, () => {
      historical.module.parseManifest(manifest)
      const tooMany = Array.from({ length: 93 }, (_, i) => ({ path: i === 0 ? 'package.json' : `src/f-${i}.js`, size: 1, sha256: '0'.repeat(64) }))
      assert.throws(() => historical.module.parseManifest({ ...manifest, files: tooMany }), /above the 80 cap/)
      assert.throws(() => historical.module.parseManifest({ ...manifest, files: [{ path: 'package.json', size: 68578304, sha256: '0'.repeat(64) }] }), /out-of-range size/)
    })
    const updater = new historical.module.PluginUpdater({ pkgDir: historical.pkgDir, dataDir: historical.dataDir, settings: () => ({}), defaultSources: [url], manifestPublicKey: verifyKey })
    if (historical.version === '2.5.9') {
      await check('2.5.9 激活失败恢复全部原版运行时文件', async () => {
        const original = new Map(oldManifest.files.map(row => [row.path, fs.readFileSync(path.join(historical.pkgDir, row.path))]))
        await assert.rejects(updater.apply({ activate: async () => ({ ok: false, error: '夹具拒绝激活', runtimeRestored: true }) }), /previous files restored/)
        for (const [rel, bytes] of original) assert.deepEqual(fs.readFileSync(path.join(historical.pkgDir, rel)), bytes, rel)
        assert.equal(fs.existsSync(path.join(historical.pkgDir, 'src/engine-parts')), true)
        assert.deepEqual(fs.readdirSync(path.join(historical.pkgDir, 'src/engine-parts')), [])
      })
      await check('2.5.9 拒绝下载中被篡改的真实分片，已安装版本不变', async () => {
        tamperedPath = rows.find(row => row.path.endsWith('.part')).path
        // 上一轮失败保留了已验证暂存；使用独立升级数据目录验证真实坏下载。
        const fresh = new historical.module.PluginUpdater({ pkgDir: historical.pkgDir, dataDir: path.join(historical.dataDir, 'tampered'), settings: () => ({}), defaultSources: [url], manifestPublicKey: verifyKey })
        await assert.rejects(fresh.apply(), /staging failed|sha256|checksum/)
        assert.equal(JSON.parse(fs.readFileSync(path.join(historical.pkgDir, 'package.json'))).version, historical.version)
        tamperedPath = ''
      })
    }
    await check(`${historical.version} 原版完成下载、安装和最新插件模块加载`, async () => {
      assert.equal((await updater.check()).available, true)
      await updater.apply({ activate: async () => {
        const module = await import(pathToFileURL(path.join(historical.pkgDir, 'index.js')).href)
        assert.equal(module.name, 'our-free-model')
        return { ok: true, version: JSON.parse(fs.readFileSync(path.join(historical.pkgDir, 'package.json'))).version }
      } })
      // 1.3.1 尚不支持激活回调，另行验证升级后的真实模块。
      assert.equal((await import(pathToFileURL(path.join(historical.pkgDir, 'index.js')).href)).name, 'our-free-model')
      assert.equal(JSON.parse(fs.readFileSync(path.join(historical.pkgDir, 'package.json'))).version, pkg.version)
      for (const row of rows) assert.equal(sha(fs.readFileSync(path.join(historical.pkgDir, row.path))), row.sha256, row.path)
      assert.equal(fs.readFileSync(path.join(historical.dataDir, 'user-settings.json'), 'utf8'), '保留用户数据\n')
      installed = historical
    })
  }
  await check('升级后的新版升级器能重新检查同一签名发布且无需重复升级', async () => {
    const { PluginUpdater } = await import(pathToFileURL(path.join(installed.pkgDir, 'src/updater.js')).href)
    const successor = new PluginUpdater({ pkgDir: installed.pkgDir, dataDir: installed.dataDir, settings: () => ({}), defaultSources: [url], manifestPublicKey: verifyKey })
    assert.equal((await successor.check()).available, false)
    assert.equal(successor.status().current, pkg.version)
  })
  const metadata = JSON.parse(fs.readFileSync(path.join(installed.pkgDir, 'vendor/magpie/engine.json')))
  if (metadata.binaries[`${process.platform}-${process.arch}`]) {
    await check('真实升级产物仅凭分片还原引擎并启动认证管理接口', async () => {
      assert.equal(fs.existsSync(path.join(installed.pkgDir, 'vendor/magpie/bin/magpie-win32-x64.exe')), false)
      const oldEnv = { ...process.env }
      let engine
      try {
        for (const key of Object.keys(process.env)) {
          if (/(?:_HOME|_DIR|_CONFIG|_DATA_DIR|_CONFIG_DIR|_PATH)$/.test(key) && !['SystemRoot', 'WINDIR'].includes(key)) delete process.env[key]
        }
        Object.assign(process.env, { HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch, PATH: '', MAGPIE_NO_ACCOUNTS: '1', MAGPIE_PARTNERS: 'off', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost', DO_NOT_TRACK: '1' })
        const { createMagpieEngine } = await import(pathToFileURL(path.join(installed.pkgDir, 'src/magpie-engine.js')).href)
        engine = createMagpieEngine({ dataDir: path.join(installed.dataDir, 'native') })
        assert.equal(engine.status().available, true)
        assert.equal((await engine.start()).state, 'ready')
        assert.equal((await engine.request('GET', '/api/settings')).status, 200)
        const binary = path.join(installed.dataDir, 'native/engine-runtime', `${metadata.binaries[`${process.platform}-${process.arch}`].sha256}.exe`)
        assert.equal(sha(fs.readFileSync(binary)), metadata.binaries[`${process.platform}-${process.arch}`].sha256)
      } finally {
        await engine?.close()
        for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
        Object.assign(process.env, oldEnv)
      }
    })
  } else console.log(`ok 本机 ${process.platform}-${process.arch} 没有已发布原生引擎，跳过进程启动；旧版安装与模块加载已验证`)
  console.log(`${checks}/${checks} 旧版升级检查通过；${rows.length} 个真实文件；${requestCount} 次本地文件请求；${production ? '生产签名' : '一次性测试签名'}；无上游调用`)
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  if (!path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('清理路径越界')
  fs.rmSync(scratch, { recursive: true, force: true })
}
