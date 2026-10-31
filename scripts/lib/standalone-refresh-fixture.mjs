/** 仅管理刷新测试的 Worker 装载：保留真实目录收集逻辑，替换账号适配器。 */
import { registerHooks } from 'node:module'

const business = new URL('../../packages/standalone/channels/business.mjs', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url !== business) return nextLoad(url, context)
    return {
      format: 'module', shortCircuit: true,
      source: `
        export * from ${JSON.stringify(business + '?refresh-fixture')}
        import fs from 'node:fs'
        import path from 'node:path'
        export function apply(ctx) {
          ctx.llm.registerAdapter(['trae', 'qodercn'], {
            async listModels(provider) {
              const fixture = JSON.parse(fs.readFileSync(path.join(ctx.platform.channelHome, 'refresh-fixture.json'), 'utf8'))[provider]
              if (fixture.fail) throw new Error('fixture-private-token')
              return fixture.models
            },
            async resolveModel() { return {} },
          })
        }
      `,
    }
  },
})
