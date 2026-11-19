/**
 * 国内直连模块（`domestic-direct.ts`）的离线回归。
 *
 * 不发真实网络请求：只验证**路由判定**与**接管边界**。真实 IP 直连需要 fake-ip
 * 代理环境，属部署验证，不在离线套件里做。
 *
 * 三条边界是本次提取的核心承诺，任一条破了都说明行为越界：
 * 1. 国内域名 + 无代理 → 接管（走 DoH 真实 IP）；
 * 2. 海外域名 → 不接管，原样交给 `fetchImpl`；
 * 3. 调用方显式给了 `dispatcher`，或上面任一级代理已命中 → 让路。
 *
 * 第 3 条尤其重要：本模块只处理「fake-ip 把国内流量误送海外」这一种情形，
 * 不得改变既有的出口优先级（插件出口 > 环境代理 > Windows 系统代理）。
 *
 * ⚠️ 默认从**源码**加载（`--source` 是默认行为）：本 PR 不提交重新构建的
 * `pack.js`（那会带进本地 esbuild 版本的整份产物差异），所以产物里还没有这个
 * 模块。维护者构建后，可用 `--pack <path>` 对产物再验一遍。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const packAt = process.argv.indexOf('--pack')
const useSource = packAt < 0
const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const ts = useSource ? (await import('typescript')).default : undefined

// 源码模式要三件事，缺一不可：
//  1. `@deepseek-ai/*` 指向与其它套件同一个 kernel 桩；
//  2. 源码里的 `.js` 说明符重写成 `.ts`（仓库内导入一律写 .js）；
//  3. `.ts` 用 TypeScript 转译（Node 的 strip-only 模式不支持 `constructor(private x)`）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (useSource && context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (useSource && url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      const source = fs.readFileSync(fileURLToPath(url), 'utf8')
      return {
        format: 'module',
        source: ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: fileURLToPath(url),
        }).outputText,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const mod = useSource
  ? await import(pathToFileURL(path.resolve('vendor/channel-pack/src/index.ts')).href)
  : await import(pathToFileURL(path.resolve(process.argv[packAt + 1])).href)

const {
  createChannelFetch,
  isDomesticHost, isDomesticUrl, domesticDirectEnabled, shouldUseDomesticDirect,
} = mod

let checks = 0
async function check(name, run) {
  await run()
  checks++
  console.log(`ok  ${name}`)
}

/** 每个用例都保存/恢复开关，避免相互污染。 */
async function withFlag(value, run) {
  const saved = process.env.OFM_DOMESTIC_DIRECT
  if (value === undefined) delete process.env.OFM_DOMESTIC_DIRECT
  else process.env.OFM_DOMESTIC_DIRECT = value
  try { await run() } finally {
    if (saved === undefined) delete process.env.OFM_DOMESTIC_DIRECT
    else process.env.OFM_DOMESTIC_DIRECT = saved
  }
}

