/**
 * Cline 模型的 **models.dev 目录来源**：补「名字 / 上下文窗口 / 图片能力」。
 *
 * ## 为什么需要（两处真实缺陷，用户报障 2026-09-30）
 *
 * ### ① 「支持图片的模型发送不了图片」
 *
 * 适配器判定图片能力时原先**只看本地兜底表**
 * （`product.fallbackModels[].supportsImage`，全表只有 5 条、且全是
 * `cline-free/*`），而远端两个目录端点**都不下发任何能力字段** ——
 * 实测 `recommended-models` 的条目只有 `{ id, name, description, tags }`，
 * `/api/v1/models` 只有裸 `id`。于是 `cline-pass/*` 一律被播报成纯文本：
 * DSH 按播报的 `inputModalities` 决定要不要把图片投影成占位符，
 * 用户**连发都发不出去**。
 *
 * ### ② 「cline-pass 部分模型列表不全」
 *
 * 网关 `recommended-models` 的 `clinePass` 数组**只有 14 条**，而实测
 * models.dev 的 `cline-pass` 块有 **18 条** —— 差的 4 条
 * （`kimi-k2.6` / `glm-5.2` / `kimi-k2.7-code` / `deepseek-v4-flash`）
 * 在本插件里**根本不存在**，用户既看不到也选不到。
 * 另外网关给 `cline-pass/*` 的 `name` **就是 id 本身**
 * （`name === 'cline-pass/mimo-v2.6-flash'`），而 models.dev 给的是
 * 可读名（`DeepSeek V4.1 Flash`）—— 列表里全是裸 id 也让人无从辨认。
 *
 * ## 实测依据（2026-09-30，本机直连 `https://models.dev/api.json`）
 *
 * `cline-pass` provider 块 18 条，逐条带 `modalities.input` 与 `limit`：
 *
 * | 模型 | `modalities.input` |
 * |---|---|
 * | `cline-pass/deepseek-v4.1-flash` | `["text","image"]` ← 用户当时用的就是它 |
 * | `cline-pass/mimo-v2.6-flash` | `["text","image","audio","video"]` |
 * | `cline-pass/minimax-m3` | `["text","image","video"]` |
 * | `cline-pass/glm-5.3` | `["text"]`（确实不带图） |
 *
 * 参考实现（`github.com/codeOct/dsh-cline-pass`）用的**正是同一来源**
 * （其 `MODELS_DEV_URL`）：它把这当作「官方扫描」并在面板里
 * 「adopt newly published models」——注释原文：*"Without it a model newer
 * than this release resolves to the `text` fallback and the harness refuses
 * every image for it, silently."* 与本仓库两处报障同型。
 *
 * ## 四条口径（与参考实现一致，别自作聪明）
 *
 * 1. **只认 `image`**：models.dev 还报 `audio` / `video` / `pdf`，而 DSH 的模态
 *    词表只有 `text` / `image`（参考实现同样**夹取**到这两个值）。
 * 2. **本地兜底表优先级更高**：它是从官方客户端内嵌目录策展出来的，
 *    本模块只补它覆盖不到的模型（见 `applyModelsDevCatalog`）。
 * 3. **不取 `limit.output`（maxTokens）**：那是「单次输出上限」，一旦下发就是
 *    真的写进请求体的 `max_tokens`；本仓库有过「据印象填大值 → vertex/google
 *    400」的真实缺陷（见 AGENTS.md 的 Gemini-400 段），故这里**只补展示名与
 *    上下文窗口**，不碰输出上限。
 * 4. **失败绝不抛到调用方**：拿不到就保持「未知」（退回本地兜底表），
 *    绝不能让一次目录抖动把**所有**模型的图片能力打回原形。
 */

import { TtlCache } from './ttl-cache.js'
import type { ClineModel } from './cline-models.js'

/** 社区模型目录（公开、无需认证）。与参考实现的 `MODELS_DEV_URL` 同源。 */
export const CLINE_MODELS_DEV_URL = 'https://models.dev/api.json'

/** 单次目录请求超时（毫秒）。 */
export const CLINE_MODELS_DEV_TIMEOUT_MS = 20_000

