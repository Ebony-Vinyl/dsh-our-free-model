import { withQueueAccountRotation } from './queue-rotation.js'
import { checkQueuedResponse } from './model-queue.js'
/**
 * Loomy LLM 适配器。
 *
 * ## 协议
 *
 * ⚠️ **认证头与业务端点不同**：chat 端点**只认** `Authorization: Bearer`，
 * 而 `/models`、`/points/*` 只认 `token`。故 `stream()` 用
 * `loomyChatHeaders()`（两个都发），`listModels()` 用 `loomyBusinessHeaders()`。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { settingsNamespaceFor } from './settings-compat.js'
import {
  isLoomyChatModel,
  isLoomyExpired,
  loomyChatHeaders,
  loomyDisplayName,
  splitLoomyRate,
  type LoomyCredential,
} from './loomy.js'
import { LOOMY, type LoomyFallbackModel, type LoomyProduct } from './loomy-product.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'

/** 本适配器注册的 provider 路由名（等价于 `LOOMY.id`）。 */
export const PROVIDER = 'loomy'

/** 远端模型条目（已归一）。 */
export interface LoomyRemoteModel {
  id: string
  /** **已规范化**的展示名（含倍率）。 */
  name: string
  contextWindow: number
  supportsImage: boolean
  supportsThinking: boolean
  /**
   * 可选思考档位（远端 `reasoning_efforts`，如 `['none','low','medium','high','xhigh']`）。
   *
   * ⚠️ **取自远端而非硬编码** —— 服务端 `GET /models` 直接下发了这两个字段，
   * 且带 `reasoning_catalog_version`（catalog 版本哈希），故档位随服务端更新，
   * 无需改代码。
   *
   * 缺失（`undefined`）表示**该模型不提供档位选择**，此时不声明 `reasoning`，
   * UI 显示「当前模型未提供推理等级」—— 而不是给一个发了也没用的档位。
   */
  efforts?: string[]
  /** 远端声明的默认档位（`default_reasoning_effort`）。 */
  defaultEffort?: string
}

/**
 * 档位 id → 中文展示名。
 *
 * ⚠️ **必须与官方 IDE 一致**。Loomy 是基于 **opencode** 构建的，其
 * `opencode.json` 的 `variants` 用的就是 `low` / `medium` / `high` 这套 id
 * （用户截图里的「低 / 中 / 高」正是它）。中文名沿用 Qoder 那套官方 i18n 表
 * （`src/qoder-adapter.ts` 的 `QODER_EFFORT_NAMES`，同源产品命名一致）。
 *
 * ⚠️ DSH 的档位选择器**直接渲染 `efforts[].name`**（不本地化），
 * 故这里给中文即中文界面。
 */
