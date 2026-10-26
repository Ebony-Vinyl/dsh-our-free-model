declare module 'ofm-provider-list' {
  export interface Provider { id: string; name: string; org: string; accent: string; note: string; login: string }
  export const providers: Provider[]
}
declare module 'ofm-shared-client' {
  // 渠道页面来自未类型化的原插件，通过构建适配导出。
  export const shared: Record<string, any>
}