/**
 * 缓存有效期。
 *
 * 用**长 TTL**（而不是像 captcha 配置那样 60 秒）：这份目录是**发布节奏**的
 * 数据（新模型上线才变），进程内按小时级刷新足够；每次会话都去拉一次既慢
 * 又无意义。⚠️ 仍要**有** TTL 而不是永久缓存 —— 上游新增模型后不该要求用户
 * 重启进程（这正是 `TtlCache` 模块头注释里记的那条缺陷）。
 */
export const CLINE_MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000

/** 从 models.dev 读到的一条模型信息（缺的字段**不编造**）。 */
export interface ClineModelsDevEntry {
  /** 本插件路由上使用的 id（已补 `cline-pass/` 前缀）。 */
  id: string
  /** 可读展示名（如 `DeepSeek V4.1 Flash`）。 */
  name?: string
  /** 上下文窗口（`limit.context`）。 */
  contextWindow?: number
  /** 是否接受图片输入（`modalities.input` 含 `image`）。 */
  supportsImage: boolean
}

/**
 * 解析 models.dev 目录，得到 `模型 id → 条目`。
 *
 * ⚠️ provider 块的位置有**两种**实测形态（参考实现两者都认）：
 * `json['cline-pass']`（本机实测就是这种）与 `json.providers['cline-pass']`。
 *
 * ⚠️ 模型 id 可能是**裸 id**（`deepseek-v4.1-flash`）也可能已带前缀 ——
 * 前者补 `cline-pass/` 前缀后才是本插件路由上真正使用的 id。
 *
 * @returns 只含**能从目录读出结论**的条目；`modalities` 缺失时
 *   `supportsImage: false`（调用方据「本地兜底表优先」再兜一层）。
 */
export function parseClineModelsDev(value: unknown): Map<string, ClineModelsDevEntry> {
  const out = new Map<string, ClineModelsDevEntry>()
  if (typeof value !== 'object' || value === null) return out
  const root = value as Record<string, unknown>
  const providers = typeof root.providers === 'object' && root.providers !== null
    ? root.providers as Record<string, unknown>
    : undefined
  const block = providers?.['cline-pass'] ?? root['cline-pass']
  if (typeof block !== 'object' || block === null) return out
  const models = (block as Record<string, unknown>).models
  if (typeof models !== 'object' || models === null) return out

  for (const [rawId, rawEntry] of Object.entries(models as Record<string, unknown>)) {
    if (rawId.length === 0) continue
    if (typeof rawEntry !== 'object' || rawEntry === null) continue
    const entry = rawEntry as Record<string, unknown>
    const id = rawId.startsWith('cline-pass/') ? rawId : `cline-pass/${rawId}`
    const name = typeof entry.name === 'string' && entry.name.trim().length > 0
      ? entry.name.trim()
      : undefined
    const limit = typeof entry.limit === 'object' && entry.limit !== null
      ? entry.limit as Record<string, unknown>
      : undefined
    const context = Number(limit?.context)
    const modalities = typeof entry.modalities === 'object' && entry.modalities !== null
      ? entry.modalities as Record<string, unknown>
      : undefined
    const input = modalities?.input
    const supportsImage = Array.isArray(input)
      && input.some((item) => typeof item === 'string' && item.toLowerCase() === 'image')
    out.set(id, {
      id,
      ...name === undefined ? {} : { name },
      ...Number.isFinite(context) && context > 0 ? { contextWindow: Math.trunc(context) } : {},
      supportsImage,
    })
  }
  return out
}

/**
 * 把 models.dev 的条目合并进已有目录。
 *
 * 三条规则（顺序即优先级，**本地兜底表/网关已有的一律不覆盖**）：
 * 1. **补缺**：目录里没有的 id **追加**在该前缀最后一条之后（保持同族相邻，
 *    不会沉到 460 条远端 id 的末尾而无人可见）；
 * 2. **补名字**：`name` 等于 id 本身时（网关就把 id 当名字下发）用可读名替换；
 * 3. **补窗口**：`contextWindow` 缺失时用 models.dev 的值。
 *
 * ⚠️ **不合并 `maxTokens`**（口径 3，见模块头）。
 * ⚠️ **不覆盖**任何已有值：策展/网关数据优先于社区目录。
 */
