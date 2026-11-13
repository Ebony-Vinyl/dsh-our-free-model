/**
 * SCNet 模型目录发现。
 *
 * ## 数据来源（按可靠性排序）
 *
 * 1. **SCNet 客户端的模型目录** `~/.sclaw/agent/models.json` →
 *    `providers.scnet.models`：客户端从平台模型列表生成并落盘，**唯一带
 *    `priceLabel` 的本地来源**（免费 = `priceLabel === "free"`），还带
 *    `contextWindow` / `maxTokens` / `input` / `thinkingMode` 等能力字段。
 * 2. **推理网关** `GET {apiBase}/models`（`Bearer sk-…`）：只给 id，没有价格也没有
 *    能力。因此它只用于两件事：校验「这个模型现在还能不能用」，以及在没有客户端
 *    目录时提供一份**模型名单**。
 * 3. **内置兜底**：什么都没有时退回 `SCNet-Max`（免费、1M/128k），保证渠道仍能出模型。
 *
 * ## 为什么必须区分「免费」
 *
 * 平台的 `priceLabel` 是**限时**免费政策，不是永久免费。本渠道默认只注册
 * `priceLabel=free` 的模型；关闭这个开关后会把目录里的全部模型都注册出来
 * （计费按平台规则走，插件不做限制）。
 *
 * @module scnet-catalog
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SCNET_FALLBACK_MODELS,
  SCNET_DEFAULT_MODEL_ID,
  type ScnetFallbackModel,
  type ScnetProduct,
} from './scnet-product.js'
import { scnetGatewayHeaders } from './scnet.js'

/** 客户端目录里标记「免费」的 `priceLabel` 值。 */
export const SCNET_FREE_PRICE_LABEL = 'free'

/** 网关 `GET /models` 的超时。 */
const GATEWAY_TIMEOUT_MS = 8_000

/** 归一后的模型条目。 */
export interface ScnetModelEntry {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** 是否接受图片输入。 */
  supportsImage: boolean
  /** 是否声明支持思考等级。 */
  supportsThinking: boolean
  /** 可选思考档位；`undefined` = 该模型不提供档位选择。 */
  efforts?: readonly string[]
  /** 默认档位。 */
  defaultEffort?: string
  /** 平台价格标签（`free` / `none` / `special` …）。 */
  priceLabel?: string
}

/** 客户端目录的解析结果。 */
export interface ScnetClientCatalog {
  path: string
  models: ScnetModelEntry[]
  /** 客户端 UI 里可见的模型 id（有就据此过滤）。 */
  visibleModelIds?: string[]
}

/**
 * 客户端数据目录的默认位置。
 *
 * 与 SCNet 客户端一致：Windows 用 `%APPDATA%\scnet-client`，macOS 用
 * `~/Library/Application Support/scnet-client`，其余用 XDG。
 */
function defaultAgentDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (typeof appData === 'string' && appData.length > 0) return path.join(appData, 'scnet-client')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'scnet-client')
  }
  const xdg = process.env.XDG_CONFIG_HOME
  return path.join(typeof xdg === 'string' && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config'), 'scnet-client')
}

/** 客户端模型目录的默认路径（`<agentDataDir>/../.sclaw/agent/models.json` 的实际形态）。 */
export function defaultScnetModelsPath(): string {
  return path.join(os.homedir(), '.sclaw', 'agent', 'models.json')
}

/** 把一条客户端目录条目归一成 {@link ScnetModelEntry}；形状不对返回 `undefined`。 */
function normalizeClientModel(raw: unknown): ScnetModelEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id.length === 0) return undefined
  const input = Array.isArray(record.input)
    ? record.input.filter((value): value is string => value === 'text' || value === 'image')
    : []
  const thinkingMode = typeof record.thinkingMode === 'string' ? record.thinkingMode : undefined
  const reasoning = typeof record.reasoning === 'boolean' ? record.reasoning : undefined
  /**
   * ⚠️ `thinkingMode === 'levels'` 比 `reasoning: true` 更可信：
   * 当前 `SCNet-Max` 的目录条目就是 `reasoning: false` + `thinkingMode: 'levels'`，
   * 而它**实际会返回 `reasoning_content`**，客户端 UI 也按分等级展示。
   */
  const supportsThinking = thinkingMode === 'levels' || reasoning === true
  return {
    id,
    name: typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : id,
    // ⚠️ 客户端目录里的 contextWindow 是**客户端自己的保守取值**（SCNet-Max 实测
    // 目录写 262144，而平台实测 1M 可用），照抄会在 1/4 处就开始压缩上下文。
    // 故取「目录值 与 实测值」的较大者；输出上限同理，再夹到上下文以内。
    contextWindow: Math.max(
      typeof record.contextWindow === 'number' && record.contextWindow > 0 ? record.contextWindow : 0,
      SCNET_FALLBACK_MODELS[0]!.contextWindow,
    ),
    maxTokens: Math.min(
      Math.max(
        typeof record.maxTokens === 'number' && record.maxTokens > 0 ? record.maxTokens : 0,
        SCNET_FALLBACK_MODELS[0]!.maxTokens,
      ),
      Math.max(
        typeof record.contextWindow === 'number' && record.contextWindow > 0 ? record.contextWindow : 0,
        SCNET_FALLBACK_MODELS[0]!.contextWindow,
      ),
    ),
    supportsImage: input.includes('image'),
    supportsThinking,
    ...(supportsThinking ? {
      efforts: SCNET_FALLBACK_MODELS[0]!.efforts ?? [],
      defaultEffort: SCNET_FALLBACK_MODELS[0]!.defaultEffort,
    } : {}),
    ...(typeof record.priceLabel === 'string' ? { priceLabel: record.priceLabel } : {}),
  }
}

