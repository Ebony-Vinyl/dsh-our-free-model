/**
 * 国内渠道在透明代理（fake-ip TUN）下的直连绕行回归。
 *
 * 只使用本机请求替身：不访问真实 DoH、不访问真实渠道端点、不读取测试机的代理
 * 配置。验证的是**路由决策**与**回退行为**，不是线上连通性。
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith('@deepseek-ai/') ? { url: kernel, shortCircuit: true } : next(specifier, context)
  },
})
const pack = await import('../vendor/channel-pack/pack.js')

let checks = 0
async function check(name, run) {
  await run()
  checks++
  console.log(`ok  ${name}`)
}

const { isDomesticHost, isDomesticUrl, createDomesticFetch } = pack

try {
  await check('国内域名后缀判定：只命中大陆服务商，不含国际站点', async () => {
    // 命中：腾讯 / 阿里 / 字节 / 华为 / 智谱 / 火山 / 阶跃 / 面壁
    for (const host of [
      'copilot.tencent.com',
      'www.codebuddy.cn',
      'gateway.qoder.com.cn',
      'api.trae.cn',
      'api.trae.com.cn',
      'codearts.huaweicloud.com',
      'open.bigmodel.cn',
      'ark.volces.com',
      'api.stepfun.com',
    ]) assert.equal(isDomesticHost(host), true, `${host} 应判为国内`)

    // 不命中：workbuddy 是国际站点，海外出口才是正常路径；其余是无关域。
    for (const host of [
      'www.workbuddy.ai',
      'api.openai.com',
      'generativelanguage.googleapis.com',
      'nottencent.com',        // 后缀相似但不是子域
      'tencent.com.evil.test', // 伪装子域
      'example.com',
    ]) assert.equal(isDomesticHost(host), false, `${host} 不应判为国内`)
  })

  await check('非法 URL 不抛错，交由原路径处理', async () => {
    assert.equal(isDomesticUrl('not a url'), false)
    assert.equal(isDomesticUrl('https://copilot.tencent.com/v2/chat'), true)
    assert.equal(isDomesticUrl(new URL('https://www.codebuddy.cn/login')), true)
  })

  await check('非国内域名原样交给 fallback，行为零变化', async () => {
    const seen = []
    const fallback = async (input, init) => {
      seen.push(String(input instanceof Request ? input.url : input))
      return new Response('fallback', { status: 200 })
    }
    const fetchWithDomestic = createDomesticFetch(fallback)
    const response = await fetchWithDomestic('https://www.workbuddy.ai/v2/chat/completions', { method: 'POST' })
    assert.equal(await response.text(), 'fallback')
    assert.deepEqual(seen, ['https://www.workbuddy.ai/v2/chat/completions'])
  })

  await check('调用方显式指定 dispatcher 时不被接管', async () => {
    // 显式代理优先：这是 outlet / 逐请求代理的既有契约，国内绕行不得覆盖。
    const seen = []
    const fallback = async (_input, init) => {
      seen.push(init)
      return new Response('fallback', { status: 200 })
    }
    const fetchWithDomestic = createDomesticFetch(fallback)
    const dispatcher = { dispatch() {} }
    await fetchWithDomestic('https://copilot.tencent.com/v2/chat/completions', { method: 'POST', dispatcher })
    assert.equal(seen.length, 1, '应走 fallback 而不是国内直连')
    assert.equal(seen[0].dispatcher, dispatcher)
  })
} finally {
  hooks.deregister()
}

console.log(`channel-domestic-direct: ${checks}/${checks} 项通过`)
