/**
 * Raccoon Work LLM 适配器。
 *
 * ## 为什么复用 `openai-compat.ts`
 *
 * 实测 `POST /api/web/llm/v2/chat/completions` 是**标准 OpenAI 兼容 + 标准 SSE**
 * （`chat.completion.chunk` + `data: [DONE]`，无加密、无信封、无格式转换），
 * 与 Qoder / Loomy 同形，正是 `openai-compat.ts` 的适用场景。
 *
 * ⚠️ **不改 `openai-compat.ts` 的内部逻辑** —— 它当前服务 qoder 与 loomy；
 * raccoon 是第三个消费者。若实测发现字段形态不符，应在**本文件**内做局部适配，
 * 而不是改共享层（那会影响另外两个 provider 的既有行为）。
 *
 * ## 两个必须真的做到的点
 *
 * 1. **`tools` 必须下发到请求体顶层** —— Qoder 与 TRAE 都因漏发而让模型
 *    在正文里臆造 XML 工具调用、harness 认不出 → 任务终止。
 * 2. **`listAllModels()` 必须实现** —— 设置页要显示被关闭的模型及其倍率；
 *    缺了它会退化为裸 id（AGENTS.md 记录的真实缺陷）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { settingsNamespaceFor } from './settings-compat.js'
import { isRaccoonExpired, raccoonPromoBadge, type RaccoonCredential, type RaccoonModelMeta } from './raccoon.js'
import type { PromotionBadge } from './buddy.js'
import {
  RACCOON,
  RACCOON_DEFAULT_EFFORT,
  RACCOON_EFFORT_NAMES,
  RACCOON_EFFORT_OFF,
  RACCOON_EFFORT_ON,
  RACCOON_REASONING_EFFORTS,
  type RaccoonFallbackModel,
  type RaccoonProduct,
} from './raccoon-product.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
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

/** 本适配器注册的 provider 路由名（等价于 `RACCOON.id`）。 */
export const PROVIDER = 'raccoon'

/**
 * 把 DSH 的档位 id 映射成请求体的 `extra_body.thinking` 字段。
 *
 * ## 为什么是这个形态（实测确证，别改）
 *
 * 唯一**有效**的思考控制通道是 **`extra_body.thinking`**（Anthropic 风格对象），
 * 服务端报错原文确认其枚举：``expected one of `adaptive`, `enabled`, `disabled` ``。
 *
 * 实测（判据为服务端上报的 `reasoning_tokens`）：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | `extra_body.thinking={type:'disabled'}` | **6/6、8/8 全为 0** → 真关闭 |
 * | `extra_body.thinking={type:'enabled'}` | 均值 218 ≈ 基线 222 → 与默认等价 |
 *
 * ⚠️ **`reasoning_effort` 虽然被服务端接受（8 个枚举值），但实测无效果** ——
 * 8 轮配对实验里 `max - minimal` 正差 4 次 / 负差 4 次（纯随机），
 * 且 `none` 不关闭思考（均值 301 vs `disabled` 的 0）。
 * 故**不用它**表达档位，详见 `raccoon-product.ts` 的常量注释。
 *
 * ⚠️ **无效的写法**（都实测过）：`extra_body.enable_thinking`、
 * 双层 `extra_body.extra_body.*`、把 `thinking` 放**顶层**（不在 `extra_body` 内）、
 * `thinking.budget_tokens`（仅被格式校验）。
 *
 * ## 语义
 *
 * - 档位为 `off` → `{ thinking: { type: 'disabled' } }`（真的不产生思考内容）
 * - 其余（含 `on`）→ `{ thinking: { type: 'enabled' } }`
 *
 * ⚠️ **不传档位时返回 `undefined`**（不发该字段），保持服务端默认行为 ——
 * 实测默认就是开启，故与 `on` 等价，但**少发一个字段**更稳。
 *
 * @returns 要写进 `extra_body` 的对象；`undefined` 表示不发该字段。
 */
export function raccoonThinkingExtraBody(
  effort: string | undefined,
): { thinking: { type: 'enabled' | 'disabled' } } | undefined {
  if (effort === undefined || effort.length === 0) return undefined
  // 只有明确的「关闭」才关；未知档位一律按开启处理（宁可多思考，不可静默关掉
  // —— 用户看不到思考内容会以为模型坏了）。
  const type = effort === RACCOON_EFFORT_OFF ? 'disabled' : 'enabled'
  return { thinking: { type } }
}

/**
 * 该模型在 UI 上可选的思考档位。
 *
 * ⚠️ **所有模型都返回同样两档** —— 实测 `extra_body.thinking` 是 **provider 级
 * 方言**，与模型无关。故不做 per-model 分派（那会是凭空猜测）。
 *
 * ⚠️ `defaultEffort` 必须落在 `efforts` 内 —— DSH 会直接拿它发请求，
 * 给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`。
 */
