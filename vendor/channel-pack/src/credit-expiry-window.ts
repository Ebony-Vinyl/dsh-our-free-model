/** 积分按到期远近分桶的通用时间窗口。 */
export const DEFAULT_CREDIT_EXPIRING_WINDOW_DAYS = 15

/** 仅接受显式的非负有限数值；0 表示没有临时积分窗口。 */
export function creditExpiringWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DSH_CREDIT_EXPIRING_WINDOW_DAYS
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_CREDIT_EXPIRING_WINDOW_DAYS
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CREDIT_EXPIRING_WINDOW_DAYS
  return parsed
}
