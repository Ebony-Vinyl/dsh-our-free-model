/**
 * 配额/余额 RPC 必须与登录、推理共用同一条渠道出网路径。
 *
 * ## 为什么单独有这一套
 *
 * PR #198 把代理注入到了登录、续期、项目探测与推理，但**余额/配额查询走的是
 * `channel-pack-rpc.ts` 的 `credits.balances` 分支**，那条路径当时没有接线，
 * 于是回落成全局 `fetch` 直连。用户在需要代理的网络里因此看到「Gemini 登录
 * 成功、账号已显示，但配额查询报 fetch failed（UND_ERR_CONNECT_TIMEOUT）」。
 *
 * `channel-network-test.mjs` 覆盖的是登录/续期/推理这条链，本套件只补上它
 * 漏掉的那一段：`credits.balances` 是否也拿到了渠道出网封装。
 *
 * 离线运行，不出网、不消耗免费额度：
 *   node scripts/channel-quota-network-test.mjs
 *   node scripts/channel-quota-network-test.mjs --pack <path-to-pack.js>
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith('@deepseek-ai/') ? { url: kernel, shortCircuit: true } : next(specifier, context)
  },
})

const packAt = process.argv.indexOf('--pack')
const pack = await import(
  packAt >= 0 ? pathToFileURL(path.resolve(process.argv[packAt + 1])).href : '../vendor/channel-pack/pack.js'
)

const savedFetch = globalThis.fetch
const QUOTA_PATH = ':retrieveUserQuotaSummary'
const TIER_PATH = ':loadCodeAssist'

let checks = 0
async function check(name, run) {
  await run()
  checks++
  console.log(`ok  ${name}`)
}

const quotaBody = () =>
  Response.json({
    groups: [
      {
        buckets: [
          { bucketId: 'gemini-5h', remainingFraction: 0.4, resetTime: '2030-01-01T00:00:00Z' },
          { bucketId: 'gemini-weekly', remainingFraction: 0.7, resetTime: '2030-01-08T00:00:00Z' },
        ],
      },
    ],
  })

const GEMINI_CREDENTIAL = JSON.stringify({
  access_token: 'fixture-access',
  refresh_token: 'fixture-refresh',
  expiry: Date.now() + 3_600_000,
  cloudaicompanionProject: 'fixture-project',
})

/**
 * 挂载渠道包并返回它的 `/api/channel-pack` RPC 调用器。
 *
 * 两条出网通道都被记录，两者都不真的出网：
 * - `proxied`：渠道出网封装最终发出的请求。`createChannelFetch` 里 `fetchImpl`
 *   是最后一跳，所以它记录到的一定是「经过了 network 封装」的请求；
 * - `direct`：绕过封装的全局 `fetch`。回归的关键就是配额端点不能出现在这里。
 *
 * ⚠️ 不能只盯 `globalThis.fetch`：`createChannelFetch` 的 `fetchImpl` 默认就是
 * `globalThis.fetch`，于是「走了封装」和「没走封装」在全局替身上看起来一模一样。
 * 这就是本套件用 `fetchImpl` 选项把两者分开的原因。
 */