export function raccoonReasoningInfo(): {
  efforts: Array<{ id: ReturnType<typeof ReasoningEffortId>; name: string }>
  defaultEffort: ReturnType<typeof ReasoningEffortId>
} {
  const efforts = RACCOON_REASONING_EFFORTS.map((id) => ({
    id: ReasoningEffortId(id),
    name: RACCOON_EFFORT_NAMES[id] ?? id,
  }))
  // ⚠️ 默认档必须确实在列表里（防御：常量被改乱时不至于抛错）
  const defaultEffort = RACCOON_REASONING_EFFORTS.includes(RACCOON_DEFAULT_EFFORT)
    ? ReasoningEffortId(RACCOON_DEFAULT_EFFORT)
    : ReasoningEffortId(RACCOON_REASONING_EFFORTS[0] ?? RACCOON_EFFORT_ON)
  return { efforts, defaultEffort }
}

/** 远端模型条目（已归一）。 */
export interface RaccoonRemoteModel {
  id: string
  /** **已规范化**的展示名（含倍率）。 */
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
  /**
   * 网关的计费状态（`billing_status` / 两端倍率 / `billing_status_note`）。
   *
   * ⚠️ 为什么把整份 meta 也带上、而不只带拼好的 `name`：展示名把促销信息
   * 压成了一个字符串（`x0.5→x0.25`），设置页要画**结构化**胶囊（独立字段
   * `promo`）就必须拿到原始字段——从名字反解析正是这套改造要消灭的做法。
   * 缺省表示「远端没给计费信息」（兜底表路径），此时不产出 `promo`。
   */
  meta?: RaccoonModelMeta
}

/**
 * 只放行**安全正整数**。
 *
 * ⚠️ 远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在
 * `defaultMaxTokens` 的硬校验上抛 `INVALID_MODEL_MAX_TOKENS`，
 * **整轮对话起不来**（不是降级，是崩）。
 */
function positiveMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: RaccoonFallbackModel): RaccoonRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // 兜底表**声明**图片能力（它有该字段）；与 loomy 不同（那边兜底表没有该信息）。
    supportsImage: model.supportsImage,
  }
}

