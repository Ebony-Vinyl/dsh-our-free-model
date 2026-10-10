/**
 * 接线集成测试：用**真实 cordis** 复现 `index.js` 的挂载时序。
 *
 * 单测（channel-visibility-test.mjs）直接对着账号池调安装函数，因此**测不到**
 * 接线本身的坑：`pack.apply(scoped)` 是同步返回的，而它 `provide` 的服务所在
 * fiber 此刻尚未进入 active 状态，于是 cordis 的 `get()` 默认 strict 会返回
 * `undefined` —— 总开关会静默失效（installed:false），界面上表现为「开关拨了
 * 没反应」。本测试按 index.js 的真实顺序走一遍，锁死这一点。
 *
 * ## 为什么可能跳过
 *
 * 真实 cordis 与 `@deepseek-ai/dsh-*` 都是 DSH 宿主自带的私有包，**不在 npm 上**。
 * CI 的离线 job 刻意不装任何依赖（见 .github/workflows/test.yml），因此这里没有
 * 可解析的 cordis 时**跳过而非失败** —— 跳过是环境事实，不是缺陷。装了 DSH 的
 * 机器（或设了 `DSH_APP_ROOT` 的机器）会真正执行。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const CHANNEL_IDS = [
  'buddy', 'workbuddy', 'codearts', 'lobsterai', 'qoder', 'qodercn', 'trae',
  'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
]

/** 找到装着 DSH 宿主依赖的 package.json；找不到就跳过本测试。 */
function findAppRoot() {
  const candidates = []
  if (process.env.DSH_APP_ROOT) candidates.push(path.join(process.env.DSH_APP_ROOT, 'package.json'))
  // DSH 桌面端的常见安装位置（Windows / macOS / Linux）。
  const home = os.homedir()
  candidates.push(
    'C:/Users/Fish/AppData/Local/Programs/DSH Desktop Beta/resources/app/package.json',
    path.join(home, 'AppData/Local/Programs/DSH Desktop/resources/app/package.json'),
    '/Applications/DSH Desktop.app/Contents/Resources/app/package.json',
    '/usr/lib/dsh-desktop/resources/app/package.json',
    '/opt/DSH Desktop/resources/app/package.json',
  )
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        // 必须真能解析出 cordis，否则换个位置的 package.json 也没用。
        createRequire(candidate).resolve('@deepseek-ai/cordis')
        return candidate
      }
    } catch { /* 试下一个 */ }
  }
  return null
}

