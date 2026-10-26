/** 从已发布渠道包生成独立业务产物；平台接口替换必须明确匹配。 */
import fs from 'node:fs'
import crypto from 'node:crypto'

const source = fs.readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')
let output = source
function replaceOnce(from, to) {
  if (output.split(from).length !== 2) throw new Error(`独立渠道生成位置不唯一或已改变：${from.slice(0, 90)}`)
  output = output.replace(from, to)
}
// 独立应用不注册宿主设置表单，删除两个仅供宿主使用的 schema。
output = output.replace(/^import Schema2? from "@deepseek-ai\/schemastery";\r?\n/gm, '')
replaceOnce(output.match(/var channelPackSchema = Schema\.object\(\{[\s\S]*?\n\}\);/)?.[0] ?? 'missing schema', 'var channelPackSchema;')
replaceOnce(output.match(/var Config = Schema2\.object\(\{[\s\S]*?\n\}\);/)?.[0] ?? 'missing config', 'var Config;')
output = output.replace(/from "@deepseek-ai\/(?:cordis|dsh-credentials|dsh-llm)"/g, 'from "./contracts.mjs"')
replaceOnce(output.match(/function resolveChannelPackHome\(ctx\) \{[\s\S]*?\n\}/)?.[0] ?? 'missing home resolver',
  'function resolveChannelPackHome(ctx) {\n  if (typeof ctx.platform?.channelHome !== "string") throw new Error("独立渠道缺少数据目录");\n  return ctx.platform.channelHome;\n}')
replaceOnce('  mountOpenAiGateway(ctx, pool);\n  installLoopResume(ctx);', '  // 独立服务由外层提供统一网关，宿主 Agent 自动续跑没有对应服务。')
replaceOnce('resolve(dirname(fileURLToPath(import.meta.url)), "qoder-auth-wasm.wasm")', 'fileURLToPath(new URL("../../../vendor/channel-pack/qoder-auth-wasm.wasm", import.meta.url))')
replaceOnce('export {\n  Config,', `export {
  toGenerateOptions, toResponsesGenerateOptions, normalizeReasoningEffort,
  responsesReasoningEffort, normalizeMaxTokens, responsesMaxOutputTokens,
  markGatewayChannel,
  collectGatewayModels, collectGatewayEffortViews, toOpenAiModels,
  Config,`)
if (/@deepseek-ai\/.*["'];/.test(output)) throw new Error('独立产物仍存在宿主 import')
output = `// 由 scripts/build-standalone-channels.mjs 生成，请勿手改。\n// 原渠道包 SHA256: ${crypto.createHash('sha256').update(source).digest('hex')}\n${output}`
const file = new URL('../packages/standalone/channels/business.mjs', import.meta.url)
if (process.argv.includes('--check')) {
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== output) throw new Error('独立渠道产物需要重新生成')
} else {
  fs.mkdirSync(new URL('../packages/standalone/channels/', import.meta.url), { recursive: true })
  fs.writeFileSync(file, output)
}
console.log('独立渠道产物校验通过')