async function mount({ withOutlet }) {
  const proxied = []
  const direct = []

  const respond = (url) => {
    if (url.includes(QUOTA_PATH)) return quotaBody()
    if (url.includes(TIER_PATH)) return Response.json({ cloudaicompanionProject: 'fixture-project' })
    return Response.json({})
  }

  // 最后一跳：经过 network 封装的请求都会到这里。
  const fetchImpl = async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    proxied.push(url)
    return respond(url)
  }

  // 全局 fetch 仍然可以被任何没走封装的代码调用 —— 它不该被调用。
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    direct.push(url)
    return respond(url)
  }

  // outlet（插件出口）是 createChannelFetch 里优先级最高的一条路径：只要
  // active() 为真，请求就一定经过 outlet.fetch，而不是全局 fetch。
  // 用它当「走了渠道出网封装」的探针，与用户启用插件出口时的真实路径一致。
  const outletFetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    proxied.push(url)
    return respond(url)
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-quota-network-'))
  const envKeys = [
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy',
    'DSH_HOME', 'DSH_CHANNEL_PACK_STATE_DIR', 'DSH_OPENAI_GATEWAY_ENABLED',
  ]
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  process.env.DSH_HOME = scratch
  process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
  process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'

  const creds = new Map()
  const routes = []
  const dispose = []

  const ctx = {
    profileContext: { home: scratch },
    platform: { channelHome: scratch },
    credentials: {
      resolve: async (ref) => (creds.has(ref) ? { value: creds.get(ref) } : undefined),
      describe: async () => undefined,
      set: async (ref, value) => {
        creds.set(ref, value)
      },
      unset: async (ref) => {
        creds.delete(ref)
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    llm: { registerAdapter() {}, registerConfigurableProviders: () => () => {}, listProviders: () => [] },
    connection: { fetch: { register: (route) => routes.push(route) } },
    get(name) {
      return this[name]
    },
    provide(name, value) {
      this[name] = value
    },
    effect(body) {
      const cleanup = body()
      if (typeof cleanup === 'function') dispose.push(cleanup)
    },
    inject(names, body) {
      if (names.every((name) => this[name] !== undefined)) body(this)
    },
    emit() {},
  }

  pack.apply(ctx, withOutlet
    ? { disableOpencode: true, outlet: { active: () => true, fetch: outletFetch } }
    : { disableOpencode: true })

  const route = routes.find((row) => row.path === '/api/channel-pack')
  assert.ok(route, '/api/channel-pack 未注册')

  const rpc = async (method, payload) => {
    const response = await route.fetch(
      new Request('http://localhost/api/channel-pack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'quota-network',
          method: 'channel-pack',
          payload: { method, payload },
        }),
      }),
    )
    const body = (await response.json()).result
    assert.equal(body.ok, true, `${method} 失败：${JSON.stringify(body.error)}`)
    return body.value
  }

  /** 建一个带可用凭据的 Gemini 账号，返回它的账号 id。 */
  async function seedGemini() {
    const started = await rpc('account.create', { provider: 'gemini' })
    const accounts = await rpc('account.list', { provider: 'gemini' })
    const account = accounts.accounts.find((row) => row.id === started.accountId)
    assert.ok(account, '新建的 Gemini 账号不在 account.list 里')
    creds.set(account.credentialRef, GEMINI_CREDENTIAL)
    proxied.length = 0
    direct.length = 0
    return started.accountId
  }

  return {
    rpc,
    seedGemini,
    creds,
    proxied,
    direct,
    async close() {
      for (const cleanup of dispose.reverse()) await cleanup()
      globalThis.fetch = savedFetch
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
      }
      fs.rmSync(scratch, { recursive: true, force: true })
    },
  }
}

try {
  await check('credits.balances(gemini) 走渠道出网封装，不回落全局 fetch', async () => {
    const app = await mount({ withOutlet: true })
    try {
      const accountId = await app.seedGemini()
      const value = await app.rpc('credits.balances', { provider: 'gemini' })

      assert.equal(
        app.proxied.some((url) => url.includes(QUOTA_PATH)),
        true,
        `配额端点没有走渠道出网封装；实际直连：${JSON.stringify(app.direct)}`,
      )
      assert.equal(
        app.direct.some((url) => url.includes(QUOTA_PATH)),
        false,
        `配额端点仍然直连了全局 fetch：${JSON.stringify(app.direct)}`,
      )
      // 档位（loadCodeAssist）与配额在同一个函数里并行发出，必须同源。
      assert.equal(
        app.proxied.some((url) => url.includes(TIER_PATH)),
        true,
        '账号档位端点没有走渠道出网封装',
      )

      // 路径对了还不够：结果要真的回来。
      const entry = value.accounts.find((row) => row.accountId === accountId)
      assert.ok(entry, 'credits.balances 没有返回该账号')
      assert.equal(entry.error, undefined, `配额查询返回了错误：${entry.error}`)
      assert.notEqual(entry.balance, null, '配额查询没有返回余额')
    } finally {
      await app.close()
    }
  })

  console.log(`channel-quota-network: ${checks}/${checks} 项通过`)
} finally {
  globalThis.fetch = savedFetch
  hooks.deregister()
}

// 渠道包会为自动签到、额度探测等挂常驻定时器；测试断言跑完即可退出，
// 不能让这些故意不 unref 的后台循环把进程钉住（否则 runner 只能超时杀掉）。
process.exit(0)
