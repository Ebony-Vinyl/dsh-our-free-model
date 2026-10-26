/**
 * Cline LLM 适配器。
 *
 * ## 与既有 provider 的差异
 *
 * Cline 的推理端点是**标准 OpenAI 兼容**的
 * （`POST {apiBase}/api/v1/chat/completions`，实测标准 SSE），
 * 故 OpenAI 协议层（消息序列化 / SSE 消费 / 错误归类）**完全复用**
 * `src/openai-compat.ts` —— 与 Qoder 同做法。
 *
 * 差异只有三处：
 *
 * 1. **鉴权头是 `Bearer workos:<jwt>`**（前缀不可剥，见 `src/cline.ts`）；
 * 2. **思考字段是 `delta.reasoning`**（不是 `delta.reasoning_content`）——
 *    已由 `consumeOpenAiSse` 同时兼容；
 * 3. **模型目录来自两个端点**（`recommended-models` 给 free 集合、
 *    `/models` 给全量 id），见 `src/cline-models.ts`。
 *
 * ## 免费标注
 *
 * 免费模型在 `name` 里拼 ` · 免费`。⚠️ **必须写进 `name` 而非 `description`**：
 * composer 的模型切换菜单只渲染 `name`（`dsh-client-ui-model-selection` 的
 * ModelSelect 里只有 `title: model.name` 与 `children: model.name`）。
 * 这是被用户报障纠正过的结论。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import {
  clineExhaustedAdvice,
  clineRateLimitResetAt,
  parseClineRateLimitHint,
  recordsClineRateLimit,
} from './cline-rate-limit.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { settingsNamespaceFor } from './settings-compat.js'
import { isClineExpired, clineHeaders, type ClineCredential } from './cline.js'
import {
  clineDisplayName,
  hasClineRemoteModels,
  loadClineModels,
  type ClineModel,
  type ClineRemoteModels,
} from './cline-models.js'
import {
  CLINE,
  CLINE_CHAT_PATH,
  CLINE_DEFAULT_REASONING_EFFORT,
  CLINE_REASONING_EFFORTS,
  type ClineProduct,
} from './cline-product.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
import { applyModelsDevCatalog, makeClineModelsDevLoader, type ClineModelsDevEntry } from './cline-models-dev.js'
import { parseClineRouting } from './cline-routing.js'
import { recordClineRequest } from './cline-request-log.js'
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

/** 本适配器注册的 provider 路由名（等价于 `CLINE.id`）。 */
export const PROVIDER = 'cline'

const CLINE_MAX_ROTATE = 3

/**
 * 单次请求输出上限的安全边界。
 *
 * ⚠️ 与 TRAE 的 `clampTraeMaxTokens` 同因：上游网关对超大 `max_tokens`
 * 会直接 4xx，而 DSH 可能注入一个来自其它 provider 的大值。
 * Cline 内嵌目录里最大的 `maxTokens` 是 **943718**
 * （`muse-spark-1.3-contributor`），故上界取它 —— 不自行编造更大的值。
 */
const CLINE_MAX_OUTPUT_TOKENS = 943_718

/** 收敛输出上限到安全区间；非法值返回 undefined（不编造）。 */
function clampClineMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const integer = Math.floor(value)
  if (integer <= 0) return undefined
  return Math.min(integer, CLINE_MAX_OUTPUT_TOKENS)
}

/**
 * 清洗工具参数 schema 里的 `enum`（递归）。
 *
 * ## 为什么必须清洗（实测 400，用户报障 2026-09-25）
 *
 * harness 下发的工具集里，某些参数的 `enum` 含**空字符串**成员。Gemini 系模型
 * （经 `google` / `vertex` provider）对此**严格校验**，直接拒绝整个请求：
 *
 * ```
 * GenerateContentRequest.tools[0].function_declarations[34]
 *   .parameters.properties[permission].enum[3]: cannot be empty
 * ```
 *
 * ⚠️ 该错误**只在部分 provider 上暴露**：上游一次请求会依次尝试多个 provider，
 * 实测命中 vertex 时报「maxOutputTokens 越界」、命中 google 时报上述 enum 错误。
 * 两者是**两个独立根因**，都要修，否则路由一漂移就复发。
 *
 * ⚠️ 本适配器**从不自己造 enum** —— `stream()` 原样透传
 * `options.tools[].parameters`，故脏数据来自上游 harness。但请求是我们发的，
 * 只能在我们这一侧拦住。
 *
 * ## 三条边界（都要守）
 *
 * - **只删空字符串**（含纯空白），其余成员原样保留 —— `enum` 可能是数字/布尔
 *   数组，按「只留字符串」过滤会把合法的数值枚举整段丢掉；
 * - 过滤后为空则**整个 `enum` 键丢弃**（空 `enum` 同样非法），而非留下 `[]`；
 * - **递归下钻**：`properties` / `items` 等嵌套层里的 `enum` 同罪。
 */
