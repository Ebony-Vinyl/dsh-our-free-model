/** 历史账号数据保留，但不能再被当前插件用于登录、探测、续期或调用。 */
export function isRetiredProvider(provider: unknown): boolean {
  return provider === 'buddy' || provider === 'workbuddy'
}
