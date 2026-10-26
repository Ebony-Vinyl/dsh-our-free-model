import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { buildStandalonePackage, repositoryRoot, standaloneSourceFiles } from './pack-standalone.mjs'

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--sources-only') {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm package sources with spaces '))
  try {
    const files = standaloneSourceFiles()
    assert.equal(new Set(files).size, files.length)
    assert.ok(!files.includes('src/updater.js'))
    assert.ok(files.every(file => !/(^|\/)(?:node_modules|\.git|settings\.json|channel-credentials\.json|service\.lock|\.env)(\/|$)/.test(file)))
    for (const file of files) {
      const source = path.join(repositoryRoot, file)
      assert.ok(fs.lstatSync(source).isFile(), file)
      const target = path.join(scratch, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
    }
    fs.writeFileSync(path.join(scratch, 'package.json'), '{"private":true,"type":"module"}\n')
    const env = { ...process.env, PATH: '', NODE_OPTIONS: '', NODE_PATH: '' }
    const cli = path.join(scratch, 'packages/standalone/cli.mjs')
    assert.match(execFileSync(process.execPath, [cli, '--help'], {
      cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 15000,
    }), /--data-dir/)
    console.log('ok 1 isolated CLI loads the complete package source graph')
    const serviceUrl = pathToFileURL(path.join(scratch, 'packages/standalone/service.mjs')).href
    const dataDir = path.join(scratch, 'isolated-data')
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { startStandalone } from ${JSON.stringify(serviceUrl)}
      const original = globalThis.fetch
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
          ? original(input, init) : Promise.resolve(Response.json({ data: [] }))
      }
      const dataDir = ${JSON.stringify(dataDir)}
      const options = { dataDir, port: 0, refresh: false }
      let service
      try {
        service = await startStandalone(options)
        const health = await (await fetch(service.url + '/health')).json()
        assert.equal(health.product, 'standalone')
        const key = JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
        const assets = JSON.parse(fs.readFileSync(new URL('./web/assets.json', ${JSON.stringify(serviceUrl)}), 'utf8'))
        for (const endpoint of ['/', ...assets.map(name => '/assets/' + name)]) {
          const response = await fetch(service.url + endpoint)
          assert.equal(response.status, 200, endpoint)
          assert.ok((await response.text()).length > 0, endpoint)
        }
        assert.equal((await fetch(service.url + '/api/management/summary')).status, 401)
        const response = await fetch(service.url + '/api/management/summary', { headers: { authorization: 'Bearer ' + key } })
        assert.equal(response.status, 200)
        assert.equal((await response.json()).channels.state, 'ready')
        await service.close()
        service = undefined
        assert.ok(!fs.existsSync(dataDir + '/service.lock'))
        service = await startStandalone(options)
        assert.equal(JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey, key)
        console.log('ok 2 isolated service starts, serves every UI chunk, enforces auth and restarts with its key')
      } finally { await service?.close() }
    `], { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 30000 })
    process.stdout.write(result)
    console.log(`Source package verification passed: ${files.length} files; ZIP/runtime/permissions require macOS --package verification`)
  } finally {
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()))
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  process.exit(0)
}
assert.equal(args.length, 2, 'usage: node scripts/standalone-package-test.mjs --package dist/<directory>')
assert.equal(args[0], '--package')
const source = path.resolve(args[1])
const dist = path.join(repositoryRoot, 'dist')
assert.equal(path.dirname(source), dist, 'package must be directly inside this repository dist directory')
const archive = `${source}.zip`
const name = path.basename(source)
const scratch = fs.mkdtempSync(path.join(dist, '.package-smoke-'))
const extracted = path.join(scratch, '解压目录 with spaces')
const dataDir = path.join(scratch, 'isolated-data')
const dshDir = path.join(scratch, 'dsh-sentinel')
let service
let browser
let checks = 0
const check = async (label, test) => {
  await test()
  checks++
  console.log(`ok ${checks} ${label}`)
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const model = 'mimo-v2.6-flash-free'
let generations = 0
const fixture = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.url === '/inference/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: model }] }))
    } else if (req.url.endsWith('/chat/completions')) {
      generations++
      res.setHeader('content-type', 'text/event-stream')
      res.end([
        { choices: [{ index: 0, delta: { content: 'package-smoke-ok' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } },
      ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n')
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [] }))
    }
  })
})
fixture.listen(0, '127.0.0.1')
await once(fixture, 'listening')
const upstream = `http://127.0.0.1:${fixture.address().port}`
const preload = path.join(scratch, 'offline-fixture.mjs')
fs.writeFileSync(preload, `
const original = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return Promise.resolve(Response.json({ data: [] }));
  }
  return original(input, options);
};
`)
fs.mkdirSync(dshDir)
fs.writeFileSync(path.join(dshDir, 'sentinel.txt'), 'unchanged')
const env = {
  ...process.env,
  PATH: '/usr/bin:/bin',
  NODE_OPTIONS: `--import "${pathToFileURL(preload).href}"`,
  OFM_TEST_UPSTREAM: upstream,
  OUR_FREE_MODEL_BASE: upstream,
  OUR_FREE_MODEL_KILO_BASE: upstream,
  DSH_HOME: dshDir,
}
delete env.NODE_PATH
const root = path.join(extracted, name)
const run = (file, argv) => execFileSync(file, argv, { cwd: scratch, env, encoding: 'utf8', timeout: 15000 })
const request = (base, endpoint, options = {}) => fetch(`${base}${endpoint}`, {
  ...options, signal: AbortSignal.timeout(10000),
})
async function start() {
  const child = spawn(path.join(root, 'start.command'), ['--port', '0', '--data-dir', dataDir, '--no-refresh'], {
    cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let errors = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { errors += value })
  const exit = new Promise(resolve => {
    child.once('error', error => resolve({ error }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  // Attach shutdown ownership immediately, including a startup timeout.
  service = { child, exit, errors: () => errors }
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Packaged service exited (${child.exitCode}); ${errors.slice(-1500)}`)
    const match = output.match(/API：http:\/\/127\.0\.0\.1:(\d+)\/v1/)
    if (match) {
      service.url = `http://127.0.0.1:${match[1]}`
      service.managementUrl = output.match(/http:\/\/127\.0\.0\.1:\d+\/#login=[A-Za-z0-9_-]+/)?.[0]
      return service
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Packaged service did not become ready in 15 seconds')
}
async function stop() {
  if (!service) return
  const current = service
  service = undefined
  current.child.kill('SIGTERM')
  const timer = setTimeout(() => current.child.kill('SIGKILL'), 10000)
  try {
    const result = await current.exit
    assert.deepEqual(result, { code: 0, signal: null }, 'service must shut down cleanly')
  } finally { clearTimeout(timer) }
}

try {
  await check('ZIP can be extracted and contains one safe package root', () => {
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n')
    assert.ok(entries.every(entry => entry.startsWith(`${name}/`) && !entry.split('/').includes('..') && !entry.includes('\\')))
    fs.mkdirSync(extracted)
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, extracted])
  })
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package-manifest.json'), 'utf8'))
  await check('every extracted byte and executable permission matches the package manifest', () => {
    assert.equal(manifest.purpose, 'development-validation-only')
    const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(directory, entry.name)
      assert.equal(entry.isSymbolicLink(), false)
      return entry.isDirectory() ? walk(file) : [path.relative(root, file)]
    })
    assert.deepEqual(walk(root).sort(), [...manifest.files.map(file => file.path), 'package-manifest.json'].sort())
    for (const record of manifest.files) {
      const file = path.join(root, record.path)
      const bytes = fs.readFileSync(file)
      assert.equal(bytes.length, record.bytes, record.path)
      assert.equal(hash(bytes), record.sha256, record.path)
      assert.equal(fs.statSync(file).mode & 0o777, record.mode, record.path)
    }
  })
  await check('package excludes host plugins, installed dependencies and user data', () => {
    const paths = manifest.files.map(file => file.path)
    assert.ok(paths.every(file => !/(^|\/)(?:node_modules|\.git|\.aoci|settings\.json|channel-credentials\.json|service\.lock|\.env)(\/|$)/.test(file)))
    for (const unwanted of ['index.js', 'client.js', 'src/updater.js', 'src/reload.js', 'feed/manifest.json']) assert.ok(!paths.includes(unwanted))
    assert.ok(paths.includes('vendor/channel-pack/qoder-auth-wasm.wasm'))
    assert.ok(paths.includes('runtime/LICENSE'))
    assert.ok(paths.includes('THIRD_PARTY_NOTICES.txt'))
  })
  await check('bundled runtime and launcher work without Node on PATH and from another directory', () => {
    assert.equal(run(path.join(root, 'runtime/node'), ['-p', 'process.version']).trim(), manifest.runtime.version)
    assert.match(run(path.join(root, 'start.command'), ['--help']), /--data-dir/)
  })
  await check('builder rejects overwriting a package or missing its runtime license', () => {
    assert.throws(() => buildStandalonePackage(), /node-license/)
    assert.throws(() => buildStandalonePackage({
      nodeExecutable: path.join(root, 'runtime/node'),
      nodeLicense: path.join(root, 'runtime/LICENSE'), outputName: name,
    }), /already exists/)
  })
  await check('actual packaged CLI starts with an isolated data directory and ephemeral port', async () => {
    await start()
    const health = await (await request(service.url, '/health')).json()
    assert.equal(health.product, 'standalone')
    assert.equal(health.version, manifest.product.version)
    assert.ok(service.managementUrl)
    assert.ok(!fs.existsSync(path.join(root, 'settings.json')))
  })
  const key = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).forwardKey
  const authorization = { authorization: `Bearer ${key}` }
  await check('all page assets load locally; unauthenticated model and management access fails', async () => {
    const assets = JSON.parse(fs.readFileSync(path.join(root, 'packages/standalone/web/assets.json'), 'utf8'))
    for (const file of ['/', ...assets.map(name => `/assets/${name}`)]) {
      const response = await request(service.url, file)
      assert.equal(response.status, 200, file)
      assert.ok(!(await response.text()).includes(key))
    }
    for (const endpoint of ['/v1/models', '/api/management/summary', '/api/management/key']) {
      assert.equal((await request(service.url, endpoint)).status, 401)
    }
    const summary = await (await request(service.url, '/api/management/summary', { headers: authorization })).json()
    assert.equal(summary.channels.state, 'ready')
  })
  await check('the extracted package completes a local model refresh and real HTTP generation', async () => {
    const refresh = await request(service.url, '/api/management/models/refresh', {
      method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(refresh.status, 200)
    const models = await (await request(service.url, '/v1/models', { headers: authorization })).json()
    assert.ok(models.data.some(entry => entry.id === model))
    const response = await request(service.url, '/v1/chat/completions', {
      method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'local smoke test' }] }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).choices[0].message.content, 'package-smoke-ok')
    assert.equal(generations, 1)
  })
  let browserVerified = false
  if (process.env.OFM_PLAYWRIGHT_MODULE) {
    await check('browser opens the extracted package and renders the account-channel page', async () => {
      const require = createRequire(import.meta.url)
      const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE)
      browser = await chromium.launch({
        headless: true, ...(process.env.OFM_BROWSER_EXECUTABLE ? { executablePath: process.env.OFM_BROWSER_EXECUTABLE } : {}),
      })
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(service.managementUrl)
      await page.getByTestId('overview-ready').waitFor()
      await page.locator('.console-nav-item').filter({ hasText: '免费账号渠道' }).click()
      await page.getByLabel('搜索渠道').waitFor()
      await page.getByText('LobsterAI', { exact: false }).first().waitFor()
      await page.screenshot({ path: `${source}.smoke.png`, fullPage: true })
      assert.deepEqual(errors, [])
      await browser.close()
      browser = undefined
      browserVerified = true
    })
  }
  await check('shutdown releases its lock and restart preserves the API key and external data', async () => {
    await stop()
    assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), false)
    await start()
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).forwardKey, key)
    await stop()
    assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), false)
    assert.deepEqual(fs.readdirSync(dshDir), ['sentinel.txt'])
    assert.equal(fs.readFileSync(path.join(dshDir, 'sentinel.txt'), 'utf8'), 'unchanged')
  })
  fs.writeFileSync(`${source}.verification.json`, `${JSON.stringify({
    package: name, platform: process.platform, arch: process.arch,
    checks, browserVerified, network: 'local-fixture', generations,
    sourceSha256: manifest.source.snapshotSha256,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  console.log(`Package verification passed: ${checks} checks; browser=${browserVerified}`)
} finally {
  try { await browser?.close() } finally {
    try { await stop() } finally {
      fixture.closeAllConnections()
      await new Promise(resolve => fixture.close(resolve))
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  }
}