try {
  await check('模块符号已导出', () => {
    for (const [name, value] of Object.entries({
      isDomesticHost, isDomesticUrl, domesticDirectEnabled, shouldUseDomesticDirect, createChannelFetch,
    })) {
      assert.equal(typeof value, 'function', `${name} 应为函数`)
    }
  })

  await check('国内渠道域名命中，海外域名不命中，后缀边界正确', () => {
    for (const host of [
      'copilot.tencent.com', 'www.codebuddy.cn', 'openapi.qoder.com.cn',
      'api.trae.cn', 'trae.com.cn', 'sensenova.cn', 'api.modelbest.cn',
    ]) {
      assert.equal(isDomesticHost(host), true, `${host} 应判为国内`)
    }
    for (const host of [
      // 国际站点：海外出口是正常路径，强制直连反而失败。
      'www.workbuddy.ai', 'api.anthropic.com', 'github.com',
      // 后缀边界反例：包含 tencent.com 但不是它的子域。
      'evil-tencent.com', 'tencent.com.evil.io', 'notcodebuddy.cn',
    ]) {
      assert.equal(isDomesticHost(host), false, `${host} 不应判为国内`)
    }
  })

  await check('isDomesticUrl 对非法输入返回 false 而不是抛错', () => {
    assert.equal(isDomesticUrl('https://copilot.tencent.com/v3/config'), true)
    assert.equal(isDomesticUrl(new URL('https://www.codebuddy.cn/x')), true)
    assert.equal(isDomesticUrl('not a url'), false)
    assert.equal(isDomesticUrl(''), false)
    assert.equal(isDomesticUrl('ftp://copilot.tencent.com'), true) // 协议无关，只看主机
  })

  await check('显式 dispatcher 一律让路（不越过调用方的出口选择）', () => {
    assert.equal(
      shouldUseDomesticDirect('https://copilot.tencent.com/v3/config', { dispatcher: { fake: true } }),
      false,
    )
  })

  await check('海外域名不接管', () => {
    assert.equal(shouldUseDomesticDirect('https://www.workbuddy.ai/v2/chat/completions', undefined), false)
    assert.equal(shouldUseDomesticDirect(new Request('https://www.workbuddy.ai/x'), undefined), false)
  })

  await check('国内域名 + 无 dispatcher → 接管（字符串与 Request 两种入参）', () => {
    assert.equal(shouldUseDomesticDirect('https://copilot.tencent.com/v3/config', undefined), true)
    assert.equal(shouldUseDomesticDirect(new Request('https://copilot.tencent.com/v3/config'), undefined), true)
  })

  await check('OFM_DOMESTIC_DIRECT 的 0/off/false 关闭，其余开启', async () => {
    for (const off of ['0', 'off', 'false', 'FALSE', ' 0 ', 'Off']) {
      await withFlag(off, () => {
        assert.equal(domesticDirectEnabled(), false, `${JSON.stringify(off)} 应关闭`)
        assert.equal(shouldUseDomesticDirect('https://copilot.tencent.com/x', undefined), false)
      })
    }
    for (const on of [undefined, '', '1', 'true', 'yes']) {
      await withFlag(on, () => assert.equal(domesticDirectEnabled(), true, `${JSON.stringify(on)} 应开启`))
    }
  })

  await check('代理优先级不被突破：环境代理存在时国内域名仍走代理', async () => {
    // 本次提取最关键的一条断言。国内直连只在「本已判定直连」的分支接管，
    // 环境代理显式配置时必须优先，否则会绕过用户既有设置。
    const seen = []
    const network = createChannelFetch({
      environment: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
      platform: 'linux',
      fetchImpl: async (input, init) => {
        seen.push({
          url: String(input instanceof Request ? input.url : input),
          hasDispatcher: init?.dispatcher !== undefined,
        })
        return new Response('ok')
      },
      dispatcherFor: () => ({ dispatch() {}, close() {}, destroy: async () => {} }),
    })
    try {
      const res = await network.fetch('https://copilot.tencent.com/v3/config')
      assert.equal(res.status, 200)
      assert.equal(seen.length, 1, '应发出一次请求')
      assert.equal(
        seen[0].hasDispatcher, true,
        '有环境代理时国内域名必须走代理 dispatcher，不得被直连接管',
      )
    } finally {
      await network.close()
    }
  })

  await check('关闭直连后国内域名交给 fetchImpl（替身不被绕过）', async () => {
    await withFlag('0', async () => {
      const seen = []
      const network = createChannelFetch({
        environment: {},
        platform: 'linux',
        fetchImpl: async (input) => {
          seen.push(String(input instanceof Request ? input.url : input))
          return new Response('ok')
        },
      })
      try {
        await network.fetch('https://copilot.tencent.com/v3/config')
        assert.deepEqual(seen, ['https://copilot.tencent.com/v3/config'])
      } finally {
        await network.close()
      }
    })
  })

  await check('Windows 系统代理命中也让路', async () => {
    const seen = []
    const network = createChannelFetch({
      environment: {},
      platform: 'win32',
      readSystemProxy: async () => 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ 127.0.0.1:7890\nProxyOverride REG_SZ <local>',
      fetchImpl: async (input, init) => {
        seen.push({ url: String(input instanceof Request ? input.url : input), hasDispatcher: init?.dispatcher !== undefined })
        return new Response('ok')
      },
      dispatcherFor: () => ({ dispatch() {}, close() {}, destroy: async () => {} }),
    })
    try {
      await network.fetch('https://www.codebuddy.cn/v3/config')
      assert.equal(seen[0]?.hasDispatcher, true, '系统代理命中时必须走代理，不得被直连接管')
    } finally {
      await network.close()
    }
  })

  console.log(`\ndomestic-direct: ${checks}/${checks} 项通过`)
} catch (error) {
  console.error('\nFAIL', error instanceof Error ? error.message : error)
  process.exitCode = 1
}