const APP_ROOT = findAppRoot()
if (APP_ROOT === null) {
  console.log('skip  wiring: no DSH host install found (set DSH_APP_ROOT to run it); the unit suite still covers the gate')
  process.exit(0)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-visibility-wiring-'))
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
// pack.js 住在插件目录下，那里没有 node_modules；它引用的这几个裸包只有 DSH
// 应用自带。用 createRequire 以应用为基准解析，尊重各包的 exports 映射
// （schemastery 的 import 入口是 lib/index.mjs，硬编码 lib/index.js 会 ENOENT）。
const appRequire = createRequire(APP_ROOT)
const NATIVE_PACKAGES = new Set(['@deepseek-ai/cordis', '@deepseek-ai/cosmokit', '@deepseek-ai/schemastery'])
const resolvedNative = new Map()
for (const name of NATIVE_PACKAGES) {
  try { resolvedNative.set(name, pathToFileURL(appRequire.resolve(name)).href) } catch { /* 交由默认解析报错 */ }
}

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // 只替换「内核契约」这一类：pack.js 通过它们拿 LlmAdapter 等基类。
    // cordis / cosmokit / schemastery 是真实运行时依赖，必须放行 —— 真实
    // cordis 正是本测试要跑的东西。
    if (NATIVE_PACKAGES.has(specifier)) {
      const native = resolvedNative.get(specifier)
      if (native !== undefined) return { url: native, shortCircuit: true }
      return nextResolve(specifier, context)
    }
    if (specifier.startsWith('@deepseek-ai/dsh-')) return { url: kernel, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
const savedFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('external network is disabled in the wiring test') }
const savedHideFlag = process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
delete process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT

const creds = new Map()
const accounts = CHANNEL_IDS.map((provider, index) => {
  const credentialRef = `TEST_${provider.toUpperCase()}`
  creds.set(credentialRef, { value: `{"token":"test-${provider}"}` })
  return {
    id: `${provider}-1`, provider, nickname: 'Test', credentialRef,
    enabled: true, refreshable: false, createdAt: index + 1,
  }
})

fs.mkdirSync(path.join(scratch, 'channel-pack'))
fs.writeFileSync(path.join(scratch, 'channel-pack/state.json'), JSON.stringify({ accounts, disabledModels: {} }))

try {
  // 真实 cordis：按绝对路径导入，绕开上面的解析钩子。
  const { Context } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/cordis')).href)
  const { installChannelCatalogVisibility } = await import('../src/channel-visibility.js')

  const root = new Context()
  const adapters = new Map()
  root.provide('logger', { info() {}, warn() {}, error() {}, debug() {} })
  root.provide('profileContext', { home: scratch })
  root.provide('credentials', {
    resolve: async ref => creds.get(ref),
    describe: async () => undefined,
    set: async () => {},
    unset: async () => {},
  })
  root.provide('llm', {
    registerAdapter(providers, adapter) { for (const provider of providers) adapters.set(provider, adapter) },
    listProviders: () => [...adapters.keys()].map(id => ({ id })),
  })
  root.provide('connection', { fetch: { register() {} } })
  // 宿主真实提供的服务：必须在 inject 之前就位，否则 cordis 的回调永远不触发。
  root.provide('commands', {})

  // 先拿到 pack 模块，供 inject 回调使用。
  const packModule = await import('../vendor/channel-pack/pack.js')

  let installed = false
  let pool = null
  let hide = true

  // 与 index.js 完全一致的顺序：inject → apply → 立刻取 accountPool → 安装门控。
  root.inject(['credentials', 'commands', 'llm'], scoped => {
    const { apply } = packModule
    apply(scoped, { disableOpencode: true })
    // ↓↓↓ index.js 里的那一行（非 strict 读取）
    pool = scoped.get('accountPool', false)
    const gate = installChannelCatalogVisibility(pool, { shouldHide: () => hide })
    installed = gate.installed
  })

  await new Promise(resolve => setImmediate(resolve))

  assert.equal(adapters.size, 13, '真实 cordis 下 13 个渠道 provider 均已注册')
  assert.ok(pool && typeof pool.hasLoggedInAccount === 'function', '同步读到了 pack 提供的账号池')
  assert.equal(installed, true, '总开关在真实 cordis 时序下成功接管（strict get 会在这里失败）')

  // 先取「门控未接管时」的可见基线：个别产品（cline/zcode）的目录只来自
  // models.dev，离线枚举为空，这是测试环境的既有事实，与本次门控无关。
  hide = false
  const baseline = []
  for (const id of CHANNEL_IDS) {
    if ((await adapters.get(id).listModels(id)).length > 0) baseline.push(id)
  }
  assert.ok(baseline.includes('loomy') && baseline.includes('raccoon'),
    `基线应包含用户截图里残留的 Loomy / Raccoon（实际 ${baseline.join(',')}）`)

  // 打开开关：13 组**全部**隐藏（隐藏不看基线，这正是总开关的意义）。
  hide = true
  for (const id of CHANNEL_IDS) {
    assert.equal((await adapters.get(id).listModels(id)).length, 0, `${id} 分组应隐藏`)
  }
  // 关闭开关：逐项恢复到基线。
  hide = false
  const restored = []
  for (const id of CHANNEL_IDS) {
    if ((await adapters.get(id).listModels(id)).length > 0) restored.push(id)
  }
  assert.deepEqual(restored, baseline, '关闭后可见集合逐项恢复到基线')

  // 上面走的是「与 index.js 相同的顺序」，但那是本测试自己写的一遍；真正要防的
  // 是 index.js 被改回 strict `get`。这里直接读它的源码断言接线形式 —— 否则本
  // 测试绿着，产品代码却可以静默失效（strict get 返回 undefined ⇒ installed:false）。
  const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(indexSource, /installChannelCatalogVisibility\(scoped\.get\('accountPool', false\)/,
    'index.js 必须以非 strict 形式读取 accountPool（strict 会静默拿不到，总开关失效）')
  assert.doesNotMatch(indexSource, /installChannelCatalogVisibility\(scoped\.get\('accountPool'\)/,
    'index.js 不得改回 strict get')

  console.log('ok  接线集成：真实 cordis 下 pack.apply 后同步取到账号池、门控接管、开则全隐关则恢复')
} finally {
  globalThis.fetch = savedFetch
  if (savedHideFlag === undefined) delete process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
  else process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = savedHideFlag
  hooks.deregister()
  fs.rmSync(scratch, { recursive: true, force: true })
}