export function sanitizeClineToolParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeClineToolParameters)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'enum' && Array.isArray(raw)) {
      const cleaned = raw.filter((item) => !(typeof item === 'string' && item.trim().length === 0))
      if (cleaned.length > 0) out[key] = cleaned
      continue
    }
    out[key] = sanitizeClineToolParameters(raw)
  }
  return out
}

/**
 * SSE 空闲超时（毫秒）。
 *
 * 分两阶段：等待首 token 的窗口与两次 chunk 之间的最大静默，均可用环境变量
 * 覆盖（便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取**
 * —— 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，
 * adapter 的 generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_CLINE_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_CLINE_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** `ClineAdapter` 的构造选项。 */
export interface ClineAdapterOptions {
  /** 默认凭据 ref（仅用于类型/日志，实际解析走 `resolveCredential`）。 */
  credentialRef: CredentialRef
  /** 从凭据存储解析凭据。 */
  resolveCredential: (modelId?: string) => Promise<ClineCredential | undefined>
  /** 静默续期凭据。 */
  refresh: () => Promise<void>
  /** 多账号池（用于限流时切换账号与模型黑名单）。 */
  accountPool?: AccountPool
  /**
   * 「本次实际使用的是哪个**账号池账号**」（池 id，如 `cline-bb211a53`）。
   *
   * ⚠️ **请求记录的「账号」列必须用池 id，不能用凭据里的 `account_id`**：
   * 面板拿 `cline.quota` 下发的**池 id** 去过滤记录，两个 id 空间不一致时
   * 过滤恒为空 → 表格**永远空白**（真实缺陷，用户报障「请求记录中数据空白」）。
   *
   * ⚠️ 回调**只用于首次确定起点**（与 `QoderAdapterOptions.currentAccountId` 同因）：
   * 它返回「池当前会给出的那个账号」，适配器内部换号后**不会跟着变**，
   * 故换号后必须用局部变量跟进。
   */
  currentAccountId?: () => string | undefined
  /**
   * 读取图片附件的原始字节（内联为 data URL 用）。
   *
   * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
   * `UNSUPPORTED_CONTENT`（而不是静默丢弃）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /**
   * 读取图片附件的**请求版本**（按像素预算与字节目标缩放后的字节）。
   *
   * ⚠️ 与 {@link readImage} 的错误契约**相反**：不可用时必须返回 `undefined`
   * 而不是抛错。判据与回退都在共享的 `projectRequestImage` 里。
   */
  readImageRequest?: (
    attachment: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link CLINE}。 */
  product?: ClineProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 模型目录加载器覆盖（测试用）。
   *
   * 默认走 `loadClineModels`（两次远端请求）。注入后单测可完全离线。
   */
  loadModels?: (options: { credential?: ClineCredential }) => Promise<{
    models: ClineModel[]
    warnings: string[]
    /**
     * 远端原始结果（判「这次到底拿到目录没有」用）。
     *
     * ⚠ 注入式加载器（单测）可以不传：此时退回用 `models.length > 0` 判断，
     * 而默认的 `loadClineModels` **一定**会传（因为 `models` 里永远并着兜底表，
     * 用长度判断是死代码 —— 见 `hasClineRemoteModels` 的注释）。
     */
    remote?: ClineRemoteModels
  }>
  /**
   * models.dev 目录加载器覆盖（测试用）。
   *
   * 默认走 `makeClineModelsDevLoader`（拉 models.dev，带 TTL 缓存）。
   * 它同时补**名字/上下文窗口/图片能力**，见 `src/cline-models-dev.ts`。
   * ⚠️ 注入后单测可完全离线 —— 与 `loadModels` 同款理由。
   */
  loadModelsDev?: () => Promise<Map<string, ClineModelsDevEntry>>
}

/**
 * Cline 模型适配器。
 *
 * 使用 `Bearer workos:<jwt>` 鉴权，仅支持 SSE（与官方客户端一致）。
 */
export class ClineAdapter extends LlmAdapter {
  private readonly product: ClineProduct
  private readonly fetchImpl: typeof fetch
  /** 远端模型目录缓存（首次成功后填充）。 */
  private remoteModels: ClineModel[] | undefined
  /** 正在进行中的目录加载（避免并发重复请求）。 */
  private loading: Promise<void> | undefined
  /**
   * models.dev 目录（`模型 id → 条目`，含名字/窗口/图片能力）。
   *
   * ⚠️ `undefined` = **还没读到**（不是「空目录」）：读不到时目录照常工作，
   * 只是少了它补的那几条。这条区分是整个模块的要点 ——
   * 把「没读到」当「不支持」正是「支持图片的模型发不了图」那个缺陷的形态。
   */
  private modelsDev: Map<string, ClineModelsDevEntry> | undefined
  /** 正在进行中的 models.dev 加载（并发去重）。 */
  private modelsDevLoading: Promise<void> | undefined
  /** models.dev 加载器。 */
  private readonly loadModelsDev: () => Promise<Map<string, ClineModelsDevEntry>>

