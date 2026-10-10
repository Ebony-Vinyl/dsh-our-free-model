/**
 * 渠道包「目录可见性总开关」的行为测试。
 *
 * 直接挂载真实的 `vendor/channel-pack/pack.js`，用**真实适配器**与**真实门控**
 * （`providerCatalogVisible`）验证三件事：
 *   1. 开关打开 ⇒ 13 个渠道分组全部从模型目录消失（`listModels()` 返回 `[]`）；
 *   2. 开关关闭 ⇒ 恢复可见；
 *   3. 「显示列表」依赖的 `listAllModels()` 始终不受影响（设置页仍能渲染）。
 *
 * 还验证开关对 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` 的接管是**权威**的：用户即使
 * 把这个环境变量显式设成假值，也不能让总开关失效；关闭后环境变量回到用户原值。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-channel-visibility-'))
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

// 13 个渠道 provider 的产品 id（与 client.js 的渠道网格一致）。
const CHANNEL_IDS = [
  'buddy', 'workbuddy', 'codearts', 'lobsterai', 'qoder', 'qodercn', 'trae',
  'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
]

process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
const savedFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('external network is disabled in the visibility test') }
const savedHideFlag = process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
delete process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT

const dispose = []
const adapters = new Map()
const creds = new Map()
// 每个渠道 provider 都配一个可解析的账号 —— 这正是用户机器上的现状
// （13 个 provider 都有账号，所以「无账号即隐藏」那条既有门控是**失效**的）。
const accounts = CHANNEL_IDS.map((provider, index) => {
  const credentialRef = `TEST_${provider.toUpperCase()}`
  creds.set(credentialRef, { value: `{"token":"test-${provider}"}` })
  return {
    id: `${provider}-1`, provider, nickname: 'Test', credentialRef,
    enabled: true, refreshable: false, createdAt: index + 1,
  }
})

const services = {
  profileContext: { home: scratch },
  credentials: {
    resolve: async ref => creds.get(ref),
    describe: async () => undefined,
    set: async (ref, value) => { creds.set(ref, { value }) },
    unset: async ref => { creds.delete(ref) },
  },
  llm: {
    registerAdapter(providers, adapter) { for (const provider of providers) adapters.set(provider, adapter) },
    listProviders: () => [...adapters.keys()].map(id => ({ id })),
  },
  connection: { fetch: { register() {} } },
}
const ctx = {
  ...services,
  logger: { info() {}, warn() {}, error() {} },
  get: name => services[name],
  provide(name, service) { services[name] = service; this[name] = service },
  effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') dispose.push(cleanup) },
  inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(this) },
  emit() {},
}

fs.mkdirSync(path.join(scratch, 'channel-pack'))
fs.writeFileSync(path.join(scratch, 'channel-pack/state.json'), JSON.stringify({ accounts, disabledModels: {} }))

try {
  const { apply } = await import('../vendor/channel-pack/pack.js')
  apply(ctx, { disableOpencode: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(adapters.size, 13, '13 个渠道 provider 均已注册')

  const pool = ctx.accountPool
  assert.ok(pool && typeof pool.hasLoggedInAccount === 'function', 'pack 通过 ctx.provide 暴露了账号池')

  // 既有门控（按账号判定）在「每个 provider 都有账号」时全部放行 —— 现状复现。
  for (const id of CHANNEL_IDS) {
    assert.equal(await pool.hasLoggedInAccount(id), true, `${id} 有已登录账号，既有门控放行`)
  }

  // 基线：默认门控下的可见集合。绝大多数产品离线也有兜底表，故基线必须几乎全满；
  // 个别产品（cline）的目录只来自 models.dev 且无兜底表，离线枚举为空 —— 那是
  // 测试环境的既有事实，与本次门控无关，故用「基线集合」而非「13 个都必须非空」
  // 做不变量，既更严格（要求恢复后逐项与基线一致）也不受离线影响。
  const listVisible = async () => {
    const visible = []
    for (const id of CHANNEL_IDS) {
      if ((await adapters.get(id).listModels(id)).length > 0) visible.push(id)
    }
    return visible
  }
  const baseline = await listVisible()
  assert.ok(baseline.length >= 12, `默认门控下绝大多数分组应可见（实际 ${baseline.length}/13）`)
  assert.ok(baseline.includes('loomy') && baseline.includes('raccoon'), '用户截图里残留的 Loomy / Raccoon 在基线中可见')

  // 模拟「用户把账号门控显式关掉」——总开关必须依然权威。
  process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = '0'

  const { installChannelCatalogVisibility } = await import('../src/channel-visibility.js')
  let hide = true
  const gate = installChannelCatalogVisibility(pool, { shouldHide: () => hide })
  assert.equal(gate.installed, true, '账号池可用时门控安装成功')

  // 1. 开关打开 ⇒ 全部分组隐藏。
  for (const id of CHANNEL_IDS) {
    assert.equal((await adapters.get(id).listModels(id)).length, 0, `${id} 分组应从模型目录隐藏`)
  }

  // 3. 「显示列表」用的 listAllModels() 必须不受影响（设置页仍要渲染）。
  for (const id of CHANNEL_IDS) {
    const adapter = adapters.get(id)
    if (typeof adapter.listAllModels !== 'function') continue
    assert.ok(adapter.listAllModels().length > 0, `${id} 的 listAllModels() 不受隐藏影响`)
  }

  // 2. 开关关闭 ⇒ 逐项恢复到基线（比「非空」更严格）。
  hide = false
  gate.sync()
  assert.deepEqual(await listVisible(), baseline, '关闭总开关后可见集合逐项恢复到基线')

  // 权威性：环境变量被显式设成假值也压不住总开关。
  hide = true
  gate.sync()
  assert.equal(process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT, '1', '开关打开时该环境变量由门控接管')
  for (const id of CHANNEL_IDS) {
    assert.equal((await adapters.get(id).listModels(id)).length, 0, `${id} 在 DSH_HIDE_MODELS_WITHOUT_ACCOUNT=0 下仍应隐藏`)
  }

  // 关闭后环境变量回到用户原值。
  hide = false
  gate.sync()
  assert.equal(process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT, '0', '关闭总开关后环境变量回到用户原值')

  console.log('ok  渠道目录可见性总开关：开则 13 组全隐、关则恢复、listAllModels 不受影响、环境变量被接管')
} finally {
  for (const cleanup of dispose.reverse()) await cleanup()
  globalThis.fetch = savedFetch
  if (savedHideFlag === undefined) delete process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
  else process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = savedHideFlag
  hooks.deregister()
  fs.rmSync(scratch, { recursive: true, force: true })
}
