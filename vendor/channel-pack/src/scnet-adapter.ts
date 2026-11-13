/**
 * SCNet LLM 适配器。
 *
 * ## 协议
 *
 * 网关是**标准 OpenAI Chat Completions 兼容端点**（`{apiBase}/chat/completions`），
 * 因此这里不需要任何协议转换，只需要：
 *
 * - 认证头：`Authorization: Bearer sk-…`（**只认这个**，平台 Cookie 完全不参与）；
 * - 请求体：`max_tokens`（vLLM 传统拼写，不是 `max_completion_tokens`）、
 *   `reasoning_effort`（网关认 `none/low/medium/high/xhigh/max`，`none` 实测让
 *   reasoning token 归零）、`tools`；
 * - 响应：标准 SSE，`delta.reasoning_content` 由共享消费器单独成块。
 *
 * ## SCNet 上游抖动的两处归一化（参考实现实测，这里就地吸收）
 *
 * | 现象 | 原始形态 | 不处理的后果 |
 * | --- | --- | --- |
 * | 路由/实例切换 | HTTP **503** + `{"type":"invalid_request_error","code":"10008"}` | 按状态码归 SERVER 已可重试，无需改写 |
 * | 参数非法却包装了瞬时抖动 | HTTP **400** + `code:"10013"` | 归 INVALID_REQUEST → 一次退避都不做，整轮失败 |
 * | 流中途被上游掐断 | SSE `data:{"error":{"message":"The response stream was interrupted…"}}` | 共享消费器可能归成不可重试错误 |
 *
 * 第三条的修法与参考插件一致：**只在「流已经吐过内容、且还没见到终止帧」时**
 * 把错误改写成 `TRANSPORT`（可重试），原文（含 `request_id`）保留在消息里。
 *
 * @module scnet-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { withQueueAccountRotation } from './queue-rotation.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'
import {
  isScnetExpired,
  scnetApiKeyOf,
  scnetChatHeaders,
  type ScnetCredential,
} from './scnet.js'
import { SCNET, SCNET_FALLBACK_MODELS, type ScnetProduct } from './scnet-product.js'
import { loadScnetModels, type ScnetModelEntry } from './scnet-catalog.js'

/** 本适配器注册的 provider 路由名（等价于 `SCNET.id`，即 `scnet-ofm`）。 */
export const PROVIDER = 'scnet-ofm'