const LOOMY_EFFORT_NAMES: Readonly<Record<string, string>> = {
  none: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

/**
 * 本插件选用的**默认思考档位**（用户要求：`high`）。
 *
 * ⚠️ **不采信远端的 `default_reasoning_effort`**（它声明的是 `low`）。
 * 依据是 DSH 的取值逻辑 —— `dsh-client-ui-model-selection` 的
 * `effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort`，
 * 即「用户没选时发哪个档」**完全由适配器声明的 `defaultEffort` 决定**，
 * 沿用远端的 `low` 会让默认思考偏浅。
 *
 * ⚠️ **必须落在该模型的 `efforts` 内**：DSH 会拿它**直接发请求**，给一个不存在的
 * 档位会抛 `UNSUPPORTED_REASONING_EFFORT`。故 `reasoningFor` 里做了 `includes`
 * 校验 —— 某模型若不提供 `high`（远端目录变化时可能发生），则**不下发默认档**，
 * 退回 DSH 的「服务商默认」语义，而不是发一个非法值。
 */
const LOOMY_PREFERRED_DEFAULT_EFFORT = 'high'

/** 把 `reasoning_efforts` 读成去重后的字符串数组（非法项丢弃）。 */
function readReasoningEfforts(entry: Record<string, unknown>): string[] {
  const raw = entry.reasoning_efforts
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 把 `capabilities.input_modalities` 读成小写字符串数组。 */
function readInputModalities(entry: Record<string, unknown>): string[] {
  const capabilities = entry.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) return []
  const raw = (capabilities as Record<string, unknown>).input_modalities
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
}

/**
 * 解析远端 `GET /models` 响应，只保留 `type === 'chat'` 的条目。
 *
 * ⚠️ 过滤判据是 `type`，**不能**看 `input_modalities` —— 实测 5 个 chat
 * 模型的输入模态含 `image`（能看图），那不是生图模型。
 * ⚠️ 展示名经 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 */
export function parseLoomyRemoteModels(payload: unknown): LoomyRemoteModel[] {
  const list = Array.isArray(payload)
    ? payload
    : (typeof payload === 'object' && payload !== null
        && Array.isArray((payload as Record<string, unknown>).data)
      ? (payload as Record<string, unknown>).data as unknown[]
      : [])
  const models: LoomyRemoteModel[] = []
  for (const item of list) {
    if (!isLoomyChatModel(item)) continue
    const entry = item as Record<string, unknown>
    const id = String(entry.id)
    const rawName = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id
    const contextWindow = Number(entry.context_length)
    const capabilities = typeof entry.capabilities === 'object' && entry.capabilities !== null
      ? entry.capabilities as Record<string, unknown>
      : {}
    const efforts = readReasoningEfforts(entry)
    const rawDefault = entry.default_reasoning_effort
    models.push({
      id,
      name: loomyDisplayName(rawName),
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
      supportsImage: readInputModalities(entry).includes('image'),
      supportsThinking: capabilities.reasoning === true,
      // ⚠️ 档位缺失时**不写这两个键**（而不是写空数组）：下游据此区分
      // 「该模型不提供档位」与「提供了但为空」。
      ...efforts.length > 0 ? { efforts } : {},
      ...typeof rawDefault === 'string' && rawDefault.length > 0
        ? { defaultEffort: rawDefault }
        : {},
    })
  }
  return models
}

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: LoomyFallbackModel): LoomyRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    // 兜底表不声明图片能力：宁可少报（用户改用文本描述），
    // 也不要报一个服务端可能不认的模态。
    supportsImage: false,
    supportsThinking: true,
    ...model.efforts !== undefined && model.efforts.length > 0
      ? { efforts: [...model.efforts] }
      : {},
    ...model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {},
  }
}

/** {@link LoomyAdapter} 的构造选项。 */
export interface LoomyAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /**
   * 解析当前可用凭据。
   *
   * ⚠️ 入参是**本轮要用的模型 id**：Loomy 的选号策略要按「该模型是否受限」
   * 先过滤账号（限流是**按模型**记的），再按余额分档。实现**必须**把它透传给
   * `AccountPool.getAvailableAccount` 的 `modelId` —— 早期实现传空串
   * （等于不按模型过滤），会让模型级限流失效。
   */
  resolveCredential: (modelId?: string) => Promise<LoomyCredential | undefined>
  /**
   * 凭据失效时的处理。
   *
   * ⚠️ Loomy **没有 refresh 端点**，故实现只做**有效性探测**并在失效时抛错，
   * 不会（也无法）续期。
   */
  refresh: (accountId?: string, reason?: 'auth') => Promise<LoomyCredential | void>
  nextAccount?: (
    modelId: string,
    tried: ReadonlySet<string>,
  ) => Promise<{ accountId: string; credential: LoomyCredential } | undefined>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<LoomyRemoteModel[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link LOOMY}。 */
  product?: LoomyProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** Loomy 模型适配器。chat 端点用 Bearer，业务端点用 token。 */
export class LoomyAdapter extends LlmAdapter {
  private readonly product: LoomyProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, LoomyFallbackModel>
  /** 远端模型缓存（含展示名与能力）；未拉取时为 undefined。 */
  private remoteModels: LoomyRemoteModel[] | undefined
  /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
  private readonly catalogGate = new RemoteCatalogGate()

