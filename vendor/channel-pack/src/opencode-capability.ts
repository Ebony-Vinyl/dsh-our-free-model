/**
 * OpenCode Zen 模型能力元数据（远端下发 + 磁盘缓存 + **非阻塞**读取）。
 *
 * ## 数据源：models.dev 的 `opencode` 条目
 *
 * `/zen/v1/models` **只返回 4 个字段**（`id` / `object` / `created` /
 * `owned_by`，实测 85 条全如此），**不含任何能力信息**。能力在 models.dev
 * （`https://models.dev/api.json` 的 `opencode` 键，实测 115 个模型），官方
 * CLI 自己就用它（`packages/core/src/models-dev.ts`）。
 *
 * | 字段 | 用途 |
 * |---|---|
 * | `modalities.input` | 能力主源：`['text']` / `['text','image']` … |
 * | `cost.input` / `cost.output` | **免费判定的权威来源**（0 = 免费） |
 * | `limit.context` / `limit.output` | 上下文窗口与输出上限 |
 *
 * ## ⚠️⚠️ 为什么读取**必须非阻塞**（真机事故 2026-10-02）
 *
 * `https://models.dev/api.json` 实测 **5.05 MB / 首字节 720ms / 下载 1.4s**
 * （轻量端点 `api/v1/opencode.json` 返回的是 HTML 404 页，不可用）。
 *
 * 我最初在 `listModels` / `resolveModel` 里**直接 await** 这个拉取，于是
 * DSH 的模型选择器必须等 1.4s+ 才能拿到列表 → **点开是一片空白**，
 * 用户报障「选择模型还是点击没弹出列表」。
 *
 * ⇒ 三条硬约定（改动前先读）：
 * 1. **渲染路径上只能读同步缓存**，永不 await 网络；
 * 2. 磁盘缓存落 `$DSH_HOME/cache/opencode-capabilities.json`，冷启动直接命中；
 * 3. 拉取在**后台**进行，完成后广播 `llm/adapters-updated` 让 DSH 重读目录。
 *
 * 缓存拿不到时**保守回退纯文本**（声明支持就必须真支持），徽标与图片能力
 * 会在后台刷新后自动补上。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OPENCODE_MODELS_DEV_URL, OPENCODE_MODELS_DEV_TTL_MS } from './opencode-product.js'

/** 归一后的模型能力条目。 */
export interface OpencodeModelCapability {
  id: string
  name: string
  /** 输入模态（已归一到 DSH 支持的 text/image；video/audio/pdf 一律降级为 text）。 */
  modalities: readonly ('text' | 'image')[]
  /** 上下文窗口（0 = 未知，不编造）。 */
  contextWindow: number
  /**
   * 模型单次输出上限（0 = 未知）。
   *
   * ⚠️ **刻意不下发给 DSH 的 `defaultMaxTokens`**（issue IKJJ68）。
   * 它是**上限**而非「合理的默认输出预算」：DSH 会在用户未指定 `max_tokens` 时
   * 直接拿它填请求，于是每轮都按上限走 —— 而 `space-bunny-free` 的上限是
   * **524288**、`nemotron-3-ultra-free` 是 128000，作为「默认」明显荒谬。
   *
   * ⚠️ 实测 2026-10-02 澄清了两件事（别再凭猜写这里的注释）：
   *   ① 给到这些值**不会被服务端拒绝**（big-pickle 32000 / nemotron 128000 /
   *      space-bunny 524288 全部 200）—— 「免费通道会拒」的说法**不成立**；
   *   ② **不给** `max_tokens` 时服务端用自己的默认值，实测 667 tokens 且
   *      `finish=stop`（自然结束，非截断）—— 现有「不下发」的行为就是好的。
   * 采下来是为了**留档**，以及将来按渠道实测出安全默认值。
   */
  maxOutputTokens: number
  /** 是否支持思考推理（**仅表示「支持」**；档位见 {@link efforts}）。 */
  reasoning: boolean
  /**
   * 思考档位 id（**原序**来自 models.dev 的 `reasoning_options`）。
   *
   * ⚠️ **空数组 = 不声明 `reasoning`**（选择器不出现），而不是「支持但无档位」。
   * 依据是 DSH 的渲染逻辑（`dsh-api-session-controller/lib/types/catalog.js`）：
   * `resolved.reasoning === undefined ? undefined : { efforts: … }` ——
   * 声明了空数组会让 UI 出现一个**没有任何档位**的空选择器。
   * （issue IKJJ0V）
   */
  efforts: readonly string[]
  /** 是否支持工具调用。 */
  toolCall: boolean
  /**
   * 是否**免费**（`cost.input` 与 `cost.output` 同时为 0）。
   *
   * ⚠️ 这是免费判定的**权威来源**（Zen 匿名通道按此放行），
   * 不依赖本地硬编码表 —— 后者会在上游调整定价后静默失准。
   */
  isFree: boolean
}