/**
 * 读取客户端的模型目录（`providers.scnet`）。
 *
 * 文件不存在 / 解析失败 / 没有模型时返回 `undefined`（**不抛异常**：客户端没装是
 * 正常情况，不是错误）。
 */
export function readClientScnetCatalog(modelsPath?: string): ScnetClientCatalog | undefined {
  const file = modelsPath !== undefined && modelsPath.trim().length > 0
    ? modelsPath.trim()
    : defaultScnetModelsPath()
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const providers = (parsed as Record<string, unknown> | undefined)?.providers
  const scnet = (providers as Record<string, unknown> | undefined)?.scnet
  const rawModels = (scnet as Record<string, unknown> | undefined)?.models
  if (!Array.isArray(rawModels)) return undefined
  const models: ScnetModelEntry[] = []
  const seen = new Set<string>()
  for (const raw of rawModels) {
    const model = normalizeClientModel(raw)
    if (model === undefined) continue
    const key = model.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    models.push(model)
  }
  if (models.length === 0) return undefined
  const visible = (scnet as Record<string, unknown>).visibleModelIds
  return {
    path: file,
    models,
    ...(Array.isArray(visible) ? { visibleModelIds: visible.filter((id): id is string => typeof id === 'string') } : {}),
  }
}

/**
 * 查询网关实时模型列表（`GET /models`）。
 *
 * 失败**不抛异常**：网络不通 / 代理拦截 / 401 都只是「无法校验」，不影响本地目录
 * 提供的模型列表，调用方据此决定是否过滤。
 */
export async function fetchGatewayModelIds(options: {
  apiKey: string
  baseUrl?: string
  fetcher?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const key = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  if (key.length === 0) return { ok: false, error: 'no api key' }
  const fetcher = options.fetcher ?? fetch
  const base = (options.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (base.length === 0) return { ok: false, error: 'no base url' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs ?? GATEWAY_TIMEOUT_MS)
  const forward = (): void => controller.abort(options.signal?.reason)
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort(options.signal.reason)
    else options.signal.addEventListener('abort', forward, { once: true })
  }
  try {
    const response = await fetcher(`${base}/models`, {
      headers: scnetGatewayHeaders(key),
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const body = await response.json() as unknown
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as Record<string, unknown> | undefined)?.data)
        ? (body as Record<string, unknown>).data as unknown[]
        : []
    const ids = rows
      .map((row) => (typeof row === 'string' ? row : (row as Record<string, unknown> | undefined)?.id))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim())
    if (ids.length === 0) return { ok: false, error: 'empty model list' }
    return { ok: true, ids }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener?.('abort', forward)
  }
}

/** 兜底模型表 → 归一后的条目。 */
function fallbackEntries(fallback: readonly ScnetFallbackModel[]): ScnetModelEntry[] {
  return fallback.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImage: model.supportsImage === true,
    supportsThinking: (model.efforts?.length ?? 0) > 0,
    ...(model.efforts === undefined ? {} : { efforts: model.efforts }),
    ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
    priceLabel: SCNET_FREE_PRICE_LABEL,
  }))
}

/** 把网关发现的陌生模型归一（元数据用兜底表的能力字段）。 */
function entryFromGatewayId(id: string, template: ScnetModelEntry): ScnetModelEntry {
  const known = SCNET_FALLBACK_MODELS.find((model) => model.id.toLowerCase() === id.toLowerCase())
  if (known !== undefined) {
    return {
      id,
      name: id,
      contextWindow: known.contextWindow,
      maxTokens: known.maxTokens,
      supportsImage: known.supportsImage === true,
      supportsThinking: (known.efforts?.length ?? 0) > 0,
      ...(known.efforts === undefined ? {} : { efforts: known.efforts }),
      ...(known.defaultEffort === undefined ? {} : { defaultEffort: known.defaultEffort }),
    }
  }
  return {
    id,
    name: id,
    contextWindow: template.contextWindow,
    maxTokens: template.maxTokens,
    // 陌生模型按纯文本声明（不给它凭空加图片能力）。
    supportsImage: false,
    supportsThinking: template.supportsThinking,
    ...(template.supportsThinking && template.efforts !== undefined
      ? { efforts: template.efforts, defaultEffort: template.defaultEffort }
      : {}),
  }
}

