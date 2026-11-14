import { PROVIDER_ICONS } from '../system/provider-icons'

/**
 * 供应商图标。
 *
 * 数据来自 magpie 引擎内置的图标集（见 provider-icons.ts），压成单色几何后
 * 由这里统一渲染。图标缺失时退回首字母，所以新增一个 registry 条目不需要
 * 同时补图 —— 它会先显示成一个可读的字母块，而不是空框。
 */
export function ProviderIcon({ id, name, size = 21 }: { id: string; name: string; size?: number }) {
  const body = PROVIDER_ICONS[id]
  if (body) {
    // 图标是受控的本地常量（只含几何与渐变定义），不是用户输入，
    // 因此用 innerHTML 注入比维护一份 React 元素映射更直接。
    //
    // 根 svg 上的 fill="currentColor" 是必须的，不是装饰：SVG 里没有 fill 的
    // 路径会取初始值 **黑色**，而不是"跟随文字颜色"。图标集里有一批（github、
    // openai、groq、zai…）是纯几何、不带 fill 的，落在深色主题的 #121215 卡片
    // 上就是一块看不见的黑 —— 半列表格的图标会凭空消失。设了 currentColor 之后
    // 这些图标跟随主题文字色；带自己 fill 的图标（品牌色）不受影响，因为子元素
    // 显式声明的 fill 优先于继承值。
    return <svg
      className="provider-glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  }
  return <span className="provider-glyph-fallback" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
}
