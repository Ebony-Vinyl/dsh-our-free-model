import { effortView, type GatewayEffortView } from './effort-view.js'

export interface GatewayModelInfo {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
}

export interface GatewayProviderModels {
  provider: string
  models: readonly GatewayModelInfo[]
}

export interface OpenAiModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
  name: string
  description?: string
  context_window?: number
  max_tokens?: number
  input?: readonly string[]
  /**
   * 思考档位的**机读视图**（附加字段，OpenAI 规范里没有这个语义）。
   *
   * ⚠️ 模型**没声明**档位时**整个字段缺省**（而不是给空数组）——「不知道」与
   * 「一个都没有」对客户端是两件事，见 `effort-view.ts` 的 `effortView`。
   */
  reasoning?: GatewayEffortView
}

export function toOpenAiModelId(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** 采集目录所需的最小 runtime 形态（便于单测替身）。 */
export interface GatewayModelSource {
  listProviders(): readonly { id: string }[]
  listModels(provider: string): Promise<readonly GatewayModelInfo[]>
  /**
   * 可选：解析某个模型的**精确**元信息（档位在这里，`listModels` 不带）。
   *
   * ⚠️ 声明为可选是刻意的：它是**附加能力**。宿主没提供（旧版本、单测替身）时
   * 目录照常返回，只是不带档位视图 —— 绝不能因为拿不到档位就让整个目录失败。
   */
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
}

/**
 * 采集全量模型目录，**逐个 provider 兜住**。
 *
 * ⚠️ 不能直接 `Promise.all` 全部 provider：任一 provider 抛错（未登录、远端
 * 目录拉取失败）会让整个目录变成失败 —— 用户看到的是「网关坏了」，而真实原因
 * 只是某一个 provider 没登录。逐个跳过也让「无凭据的 provider 不出现在目录里」
 * 天然成立。
 *
 * ⚠️ **本函数承诺永不抛出**。它是「网关面板顺带展示的目录」，是附加信息，
 * 不该有能力把调用方（设置页状态读取、请求失败后的纠错建议）一起拖垮。
 * 故对下列畸形输入全部降级为空：方法缺失、`listProviders()` 返回非数组、
 * 某个 `listModels()` 返回非数组、provider 条目缺 id。
 * （`llm` 来自 DSH 的 service，真实形态与类型声明可能不一致，故不假设它守规矩。）
 */
export async function collectGatewayModels(
  llm: GatewayModelSource,
  onError?: (provider: string, error: unknown) => void,
): Promise<GatewayProviderModels[]> {
  let providers: readonly { id: string }[] = []
  try {
    const raw = llm?.listProviders?.()
    if (Array.isArray(raw)) providers = raw.filter((entry): entry is { id: string } => typeof entry?.id === 'string')
  } catch (error) {
    onError?.('listProviders', error)
  }
  if (providers.length === 0) return []

  const groups = await Promise.all(providers.map(async ({ id: provider }) => {
    try {
      const models = await llm.listModels(provider)
      if (!Array.isArray(models)) {
        onError?.(provider, new Error('listModels 未返回数组'))
        return undefined
      }
      return { provider, models: models as readonly GatewayModelInfo[] }
    } catch (error) {
      onError?.(provider, error)
      return undefined
    }
  }))
  return groups.filter((group): group is GatewayProviderModels => group !== undefined)
}

/**
 * 采集成设置页可直接渲染的 `{ id, name, input }` 列表。
 *
 * 与 {@link toOpenAiModels} 共用同一份采集逻辑与容错口径 —— 用户在设置页看到的
 * 与 `/v1/models` 返回的**必须**是同一批 ID 与同一份能力声明，两处各算一遍必然
 * 漂移，而漂移的症状是「照着设置页选的模型却不支持图片」。
 *
 * ⚠️ `input` 原样透传**不归一化**：它决定用户能否给该模型发图片，而各 provider
 * 的能力声明才是权威（`/v1/models` 的 HTTP 路径同样直接输出它）。
 * 缺失时归一化为 `['text']`，与各适配器「不声明即按 text 保守处理」一致
 * （见 lobsterai-adapter.ts:768-770）——宁可少报能力，也不要让用户发一张
 * 注定被上游拒绝的图。
 */
export async function collectGatewayModelIds(
  llm: GatewayModelSource,
  onError?: (provider: string, error: unknown) => void,
  effortViews?: ReadonlyMap<string, GatewayEffortView>,
): Promise<GatewayModelIdEntry[]> {
  const groups = await collectGatewayModels(llm, onError)
  return toGatewayModelIds(groups, effortViews)
}

/**
 * 设置页面板渲染一行的**权威字段**。
 *
 * ⚠️ `provider` / `model` 是**采集侧给的拆分**，不是前端从 `id` 切出来的。
 * 模型名里允许带斜杠（实测 Cline 的 `cline/anthropic/claude-sonnet-5.5`），
 * 按首个 `/` 反推虽然与网关自己的路由口径同源（`messages.ts` 的
 * `parseModelRoute` 同样用 `indexOf('/')`），但一旦某家 provider 的模型名
 * 以 `/` 开头、或 provider key 本身含 `/`，反推就会错位。
 * 分组是「哪家有哪些模型」这个**用户语义**，理应由采集侧决定而不是猜。
 */
export interface GatewayModelIdEntry {
  /** 可直接填进 agent 配置的完整 ID（`provider/模型名`）。 */
  id: string
  /** 该条目所属的 provider key（**权威值**，非从 `id` 切出）。 */
  provider: string
  /** provider 内部的模型名（不含 `<provider>/` 前缀）。 */
  model: string
  name: string
  input: readonly string[]
  reasoning?: GatewayEffortView
}

/**
 * 分组目录 → 扁平行（设置页/面板用）。
 *
 * ⚠️ 抽成**纯函数**是为了让「已经采集过分组与档位」的调用方直接复用，
 * 而不是再走一遍 `collectGatewayModelIds` 把目录拉第二次
 * （重复采集的症状是同一份清单里两次出现不同的档位）。
 */
export function toGatewayModelIds(
  groups: readonly GatewayProviderModels[],
  effortViews?: ReadonlyMap<string, GatewayEffortView>,
): GatewayModelIdEntry[] {
  return groups.flatMap(({ provider, models }) => models.map((model) => {
    const id = toOpenAiModelId(provider, model.id)
    const reasoning = effortViews?.get(id)
    return {
      id,
      // ⚠️ 这两个字段**必须由这里给出**（见 `GatewayModelIdEntry` 的注释）：
      // 前端没有别的地方能拿到权威拆分。
      provider,
      model: model.id,
      name: model.name,
      input: Array.isArray(model.inputModalities) && model.inputModalities.length > 0
        ? [...model.inputModalities]
        : ['text'],
      ...reasoning === undefined ? {} : { reasoning },
    }
  }))
}

/**
 * 逐个模型解析**档位视图**（key = `provider/model`）。
 *
 * ## 为什么要单独解析
 *
 * DSH 的 `LlmModelInfo`（`listModels` 的产物）**不带**档位，档位只在
 * `resolveModelInfo` 的 `LlmResolvedModelInfo.reasoning` 里。而档位正是本网关
 * 最需要公开的东西 —— 各 provider 的档位 id 私有（`light` / `extra_high` /
 * `xhigh` / `on`），客户端不查就只能猜，猜错就是 400。
 *
 * ## 成本与容错
 *
 * 每个模型一次 `resolveModelInfo`：它读的是适配器**已缓存**的远端目录
 * （`listModels` 刚拉过），故不产生额外网络请求；DSH 自己的 `buildModelCatalog`
 * 也是「每个 provider listModels 后逐个 resolveModelInfo」的同一形状。
 * 逐模型 catch：单个模型解析失败只是**它**没有档位字段，不影响整个目录。
 */
export async function collectGatewayEffortViews(
  llm: GatewayModelSource,
  groups: readonly GatewayProviderModels[],
  onError?: (provider: string, error: unknown) => void,
): Promise<Map<string, GatewayEffortView>> {
  const views = new Map<string, GatewayEffortView>()
  const resolve = llm?.resolveModelInfo
  // 宿主不提供该能力时**静默返回空表**：档位是附加信息，拿不到就不发字段，
  // 不能让整份目录跟着失败。
  if (typeof resolve !== 'function') return views
  await Promise.all(groups.flatMap(({ provider, models }) => models.map(async (model) => {
    try {
      const info = await resolve.call(llm, provider, model.id) as {
        reasoning?: { efforts?: readonly { id?: unknown; name?: unknown }[]; defaultEffort?: unknown }
      } | undefined
      const view = effortView(info?.reasoning?.efforts, info?.reasoning?.defaultEffort)
      if (view !== undefined) views.set(toOpenAiModelId(provider, model.id), view)
    } catch (error) {
      onError?.(provider, new Error(
        `${model.id} 的档位解析失败（该模型不带档位字段，目录本身照常返回）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      ))
    }
  })))
  return views
}

/** 将 DSH 的 provider 分组目录转换为 OpenAI models 响应中的 data 项。 */
export function toOpenAiModels(
  groups: readonly GatewayProviderModels[],
  effortViews?: ReadonlyMap<string, GatewayEffortView>,
): OpenAiModel[] {
  return groups.flatMap(({ provider, models }) => models.map((model) => {
    const reasoning = effortViews?.get(toOpenAiModelId(provider, model.id))
    return {
      id: toOpenAiModelId(provider, model.id),
      object: 'model' as const,
      created: 0,
      owned_by: provider,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { context_window: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { max_tokens: model.maxTokens },
      ...model.inputModalities === undefined ? {} : { input: model.inputModalities },
      ...reasoning === undefined ? {} : { reasoning },
    }
  }))
}