/** 可选模型加载选项。 */
export interface ScnetModelLoadOptions {
  product?: ScnetProduct
  apiKey?: string
  baseUrl?: string
  /** 客户端模型目录路径（默认 `~/.sclaw/agent/models.json`）。 */
  modelsPath?: string
  /** 只注册免费模型（默认 `true`）。 */
  freeOnly?: boolean
  /** 刷新时是否用网关校验可用性（默认 `true`）。 */
  verifyWithGateway?: boolean
  fetcher?: typeof fetch
  signal?: AbortSignal
}

/**
 * 加载模型目录。
 *
 * 优先级：客户端目录（含免费标记与能力字段）→ 网关名单（只有 id）→ 内置兜底。
 * 客户端的 `visibleModelIds` 用于过滤用户自己隐藏的模型。
 */
export async function loadScnetModels(options: ScnetModelLoadOptions = {}): Promise<ScnetModelEntry[]> {
  const product = options.product
  const fallback = fallbackEntries(product?.fallbackModels ?? SCNET_FALLBACK_MODELS)
  const template = fallback[0]!
  const client = readClientScnetCatalog(options.modelsPath)
  const freeOnly = options.freeOnly !== false

  /** 客户端目录给出的候选（按客户端顺序，免费优先保留 `SCNet-Max` 在前）。 */
  let candidates: ScnetModelEntry[] = []
  if (client !== undefined) {
    const visible = client.visibleModelIds
    candidates = client.models
      .filter((model) => !freeOnly || model.priceLabel === undefined || model.priceLabel === SCNET_FREE_PRICE_LABEL)
      .filter((model) => visible === undefined || visible.includes(model.id))
    if (candidates.length === 0 && !freeOnly) candidates = [...client.models]
  }

  /**
   * 没有客户端目录 = **拿不到 priceLabel**，也就无从判断哪些模型是免费的。
   *
   * 此时只注册兜底表（SCNet-Max），**不**把网关里的全部模型塞进选择器：
   * 实测该网关当前返回 32 个模型，绝大多数收费（用户一旦选中就会按平台规则计费），
   * 还混着 `Qwen3-Embedding-8B` 这种非对话模型；而且每次 `listModels` 都要多打一次
   * 网络请求，首次进入会话时可能拖慢甚至拖垮目录构建。
   *
   * 想看全部模型：装上 SCNet 客户端并登录一次（它会生成带 priceLabel 的
   * `~/.sclaw/agent/models.json`），或把 `freeOnly` 关掉。
   */
  if (client === undefined && freeOnly) return sortPreferred(fallback)

  /** 网关名单（可选）。 */
  let gatewayIds: string[] | undefined
  if (options.verifyWithGateway !== false && typeof options.apiKey === 'string' && options.apiKey.length > 0) {
    const gateway = await fetchGatewayModelIds({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? product?.apiBase ?? '',
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (gateway.ok) gatewayIds = gateway.ids
  }

  if (candidates.length > 0) {
    // 有客户端目录：用网关名单做「现在还能不能用」的交集校验；网关不可用时不过滤。
    const filtered = gatewayIds === undefined
      ? candidates
      : candidates.filter((model) => gatewayIds!.some((id) => id.toLowerCase() === model.id.toLowerCase()))
    // 交集为空通常是网关侧临时异常：宁可保留客户端目录，也不要让用户看到空列表。
    const picked = filtered.length > 0 ? filtered : candidates
    return sortPreferred(picked)
  }

  if (gatewayIds !== undefined) {
    return sortPreferred(gatewayIds.map((id) => entryFromGatewayId(id, template)))
  }

  return sortPreferred(fallback)
}

/** 默认模型排最前，其余保持原顺序（客户端/网关目录本身是平台推荐顺序）。 */
function sortPreferred(models: ScnetModelEntry[]): ScnetModelEntry[] {
  const preferred = models.filter((model) => model.id.toLowerCase() === SCNET_DEFAULT_MODEL_ID.toLowerCase())
  const rest = models.filter((model) => model.id.toLowerCase() !== SCNET_DEFAULT_MODEL_ID.toLowerCase())
  return [...preferred, ...rest]
}