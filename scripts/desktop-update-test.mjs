import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createDesktopUpdater, selectDesktopRelease, newerVersion, installerChecksum } from '../packages/standalone/desktop-update.mjs'

// `realpath` because macOS hands out a temp dir under `/var`, which is a symlink
// to `/private/var` — the managed-storage checks reject any symlinked ancestor,
// so an unresolved path fails on macOS before a single assertion runs.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-desktop-update-')))
const bytes = Buffer.from('官方安装包下载夹具，不执行安装')
const sha = crypto.createHash('sha256').update(bytes).digest('hex')
const release = version => ({ tag_name: `v${version}`, draft: false, prerelease: false, body: '更新说明', assets: [
  { name: `Our.Free.Model_${version}_x64-setup.exe`, size: bytes.length, browser_download_url: `https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/download/v${version}/Our.Free.Model_${version}_x64-setup.exe` },
  { name: 'SHA256SUMS', browser_download_url: `https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/download/v${version}/SHA256SUMS` },
] })
let mode = 'ok', requests = 0
const fixtureFetch = async (url) => {
  requests++
  if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
  if (mode === 'network') throw new TypeError('fetch failed')
  if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify([
    { tag_name: 'v2.7.9', assets: [{ name: 'dsh-our-free-model-2.7.9.tgz' }] },
    { ...release('9.0.0'), prerelease: true }, release('2.7.3'), release('2.7.1'),
  ]))
  if (url.endsWith('/SHA256SUMS')) return new Response(`${mode === 'bad-hash' ? '0'.repeat(64) : sha}  Our.Free.Model_2.7.3_x64-setup.exe\n`)
  return new Response(mode === 'oversize' ? Buffer.concat([bytes, Buffer.from('多余')]) : bytes,
    { headers: mode === 'wrong-size-header' ? { 'content-length': '99999' } : {} })
}
let checks = 0
const check = async (name, run) => { await run(); console.log(`ok ${++checks} - ${name}`) }
const manager = (name, extra = {}) => createDesktopUpdater({ dataDir: path.join(scratch, name), version: '2.7.1', platform: 'win32', arch: 'x64', fetchImpl: fixtureFetch, ...extra })
const runCheck = async updater => { updater.check(); const state = await updater.settled(); assert.equal(state.phase, 'idle'); return state }
try {
  await check('跳过仅插件、预发布与旧版本，按真实桌面包选择最高版本', async () => {
    const updater = manager('versions'); const state = await runCheck(updater)
    assert.equal(state.latest.version, '2.7.3'); assert.equal(state.available, true)
    assert.equal(newerVersion('2.10.0', '2.9.9'), true)
    assert.equal(newerVersion('2.7.1', '2.7.1'), false)
    assert.equal(selectDesktopRelease([{ tag_name: 'v3.0.0', assets: [{ name: 'plugin.tgz' }] }]), null)
    assert.equal(selectDesktopRelease([release('2.7.3')], 'arm64'), null)
  })
  await check('SHA 校验成功后才生成原生安装凭据，并保留配置', async () => {
    const updater = manager('download'); await runCheck(updater)
    fs.mkdirSync(path.join(scratch, 'download'), { recursive: true }); fs.writeFileSync(path.join(scratch, 'download/settings.json'), '原有配置')
    assert.equal(updater.download().phase, 'downloading'); assert.equal((await updater.settled()).phase, 'ready')
    const directory = path.join(scratch, 'download/desktop-updates')
    assert.deepEqual(fs.readFileSync(path.join(directory, `installer-${sha}.exe`)), bytes)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'ready.json'))), { schemaVersion: 1, version: '2.7.3', size: bytes.length, sha256: sha })
    assert.equal(fs.readFileSync(path.join(scratch, 'download/settings.json'), 'utf8'), '原有配置')
    const previous = requests; updater.download(); await updater.settled(); assert.equal(requests - previous, 1, '有效缓存只重读官方校验文件')
  })
  await check('坏摘要、超限下载及错误长度不会写入安装凭据，临时文件被清理', async () => {
    for (const failure of ['bad-hash', 'oversize', 'wrong-size-header']) {
      mode = 'ok'; const updater = manager(failure); await runCheck(updater)
      mode = failure; updater.download(); const state = await updater.settled()
      assert.equal(state.phase, 'error'); assert(state.error)
      const dir = path.join(scratch, failure, 'desktop-updates')
      assert.equal(fs.existsSync(path.join(dir, 'ready.json')), false)
      assert.equal(fs.readdirSync(dir).some(name => /\.(part|tmp)$/.test(name)), false)
    }
    mode = 'ok'
  })
  await check('下载缓存篡改后重新下载，检查新版本时旧安装凭据失效', async () => {
    const updater = manager('corrupt'); await runCheck(updater); updater.download(); await updater.settled()
    const dir = path.join(scratch, 'corrupt/desktop-updates'); fs.writeFileSync(path.join(dir, `installer-${sha}.exe`), '坏缓存')
    updater.download(); assert.equal((await updater.settled()).phase, 'ready'); assert.deepEqual(fs.readFileSync(path.join(dir, `installer-${sha}.exe`)), bytes)
    await runCheck(updater); assert.equal(fs.existsSync(path.join(dir, 'ready.json')), false)
  })
  await check('拒绝重复操作、未检查的下载及已关闭管理器', async () => {
    const updater = manager('concurrent'); assert.throws(() => updater.download(), /先检查/)
    updater.check(); assert.throws(() => updater.check(), error => error.statusCode === 409)
    await updater.settled(); updater.close(); assert.throws(() => updater.check(), /关闭/)
  })
  await check('拒绝外部安装包地址、非 HTTPS 重定向和不唯一的摘要', async () => {
    const foreign = release('2.7.3'); foreign.assets[0].browser_download_url = 'https://evil.invalid/setup.exe'
    assert.throws(() => selectDesktopRelease([foreign]), /官方发布源/)
    assert.throws(() => installerChecksum(`${sha}  setup.exe\n${sha}  setup.exe`, 'setup.exe'), /唯一/)
    mode = 'redirect'; const updater = manager('redirect'); updater.check(); assert.equal((await updater.settled()).phase, 'error'); mode = 'ok'
  })
  await check('不支持的平台与浏览器服务不发更新请求，当前版本无需降级', async () => {
    const unsupported = manager('unsupported', { platform: 'darwin' }); const previous = requests
    assert.throws(() => unsupported.check(), /Windows/); assert.equal(requests, previous)
    const browser = manager('browser', { version: undefined }); assert.equal(browser.status().supported, false)
    const latest = manager('latest', { version: '2.8.0' }); assert.equal((await runCheck(latest)).available, false); assert.throws(() => latest.download(), /先检查/)
  })
  await check('网络失败显示错误且允许重新检查恢复', async () => {
    const updater = manager('recovery'); mode = 'network'; updater.check(); assert.equal((await updater.settled()).phase, 'error')
    mode = 'ok'; assert.equal((await runCheck(updater)).available, true)
  })
  await check('实际管理接口要求私有会话与同源，且不提供 HTTP 安装入口', async () => {
    const savedFetch = globalThis.fetch
    const previousVersion = process.env.OFM_DESKTOP_VERSION
    process.env.OFM_DESKTOP_VERSION = '2.7.1'
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? savedFetch(input, init) : fixtureFetch(url.href, init)
    }
    let service
    try {
      const { startStandalone } = await import('../packages/standalone/service.mjs')
      // The endpoint refuses to check anywhere but Windows x64, and CI is not
      // that host. Declare the host instead of skipping the flow: the point of
      // this case is the HTTP wiring, which must be exercised where CI runs.
      service = await startStandalone({ dataDir: path.join(scratch, 'http'), port: 0, refresh: false, logger: { warn() {} }, desktopPlatform: 'win32', desktopArch: 'x64' })
      const api = '/api/management/desktop-update'
      const request = (route, options = {}) => savedFetch(service.url + route, { ...options, headers: { origin: service.url, 'content-type': 'application/json', ...options.headers } })
      assert.equal((await request(api)).status, 401)
      const key = JSON.parse(fs.readFileSync(service.keyFile)).forwardKey
      assert.equal((await request(api, { headers: { authorization: `Bearer ${key}` } })).status, 403)
      const token = new URLSearchParams(new URL(service.managementUrl).hash.slice(1)).get('login')
      const login = await request('/api/management/session', { method: 'POST', body: JSON.stringify({ bootstrapToken: token }) })
      assert.equal(login.status, 200)
      const cookie = login.headers.get('set-cookie').split(';')[0]
      assert.equal((await request(api, { headers: { cookie } })).status, 200)
      assert.equal((await request(api + '/check', { method: 'POST', body: '{}', headers: { cookie, origin: 'https://foreign.invalid' } })).status, 403)
      assert.equal((await request(api + '/install', { method: 'POST', body: '{}', headers: { cookie } })).status, 404)
      assert.equal((await request(api + '/check', { method: 'POST', body: '{}', headers: { cookie } })).status, 200)
      let status
      for (let i = 0; i < 100; i++) {
        status = await (await request(api, { headers: { cookie } })).json()
        if (status.phase !== 'checking') break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(status.latest.version, '2.7.3')
    } finally {
      await service?.close()
      globalThis.fetch = savedFetch
      if (previousVersion === undefined) delete process.env.OFM_DESKTOP_VERSION
      else process.env.OFM_DESKTOP_VERSION = previousVersion
    }
  })
  console.log(`${checks}/${checks} 桌面更新检查通过；所有下载均为本地替身，未执行安装器`)
} finally {
  assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir()))
  fs.rmSync(scratch, { recursive: true, force: true })
}
