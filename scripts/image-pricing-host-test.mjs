/**
 * 使用指定宿主依赖执行真实 spill-policy；不安装依赖、不读取真实账号或调用上游。
 * node scripts/image-pricing-host-test.mjs <包含宿主 node_modules 的目录>
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from '../src/adapter.js'

if (!process.argv[2]) throw new Error('请提供含宿主 node_modules 的隔离目录')
const require = createRequire(import.meta.url)
const resolve = name => require.resolve(name, { paths: [path.resolve(process.argv[2])] })
const llmUrl = pathToFileURL(resolve('@deepseek-ai/dsh-llm')).href
const { LlmRuntime } = await import(llmUrl)
const { apply: applySpill } = await import(pathToFileURL(resolve('@deepseek-ai/dsh-spill-policy')).href)
const version = JSON.parse(fs.readFileSync(resolve('@deepseek-ai/dsh-spill-policy/package.json'), 'utf8')).version
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-image-pricing-'))
process.env.DSH_HOME = home
process.env.DSH_CHANNEL_PACK_STATE_DIR = home
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
process.env.QODER_MACHINE_TOKEN_PATH = path.join(home, 'unused-token.json')
process.env.QODER_RUNTIME_INFO = path.join(home, 'missing-runtime.exe')
const imagePath = path.join(home, 'fixture.png')
fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4GQAAAAASUVORK5CYII=', 'base64'))
const kernelUrl = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/vendor/channel-pack/pack.js') && specifier.startsWith('@deepseek-ai/')) {
    return { url: specifier === '@deepseek-ai/dsh-llm' ? llmUrl : kernelUrl, shortCircuit: true }
  }
  return next(specifier, context)
} })
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('宿主图片回归禁止外网请求') }
const disposers = [], adapters = new Map()
const services = {
  profileContext: { home },
  credentials: { resolve: async () => undefined, describe: async () => undefined,
    set: async () => { throw new Error('禁止写入凭据') }, unset: async () => {} },
  llm: { registerAdapter(providers, adapter) { for (const provider of providers) adapters.set(provider, adapter) },
    listProviders: () => [...adapters.keys()].map(id => ({ id })) },
  connection: { fetch: { register() {} } },
}
const ctx = {
  ...services, logger: { info() {}, warn() {}, error() {} }, get: name => services[name],
  provide(name, value) { services[name] = value; this[name] = value },
  effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') disposers.push(cleanup) },
  inject(names, fn) { if (names.every(name => services[name] !== undefined)) fn(this) }, emit() {},
}
const text = 'Diagnostic fixture. '.repeat(25600)
const image = { type: 'image', attachment: { attachmentId: 'fixture', mediaType: 'image/png', width: 1, height: 1 } }
async function verify(provider, withImage) {
  const listeners = new Map(), warnings = [], saved = []
  const llm = { imageRequestPricing(p, m) {
    return LlmRuntime.prototype.imageRequestPricing.call({ adapters: new Map([[provider, { adapter: adapters.get(provider) }]]) }, p, m)
  } }
  const host = {
    llm, attachments: { imageHostPath: () => imagePath }, fs: { processPathFromHostPath: file => file },
    spillStore: { async saveText(input) {
      const file = path.join(home, `${provider}-${withImage}.txt`)
      fs.writeFileSync(file, input.content); saved.push(file)
      return { locator: file, bytes: Buffer.byteLength(input.content), retrievalHint: '读取隔离文件。' }
    } },
  }
  applySpill({ on: (event, fn) => listeners.set(event, fn), get: key => host[key],
    logger: { warn: message => warnings.push(message) } }, { maxInlineTokens: 12500 })
  const exec = { name: 'diagnostic_tool', callId: 'fixture-call', agent: {
    options: { provider, model: 'deepseek-v4.1-flash' }, session: {
      header: { id: 'isolated-issue151' }, requestHeader: () => ({ config: { provider, model: 'deepseek-v4.1-flash' } }),
    },
  } }
  const content = withImage ? [{ type: 'text', text }, image] : [{ type: 'text', text }]
  const result = await listeners.get('tools/post-execute')(exec, { content, isError: false }, async () => ({ kind: 'accept' }))
  assert.equal(saved.length, 1, `${provider} 必须落盘`)
  assert.deepEqual(warnings, [], `${provider} 不应触发计价或存储失败`)
  const preview = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  assert.ok(preview.includes('Full formatted result stored at:'), `${provider} 必须返回可恢复文件提示`)
  assert.ok(Buffer.byteLength(preview) < Buffer.byteLength(text))
  const full = fs.readFileSync(saved[0], 'utf8')
  assert.ok(full.startsWith(text), '完整文本不能丢失')
  if (withImage) assert.ok(full.includes(JSON.stringify(imagePath)), '完整结果必须保留图片读取地址')
}
try {
  const { apply } = await import('../vendor/channel-pack/pack.js')
  apply(ctx, { disableOpencode: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(adapters.size, 13)
  const free = new FreeModelAdapter({ state: () => ({ catalog: [], membership: {}, settings: {} }), recordUsage() {} })
  adapters.set(ROUTE_MAIN, free); adapters.set(ROUTE_REGION, free)
  await verify('buddy', false)
  for (const provider of adapters.keys()) await verify(provider, true)
  console.log(`ok  宿主 ${version}：15 路由的 512KB 含图结果和纯文本对照均真实落盘，预览有恢复地址，无计价失败警告`)
} finally {
  for (const cleanup of disposers.reverse()) await cleanup()
  hooks.deregister(); globalThis.fetch = originalFetch
  fs.rmSync(home, { recursive: true, force: true })
}
