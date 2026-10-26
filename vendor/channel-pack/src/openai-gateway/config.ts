export const DEFAULT_GATEWAY_HOST = '127.0.0.1'
export const DEFAULT_GATEWAY_PORT = 8326

export interface OpenAiGatewayConfig {
  host: string
  port: number
}

/**
 * 网关开关。只有**显式**的假值才停用，未设置时默认启用（保持既有行为）。
 *
 * ⚠️ 不能写成 `parseInt(raw) || 1` 这类形式：`'0'` 是**合法**的停用值，
 * 而 `0` 是 falsy 会被 `||` 静默换回默认值 —— 开关会「关不掉」。
 * 判定只看归一化后的字符串，与本仓库 Qoder 环境变量的同一教训同源。
 */
export function isGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DSH_OPENAI_GATEWAY_ENABLED?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no'
}

/** 解析本机网关配置，端口错误时显式失败，避免静默换端口。 */
export function resolveGatewayConfig(env: NodeJS.ProcessEnv = process.env): OpenAiGatewayConfig {
  const rawPort = env.DSH_OPENAI_GATEWAY_PORT
  if (rawPort === undefined || rawPort.trim() === '') {
    return { host: DEFAULT_GATEWAY_HOST, port: DEFAULT_GATEWAY_PORT }
  }
  const port = Number.parseInt(rawPort, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort.trim()) {
    throw new Error('DSH_OPENAI_GATEWAY_PORT 必须是 1 到 65535 之间的整数')
  }
  return { host: DEFAULT_GATEWAY_HOST, port }
}