/**
 * 实测校准表：**只**覆盖与 models.dev 不一致的视觉能力。
 *
 * ## 范围（用户定调 2026-10-02：只验证免费模型）
 *
 * 校准**只针对免费模型**。付费模型走账号通道，能力以远端 models.dev 为准即可，
 * 不做逐个实测 —— 那需要真实付费调用，且余额/价格变动时结论也易过期。
 */
const MEASURED_IMAGE_OVERRIDES: Record<string, { image: boolean; note: string }> = {
  // 实测 2026-10-02：models.dev 标 `modalities.input: ["text"]`，
  // 但 1×1 PNG 的多模态请求真实返回 200（big-pickle 是最常用的免费模型）。
  'big-pickle': { image: true, note: '2026-10-02 实测 200，models.dev 漏报 image' },
  // 实测 2026-10-02：models.dev 标支持 image，但带图请求真实 500
  // （"Upstream request failed: Endpoint is unsupported"）。
  'longcat-2.5-preview-free': { image: false, note: '2026-10-02 实测 500，models.dev 多报 image' },
}

/** models.dev 原始条目（只声明用到的字段）。 */
interface RawModelDevEntry {
  id?: unknown
  name?: unknown
  modalities?: { input?: unknown }
  limit?: { context?: unknown; output?: unknown }
  cost?: { input?: unknown; output?: unknown }
  reasoning?: unknown
  /**
   * 思考档位声明（issue IKJJ0V）。
   *
   * 实测 2026-10-02：115 个 opencode 模型里 **88 个**带此字段，形态有四种：
   * | 形态 | 实例 |
   * |---|---|
   * | 多档 | `{"type":"effort","values":["minimal","low","medium","high","xhigh"]}` |
   * | 自定义档 | `{"type":"effort","values":["low","high","max"]}` |
   * | 单档 | `{"type":"effort","values":["max"]}` |
   * | 仅开关 | `{"type":"toggle"}` |
   * | 预算制 | `{"type":"budget_tokens","max":81920}` |
   */
  reasoning_options?: unknown
  tool_call?: unknown
}