  constructor(private readonly options: LoomyAdapterOptions) {
    super()
    this.product = options.product ?? LOOMY
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
   * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /** 完整目录（**不套黑名单**），带最终展示名。设置页需要它渲染被关闭的模型。 */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /**
   * 取远端模型目录；**失败时不把兜底表写进缓存**。
   *
   * ⚠ 原实现是 `this.remoteModels = fallback; return fallback` —— 把兜底表当成
   * 「已加载」记下，于是一次瞬时失败会让该 provider **整个进程生命周期**都只剩
   * 兜底模型（用户看不到自己的模型，且无从触发重试，只能重启）。
   * 改为：只缓存**真实远端目录**，兜底表每次现算（纯本地、零成本），
   * 并用 {@link RemoteCatalogGate} 的冷却挡住「每模型重试一次」的放大。
   */
  private async loadModels(): Promise<LoomyRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote !== undefined) {
      await this.catalogGate.run(async () => {
        const fetched = await fetchRemote()
        if (fetched.length === 0) return false
        this.remoteModels = fetched
        return true
      })
      if (this.remoteModels !== undefined) return this.remoteModels
    }
    return this.product.fallbackModels.map(fallbackToRemote)
  }

  private inputModalitiesFor(model: LoomyRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider
    // 分组隐藏。**必须返回空数组而不能抛错**（抛错会被归入 catalog 的
    // failures，界面上反而多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    // ⚠️ name **不带倍率**（与 qoder/trae 一致）：价格只属于选择列表语境。
    const bareName = fallback !== undefined ? splitLoomyRate(fallback.name).name : model
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry !== undefined ? splitLoomyRate(entry.name).name : bareName,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    // 思考档位：**远端 `reasoning_efforts` 直接生成**（用户要求）。
    const reasoning = this.reasoningFor(entry, fallback)
    if (reasoning !== undefined) resolved.reasoning = reasoning
    return resolved
  }

  /**
   * 该模型的思考档位（`resolveModel` 的 `reasoning` 字段）。
   *
   * ⚠️ **此前根本不声明** —— DSH 的思考强度选择器**只会**从
   * `resolveModel().reasoning` 渲染，故两个站点从来没出现过档位选择器，
   * 尽管远端早就下发了 `reasoning_efforts`。这与 Qoder 那次（AGENTS.md 2.2 节）
   * 是**完全同型**的缺陷。
   *
   * 三条口径：
   * 1. `efforts` **原样取远端顺序**（服务端下发的就是展示顺序）；
   * 2. `defaultEffort` **必须落在 `efforts` 内** —— DSH 会拿它直接发请求，
   *    给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟；
   * 3. 远端未下发档位时不声明 `reasoning`（UI 显示「当前模型未提供推理等级」）。
   */
  private reasoningFor(
    entry: LoomyRemoteModel | undefined,
    fallback: LoomyFallbackModel | undefined,
  ): LlmResolvedModelInfo['reasoning'] {
    // 远端优先；远端整体失败时用兜底表（两者字段同名同形）。
    const efforts = entry?.efforts ?? fallback?.efforts
    if (efforts === undefined || efforts.length === 0) return undefined
    // ⚠️ **默认档用本插件自己的「高」，不采信远端的 `default_reasoning_effort`**（用户要求）。
    // 依据：远端声明的是 `low`，而 DSH 的 `effectiveEffort` 直接取 `defaultEffort`
    // （`dsh-client-ui-model-selection`：`state.current?.reasoningEffort ?? reasoning?.defaultEffort`），
    // 即「用户没选时发哪个档」完全由这里决定 —— 沿用 low 会让默认思考偏浅。
    const defaultEffort = LOOMY_PREFERRED_DEFAULT_EFFORT
    const hasDefault = efforts.includes(defaultEffort)
    return {
      efforts: efforts.map((id) => ({
        id: ReasoningEffortId(id),
        // 未登记的中文名回退到 id 本身（新档位上线时不至于空白）。
        name: LOOMY_EFFORT_NAMES[id] ?? id,
      })),
      ...hasDefault ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {},
    }
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片能力按**模型**判定。这里**不能**放宽成「总是接受」：DSH 在
    // LlmRuntime 里按适配器播报的 `inputModalities` 决定要不要把图片投影成
    // 文本占位符，声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`loomy: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('loomy: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 取凭据（过期则先尝试探测/刷新）
    //
    // ⚠️ **必须把模型 id 传给选号器**：Loomy 的选号要先按「该模型是否受限」
    // 过滤账号（限流按模型记），再按余额分档。传空串会让模型级限流失效。
    let credential = await this.options.resolveCredential(options.model)
    let accountId = credential === undefined ? undefined
      : await this.options.accountPool?.findAccountIdByCredential(this.product.id, credential.access_token)
    if (credential === undefined || isLoomyExpired(credential)) {
      credential = await this.options.refresh(accountId || undefined)
        ?? await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('loomy: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    const messages = serializeMessages(options.messages, imageUrls)

    /**
     * 前置 system 消息（若有）。
     *
     * ⚠️ 必须**先拼再放进对象**，不要在对象字面量里写两次 `messages` ——
     * 后者依赖「后面的键覆盖前面」这一隐式行为，读者极易误判成漏了 system。
     */
    const wireMessages = options.system !== undefined && options.system.length > 0
      ? [{ role: 'system', content: options.system }, ...messages]
      : messages

    /**
     * 思考档位：仅当**该模型确实声明了它**时才下发。
     *
     * ⚠️ **必须校验档位在该模型的 `efforts` 内**：DSH 会把用户选的档位直接透传，
     * 给一个远端不认的值比不给更糟。校验不过时**静默不下发**（退回服务端默认档），
     * 而不是发一个可能被拒的值。
     *
     * ⚠️ **不能靠 HTTP 状态码判断该字段是否生效**：实测传
     * `reasoning_effort` / `reasoningEffort` / `thinking` 三种名字**都返回 200**
     * —— 服务端对未知字段静默忽略（与「无效模型名回退默认模型」同一模式）。
     * 故这里的字段名依据是**远端自己的命名**，而非「试出来能通」。
     */
    const effortsForModel = (await this.loadModels()).find((m) => m.id === options.model)?.efforts
      ?? this.fallbackIndex.get(options.model)?.efforts
    const effort = options.reasoningEffort !== undefined
      && effortsForModel !== undefined
      && effortsForModel.includes(options.reasoningEffort)
      ? options.reasoningEffort
      : undefined

    /** 构造请求体。 */
    const buildBody = (): string => JSON.stringify({
      model: options.model,
      messages: wireMessages,
      stream: true,
      ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
      ...effort !== undefined ? { reasoning_effort: effort } : {},
      ...options.tools !== undefined && options.tools.length > 0
        ? {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...tool.description.length > 0 ? { description: tool.description } : {},
                ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
              },
            })),
          }
        : {},
    })

    /** 发送一次 chat 请求。 */
    const send = async (token: string): Promise<Response> => {
      try {
        return await this.fetchImpl(`${this.product.apiBase}/chat/completions`, {
          method: 'POST',
          // ⚠️ chat 端点只认 Bearer（业务端点才认 token），这里两个都发。
          headers: loomyChatHeaders(token),
          body: buildBody(),
          signal: options.signal,
        }).then(checkQueuedResponse)
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `loomy: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    const tried = new Set<string>()
    for (let attempt = 0; attempt < 3; attempt++) {
      if (accountId) tried.add(accountId)
      let emitted = false
      try {
        let response = await send(credential.access_token)
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel()
          credential = await this.options.refresh(accountId || undefined, 'auth')
            ?? await this.options.resolveCredential(options.model)
          if (credential === undefined || credential.access_token.length === 0) {
            throw new LlmError('loomy: credential expired and refresh failed', 'AUTH', { status: response.status })
          }
          response = await send(credential.access_token)
        }
        if (!response.ok) {
          const errorText = await response.text().catch(() => '')
          let quota = response.status === 402
          try { quota ||= isLoomyQuotaError(JSON.parse(errorText)) } catch {}
          throw new LlmError(
            `loomy: ${errorDetail(errorText)}`,
            quota ? 'QUOTA_EXCEEDED' : httpErrorCode(response.status),
            { status: response.status },
          )
        }
        for await (const chunk of consumeOpenAiSse(response, { signal: options.signal }, {
          label: 'loomy',
          firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
          chunkTimeoutMs: resolveChunkTimeoutMs(),
          isQuotaError: isLoomyQuotaError,
          ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        })) {
          emitted = true
          yield chunk
        }
        return
      } catch (error) {
        if (options.signal?.aborted || !(error instanceof LlmError) || error.code !== 'QUOTA_EXCEEDED') throw error
        if (accountId) {
          await this.options.accountPool?.updateModelRateLimit(accountId, options.model, nextUtc8DayStartMs())
        }
        if (emitted || attempt === 2 || this.options.nextAccount === undefined) throw error
        const next = await this.options.nextAccount(options.model, tried)
        if (next === undefined || tried.has(next.accountId)) throw error
        accountId = next.accountId
        credential = next.credential
        if (isLoomyExpired(credential)) credential = await this.options.refresh(accountId) ?? credential
      }
    }
  }
}

function isLoomyQuotaError(data: Record<string, unknown>): boolean {
  const error = typeof data.error === 'object' && data.error !== null
    ? data.error as Record<string, unknown>
    : data
  return String(error.code ?? data.code) === '402'
    || /积分不足|余额不足|insufficient[_\s]+(?:points|balance|credits)/i.test(String(error.message ?? error.msg ?? ''))
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_LOOMY_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_LOOMY_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/**
 * 在 `ctx.llm` 上注册 Loomy provider 路由与适配器。
 *
 * 返回适配器实例：Channel Pack「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerLoomyLlm(ctx: Context, options: LoomyAdapterOptions): LoomyAdapter {
  const product = options.product ?? LOOMY
  const adapter = withQueueAccountRotation(product.id, options, scoped => new LoomyAdapter(scoped))
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