export function applyModelsDevCatalog(
  models: readonly ClineModel[],
  dev: ReadonlyMap<string, ClineModelsDevEntry>,
): ClineModel[] {
  if (dev.size === 0) return [...models]
  const out: ClineModel[] = []
  const present = new Set(models.map((model) => model.id))
  // 新条目插在「同前缀最后一条」之后，保持 cline-pass/* 相邻。
  const pending = new Map<string, ClineModel[]>()
  const prefixOf = (id: string): string => {
    const slash = id.indexOf('/')
    return slash > 0 ? id.slice(0, slash) : ''
  }
  for (const [id, entry] of dev) {
    if (present.has(id)) continue
    const prefix = prefixOf(id)
    const bucket = pending.get(prefix) ?? []
    bucket.push({
      id,
      name: entry.name ?? id,
      isFree: false,
      ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
      ...entry.supportsImage ? { supportsImage: true } : {},
    })
    pending.set(prefix, bucket)
  }

  // 该前缀在目录里**最后一次**出现的位置 —— 新条目追加其后，既相邻又排在
  // 同族末尾（不能挂在第一条后面：那会让新模型插到同族中间）。
  const lastIndexOfPrefix = new Map<string, number>()
  models.forEach((model, index) => { lastIndexOfPrefix.set(prefixOf(model.id), index) })

  models.forEach((model, index) => {
    const entry = dev.get(model.id)
    out.push(entry === undefined
      ? model
      : {
          ...model,
          // 网关把 id 当名字下发时（`name === id`）才用可读名替换。
          ...entry.name !== undefined && model.name === model.id ? { name: entry.name } : {},
          ...model.contextWindow === undefined && entry.contextWindow !== undefined
            ? { contextWindow: entry.contextWindow }
            : {},
          // ⚠️ `supportsImage` 只在**缺失**时补：本地兜底表显式 `false` 也照样赢。
          ...model.supportsImage === undefined && entry.supportsImage ? { supportsImage: true } : {},
        })
    const prefix = prefixOf(model.id)
    if (lastIndexOfPrefix.get(prefix) === index) {
      const extra = pending.get(prefix)
      if (extra !== undefined) {
        out.push(...extra)
        pending.delete(prefix)
      }
    }
  })
  // 没有任何同前缀条目的（理论上不会发生）追加在末尾，宁可多出来也不丢。
  for (const bucket of pending.values()) out.push(...bucket)
  return out
}

/** {@link makeClineModelsDevLoader} 的选项（全部可注入，便于离线单测）。 */
export interface ClineModelsDevLoaderOptions {
  /** 覆盖 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 覆盖 TTL。 */
  ttlMs?: number
  /** 覆盖时钟（测试用）。 */
  now?: () => number
}

/**
 * 造一个「取 models.dev 目录」的加载器：**带 TTL 与在飞去重**，失败**向上抛**。
 *
 * ⚠️ 失败必须抛（而不是返回空表）：`TtlCache` 只在成功时写入缓存，
 * 抛错才能让下一次调用**重试**，也才能让调用方区分「没读到」与
 * 「读到了且不支持」—— 把失败记成空表会把所有模型的图片能力永久打回纯文本。
 */
export function makeClineModelsDevLoader(
  options: ClineModelsDevLoaderOptions = {},
): () => Promise<Map<string, ClineModelsDevEntry>> {
  const fetcher = options.fetcher ?? fetch
  const cache = new TtlCache<Map<string, ClineModelsDevEntry>>({
    ttlMs: options.ttlMs ?? CLINE_MODELS_DEV_TTL_MS,
    ...options.now === undefined ? {} : { now: options.now },
    load: async () => {
      const response = await fetcher(CLINE_MODELS_DEV_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CLINE_MODELS_DEV_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`)
      return parseClineModelsDev(await response.json())
    },
  })
  return async () => await cache.get()
}