/** 磁盘缓存的落盘形态。 */
interface CapabilityCacheFile {
  /**
   * ⚠️ 2026-10-02 从 1 升到 **2**（issue IKJJ0V：新增 `efforts` 字段）。
   * 旧版本缓存**没有** `efforts`，若沿用 version:1 会被当成有效数据继续用，
   * 思考档位在 TTL 内（最长 60 分钟）持续缺失 —— 表现为「改了没用，重启才好」。
   *
   * ⚠️ 2026-10-16 从 2 升到 **3**：`toggle` 形态不再翻成 `['none','low']`
   * （见 {@link normalizeEfforts}）。v2 缓存里存着那对**编出来的**档位，
   * 沿用会让旧档位菜单在 TTL 内继续出现 —— 用户选了「关闭思考」而线上发的是
   * 一个上游没声明过的值。同一理由，同一处理。
   */
  version: 3
  at: number
  entries: readonly OpencodeModelCapability[]
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * 档位 id → 官方中文展示名。
 *
 * ⚠️ 沿用 Qoder 那份**官方 i18n**（`settings.efforts`，见 AGENTS.md §2.2），
 * 因为 DSH 客户端**直接渲染** `efforts[].name`（不本地化、不查字典），
 * 给英文就显示英文。
 * ⚠️ `minimal` / `xhigh` 在那份表里没有 —— models.dev 确实会下发这两个值，
 * 遇到时回退到 id 本身（**不猜中文**）：宁可显示 `minimal` 也不编一个错译。
 */
const EFFORT_NAMES: Record<string, string> = {
  none: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

/**
 * 档位 id → 展示名（**无官方中文时回退到 id 本身**，不猜译名）。
 *
 * 导出给适配器用：`resolveModel()` 要给 `efforts[].name` 填中文，
 * 而客户端**直接渲染**该字段。
 */
export function opencodeEffortName(id: string): string {
  return EFFORT_NAMES[id] ?? id
}

/**
 * 从 `reasoning_options` 提取思考档位。
 *
 * ## 只认 `effort` 形态（2026-10-16 重写，对齐官方客户端）
 *
 * 官方 CLI 的档位表就是 `reasoning_options` 里 `effort.values` 的机械投影
 * （`packages/core/src/variant.ts` 的 `resolve()`：对 opencode 所用的
 * `@ai-sdk/openai-compatible` 包走 `openaiChat` 协议，只有 `effort` 形态产出
 * 变体，`toggle`/`budget_tokens` 都产出空表），而**线上的唯一表达就是
 * `reasoning_effort`**（同文件的 `settings.reasoningEffort`）。故：
 *
 * - `type:'effort'` + `values` → **原序**产出，值就是上游认的 id；
 * - `type:'toggle'` → **不声明**。旧实现把它翻成 `['none','low']`（关/开），
 *   那是**语义发明**：官方客户端对这类模型一个档位都不给，而线上的
 *   `reasoning_effort` 也表达不了「开关」。更糟的是上游会**校验**这个字段
 *   （2026-10-02 实测：非法值回 `[400] reasoning_…`），发一个它没声明过的
 *   档位等于拿整轮对话赌运气。
 * - `type:'budget_tokens'`（预算制）→ 同理不声明。DSH 的 `reasoning.efforts`
 *   表达不了预算，编一档等于谎报能力。
 *
 * @returns 档位 id 数组；为空表示**不声明** `reasoning`（UI 不出现）。
 */
function normalizeEfforts(entry: RawModelDevEntry): readonly string[] {
  if (!Array.isArray(entry.reasoning_options)) return []
  const out: string[] = []
  for (const raw of entry.reasoning_options) {
    if (typeof raw !== 'object' || raw === null) continue
    const option = raw as { type?: unknown; values?: unknown }
    if (option.type === 'effort' && Array.isArray(option.values)) {
      for (const v of option.values) {
        if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v)
      }
    }
  }
  return out
}

/** 把 models.dev 的一个条目归一；不合法时返回 null。 */
function normalizeEntry(id: string, raw: unknown): OpencodeModelCapability | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as RawModelDevEntry
  const declared = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.filter((m): m is string => typeof m === 'string')
    : []
  // ⚠️ **video / audio / pdf 一律降级为 text**：DSH 的 `inputModalities` 只认
  // 这两个值，声明不存在的模态会让 DSH 投影出我们并不发送的内容。
  let modalities: ('text' | 'image')[] = ['text']
  if (declared.includes('image')) modalities = ['text', 'image']
  const override = MEASURED_IMAGE_OVERRIDES[id]
  if (override !== undefined) modalities = override.image ? ['text', 'image'] : ['text']
  const efforts = normalizeEfforts(entry)
  return {
    id,
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
    modalities,
    contextWindow: isFiniteNumber(entry.limit?.context) ? entry.limit!.context as number : 0,
    maxOutputTokens: isFiniteNumber(entry.limit?.output) ? entry.limit!.output as number : 0,
    // ⚠️ `reasoning` 与 `efforts` 必须一致：只有真拿到档位才报「支持思考」。
    // `reasoning: true` 但 `efforts: []` 会声明一个空选择器（UI 出现但无内容）。
    reasoning: entry.reasoning === true && efforts.length > 0,
    efforts,
    toolCall: entry.tool_call !== false,
    isFree: isFiniteNumber(entry.cost?.input) && entry.cost!.input === 0
      && isFiniteNumber(entry.cost?.output) && entry.cost!.output === 0,
  }
}

