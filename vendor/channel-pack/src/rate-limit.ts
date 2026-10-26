/** 渠道共用的限流识别、重置时刻解析与等待时间格式化。 */
export function formatResetIn(resetAtMs: number, nowMs: number = Date.now()): string {
  const diff = resetAtMs - nowMs
  if (diff <= 0) return '即将重置'
  if (diff < 60_000) return '不到 1 分钟'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟`
  // 保留一位小数：额度按自然日结算，剩余时间通常在 1~24 小时之间，
  // 只报整数会让「还有 1 小时」与「还有 1.9 小时」看起来一样。
  return `${Math.round(diff / 360_000) / 10} 小时`
}

const RATE_LIMIT_PATTERN =
  /频率限制|频率超出|使用量已超出|重置|rate.?limit|frequency limit|usage exceeds|too many requests/i

export function isRateLimited(body: string, status?: number): boolean {
  if (status === 429) return true
  return RATE_LIMIT_PATTERN.test(body)
}

const RESET_TIME_PATTERN = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i

export const RATE_LIMIT_FALLBACK_MS = 3_600_000

export function parseRateLimitError(
  body: string,
  currentModel: string,
  status?: number,
): { modelId: string; resetTimeMs: number } | null {
  const fallback = (): { modelId: string; resetTimeMs: number } => ({
    modelId: currentModel,
    resetTimeMs: Date.now() + RATE_LIMIT_FALLBACK_MS,
  })
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const msg = typeof data.msg === 'string' ? data.msg : ''
    const resetMatch = RESET_TIME_PATTERN.exec(msg)
    if (resetMatch) {
      // 用捕获到的真实时区拼接（不再写死 UTC+8），Date.parse 能正确解析该写法。
      const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`)
      if (!Number.isNaN(resetMs)) {
        return { modelId: currentModel, resetTimeMs: resetMs }
      }
    }
    // 标准 OpenAI 429 格式，或带业务码但文案无法解析出时间
    if (isRateLimited(body, status)) {
      return fallback()
    }
    return null
  } catch {
    // 非 JSON（空体、纯文本、CDN 的 HTML 错误页）：只剩状态码可判。
    return status === 429 ? fallback() : null
  }
}