  /**
   * 目录加载闸门：并发去重 + 失败/空结果冷却。
   *
   * 此前这里只有 in-flight 去重（`private loading`），失败后立刻允许重试 ⇒
   * `buildModelCatalog` 的「每模型一次 resolveModel」会把一次失败放大成 N 次。
   * 详见 `src/remote-catalog-gate.ts` 的实测依据。
   */
  private readonly catalogGate = new RemoteCatalogGate()

  constructor(private readonly options: ClineAdapterOptions) {
    super()
    this.product = options.product ?? CLINE
    this.fetchImpl = options.fetchImpl ?? fetch
    this.loadModelsDev = options.loadModelsDev ?? makeClineModelsDevLoader({ fetcher: this.fetchImpl })
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

  /**
   * 模型接受的输入模态。
   *
   * 两级判据（**顺序不能颠倒**）：
   * 判据是**目录条目上的 `supportsImage`**，而它有两个来源（优先级即顺序）：
   * 1. **本地兜底表/内嵌目录**（`product.fallbackModels` 的策展条目）——
   *    从官方客户端内嵌目录提取的，比社区目录权威；显式 `false` 也照样赢。
   * 2. **models.dev**（`src/cline-models-dev.ts` 补进目录）—— 补前者覆盖不到的
   *    模型（`cline-pass/*` 等）。
   *
   * ⚠️ **这是「支持图片的模型发不了图」的修复点**：修复前只看第 1 级，而它
   * 全表只有寥寥几条 `cline-free/*` 条目 ⇒ `cline-pass/*` 等**全部**被播报成
   * 纯文本 ⇒ DSH 根本不把图片送进来。详见 `src/cline-models-dev.ts`。
   *
   * ⚠️ 没有结论时保守报 `text`（宁可少报能力，也不要报一个服务端不认的模态）
   * —— 注意这与「明确读到不支持」是两回事，但外部行为一致。
   */
  private inputModalitiesFor(model: string): readonly ('text' | 'image')[] {
    const entry = this.remoteModels?.find((candidate) => candidate.id === model)
    return entry?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  /**
   * 懒加载远端模型目录。
   *
   * `resolveModel` 可能先于 `listModels` 被调用（如直接进入会话），
   * 此时同样触发远端拉取。
   *
   * ⚠️ **并发去重**：`listModels` 与 `resolveModel` 会在启动时被 DSH 并发调用，
   * 不去重会打出多份重复的远端请求（两个端点各一次，乘以并发数）。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined) return
    await this.catalogGate.run(async () => {
      try {
        // 目录加载路径**没有**目标模型（它要一次列出全部模型），故不传 modelId：
        // 空串在 `getAvailableAccount` 里是「不按模型过滤」的合法语义，正是这里要的。
        const credential = await this.options.resolveCredential()
        const load = this.options.loadModels ?? ((opts: { credential?: ClineCredential }) =>
          loadClineModels(this.product, {
            ...opts.credential === undefined ? {} : { credential: opts.credential },
            fetcher: this.fetchImpl,
          }))
        const { models, warnings, remote } = await load({
          ...credential === undefined ? {} : { credential },
        })
        // ⚠ **不能**用 `models.length === 0` 判断「没拿到目录」：`mergeClineModels`
        // 会无条件把兜底表并进 `models`（展示需要），实测两个端点全挂时它仍是 5 条
        // ⇒ 旧判据是死代码，冷却永不触发、兜底被永久当成远端结果缓存。
        const gotRemote = remote !== undefined
          ? hasClineRemoteModels(remote)
          : models.length > 0
        let merged = models
        if (models.length > 0) {
          // ⚠️ **models.dev 是目录的第三个来源**（补缺的模型 + 可读名 + 上下文
          // 窗口 + 图片能力），必须在这里合并 —— 合并进目录后，
          // `inputModalitiesFor` 只看目录条目就够了（见其注释）。
          // 它失败不影响目录本身（只记日志）。
          merged = applyModelsDevCatalog(models, await this.ensureModelsDev())
        }
        // 目录部分失败时留下日志：静默降级会让用户看到「少了模型」却无从排查
        // （两个端点独立容错，故这里只记 warning 不抛错）。
        for (const warning of warnings) {
          // eslint-disable-next-line no-console
          console.warn(`[cline] 模型目录来源失败：${warning}`)
        }
        if (!gotRemote) return false
        this.remoteModels = merged
        return true
        return true
      } catch (error) {
        // 拉取失败保持未定义，后续 listModels/resolveModel 仍回退静态兜底表。
        // eslint-disable-next-line no-console
        console.warn(`[cline] 模型目录拉取失败：${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    })
  }

  /**
   * 懒加载 models.dev 目录，并发去重。
   *
   * ⚠️ **失败只记日志、返回空表**：拿不到就相当于「这一层没有补充」，
   * 目录与图片能力都退回本地兜底表；下一次调用会重试（`TtlCache` 不缓存失败）。
   * 它是**补充**信息，不能因为一次抖动就让整个 provider 不可用。
   *
   * @returns 读到的条目；失败返回空 Map（调用方无需区分）。
   */
  private async ensureModelsDev(): Promise<Map<string, ClineModelsDevEntry>> {
    if (this.modelsDev !== undefined) return this.modelsDev
    if (this.modelsDevLoading !== undefined) {
      await this.modelsDevLoading
      return this.modelsDev ?? new Map()
    }
    this.modelsDevLoading = (async () => {
      try {
        this.modelsDev = await this.loadModelsDev()
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[cline] models.dev 目录拉取失败（缺的模型与图片能力退回本地兜底表）：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        this.modelsDevLoading = undefined
      }
    })()
    await this.modelsDevLoading
    return this.modelsDev ?? new Map()
  }

  /** 兜底目录（远端不可用时的静态表，含 5 个免费模型）。 */
  private fallbackCatalog(): ClineModel[] {
    return this.product.fallbackModels.map((model) => ({
      id: model.id,
      name: model.name,
      isFree: model.isFree === true,
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.supportsImage === undefined ? {} : { supportsImage: model.supportsImage },
      ...model.description === undefined ? {} : { description: model.description },
    }))
  }

  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（免费标记）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
   *
   * ⚠️ 本方法是**同步**的（与 RPC 层 `ModelCatalogSource` 契约一致），
   * 故它只能读已缓存的目录。首次调用若缓存为空会触发一次**后台**加载，
   * 由下一次调用（或 DSH 的目录刷新）拿到结果 —— 而 `model.list` 端点
   * 之前一定会先走 `ctx.llm.listModels()`（那会 await 加载完成），
   * 故实际使用中不会读到空目录。
   */
  listAllModels(): readonly { id: string; name: string; isFree: boolean }[] {
    const source = this.remoteModels ?? this.fallbackCatalog()
    if (this.remoteModels === undefined) void this.ensureRemoteModels()
    // ⚠️ 必须带上 `isFree`：Channel Pack 的模型列表要按「计费/来源」分组
    // （订阅 / 免费 / Cloud / 按量计费），而**免费集合是远端动态下发的**
    // （见 `cline-models.ts` 的并集规则）—— 让客户端按前缀猜会漂移。
    return source.map((model) => ({ id: model.id, name: clineDisplayName(model), isFree: model.isFree }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 没有任何已登录账号时返回空数组 → DSH 的 `buildModelCatalog` 把整个
    // provider 分组隐藏（它显式 `.filter(group => group.models.length > 0)`）。
    // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`，
    // 界面上反而多出一条 provider 报错）。
    //
    // ⚠️ 门控放在 `ensureRemoteModels()` **之前**：没有已登录账号时连远端目录都
    // 不必拉。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []
    // 必须 await：冷缓存时目录尚未落地就返回，模型选择器会短暂显示错误的
    // 模型集合（Channel Pack 的模型开关也据此渲染）。
    // ⚠️ 目录里**已经**并入 models.dev（补缺的模型 / 可读名 / 图片能力），
    // 故这里不需要再单独 await 一次模态表。
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? this.fallbackCatalog()
    // 用户在 Channel Pack 关闭的模型（黑名单制：不在表里即默认打开）。
    // 只影响此处对外播报的模型目录，不改变 resolveModel/stream 的路由能力
    // ——与 DSH 对 listModels 的约定一致（目录是建议性的，缺省不构成拒绝）。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 免费标记拼进 `name`（**不是** `description`）：composer 的模型切换菜单
      // 只渲染 name，description 仅用于 /model 弹窗。
      name: clineDisplayName(model),
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: this.inputModalitiesFor(model.id),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // 目录里已并入 models.dev（名字 / 窗口 / 图片能力），故 `inputModalities`
    // 与展示名在这一次 await 之后就都是最终值。
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? this.fallbackCatalog()
    const entry = source.find((candidate) => candidate.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      // ⚠️ `resolveModel` 的 `name` **不带**免费标记（与 Qoder/TRAE 一致）：
      // 标记只属于「选择列表」语境；会话记录里带上它会污染历史展示。
      name: entry?.name ?? model,
      inputModalities: this.inputModalitiesFor(model),
    }
    // 上下文窗口：远端/兜底表已知时才声明（未知时不编造，让 DSH 用默认值）。
    if (entry?.contextWindow !== undefined) resolved.context = { contextWindow: entry.contextWindow }
    // 单次输出上限：必须声明为 `defaultMaxTokens`，否则 DSH 只在调用方显式
    // 给值时才下发 `max_tokens`，上限永久退回网关默认值

    const maxTokens = clampClineMaxTokens(entry?.maxTokens)
    if (maxTokens !== undefined) resolved.defaultMaxTokens = maxTokens
    // 思考档位：对**所有**模型统一声明（远端不下发档位，见产品配置注释）。
    // 这是 composer 里「思考强度」选择器的唯一入口 —— 不声明则 UI 显示
    // 「当前模型未提供推理等级」。
    resolved.reasoning = {
      efforts: CLINE_REASONING_EFFORTS.map((effort) => ({
        id: ReasoningEffortId(effort.id),
        name: effort.name,
      })),
      defaultEffort: ReasoningEffortId(CLINE_DEFAULT_REASONING_EFFORT),
    }
    return resolved
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
    // 图片能力按**模型**判定（内嵌目录 capabilities）。
    //
    // 这里**不能**放宽成「总是接受」：DSH 在 LlmRuntime 里按适配器播报的
    // `inputModalities` 决定要不要把图片投影成文本占位符，声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      // ⚠️ 判定能力之前先把**目录**读进来（`resolveModel` 通常已 await 过，
      // 这里命中缓存、不发请求）；`stream()` 也可能被直接调用而没有前置
      // `resolveModel`，缺了这一步会把支持图片的模型误判成纯文本
      // —— 那正是「支持图片的模型发不了图」的形态。
      await this.ensureRemoteModels()
      if (!this.inputModalitiesFor(options.model).includes('image')) {
        throw new LlmError(
          `cline: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('cline: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        // ⚠️ 先试**请求版本**（缩放），拿不到才发原图。
        // ⚠️ 先试**请求版本**（缩放），拿不到才发原图。
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

    // 1. 获取凭据（过期则先静默续期）
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isClineExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('cline: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 构造 OpenAI 请求体（复用共享序列化，含 0.1.7 消息形状归一化）
    const messages = serializeMessages(options.messages, imageUrls)
    const bodyObj: Record<string, unknown> = {
      model: options.model,
      messages: options.system !== undefined && options.system.length > 0
        ? [{ role: 'system', content: options.system }, ...messages]
        : messages,
      stream: true,
    }
    if (options.tools !== undefined && options.tools.length > 0) {
      bodyObj.tools = options.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          // ⚠️ parameters 必须清洗后再下发：harness 的工具 schema 里可能带
          // 空串 `enum` 成员，Gemini 系会直接 400（见 sanitizeClineToolParameters）。
          parameters: sanitizeClineToolParameters(tool.parameters),
        },
      }))
    }
    if (options.temperature !== undefined) bodyObj.temperature = options.temperature
    const maxTokens = clampClineMaxTokens(options.maxTokens)
    if (maxTokens !== undefined) bodyObj.max_tokens = maxTokens
    if (options.stop !== undefined && options.stop.length > 0) bodyObj.stop = options.stop
    // 推理强度：DSH 注入的 `reasoningEffort` 原样透传给上游的 `reasoning_effort`。
    //
    // ⚠️ **这里绝不能加白名单校验**。档位表（`CLINE_REASONING_EFFORTS`）是客户端
    // 内嵌目录的快照，会随 Cline 版本变化；校验等于把上游新增的档位静默丢弃。
    // 且上游对**完全不认识**的档位也只是静默忽略 —— 实测
    // `reasoning_effort: 'banana'` 返回 HTTP 200、思考量为 0，**不报错**，
    // 故白名单既无必要也无收益。
    if (options.reasoningEffort !== undefined) {
      bodyObj.reasoning_effort = options.reasoningEffort
    }

    const body = JSON.stringify(bodyObj)

    // 计时起点:**首次发起请求**的时刻(图片读取/凭据解析不算 —— 那是本地开销,
    // 记录的是「这笔请求等了多久」,与参考实现的 startedAt 同口径)。
    const startedAt = Date.now()

    // 3. 发送请求（401/403 时刷新一次凭据后重试）
    //
    // ⚠️ **403 必须先排除「地域限制」**：它与凭据无关，续期在这里永远无用，
    // 且最终会被归成 AUTH（UI 显示「API 密钥无效」），真实原因彻底丢失。
    // 命中时直接抛出带真实原因的错误（见 isClineRegionForbidden）。
    // ⚠️ 用**账号池 id** 起步，**不是**凭据里的 `account_id`（`usr-…`）：
    // 面板用 `cline.quota` 下发的池 id 过滤请求记录，用错 id 空间会让表格
    // **永远空白**（真实缺陷，用户报障「请求记录中数据空白」）。
    // ⚠️ 回调只用于**首次**确定起点，换号后由下面的局部变量跟进（与 Qoder 同因）。
    let currentAccountId = this.options.currentAccountId?.() ?? ''
    let response = await this.send(credential, body, options)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      const forbiddenText = await response.text().catch(() => '')
      if (isClineRegionForbidden(response.status, forbiddenText)) {
        throw new LlmError(
          `cline: ${errorDetail(forbiddenText)}`,
          'PERMISSION_DENIED',
          { status: response.status },
        )
      }
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential(options.model)
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('cline: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await this.send(credential, body, options)
    }

    // 4. 非 2xx：限流时换号重试，其余如实报错。
    //

    // 账户级余额（`/balance`），余额耗尽属于 `hard-credit` 语义，
    // 也值得换号 —— 两者都用状态码 429 / 402 + 文案判定。
    if (!response.ok) {
      let errorText = await response.text().catch(() => '')
      const shouldRotate = isClineRotatableFailure(response.status, errorText)
      if (this.options.accountPool !== undefined && shouldRotate) {
        const tried = new Set<string>()
        if (currentAccountId.length > 0) tried.add(currentAccountId)
        const maxRotate = CLINE_MAX_ROTATE - 1
        // ⚠️ 不再拼「最后一次失败的原样信息」：它会把上游英文整句复述进最终错误，
        // 而 `clineExhaustedAdvice` 已把语义（限流 / 当日免费额度 / 额度耗尽）用
        // 中文说清 —— 两遍叠加会让消息变成其它 provider 的两三倍长
        // （用户 2026-10-03 报障「这个报告和其它的供应商比起来是不是太长了」）。
        // 上游原文只在**没识别出语义**时由那个函数附上（见 src/cline-rate-limit.ts）。
        /**
         * 记下「刚失败的那个账号被限流到什么时候」。
         *
         * ⚠️ 必须**在每次失败后**都调用（含循环结束后的最后一次）：原来的写法把
         * 标记放在**下一轮的开头**，于是「换号次数用尽而退出」时，**最后一个**
         * 账号永远不会被标记 —— 它下一次又会被 `getAvailableAccount` 选中、
         * 立刻再撞一次同样的墙（本机 cline 只有一个账号，故这条尤其致命）。
         */
        let markedAccountId = ''
        const markLimited = async (): Promise<void> => {
          if (currentAccountId.length === 0) return
          if (currentAccountId === markedAccountId) return
          if (!recordsClineRateLimit(response.status, errorText)) return
          markedAccountId = currentAccountId
          await this.options.accountPool?.updateModelRateLimit(
            currentAccountId,
            options.model,
            clineRateLimitResetAt(response, errorText, options.model),
          )
        }
        for (let round = 0; round < maxRotate; round++) {
          await markLimited()
          const next = await this.options.accountPool.getAvailableAccount(
            this.product.id, options.model, tried,
          )
          if (next === null || next === undefined || tried.has(next.entry.id)) break
          tried.add(next.entry.id)
          credential = next.credential as ClineCredential
          currentAccountId = next.entry.id
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeWithLog(response, options, {
              model: options.model,
              accountId: currentAccountId.length > 0 ? currentAccountId : (credential.account_id ?? ''),
              startedAt,
            })
            return
          }
          errorText = await response.text().catch(() => '')
          if (!isClineRotatableFailure(response.status, errorText)) break
        }
        // 循环退出前最后失败的那个账号（见 markLimited 的注释）。
        await markLimited()
        // 报文里能读到什么语义就说什么话：「当日免费额度」与「短时限流」的动作
        // 完全不同，而两者**都是 429**，只能靠文案区分（见 cline-rate-limit.ts）。
        const hint = parseClineRateLimitHint(errorText)
        const advice = clineExhaustedAdvice(
          response.status,
          hint,
          recordsClineRateLimit(response.status, errorText)
            ? clineRateLimitResetAt(response, errorText, options.model)
            : undefined,
        )
        // ⚠️ 文案要短（用户报障「比其它供应商长」）：前缀只说「哪个模型、账号都用完了」，
        // 其余全部交给 `clineExhaustedAdvice` —— 原始报文不再出现在这里。
        throw new LlmError(
          `cline: 模型 ${options.model} 的所有账号均不可用 —— ${advice}`,
          'QUOTA_EXCEEDED',
        )
      }
      throw new LlmError(
        `cline: ${errorDetail(errorText)}`,
        httpErrorCode(response.status),
        { status: response.status },
      )
    }

    // 5. 消费 SSE 流(并记录请求流水,见 consumeWithLog)
    yield* this.consumeWithLog(response, options, {
      model: options.model,
      // ⚠️ **池 id 优先**：面板按 `cline.quota` 的池 id 过滤记录，用凭据里的
      // `usr-…` 会让过滤恒空（表格永远空白）。只有**没有池账号**（回退到单凭据
      // ref 的模式）时才退回 `usr-…` —— 那种模式下 `cline.quota` 同样没有账号
      // 可翻页，记录查不到但至少不会张冠李戴。
      accountId: currentAccountId.length > 0 ? currentAccountId : (credential.account_id ?? ''),
      startedAt,
    })
  }

  /**
   * 消费 OpenAI 兼容 SSE 并**记录请求流水**（「订阅额度」面板的请求记录，
   * 见 `src/cline-request-log.ts`）。
   *
   * 记录字段对齐参考实现（`github.com/codeOct/dsh-cline-pass` 的请求记录部分）：
   * 总延迟、**首个内容块耗时（ttft）**、token 用量（含**思考 token** ——
   * 它是解释「为什么等了这么久才出字」的关键数字：这个网关不流式输出思考内容，
   * 思考量只出现在 usage 里）、失败原因。
   *
   * ⚠️ 与参考实现的**差异及理由**：
   * - 不记 `ttfb`（响应体首字节）：本适配器只有单一网关、无 upstream 路由，
   *   响应头到达与首块之间没有独立的「选路」阶段，展示位只剩两个 ——
   *   表格显示「首块 / 总延迟」两个数即可。
   * - 换号过程**不逐笔记**：只记**最终结果**一笔。参考实现会把 AUTH/QUOTA
   *   的每次 attempt 都记成失败行；本适配器的 429 换号风暴（最多 3 轮）
   *   会把 100 条上限刷满，而用户真正要看的是「这笔请求成了没、花了多少」，
   *   「所有账号均不可用」这行已包含换号语义。
   *
   * ⚠️ **失败也必须记**：失败的请求是排查「为什么没回复」的第一线索
   * （429 / 11140 安全策略 / 网络错误各是不同的原因）。记录本身绝不抛错
   * （`recordClineRequest` 已兜底），记账失败不得反噬推理。
   *
   * @param meta - `accountId` 是**最终服务的那笔**账号（换号后即最后一个）。
   */
  private async *consumeWithLog(
    response: Response,
    options: GenerateOptions,
    meta: { model: string; accountId: string; startedAt: number },
  ): AsyncIterable<StreamChunk> {
    /** 首个内容块耗时；0 表示还没有任何块到达。 */
    let ttftMs = 0
    /**
     * 首个**正文**块耗时；0 = 本次没有任何正文（纯思考/纯 usage 的响应）。
     *
     * ⚠️ 与 `ttftMs` 是**两个时刻**：Cline 会流式下发思考增量
     * （`delta.reasoning`），故「第一块」常常是思考块。展示层的「输出速率」
     * 必须让分子分母落在**正文阶段**（`outputTokens − reasoningTokens`
     * ÷ `totalMs − ttfcMs`），否则速率被无限放大 —— 用户报障的
     * `11814.8 t/s` 正是这样来的（见 `src/cline-request-log.ts` 的 `ttfcMs`）。
     */
    let ttfcMs = 0
    /**
     * usage 帧，**在它经过时捕获**：网关把它放在内容之后的最后一帧，
     * 流结束才记账的前提是「这块真的被读到了」—— 若调用方中途 abort、
     * 或上游提前断开，usage 帧可能永远没被消费到。此时**如实标为「未收到」**
     * （`usageReported: false`），由展示层显示 `—` 而不是 `0`
     * —— 0 会被读成「瞬间完成、没花 token」（参考实现同约定）。
     */
    let usage: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      reasoningTokens?: number
    } | undefined
    /**
     * 网关报告的**真实上游渠道**（`alibaba` / `baseten` / `GMICloud` …）。
     *
     * ⚠️ 逐帧观测、**最后一次非空为准**（参考实现注释：路由元数据出现在
     * 「携带它的那一帧」上）。读不到时留空串，展示层回落到模型命名空间
     * —— 「记录成模型前缀」正是用户报障的「上游显示不正确」，见
     * `src/cline-routing.ts`。
     */
    let upstream = ''
    const observeFrame = (frame: Record<string, unknown>): void => {
      const found = parseClineRouting(frame)
      if (found.length > 0) upstream = found
    }
    try {
      for await (const chunk of this.consume(response, options, observeFrame)) {
        if (ttftMs === 0) ttftMs = Date.now() - meta.startedAt
        // 正文块（文本 / 工具调用）才算「正文阶段」的起点：Cline 会先流式下发
        // 思考增量（`delta.reasoning`），把思考块当成正文会让速率的分子分母
        // 落在不同时间段（用户报障 11814.8 t/s 的根因）。
        if (ttfcMs === 0 && (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta')) {
          ttfcMs = Date.now() - meta.startedAt
        }
        if (chunk.type === 'usage' && typeof chunk.usage === 'object' && chunk.usage !== null) {
          usage = {
            inputTokens: Number(chunk.usage.inputTokens ?? 0) || 0,
            outputTokens: Number(chunk.usage.outputTokens ?? 0) || 0,
            // 缓存命中/思考量：有值才带（表格的 ⚡ / 🧠 两项据此出现）。
            ...(typeof chunk.usage.cacheReadTokens === 'number' && chunk.usage.cacheReadTokens > 0
              ? { cacheReadTokens: chunk.usage.cacheReadTokens }
              : {}),
            ...(typeof chunk.usage.reasoningTokens === 'number' && chunk.usage.reasoningTokens > 0
              ? { reasoningTokens: chunk.usage.reasoningTokens }
              : {}),
          }
        }
        yield chunk
      }
    } catch (error) {
      recordClineRequest({
        model: meta.model,
        accountId: meta.accountId,
        usageReported: usage !== undefined,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        // 推理强度：**DSH 注入的原值**（未指定时空串 ⇒ 记录里少一行 tooltip）。
        effort: options.reasoningEffort ?? '',
        upstream,
        ttftMs,
        ttfcMs,
        totalMs: Date.now() - meta.startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    recordClineRequest({
      model: meta.model,
      accountId: meta.accountId,
      usageReported: usage !== undefined,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      // 推理强度：**DSH 注入的原值**（未指定时空串 ⇒ 记录里少一行 tooltip）。
      effort: options.reasoningEffort ?? '',
      upstream,
      ttftMs,
      ttfcMs,
      totalMs: Date.now() - meta.startedAt,
    })
  }

  /** 消费 OpenAI 兼容 SSE（共享实现）。 */
  private consume(
    response: Response,
    options: GenerateOptions,
    onFrame?: (data: Record<string, unknown>) => void,
  ): AsyncIterable<StreamChunk> {
    return consumeOpenAiSse(response, { ...options.signal === undefined ? {} : { signal: options.signal } }, {
      label: 'cline',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      // 旁路观测网关路由元数据（真正服务这笔请求的上游渠道）。
      ...onFrame === undefined ? {} : { onFrame },
    })
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    credential: ClineCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.product.apiBase}${CLINE_CHAT_PATH}`, {
        method: 'POST',
        // ⚠️ 头里的 Authorization 必须是**带 workos: 前缀**的值
        //（见 src/cline.ts 的 clineBearerValue 注释）。
        headers: {
          ...clineHeaders(credential, this.product),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      if (isTransportError(error)) {
        throw new LlmError(
          `cline: transport error: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT',
          { cause: error as Error },
        )
      }
      throw error
    }
  }
}

/**
 * 该失败是否值得**换号重试**。
 *
 * ⚠️ 限流标记该写多长、以及给用户什么建议，都在 `src/cline-rate-limit.ts`
 * （那里有 Cline 专属的等待时长解析：它把时长写在**英文句子**里，
 * 既没有 `retry-after` 头、也没有绝对时刻）。
 */
export function isClineRotatableFailure(status: number, body: string): boolean {
  if (status === 429 || status === 402) return true
  const lower = body.toLowerCase()
  return CLINE_CREDIT_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * 额度/限流文案标记。
 *
 * 中英双通道：Cline 是国际产品，但用户账号可能是中文界面，
 * 且网关在不同层可能给出不同文案。
 */
export const CLINE_CREDIT_MARKERS: readonly string[] = [
  'insufficient', 'quota', 'rate limit', 'too many requests', 'balance',
  'credit', 'payment required', 'exceeded',
  '积分不足', '额度不足', '余额不足', '频率限制', '超出限制',
]

/**
 * 该失败是否是**与凭据无关的访问限制**（地域封锁 / 模型未开通）。
 *
 * ## 为什么必须单独识别（真实缺陷，用户报障 2026-09-25）
 *
 * Cline 对「该地区不可用」的模型返回 **403**，而 401/403 在本适配器里原本一律
 * 被当作「凭据过期」：触发续期 → 重试 → 仍 403 → 最终 `httpErrorCode(403)`
 * 归成 `AUTH` → DSH 渲染成「**API 密钥无效**」。
 *
 * 实测 `cline-free/muse-spark-1.3-contributor`：
 *
 * ```
 * 403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor
 *       is not available in your region","success":false}
 * ```
 *
 * 后果有两个：① 真实原因（地域限制）被完全掩盖，用户以为要去重新登录；
 * ② 每次请求都白跑一次续期（续期还会成功，所以不会提前报错，纯属浪费）。
 *
 * ⚠️ **不能按状态码一刀切**：同一批 403 里既有真的凭据问题，也有地域限制，
 * 只能靠**响应体文案**区分。认三种表述（上游措辞可能微调，故取特征词）：
 * `not available in your region` / `access forbidden` / `region not supported`。
 *
 * ⚠️ 命中时**跳过续期**，并让错误文案带出真实原因 —— 续期在这里永远无用，
 * 反而拖慢失败反馈。
 */
export function isClineRegionForbidden(status: number, body: string): boolean {
  if (status !== 403) return false
  const lower = body.toLowerCase()
  return CLINE_REGION_FORBIDDEN_MARKERS.some((marker) => lower.includes(marker))
}

/** 地域/访问限制文案标记（小写比对）。 */
const CLINE_REGION_FORBIDDEN_MARKERS: readonly string[] = [
  'not available in your region',
  'access forbidden',
  'region not supported',
  'not available in your country',
]

/**
 * 在 `ctx.llm` 上注册 Cline provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动，得到 `cline`。
 *
 * ⚠️ 刻意**不**向 DSH 声明可配置 provider（`registerConfigurableProviders`）——
 * 详见 `llm-register-compat.ts` 模块头。
 */
export function registerClineLlm(ctx: Context, options: ClineAdapterOptions): ClineAdapter {
  const product = options.product ?? CLINE
  const adapter = new ClineAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  // 返回实例：Channel Pack「显示列表」需要 `listAllModels()`（不受黑名单影响、
  // 带最终展示名）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
  return adapter
}