/** 能力表缓存文件路径（`$DSH_HOME/cache` 下，与宿主缓存同处）。 */
function cacheFilePath(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'cache', 'opencode-capabilities.json')
}

/** 进程内同步可读的缓存（渲染路径只读它，绝不 await）。 */
let memory: readonly OpencodeModelCapability[] = []

/** 磁盘缓存的写入时刻（0 = 无缓存），供 TTL 判定。 */
let cacheFileAt = 0

/** 后台拉取是否已在进行（去重，避免并发重复下载 5 MB）。 */
let refreshing: Promise<void> | undefined

/** 磁盘缓存读一次（冷启动路径）。 */
let diskLoaded = false
async function ensureDiskLoaded(): Promise<void> {
  if (diskLoaded) return
  diskLoaded = true
  try {
    const raw = await readFile(cacheFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as CapabilityCacheFile
    if (parsed?.version === 3 && Array.isArray(parsed.entries) && parsed.entries.length > 0) {
      memory = parsed.entries
      cacheFileAt = typeof parsed.at === 'number' ? parsed.at : 0
    }
  } catch {
    // 首次运行没有缓存文件是**正常**的（不是错误），走纯文本兜底。
  }
}

/**
 * **同步**读磁盘缓存（模块加载时执行一次）。
 *
 * ## ⚠️⚠️ 为什么必须有这一步（真机报障 2026-10-02，根因）
 *
 * DSH 内核在 `prompt` 准入阶段校验图片：
 * ```js
 * const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
 * if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
 *   throw new RemoteError(..., "Model ... does not support image input.")
 * ```
 * （见 `dsh-api-session-controller/lib/index.js`）
 *
 * 那次校验**紧贴用户操作**发生，而能力表此前只靠 `ensureDiskLoaded()` 的
 * **异步** `await readFile` 填充 ⇒ 冷启动后有一段窗口里
 * `getOpencodeCapabilitiesSync()` 恒返回 `[]` ⇒ `inputModalities` 报 `['text']`
 * ⇒ **网关发图被内核拒绝**，报「模型不支持图片输入」。
 *
 * 「后台刷新后广播 `llm/adapters-updated`」救不了：广播只触发 UI 重渲染，
 * 不会重新走一次准入校验。
 *
 * ⇒ 模块加载时**同步**把磁盘缓存读进内存（缓存文件 ~19KB，`readFileSync`
 * 代价可忽略），保证 `resolveModel` 第一次被调用就拿到完整能力表。
 * 代价是插件加载多一次同步 IO，可接受。
 */
function loadDiskCacheSync(): void {
  if (diskLoaded) return
  diskLoaded = true
  try {
    const raw = readFileSync(cacheFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as CapabilityCacheFile
    if (parsed?.version === 3 && Array.isArray(parsed.entries) && parsed.entries.length > 0) {
      memory = parsed.entries
      cacheFileAt = typeof parsed.at === 'number' ? parsed.at : 0
    }
  } catch {
    // 没有缓存文件是正常的（首次运行），后台会补齐。
  }
}

async function writeDiskCache(entries: readonly OpencodeModelCapability[]): Promise<void> {
  try {
    const path = cacheFilePath()
    await mkdir(join(path, '..'), { recursive: true })
    const payload: CapabilityCacheFile = { version: 3, at: Date.now(), entries }
    await writeFile(path, JSON.stringify(payload), 'utf8')
  } catch {
    // 缓存写失败不影响功能（下次仍会从网络补齐）
  }
}

/** 单次拉取的超时（毫秒）。
 *
 * ⚠️ **必须有**：`fetch` 在某些宿主网络环境（代理未起、TUN 未连通）下
 * 会**永不 settle**（用户报障「模型选择一直卡着」，实测非慢而是挂死）。
 * 没有超时 = 后台任务永久悬挂，且它还占着 `refreshing` 去重位，
 * 导致后续所有刷新请求都被跳过。
 */
const FETCH_TIMEOUT_MS = 20_000

async function fetchAndCache(): Promise<void> {
  const response = await fetch(OPENCODE_MODELS_DEV_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = (await response.json()) as Record<string, { models?: Record<string, unknown> }>
  const models = body['opencode']?.models
  if (typeof models !== 'object' || models === null) throw new Error('缺少 opencode 条目')
  const out: OpencodeModelCapability[] = []
  for (const [id, raw] of Object.entries(models)) {
    const entry = normalizeEntry(id, raw)
    if (entry !== null) out.push(entry)
  }
  if (out.length === 0) throw new Error('解析结果为空')
  memory = out
  await writeDiskCache(out)
}

/**
 * 后台刷新能力表（**永不阻塞**调用方）。
 *
 * @param onUpdated 刷新成功后的回调（接线层用它广播 `llm/adapters-updated`，
 *                  让 DSH 重读目录并按新能力重渲染）。
 * @param force 忽略 TTL 强制刷新（「刷新目录」按钮用）。
 */
export function refreshOpencodeCapabilities(
  onUpdated?: () => void,
  force = false,
): void {
  // ⚠️ 上一次拉取若**卡住**（fetch 永不 settle 且超时信号未生效的极端情况），
  // `refreshing` 会被永久占住，之后所有刷新都被跳过、缓存也永远补不上。
  // 故超过两倍超时即视为「上一次已死」，允许重新发起。
  if (refreshing !== undefined && Date.now() - refreshingStartedAt > FETCH_TIMEOUT_MS * 2) {
    refreshing = undefined
  }
  if (refreshing !== undefined) return
  refreshingStartedAt = Date.now()
  refreshing = (async () => {
    try {
      await ensureDiskLoaded()
      // 磁盘缓存足够新就不重复下载 5 MB。
      if (!force && cacheFileAt > 0 && Date.now() - cacheFileAt < OPENCODE_MODELS_DEV_TTL_MS) return
      await fetchAndCache()
      onUpdated?.()
    } catch {
      // 拉取失败（含超时）：保留现有缓存继续用（能力退化为上一次的读数，而不是清空）
    } finally {
      refreshing = undefined
    }
  })()
}

/** 在途拉取的开始时刻（用于识别「卡死」的那一次，见 refreshOpencodeCapabilities）。 */
let refreshingStartedAt = 0

/**
 * **同步**读当前已知的能力表。
 *
 * ⚠️ 刻意**不是** async：调用方在渲染路径上（listModels / resolveModel），
 * await 网络会卡住模型选择器（真机事故）。
 *
 * ⚠️⚠️ 首次调用会**同步**读磁盘缓存（`readFileSync`，~19KB）—— 不是网络 IO，
 * 代价可忽略，却能保证 `resolveModel` 第一次被调用就拿到完整能力表。
 * 少了这一步，内核的 `prompt` 准入校验会读到 `inputModalities: ['text']`
 * 而拒绝图片（详见 {@link loadDiskCacheSync} 的事故记录）。
 */
export function getOpencodeCapabilitiesSync(): readonly OpencodeModelCapability[] {
  loadDiskCacheSync()
  return memory
}

/** 首次调用：读磁盘缓存（非阻塞，fire-and-forget）。 */
export function primeOpencodeCapabilities(): void {
  // 同步读一次，让紧随其后的任何 resolveModel/listModels 都拿得到。
  loadDiskCacheSync()
  void ensureDiskLoaded().then(() => {
    // 有缓存就直接用；没有则在后台补一次。
    if (memory.length === 0) refreshOpencodeCapabilities()
  })
}

/** 清空内存与磁盘缓存（单测用）。 */
export async function clearOpencodeCapabilitiesCache(): Promise<void> {
  memory = []
  cacheFileAt = 0
  diskLoaded = false
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(cacheFilePath())
  } catch {
    // 文件不存在是正常的
  }
}

/** 某模型是否接受图片输入（未知模型按纯文本处理）。 */
export function supportsOpencodeImage(capability: OpencodeModelCapability | undefined): boolean {
  return capability?.modalities.includes('image') === true
}
