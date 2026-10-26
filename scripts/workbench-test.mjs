import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createWorkbench, prepareClientLaunch, resolveClientExecutable, privateWrite } from '../packages/standalone/workbench.mjs'
import { createProviderManagement } from '../packages/standalone/providers.mjs'
import { createRuntimeStores } from '../src/core/runtime.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-workbench-'))
let checks = 0
const check = async (name, action) => { await action(); checks++; console.log(`ok ${name}`) }
const plan = id => ({
  client: { id, executable: process.execPath, cwd: scratch, mode: 'gateway', model: 'deepseek/model' },
  profileDir: path.join(scratch, id), baseUrl: 'http://127.0.0.1:18900', key: 'private-local-key',
  env: { PATH: process.env.PATH, CODEX_SQLITE_HOME: 'native-session-database', OPENAI_API_KEY: 'inherited-secret', ANTHROPIC_API_KEY: 'old-claude-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth', GOOGLE_API_KEY: 'old-google-key', GOOGLE_GENAI_USE_VERTEXAI: 'true' },
})
let stores
try {
  await check('Codex pure API has explicit token and isolated home without native sign-in', () => {
    const prepared = prepareClientLaunch(plan('codex'))
    const config = fs.readFileSync(path.join(prepared.env.CODEX_HOME, 'config.toml'), 'utf8')
    assert.match(config, /requires_openai_auth = false/)
    assert.match(config, /wire_api = "responses"/)
    assert.match(config, /experimental_bearer_token = "private-local-key"/)
    assert.equal(prepared.env.OPENAI_API_KEY, undefined)
    assert.equal(prepared.env.CODEX_SQLITE_HOME, path.join(prepared.env.CODEX_HOME, 'sqlite'))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(prepared.env.CODEX_HOME, 'auth.json'))), { OPENAI_API_KEY: 'private-local-key' })
    assert.equal(fs.existsSync(path.join(scratch, '.codex')), false)
  })
  await check('Claude launches on gateway with inherited official auth removed', () => {
    const prepared = prepareClientLaunch(plan('claude'))
    assert.equal(prepared.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18900')
    assert.equal(prepared.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    assert.equal(prepared.env.ANTHROPIC_API_KEY, 'private-local-key')
    assert.deepEqual(prepared.args, ['--model', 'deepseek/model'])
    assert.ok(prepared.env.CLAUDE_CONFIG_DIR.startsWith(scratch + path.sep))
  })
  await check('Gemini is configured for API-key mode in its isolated home', () => {
    const prepared = prepareClientLaunch(plan('gemini'))
    assert.equal(prepared.env.GOOGLE_API_KEY, undefined)
    assert.equal(prepared.env.GOOGLE_GENAI_USE_VERTEXAI, undefined)
    assert.equal(prepared.env.GEMINI_API_KEY, 'private-local-key')
    assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.env.GEMINI_CLI_HOME, '.gemini/settings.json'))).security.auth.selectedType, 'gemini-api-key')
  })
  await check('gateway preparation preserves Gemini settings and clears Claude provider selectors', () => {
    const options = plan('gemini')
    const settingsFile = path.join(options.profileDir, '.gemini/settings.json')
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ ui: { theme: 'custom' }, mcpServers: { local: { command: 'tool' } } }))
    const prepared = prepareClientLaunch({ ...options, env: {
      ...options.env, CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: 'native-resource',
    } })
    const settings = JSON.parse(fs.readFileSync(settingsFile))
    assert.equal(settings.ui.theme, 'custom')
    assert.ok(settings.mcpServers.local)
    const claude = prepareClientLaunch({ ...plan('claude'), env: {
      ...options.env, CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: 'native-resource',
    } })
    assert.equal(claude.env.CLAUDE_CODE_USE_FOUNDRY, undefined)
    assert.equal(claude.env.ANTHROPIC_FOUNDRY_RESOURCE, undefined)
  })
  await check('native manager launch preserves its configuration and creates no profile', () => {
    const options = plan('cc-switch')
    options.client.mode = 'native'
    const prepared = prepareClientLaunch(options)
    assert.equal(prepared.env.OPENAI_API_KEY, 'inherited-secret')
    assert.equal(fs.existsSync(options.profileDir), false)
  })
  await check('config generation rejects remote gateway and missing models', () => {
    assert.throws(() => prepareClientLaunch({ ...plan('codex'), baseUrl: 'https://example.com' }))
    const options = plan('codex')
    options.client.model = ''
    assert.throws(() => prepareClientLaunch(options), /模型/)
  })
  await check('a CLI executable on PATH is not reported as Codex Desktop', () => {
    const cliOnly = path.join(scratch, 'codex.exe')
    fs.writeFileSync(cliOnly, '')
    const isolated = createWorkbench({
      dataDir: path.join(scratch, 'path-detection'), home: scratch, platform: 'win32',
      env: { PATH: scratch, SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
      info: () => ({ baseUrl: 'http://127.0.0.1:18900', enabled: true }), key: () => 'secret',
      modelRows: () => [],
    })
    assert.equal(isolated.clients().find(row => row.id === 'codex').installed, true)
    assert.equal(isolated.clients().find(row => row.id === 'codex-desktop').installed, false)
  })
  await check('npm CLI wrappers resolve package bin metadata without executing a command shell', () => {
    const shimDir = path.join(scratch, 'npm')
    const packageDir = path.join(shimDir, 'node_modules/@google/gemini-cli')
    fs.mkdirSync(path.join(packageDir, 'bundle'), { recursive: true })
    fs.writeFileSync(path.join(shimDir, 'gemini.cmd'), '@echo off')
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ bin: { gemini: 'bundle/gemini.js' } }))
    fs.writeFileSync(path.join(packageDir, 'bundle/gemini.js'), '// fixture only')
    const source = { executable: path.join(shimDir, 'gemini.cmd'), args: ['--model', 'literal/%PATH%&model'], env: {}, cwd: scratch }
    const resolved = resolveClientExecutable(source, 'gemini', { platform: 'win32', nodePath: process.execPath })
    assert.equal(resolved.executable, process.execPath)
    assert.deepEqual(resolved.args, [path.join(packageDir, 'bundle/gemini.js'), '--model', 'literal/%PATH%&model'])
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ bin: { gemini: '../../../../outside.js' } }))
    assert.throws(() => resolveClientExecutable(source, 'gemini', { platform: 'win32' }), /无法解析/)
  })
  await check('private-write permission failures leave the old destination untouched', () => {
    const destination = path.join(scratch, 'atomic-private.json')
    privateWrite(destination, 'old')
    const chmod = fs.chmodSync
    fs.chmodSync = (file, mode) => {
      if (String(file).startsWith(destination + '.') && String(file).endsWith('.tmp')) throw new Error('permission failure')
      return chmod(file, mode)
    }
    try { assert.throws(() => privateWrite(destination, 'new'), /permission failure/) }
    finally { fs.chmodSync = chmod }
    assert.equal(fs.readFileSync(destination, 'utf8'), 'old')
  })
  const children = []
  const launches = []
  const workbench = createWorkbench({
    dataDir: path.join(scratch, 'state'), home: scratch,
    info: () => ({ baseUrl: 'http://127.0.0.1:18900', enabled: true }), key: () => 'secret',
    modelRows: () => [{ id: 'deepseek/model' }],
    spawnImpl(executable, args, options) {
      const child = new EventEmitter()
      child.pid = 1234
      child.kill = () => { child.emit('exit', 0); return true }
      child.unref = () => {}
      children.push(child)
      launches.push({ executable, args, options })
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  })
  await check('invalid paths, modes, IDs and arbitrary fields are rejected without writing state', () => {
    for (const patch of [
      { id: 'unknown' }, { id: 'codex', executable: 'relative.exe' },
      { id: 'codex', cwd: 'relative' }, { id: 'codex', model: 'x\nbad' },
      { id: 'codex', args: ['execute-anything'] }, { id: 'codex', mode: 'bad' },
      { id: 'cc-switch', mode: 'gateway' },
    ]) assert.throws(() => workbench.save(patch))
    assert.equal(fs.existsSync(path.join(scratch, 'state/workbench.json')), false)
  })
  await check('saved client configuration survives recreation', () => {
    workbench.save({ id: 'codex-desktop', executable: process.execPath, cwd: scratch, model: 'deepseek/model' })
    const reloaded = createWorkbench({ dataDir: path.join(scratch, 'state'), info: () => ({}), key: () => '', modelRows: () => [], home: scratch })
    assert.equal(reloaded.clients().find(row => row.id === 'codex-desktop').model, 'deepseek/model')
    assert.equal(reloaded.clients().find(row => row.id === 'codex-desktop').installed, true)
  })
  await check('launch owns one process and passes private config without shell interpolation', async () => {
    assert.equal((await workbench.launch({ id: 'codex-desktop' })).ok, true)
    assert.equal(launches[0].options.shell, false)
    assert.equal(launches[0].options.env.CODEX_HOME, path.join(scratch, 'state/clients/codex-desktop'))
    assert.ok(launches[0].args[0].startsWith('--user-data-dir='))
    assert.equal(workbench.clients().find(row => row.id === 'codex-desktop').running, true)
    await assert.rejects(() => workbench.launch({ id: 'codex-desktop' }), /已经启动/)
    assert.throws(() => workbench.save({ id: 'codex-desktop', model: 'other' }), /先关闭/)
    assert.equal((await workbench.stop({ id: 'codex-desktop' })).ok, true)
    assert.equal(workbench.clients().find(row => row.id === 'codex-desktop').running, false)
    await assert.rejects(() => workbench.stop({ id: 'codex' }), /没有/)
  })
  await check('unavailable model cannot start an installed client', async () => {
    workbench.save({ id: 'codex-desktop', model: 'gone' })
    await assert.rejects(() => workbench.launch({ id: 'codex-desktop' }), /模型当前不可用/)
    assert.equal(launches.length, 1)
  })
  await check('interactive ownership tracks the terminal handle and awaits Stop and disposal', async () => {
    let running = true, stops = 0
    const terminalPlans = []
    const clientManager = createWorkbench({
      dataDir: path.join(scratch, 'terminal-state'), home: scratch, env: { PATH: '' },
      info: () => ({ baseUrl: 'http://127.0.0.1:18900', enabled: true }), key: () => 'local-key',
      modelRows: () => [{ id: 'deepseek/model' }],
      terminalLaunch: async (plan, options) => {
        terminalPlans.push({ plan, options })
        running = true
        return {
          pid: 7654, isRunning: async () => running,
          stop: async () => { stops++; running = false },
          dispose: async () => { stops++; running = false },
        }
      },
    })
    clientManager.save({ id: 'codex', executable: process.execPath, cwd: scratch, model: 'deepseek/model' })
    assert.equal((await clientManager.launch({ id: 'codex' })).pid, 7654)
    assert.equal(clientManager.clients().find(row => row.id === 'codex').running, true)
    assert.equal(terminalPlans[0].plan.env.CODEX_HOME, path.join(scratch, 'terminal-state/clients/codex'))
    await clientManager.stop({ id: 'codex' })
    assert.equal(stops, 1)
    assert.equal(clientManager.clients().find(row => row.id === 'codex').running, false)
    await clientManager.launch({ id: 'codex' })
    await clientManager.dispose()
    assert.equal(stops, 2)
    await assert.rejects(() => clientManager.launch({ id: 'codex' }), /工作台正在停止/)
  })
  stores = createRuntimeStores({ dataDir: path.join(scratch, 'providers') })
  let syncs = 0
  const providers = createProviderManagement({
    stores, runtime: { syncAggregateCatalog: () => { syncs++ } },
    persist: patch => { stores.settings.update(patch); stores.settings.flush() },
  })
  await check('full provider directory appears before any connection', () => {
    assert.ok(providers.list().registry.length >= 70)
    assert.deepEqual(providers.list().configured, {})
  })
  await check('provider save keeps secrets private and supports model overrides', () => {
    providers.save({ providerId: 'openai_api', apiKey: 'sk-private-test-1234', models: ['custom/model', 'custom/model'] })
    const view = providers.list()
    assert.equal(view.configured.openai_api.hasKey, true)
    assert.equal(view.configured.openai_api.keyHint, '…1234')
    assert.deepEqual(view.configured.openai_api.models, ['custom/model'])
    assert.equal(JSON.stringify(view).includes('sk-private-test'), false)
    providers.save({ providerId: 'openai_api', enabled: false })
    assert.equal(stores.settings.get().aggregate.providers.openai_api.apiKey, 'sk-private-test-1234')
    assert.equal(providers.list().configured.openai_api.enabled, false)
  })
  await check('provider URLs and fields validate and explicit key clear removes credential', () => {
    for (const patch of [
      { providerId: 'unknown' }, { providerId: 'openai_api', apiKey: 'bad\nkey' },
      { providerId: 'openai_api', baseUrl: 'file:///secret' }, { providerId: 'openai_api', baseUrl: 'https://key@host.test' },
      { providerId: 'openai_api', baseUrl: 'https://host.test/?key=secret' }, { providerId: 'openai_api', models: [''] },
      { providerId: 'openai_api', arbitrary: true },
    ]) assert.throws(() => providers.save(patch))
    providers.save({ providerId: 'openai_api', apiKey: '' })
    assert.equal(providers.list().configured.openai_api.hasKey, false)
    providers.remove({ providerId: 'openai_api' })
    assert.deepEqual(providers.list().configured, {})
    assert.ok(syncs >= 4)
  })
} finally {
  stores?.dispose()
  assert.ok(fs.realpathSync(scratch).startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(`workbench: ${checks} checks passed`)