/** 思考档位 id → 中文展示名（与其余渠道同一套命名）。 */
const SCNET_EFFORT_NAMES: Readonly<Record<string, string>> = {
  none: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

/** 选项：由 `index.ts` 注入账号池与凭据解析。 */
export interface ScnetAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析本轮该用哪个账号的凭据；`modelId` 必须透传给账号池（模型级限流）。 */
  resolveCredential: (modelId?: string) => Promise<ScnetCredential | undefined>
  /** 凭据失效时的处理（SCNet 可以静默重换 Key）。 */
  refresh: (accountId?: string, reason?: 'auth') => Promise<ScnetCredential | void>
  /** 换号重试。 */
  nextAccount?: (
    modelId: string,
    tried: ReadonlySet<string>,
  ) => Promise<{ accountId: string; credential: ScnetCredential } | undefined>
  /** 拉取远端模型目录（客户端目录 / 网关名单）；失败时回退兜底表。 */
  fetchRemoteModels?: () => Promise<ScnetModelEntry[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link SCNET}。 */
  product?: ScnetProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** SCNet 模型适配器。 */
export class ScnetAdapter extends LlmAdapter {
  private readonly product: ScnetProduct
  private readonly fetchImpl: typeof fetch
  /** 远端模型缓存（真实目录，不含兜底表）。 */
  private remoteModels: ScnetModelEntry[] | undefined
  /** 目录加载闸门：并发去重 + 失败/空结果冷却。 */
  private readonly catalogGate = new RemoteCatalogGate()

  constructor(private readonly options: ScnetAdapterOptions) {
    super()
    this.product = options.product ?? SCNET
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** 描述本适配器拥有的 provider 路由。 */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /** 完整目录（**不套黑名单**），设置页需要它渲染被关闭的模型。 */
  listAllModels(): readonly { id: string; name: string }[] {
    const models = this.remoteModels ?? fallbackModels(this.product)
    return models.map((model) => ({ id: model.id, name: model.name }))
  }

  /**
   * 取远端模型目录；**失败时不把兜底表写进缓存**。
   *
   * 把兜底表当成「已加载」记下，会让一次瞬时失败让该 provider 整个进程生命周期
   * 只剩兜底模型（用户看不到自己的模型，且无从触发重试）。
   */
  private async loadModels(): Promise<ScnetModelEntry[]> {
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
    return fallbackModels(this.product)
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider 分组隐藏。
    // **必须返回空数组而不能抛错**（抛错会被归入 catalog 的 failures，界面上反而多一条报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []
    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: model.supportsImage ? ['text', 'image'] : ['text'],
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = SCNET_FALLBACK_MODELS[0]!
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: entry?.supportsImage === true ? ['text', 'image'] : ['text'],
    }
    /**
     * ⚠️ 上下文必须放进 **`context.contextWindow`**，不是顶层 `contextWindow` ——
     * `LlmResolvedModelInfo` 上根本没有 `contextWindow` 字段，写错了会被静默忽略。
     * 真实后果（用户报障）：切换模型时报
     * `no context capacity for scnet-ofm/SCNet-Max; configure contextWindow on
     * that adapter model`，上下文压缩直接失败，模型根本切换不过去。
     */
    const contextWindow = entry?.contextWindow ?? fallback.contextWindow
    if (contextWindow > 0) resolved.context = { contextWindow }
    /** 同理：输出上限的字段名是 `defaultMaxTokens`（不是 `maxOutputTokens`）。 */
    const maxTokens = Math.min(entry?.maxTokens ?? fallback.maxTokens, contextWindow)
    if (maxTokens > 0) resolved.defaultMaxTokens = maxTokens
    if (entry?.supportsThinking === true && entry.efforts !== undefined && entry.efforts.length > 0) {
      const efforts = entry.efforts
      // 默认档必须落在 efforts 内：DSH 会直接拿它发请求，给不存在的档位会抛
      // UNSUPPORTED_REASONING_EFFORT，比不给更糟。
      const defaultEffort = entry.defaultEffort !== undefined && efforts.includes(entry.defaultEffort)
        ? entry.defaultEffort
        : efforts.includes('high') ? 'high' : efforts[0]!
      resolved.reasoning = {
        efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: SCNET_EFFORT_NAMES[id] ?? id })),
        ...(efforts.includes(defaultEffort) ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {}),
      }
    }
    return resolved
  }

  /**
   * 流式生成。
   *
   * 结构照抄已验证的 loomy 适配器（换号、401 刷新重发、quota 换号），
   * 差异只有 SCNet 自己的错误归一化与 `max_tokens` 拼写。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    /**
     * 图片附件 → data URL（与其余渠道同一套桥接）。
     *
     * ⚠️ `collectImages` 的入参是**消息的 content 块数组**，不是消息数组 ——
     * 直接把 `options.messages` 传进去时每个元素都是 `{role, content}`，
     * `block.type === 'image'` 永远不命中，于是 `imageRefs` 恒空、图片被静默丢弃
     * （真实反馈：「我贴了图，模型说没收到图像内容」）。必须逐条消息取 content。
     */
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const allModels = await this.loadModels()
    const entryForImage = allModels.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      // 能力按**模型**判定：DSH 依适配器播报的 inputModalities 决定是否把图片投影
      // 成文本占位符 —— 声明支持就必须真支持，不能放宽成「总是接受」。
      if (entryForImage?.supportsImage !== true) {
        throw new LlmError(`scnet: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('scnet: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但字节读取失败时，空 Map
      // 仍会让 userContentParts 产出 [image unavailable] 占位符，而不是静默消失。
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 取凭据（过期则先尝试续期）
    let credential = await this.options.resolveCredential(options.model)
    let accountId = credential === undefined ? undefined
      : await this.options.accountPool?.findAccountIdByCredential(this.product.id, scnetApiKeyOf(credential) ?? '')
    if (credential === undefined || isScnetExpired(credential) || scnetApiKeyOf(credential) === undefined) {
      credential = await this.options.refresh(accountId || undefined)
        ?? await this.options.resolveCredential(options.model)
    }
    let apiKey = scnetApiKeyOf(credential)
    if (credential === undefined || apiKey === undefined) {
      throw new LlmError('scnet: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    const messages = serializeMessages(options.messages, imageUrls)
    const wireMessages = options.system !== undefined && options.system.length > 0
      ? [{ role: 'system', content: options.system }, ...messages]
      : messages

    // 2. 思考档位：仅当该模型确实声明了它、且档位在其列表内时才下发。
    const modelEntry = entryForImage
    const effort = options.reasoningEffort !== undefined
      && modelEntry?.efforts !== undefined
      && modelEntry.efforts.includes(options.reasoningEffort)
      ? options.reasoningEffort
      : undefined

    const buildBody = (): string => JSON.stringify({
      model: options.model,
      messages: wireMessages,
      stream: true,
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop }),
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
      ...(options.tools === undefined || options.tools.length === 0
        ? {}
        : {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...(tool.description.length > 0 ? { description: tool.description } : {}),
                ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
              },
            })),
          }),
    })

    const send = async (key: string): Promise<Response> => {
      try {
        return await this.fetchImpl(`${String(credential?.baseUrl ?? this.product.apiBase).replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: scnetChatHeaders(key),
          body: buildBody(),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `scnet: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    const tried = new Set<string>()
    /** 同一请求体是否已经用过「`400 + 10013` 一次性自愈」（见模块头）。 */
    let healedInvalidRequest = false

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (accountId !== undefined) tried.add(accountId)
      let emitted = false
      try {
        let response = await send(apiKey)
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel()
          credential = await this.options.refresh(accountId || undefined, 'auth')
            ?? await this.options.resolveCredential(options.model)
          const renewedKey = scnetApiKeyOf(credential)
          if (renewedKey === undefined) {
            throw new LlmError('scnet: credential expired and refresh failed', 'AUTH', { status: response.status })
          }
          apiKey = renewedKey
          response = await send(apiKey)
        }
        if (!response.ok) {
          const errorText = await response.text().catch(() => '')
          const status = response.status
          const detail = errorDetail(errorText)
          /**
           * `400 + 10013`（平台「参数非法」）偶尔被用来包装瞬时抖动：
           * 同一请求体第一次遇到时按可重试处理（抛 `SERVER`），第二次仍报就原样
           * 失败（说明确实是参数问题），不会拖成 5 次无用重试。
           */
          if (status === 400 && /\b10013\b/.test(errorText) && !healedInvalidRequest) {
            healedInvalidRequest = true
            throw new LlmError(
              `scnet: 上游瞬时拒绝（code=10013），已自动重试一次：${detail}`,
              'SERVER',
              { status },
            )
          }
          throw new LlmError(`scnet: ${detail}`, httpErrorCode(status), { status })
        }

        const reader = consumeOpenAiSse(response, { signal: options.signal }, {
          label: 'scnet',
          firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
          chunkTimeoutMs: resolveChunkTimeoutMs(),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        })
        let sawContent = false
        try {
          for await (const chunk of reader) {
            emitted = true
            sawContent = true
            yield chunk
          }
        } catch (error) {
          /**
           * 流中途被上游掐断：`data:{"error":{"message":"The response stream was interrupted…"}}`。
           *
           * 共享消费器对这句原文没有可匹配的特征，会落到不可重试的兜底错误；这里
           * 在**已经吐过内容**的前提下把它归回 `TRANSPORT`（原文保留），让 DSH 的
           * 退避重试接管 —— 与参考插件的 SSE 层改写等价。
           */
          if (error instanceof LlmError && sawContent && /response stream was interrupted/i.test(error.message)) {
            throw new LlmError(
              `scnet: stream ended before completion (${error.message})`,
              'TRANSPORT',
              { cause: error },
            )
          }
          throw error
        }
        return
      } catch (error) {
        if (options.signal?.aborted || !(error instanceof LlmError) || error.code !== 'QUOTA_EXCEEDED') throw error
        if (accountId !== undefined) {
          await this.options.accountPool?.updateModelRateLimit(accountId, options.model, nextUtc8DayStartMs())
        }
        if (emitted || attempt === 2 || this.options.nextAccount === undefined) throw error
        const next = await this.options.nextAccount(options.model, tried)
        if (next === undefined || tried.has(next.accountId)) throw error
        accountId = next.accountId
        credential = next.credential
        const nextKey = scnetApiKeyOf(credential)
        if (nextKey === undefined) throw error
        apiKey = nextKey
        if (isScnetExpired(credential)) {
          const refreshed = await this.options.refresh(accountId)
          const refreshedKey = scnetApiKeyOf(refreshed ?? undefined)
          if (refreshedKey !== undefined) {
            credential = refreshed as ScnetCredential
            apiKey = refreshedKey
          }
        }
      }
    }
  }
}

/** 兜底模型表 → 归一后的条目。 */
function fallbackModels(product: ScnetProduct): ScnetModelEntry[] {
  return product.fallbackModels.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImage: model.supportsImage === true,
    supportsThinking: (model.efforts?.length ?? 0) > 0,
    ...(model.efforts === undefined ? {} : { efforts: model.efforts }),
    ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
  }))
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_SCNET_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_SCNET_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/**
 * 在 `ctx.llm` 上注册 SCNet provider 路由与适配器。
 *
 * 返回适配器实例：Channel Pack「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。
 */
export function registerScnetLlm(ctx: Context, options: ScnetAdapterOptions): ScnetAdapter {
  const product = options.product ?? SCNET
  const adapter = withQueueAccountRotation(product.id, options, scoped => new ScnetAdapter(scoped))
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}