/** {@link RaccoonAdapter} 的构造选项。 */
export interface RaccoonAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<RaccoonCredential | undefined>
  /** 凭据失效时的处理（raccoon 有 refresh 端点，会真续期）。 */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<RaccoonRemoteModel[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /**
   * 读取图片附件的**请求版本**（按字节目标缩放后的字节）。
   *
   * ⚠️ 与 {@link readImage} 的错误契约相反：**不可用时要返回 `undefined`**
   * 而不是抛错，适配器据此回退原图。理由与桥接实现见
   * `src/index.ts` 的 `makeReadImageRequest`、`src/image-budget.ts` 的
   * `projectRequestImage`。
   *
   * 背景（issue !IKITT9 的 raccoon 变体）：该网关按**请求体字节**设限，
   * 实测 `HTTP_413: request body exceeds 10MB` —— 两张 2560×1600 的截图
   *（base64 后各 ≈3.9 MB）再加别的内容就可能被拒。
   */
  readImageRequest?: (
    attachment: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link RACCOON}。 */
  product?: RaccoonProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** Raccoon Work 模型适配器。 */
export class RaccoonAdapter extends LlmAdapter {
  private readonly product: RaccoonProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, RaccoonFallbackModel>
  /** 远端模型缓存；未拉取时为 undefined。 */
  private remoteModels: RaccoonRemoteModel[] | undefined
  /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
  private readonly catalogGate = new RemoteCatalogGate()

  constructor(private readonly options: RaccoonAdapterOptions) {
    super()
    this.product = options.product ?? RACCOON
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串，直接回退到本产品的 id。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key
   * 补回，而那条路径拿不到展示名，会退化成裸 id（倍率与模型名随之丢失）。
   */
  listAllModels(): readonly { id: string; name: string; promo?: PromotionBadge }[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => {
      // 促销走**独立字段** `promo`（与 buddy/qoder/trae 同一契约）。
      const promo = model.meta === undefined ? undefined : raccoonPromoBadge(model.meta)
      return { id: model.id, name: model.name, ...promo === undefined ? {} : { promo } }
    })
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
  private async loadModels(): Promise<RaccoonRemoteModel[]> {
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

  private inputModalitiesFor(model: RaccoonRemoteModel | undefined): readonly ('text' | 'image')[] {
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

    return listed.map((model) => {
      // 促销走独立字段（与 `listAllModels` 同源）：设置页据此画结构化胶囊。
      const promo = model.meta === undefined ? undefined : raccoonPromoBadge(model.meta)
      return {
        provider: this.product.id,
        id: model.id,
        // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
        name: model.name,
        ...promo === undefined ? {} : { promo },
        inputModalities: this.inputModalitiesFor(model),
      }
    })
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    // ⚠️ name **不带倍率**（与 qoder/trae/loomy 一致）：价格只属于选择列表语境。
    const bareName = fallback !== undefined ? fallback.name.replace(/ · .*$/, '') : model
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry !== undefined ? entry.name.replace(/ · .*$/, '') : bareName,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    // ⚠️ 远端非法值必须过滤（见 positiveMaxTokens）：不声明就让 DSH 用默认值。
    const maxTokens = positiveMaxTokens(entry?.maxTokens ?? fallback?.maxTokens)
    if (maxTokens !== undefined) resolved.defaultMaxTokens = maxTokens
    // 思考档位（两态：深度思考 / 关闭思考）。实测确证见 `raccoonReasoningInfo`。
    // ⚠️ 所有模型一致 —— `extra_body.thinking` 是 provider 级方言，与模型无关。
    resolved.reasoning = raccoonReasoningInfo()
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法。与其余适配器同款 shim。
   */
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
    // 图片能力按**模型**判定。不能放宽成「总是接受」：DSH 在 LlmRuntime 里
    // 按适配器播报的 `inputModalities` 决定要不要把图片投影成文本占位符，
    // 声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`raccoon: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('raccoon: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        // ⚠️ 先试**请求版本**：这家网关按请求体字节设限（实测
        // `HTTP_413: request body exceeds 10MB`），原图直发时两张大截图
        // 就能把配额吃掉大半。拿不到（老宿主 / 拒绝投影 / 缺尺寸）就回退原图。
        const projected = await projectRequestImage(ref, {
          readImageRequest: this.options.readImageRequest,
          pixelBudget: this.product.imagePixelBudget,
          maxBytes: this.product.imageMaxBytes,
        })
        const image = projected ?? await readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 取凭据（过期则先续期）
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isRaccoonExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('raccoon: no usable credential; log in first', 'MISSING_CREDENTIAL')
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
     * 思考档位 → `extra_body` 内容。
     *
     * ⚠️ 在 `buildBody` **之外**算一次：`buildBody` 会在重试时被多次调用，
     * 每次重算虽无害但没必要。
     */
    const thinking = raccoonThinkingExtraBody(options.reasoningEffort)

    /** 构造请求体。 */
    const buildBody = (): string => JSON.stringify({
      model: options.model,
      messages: wireMessages,
      stream: true,
      ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
      // ⚠️ tools 必须真的下发到请求体**顶层**：Qoder/TRAE 都因漏发而让模型
      // 在正文里臆造 XML 工具调用，harness 认不出 → 任务终止。
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
      // 思考档位（开 / 关）。⚠️ **必须在 `extra_body` 内** —— 实测放顶层会被忽略
      //（连非法值都不报错）。不传档位时不发该字段，保持服务端默认（= 开）。
      ...thinking !== undefined ? { extra_body: thinking } : {},
    })

    const headers = (): Record<string, string> => ({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential?.access_token ?? ''}`,
      'X-Org-Code': credential?.office_identity ?? '',
      'X-Raccoon-Language': 'zh',
      'X-Client-Platform': this.product.clientPlatform,
    })

    /** 发送一次 chat 请求。 */
    const send = async (): Promise<Response> => {
      try {
        return await this.fetchImpl(
          `${this.product.apiBase}${this.product.llmApiPrefix}/chat/completions`,
          {
            method: 'POST',
            headers: headers(),
            body: buildBody(),
            signal: options.signal,
          },
        )
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `raccoon: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    let response = await send()
    // 401/403 时续期一次并重试（raccoon 有 refresh_token 轮换）。
    if (response.status === 401 || response.status === 403) {
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential(options.model)
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('raccoon: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await send()
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new LlmError(`raccoon: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
    }

    // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse 处理。
    yield* consumeOpenAiSse(response, { signal: options.signal }, {
      label: 'raccoon',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    })
  }
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_RACCOON_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_RACCOON_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/**
 * 在 `ctx.llm` 上注册 raccoon provider 路由与适配器。
 *
 * 返回适配器实例：Channel Pack「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerRaccoonLlm(ctx: Context, options: RaccoonAdapterOptions): RaccoonAdapter {
  const product = options.product ?? RACCOON
  const adapter = new RaccoonAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
