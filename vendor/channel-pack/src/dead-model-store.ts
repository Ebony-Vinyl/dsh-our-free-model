/**
 * 「已失效模型」的**运行时实证**记录与剔除。
 *
 * ## 解决什么（真实报障，2026-10-05）
 *
 * 用户在 Channel Pack 选中 cline 的 `cline-free/deepseek-v4.1-flash`，每轮都失败：
 *
 * ```
 * cline: model not found HTTP_404
 * ```
 *
 * 账号、余额、网络都正常。该模型**已被 Cline 从 `free` 数组移除**，但模型列表里
 * 仍然显示它、并且仍然标着「免费」—— 用户拿到的是一个看着可用、一点就 404 的条目。
 *
 * 根因是各 provider 的**兜底模型表**（`product.fallbackModels` 等）是**编译期快照**，
 * 上游下架模型时它不会自己跟着变。
 *
 * ## ⚠️ 为什么不能用「远端目录里没有 ⇒ 已下架」来剔除
 *
 * 那个判据只在**远端完整权威**的 provider 上成立。本仓库的实际情况分三类：
 *
 * ⇒ 唯一**跨 provider 安全**的判据是**阳性证据**：这个模型**真的**请求失败并返回
 * 「模型不存在」时，才把它记为失效。**不从残缺目录反推。**
 *
 * ## 行为
 *
 * 1. **记录**：适配器的 `stream()` 抛出的错误被判定为「模型已失效」时，
 *    按 `provider + modelId` 落盘到 `$DSH_HOME/channel-pack/dead-models.json`。
 * 2. **剔除**：此后该 provider 的 `listModels()` / `listAllModels()` 不再播报它。
 * 3. **过期**：记录带 TTL（默认 30 天）。上游若把模型重新上架，最多 30 天后自动
 *    回到列表 —— 因为已被剔除的模型用户**选不到**，不可能靠「再成功一次」自愈，
 *    只能靠过期回收。TTL 可用 `DSH_DEAD_MODEL_TTL_DAYS` 覆盖（0 = 永不过期）。
 *
 * ## 判据为什么必须保守
 *
 * 误判（把可用模型记成失效）会把一个好模型从列表里藏起来，且**用户无法自行恢复**
 * （见上：选不到 ⇒ 不可能再成功 ⇒ 记录不会清）。故：
 *
 * - 只认明确的「模型不存在」文案；
 * - 出现限流 / 额度 / 认证类关键词时**一律不记**（那些是账号问题，不是模型问题）；
 * - 错误码为 AUTH / QUOTA_EXCEEDED / RATE_LIMIT / MISSING_CREDENTIAL /
 *   PERMISSION_DENIED 时一律不记。
 *
 * ## 为什么落独立文档，而不是并进 `state.json`
 *
 * 同 `permanent-lock-store.ts` 记录的那类风险：`state.json` 是 **dsh home 级、
 * 全局共享**的（同机多个 profile 共用一份），而本插件的存储是**整体替换**语义 ——
 * 旧版本代码整体重写时会静默抹掉它不认识的字段。独立文档则无人争抢。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveChannelPackHome } from './channel-pack-store.js'

/** 独立文档的文件名（与 state.json 同目录）。 */
export const DEAD_MODELS_FILE = 'dead-models.json'

/** 文档 schema 标记（与本仓库其它状态文档同惯例）。 */
const SCHEMA = 'channel-pack/dead-models/v1'

/** 默认保留天数；可用 `DSH_DEAD_MODEL_TTL_DAYS` 覆盖（0 = 永不过期）。 */
const DEFAULT_TTL_DAYS = 30

/** 单条记录：何时、因何判为失效。 */
interface DeadModelRecord {
  /** ISO 时间戳。 */
  at: string
  /** 判据命中的错误文案（排查用）。 */
  reason?: string
}

/** `provider → modelId → 记录`。 */
type DeadModelRecords = Record<string, Record<string, DeadModelRecord>>

/**
 * 「模型已失效」的文案判据。
 *
 * ⚠️ 全部要求「model」与「不存在」语义**同现**，不接受泛词：
 * `unsupported` / `invalid` 单独出现**不算**（可能是参数错而非模型下架）。
 *
 * ## ⚠️⚠️ 窗口字符类**不能排除点号**（真实缺陷，2026-10-06 复审 !66 实测）
 *
 * 初版四条英文正则都用 `[^.!?]{0,N}` 做窗口，而**本仓库几乎所有模型 id 都带
 * 小数点**（`deepseek-v4.1-flash` / `gpt-5.6-astra` / `muse-spark-1.3-contributor`）
 * —— 点号直接截断窗口，导致**英文路径对带点 id 全部漏判**：
 *
 * ```
 * model deepseek-v4.1-flash 不存在        → 初版 false（应为 true）
 * The model gpt-5.6-astra does not exist   → 初版 false（应为 true）
 * model deepseekv41flash does not exist    → 初版 true （无点才命中）
 * ```
 *
 * ⇒ 现在英文窗口只排除**句子终止符**（`!?` 与换行），**保留点号**。
 * 窗口也从 24/16 放宽到 64：初版英文窗口的**实测有效上限只有 17 字符**
 * （18 即漏判），而本仓库最长模型 id `cline-free/muse-spark-1.3-contributor`
 * 有 **37 字符**（`cline-product.ts`）。
 *
 * ## ⚠️ `not supported` / `not available` **不是**下架证据（同一轮复审实测）
 *
 * 初版把 `available` / `supported` 与 `found`/`exist` 并列，于是这 6 条
 * **换套餐 / 换地域 / 换端点就能恢复**的文案被误判成「模型已下架」：
 *
 * ```
 * cline: model not supported in this plan      → 初版 true ★误判
 * model not available in your region           → 初版 true ★误判
 * the selected model is not available for reasoning → 初版 true ★误判
 * ```
 *
 * 误判代价极高（被藏 30 天且用户无法自愈），故**只认 `found` / `exist`** ——
 * 这与本文件头「`unsupported` 单独出现不算」的既有口径一致。
 *
 * ## ⚠️⚠️ 为什么改成「先抽 id、再判语义」而不是加长窗口（2026-10-06 复审实测）
 *
 * 加长窗口（`[^.!?]{0,24}` → `[^!?\n]{0,64}`）虽然修好了点号阻断，却**引入了跨句误判** ——
 * 因为 `.` 既是 id 内部的小数点**又是**句末标点，无法在字符类里区分。实测：
 *
 * ```
 * model x is fine. the container image does not exist   → 误判为「模型已下架」
 * the config file model list is fine; however this build does not exist → 误判
 * ```
 *
 * ⇒ 改为**两步**：先按 {@link goneCandidates} 从文案里抽出**候选模型 id**
 * （允许内部含小数点/斜杠/连字符），再要求「**紧邻该 id** 出现不存在语义」。
 * 这样与标点无关、也不依赖窗口长度。
 */
const GONE_PATTERNS: readonly RegExp[] = [
  /model\s+not\s+found/i,
  /(?:unknown|no\s+such|nonexistent)\s+model/i,
  // ⚠️ OpenAI 标准的 `model_not_found` / `model-not-found` 形态。
  //
  // ⚠️⚠️ 必须要求它**独占一句话成分**（2026-10-06 复审实测）：只加 `\b` 词边界
  // 不够 —— `model_not_found` 在**遥测/日志文案**里常作为**字段名**出现，后面
  // 紧跟别的内容：
  //   error_class=model_not_found, retry allowed      → 初版误判下架
  //   the model_not_found metric was not exported     → 初版误判下架
  //   model_not_found_reason=upstream                 → 初版误判下架
  // 误判会把**可用模型藏 30 天**且用户需手动恢复。
  //
  // ⇒ 后面**只允许**：① 结束；② 句末标点（`.` `!` `?` `;`）；③ 收尾括号/引号；
  // **不含逗号**（`…not_found, retry allowed` 里逗号后仍是另一个字段 ⇒ 不算阳性）。
  /\bmodel[_\-]not[_\-]found\b(?=\s*(?:[.!;?)}\]'"]|$))/i,
]

/**
 * 「不存在」的语义片段（要求**紧邻**候选 id 出现，见 {@link matchesGonePhrase}）。
 *
 * ⚠️ **只认 `found` / `exist`**：`available` / `supported` 会把
 * 「换套餐 / 换地域就能恢复」的问题误判成下架（见文件头）。
 *
 * ⚠️⚠️ 外层**必须有非捕获分组** `(?: … )`（2026-10-06 复审实测）：本片段要被
 * 拼进带 `^` 锚点的正则里，若不分组，`|` 的**顶层交替**会让除第一个以外的所有分支
 * **脱离锚定**、在全串任意位置匹配 —— 于是
 * `model x is fine. the container image does not exist` 会被误判成「模型已下架」
 * （`does not exist` 那一支恰好就是被锚定的那一支，掩盖了问题；漏掉的是
 * `\bnot (found|exist)` 与全部中文分支）。
 */
const GONE_TAIL = /(?:(?:does\s*not|doesn'?t)\s+(?:exist|found)|\bnot\s+(?:found|exist)|不存在|未找到|未上线|已下线|已下架)/

/**
 * 一个「模型 id 样式」的词元。
 *
 * 字符集刻意**允许小数点、斜杠、连字符、下划线**（本仓库真实 id：
 * `deepseek-v4.1-flash` / `cline-free/muse-spark-1.3-contributor` / `gpt-5.6-astra`），
 * 但**不允许空格** —— 于是 `model x is fine. the container image` 里的
 * `x` 虽然也是词元，它的「紧邻后文」是 ` is`，不含不存在语义 ⇒ 判 false。
 *
 * ⚠️ **允许中文**（`qmodel` 之类无中文，但文案里会出现 `模型 已下线` 这类
 * 「主语 + 中文语义」而中间没有 id 的形态）；中文分支不参与 id 抽取，
 * 由 {@link GONE_TAIL} 直接匹配。
 */
const TOKEN = String.raw`[A-Za-z0-9][A-Za-z0-9._/-]{0,63}`

/**
 * 判定「文案里提到了某个模型，且**紧邻它**说了它不存在」。
 *
 * ⚠️ **必须锚定**（`^`）—— 不可用 `GONE_TAIL.test(tail)` 那种「往后随便搜」：
 * 那会跨句命中（`model x is fine. the container image does not exist`
 * 里，`x` 之后的整段尾巴都会被扫到），正是本函数要消除的误判。
 *
 * @param message - 错误文案。
 * @returns true 表示存在这样一组「id + 紧邻不存在」的相邻搭配。
 */
function matchesGonePhrase(message: string): boolean {
  // 主语后**没有** id，直接跟中文语义（`该模型已下线`）也算阳性。
  for (const subject of message.matchAll(new RegExp(String.raw`(?:model|模型)["'\x60]?[\s,]*`, 'gi'))) {    const tail = message.slice((subject.index ?? 0) + subject[0].length)
    // 紧邻形式 A：`模型 已下线` / `model "gpt-5.6-astra" does not exist`
    // 中间只允许**引号/逗号/空格**等收尾符号，不允许隔一整个子句。
    if (new RegExp(String.raw`^["'\x60]?[\s,]*${GONE_TAIL.source}`, 'i').test(tail)) return true
  }
  // 主语 + 显式 id：必须「id 后紧邻不存在语义」。
  // ⚠️ 主语与 id 之间允许「引号 + 空格」的**任意组合**（实测这几种都真实存在）：
  // `The model gpt-5.6-astra does not exist`（无引号）/
  // `model "x" does not exist`（双引号紧贴）/
  // `` The model `x` does not exist ``（反引号**两侧都有空格**）。
  // 写成 `["'\x60]?\s+` 会漏掉最后一种 —— `?` 可选导致 `\s+` 必须紧邻单词字符。
  for (const subject of message.matchAll(new RegExp(String.raw`(?:model|模型)[\s"'\x60]*(${TOKEN})`, 'gi'))) {
    const tail = message.slice((subject.index ?? 0) + subject[0].length)
    if (new RegExp(String.raw`^["'\x60]?[\s,]*${GONE_TAIL.source}`, 'i').test(tail)) return true
  }
  return false
}

/**
 * 「与模型无关」的排除词：命中则**不记**。
 *
 * 限流 / 额度 / 认证失败都可能带 `model` 字样（例如「该模型额度已用尽」），
 * 但它们说明的是**账号**状态，不是模型下架 —— 记错了会把可用模型藏起来。
 *
 * ⚠️ 英文几个词**必须加 `\b` 词边界**（2026-10-06 复审 !66 实测）：无边界时
 * `quota` / `insufficient` 会命中 `model-quota-v2 does not exist` 这类
 * **正常的下架文案**，把它误杀成「不记」。`expired` 更是必须**带主语**
 * （见下），因为「模型租约到期」也是下架的一种说法。
 *
 * ⚠️ 中文排除词（额度 / 积分 / 余额 / 凭据 …）**不要**收紧：它们的方向是
 * **宁可漏判不可误伤**，与本文件「误判代价不对称」的总原则一致。实测
 * 「模型 qfmodel 已下架，积分不予退还」判 false（漏判）—— 这是**正确**的取舍。
 */
const NOT_GONE_PATTERNS: readonly RegExp[] = [
  /\brate\s*-?\s*limit\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\bquota\b/i,
  /\binsufficient\b/i,
  /\bunauthor|\bforbidden\b|\binvalid\s+(?:token|api\s*key|credential)/i,
  // ⚠️ `expired` 必须**带主语**才算认证失败（`token expired` / `session expired`），
  // 否则会误杀正常的下架文案：`model expired-v3 does not exist`、
  // `the model lease expired`（模型租约到期也是下架的一种说法）。
  /\b(?:token|session|credential|key|auth|lease)\s+(?:has\s+|hasn'?t\s+|is\s+|was\s+)?expired\b/i,
  /\bexpired\s+(?:token|session|credential|key|auth)\b/i,
  /限流|限速|额度|余额|积分|排队|繁忙|未登录|认证|鉴权|凭据/,
]

/** 这些错误码明确与「模型是否存在」无关。 */
const IGNORED_CODES: ReadonlySet<string> = new Set([
  'AUTH',
  'QUOTA_EXCEEDED',
  'RATE_LIMIT',
  'MISSING_CREDENTIAL',
  'PERMISSION_DENIED',
])

/**
 * 判断一个错误是否构成「该模型已失效」的**阳性证据**。
 *
 * @param error - 适配器抛出的错误。
 * @returns true 仅当能确认模型本身不可用（而非账号 / 网络 / 参数问题）。
 */
export function isModelGoneError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && IGNORED_CODES.has(code)) return false
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string' || message.length === 0) return false
  if (NOT_GONE_PATTERNS.some((pattern) => pattern.test(message))) return false
  if (GONE_PATTERNS.some((pattern) => pattern.test(message))) return true
  // 「id + 紧邻的不存在语义」（抗跨句误判的那一条，见 matchesGonePhrase 注释）。
  return matchesGonePhrase(message)
}

/** TTL（毫秒）；0 表示不过期。 */
function ttlMs(): number {
  const raw = process.env.DSH_DEAD_MODEL_TTL_DAYS
  if (raw !== undefined && raw.trim().length > 0) {
    const days = Number(raw.trim())
    if (Number.isFinite(days) && days >= 0) return days * 24 * 60 * 60 * 1000
  }
  return DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000
}

/** 把磁盘内容归一成 {@link DeadModelRecords}（任何形状异常都退化为空表）。 */
function sanitize(parsed: unknown): DeadModelRecords {
  const out: DeadModelRecords = {}
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
  const providers = (parsed as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return out
  for (const [provider, entries] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) continue
    const keep: Record<string, DeadModelRecord> = {}
    for (const [modelId, meta] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof meta !== 'object' || meta === null) continue
      const at = (meta as { at?: unknown }).at
      if (typeof at !== 'string') continue
      const reason = (meta as { reason?: unknown }).reason
      keep[modelId] = {
        at,
        ...typeof reason === 'string' ? { reason } : {},
      }
    }
    if (Object.keys(keep).length > 0) out[provider] = keep
  }
  return out
}

/** 存储后端。 */
interface DeadModelStore {
  readonly kind: 'file' | 'memory'
  load(): DeadModelRecords
  save(records: DeadModelRecords): void
}

/** 仅内存后端：无法定位 dsh home 时的显式降级（与 `MemoryLockStore` 同策）。 */
class MemoryDeadModelStore implements DeadModelStore {
  readonly kind = 'memory' as const
  private records: DeadModelRecords = {}

  load(): DeadModelRecords {
    return this.records
  }

  save(records: DeadModelRecords): void {
    this.records = records
  }
}

/** 文件后端：`$DSH_HOME/channel-pack/dead-models.json`（原子写：tmp + rename）。 */
class FileDeadModelStore implements DeadModelStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): DeadModelRecords {
    try {
      if (!existsSync(this.path)) return {}
      return sanitize(JSON.parse(readFileSync(this.path, 'utf-8')) as unknown)
    } catch (error) {
      // 损坏时按**空表**处理：宁可多显示一个失效模型，也不要因为解析失败
      // 把整张表当成「全部失效」而藏掉可用模型。
      this.logger?.warn(`[channel-pack] 读取 ${this.path} 失败，按无失效记录处理: ${String(error)}`)
      return {}
    }
  }

  save(records: DeadModelRecords): void {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, providers: records }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

/** 进程级后端；`configureDeadModelStore` 可注入（注入前按环境变量懒解析）。 */
let store: DeadModelStore | undefined
/** 内存镜像，避免每次列模型都读盘。 */
let cache: DeadModelRecords | undefined

/** 记日志用的 logger（由 {@link configureDeadModelStore} 注入）。 */
let logger: { warn(message: string): void } | undefined
/**
 * 注入的 ctx（由 {@link configureDeadModelStore} 注入）。
 *
 * ⚠️ **必须用它解析 home**（2026-10-06 复审 !66 实测）：全仓库其余 5 处
 * `resolveChannelPackHome` 调用（`channel-pack-store` / `permanent-lock-store` /
 * `badge-preferences` / `auto-checkin` / `gemini-sigstore`）**全部传真 ctx**，
 * 而 `resolveChannelPackHome` 的第二优先级是 `profileContext.home`、第三才是
 * `$DSH_HOME` ⇒ 传 `undefined` 会**跳过 profile home**，在 profile home 与
 * `$DSH_HOME` 不相等时把本文档写到**另一个目录**，造成
 * 「账号池在 A、失效表在 B」的分裂 —— 正是 `permanent-lock-store.ts:129-133`
 * 明确警告过、必须避免的那类问题。
 * ⚠️ 未注入时（只有单测会这样）退化用空对象：`resolveChannelPackHome` 的
 * `readService` 接受 `unknown`，读不到 `profileContext` 就自然落到
 * `DSH_CHANNEL_PACK_STATE_DIR` / `$DSH_HOME` / `~/.dsh` —— 单测正是靠第一个来源隔离。
 */
let injectedCtx: Context | undefined

function ensureStore(): DeadModelStore {
  if (store !== undefined) return store
  // ⚠️ 传 `injectedCtx`（可能为 undefined，那时才退化到环境变量 / `~/.dsh`）。
  // 不能裸传 `undefined`：那样会永远丢掉 `profileContext.home`。
  // 未注入时（只有单测会这样）用空对象：`readService` 接受 `unknown`，读不到
  // `profileContext` 就自然落到 `DSH_CHANNEL_PACK_STATE_DIR` —— 单测靠它隔离。
  const home = resolveChannelPackHome(injectedCtx ?? ({} as Context))
  if (home === undefined) {
    logger?.warn('[channel-pack] 无法定位 DSH home，已失效模型记录仅存在于内存中')
    store = new MemoryDeadModelStore()
  } else {
    store = new FileDeadModelStore(join(home, 'channel-pack', DEAD_MODELS_FILE), logger)
  }
  return store
}

/**
 * 注入 ctx。
 *
 * 两个用途：**把日志接进 DSH 的 logger**，以及**复用同一份 home 解析**。
 * 不调用也能工作（退化为环境变量解析 + 不记日志），`index.ts` 的 apply 里
 * 调用一次即可 —— 且**必须在任何 `registerXxxLlm` 之前**。
 */
export function configureDeadModelStore(ctx: Context): void {
  logger = ctx.logger
  injectedCtx = ctx
  // ⚠️⚠️ **落盘成功才允许丢弃内存镜像**（2026-10-06 复审实测 + 反向验证）：
  // 本函数在 HMR / fiber 重启时会被再调一次（`llm-register-compat.ts` 的模块头
  // 记录了那个重启竞态）。若无条件 `cache = undefined`，**尚未落盘的记录**就
  // 永久丢失 —— 在**降级路径**（home 定位失败 / 目录不可写，只存在于内存）下
  // 是真实的数据丢失。
  //
  // ⚠️ **判据是「落盘成功」，不是「有记录」**：落盘失败时必须**保留 cache**
  // （新 home 可能仍不可写，清掉就彻底没了）。探针实测：把 `persist()` 的成功
  // 判据去掉后，本用例立刻红（`expected [] to deeply equal ['mem-only']`）。
  if (cache !== undefined && Object.keys(cache).length > 0 && tryPersist()) {
    store = undefined
    cache = undefined
    return
  }
  // home 取决于注入的 ctx，故丢弃既有后端，下次访问时按新 ctx 重建
  //（`cache` 保留：它要么为空，要么是上面未能落盘的那份，绝不能丢）。
  store = undefined
}

/** 写回并报告是否**真的落盘成功**（失败只记日志，不抛）。 */
function tryPersist(prunedCount = 0): boolean {
  try {
    ensureStore().save(cache ?? {})
    if (prunedCount > 0) {
      logger?.warn(`[channel-pack] 已失效模型记录清理 ${prunedCount} 条（超过 TTL）`)
    }
    return true
  } catch (error) {
    logger?.warn(`[channel-pack] 已失效模型记录写入失败: ${String(error)}`)
    return false
  }
}

/** 写回（失败只记日志，不影响调用方）。 */
function persist(prunedCount = 0): void {
  tryPersist(prunedCount)
}

/** 读入并做 TTL 剪枝（结果缓存）。 */
function loadRecords(): DeadModelRecords {
  if (cache !== undefined) return cache
  const raw = ensureStore().load()
  const ttl = ttlMs()
  const now = Date.now()
  const out: DeadModelRecords = {}
  let pruned = 0
  for (const [provider, entries] of Object.entries(raw)) {
    const keep: Record<string, DeadModelRecord> = {}
    for (const [modelId, meta] of Object.entries(entries)) {
      if (ttl > 0) {
        const at = Date.parse(meta.at)
        if (!Number.isFinite(at) || now - at > ttl) {
          pruned++
          continue
        }
      }
      keep[modelId] = meta
    }
    if (Object.keys(keep).length > 0) out[provider] = keep
  }
  cache = out
  if (pruned > 0) persist(pruned)
  return out
}

/**
 * 记录一个「已失效」模型。
 *
 * @param provider - provider id（`product.id`）。
 * @param modelId - 裸模型 id。
 * @param reason - 判据命中的错误文案（排查用）。
 * @returns true 表示这是**新**记录（此前未记过）。
 */
export function recordDeadModel(provider: string, modelId: string, reason?: string): boolean {
  if (provider.length === 0 || modelId.length === 0) return false
  const records = loadRecords()
  const bucket = records[provider] ?? (records[provider] = {})
  if (bucket[modelId] !== undefined) return false
  bucket[modelId] = {
    at: new Date().toISOString(),
    ...reason === undefined ? {} : { reason },
  }
  persist()
  logger?.warn(
    `[channel-pack] 模型 ${provider}/${modelId} 已被判为失效（${reason ?? 'model not found'}），`
    + '此后不再列入模型列表',
  )
  return true
}

/** 取某 provider 的已失效模型 id 集合。 */
export function deadModelIdsFor(provider: string): ReadonlySet<string> {
  const bucket = loadRecords()[provider]
  return bucket === undefined ? new Set<string>() : new Set(Object.keys(bucket))
}

/**
 * 移除失效记录 —— 这是用户**唯一的**自愈路径（`model.clearDead` 端点）。
 *
 * ⚠️ 不清理黑名单：`disabledModels` 是用户的**主动选择**，失效记录是系统推断，
 * 两者语义不同、必须分开清除（否则「重新显示」会顺带把用户特意关着的模型打开）。
 *
 * @param provider - 目标 provider。
 * @param modelId - 指定模型；省略则清空该 provider 的全部失效记录。
 * @returns 实际移除的条目数（0 = 本来就没有记录，属幂等）。
 */
export function clearDeadModels(provider: string, modelId?: string): number {
  if (provider.length === 0) return 0
  const records = loadRecords()
  const bucket = records[provider]
  if (bucket === undefined) return 0
  let removed = 0
  if (modelId === undefined) {
    removed = Object.keys(bucket).length
    delete records[provider]
  } else if (modelId.length > 0 && bucket[modelId] !== undefined) {
    delete bucket[modelId]
    removed = 1
    // 空桶不留痕：否则设置页会多出一个没有模型的下拉组。
    if (Object.keys(bucket).length === 0) delete records[provider]
  }
  if (removed > 0) {
    persist()
    logger?.warn(
      `[channel-pack] 已恢复 ${removed} 个失效模型（${provider}${modelId === undefined ? '' : `/${modelId}`}），`
      + '它们将重新出现在模型列表中',
    )
  }
  return removed
}

/** 从列表里剔除此 provider 的已失效模型（非数组 / 无 id 的条目原样保留）。 */
function filterList(providers: readonly string[], list: unknown): unknown {
  if (!Array.isArray(list) || list.length === 0) return list
  const dead = new Set<string>()
  for (const provider of providers) {
    for (const id of deadModelIdsFor(provider)) dead.add(id)
  }
  if (dead.size === 0) return list
  const kept = list.filter((item) => {
    if (item === null || typeof item !== 'object') return true
    const id = (item as { id?: unknown }).id
    return !(typeof id === 'string' && dead.has(id))
  })
  return kept.length === list.length ? list : kept
}

/**
 * 记录归属的 provider：`prepareCall(provider, …)` 与 `stream(options)` 都带 provider，
 * 故**按本次请求实际的 provider 归属**。
 *
 * @param ids - 本适配器注册的 provider id 列表。
 * @param candidate - 本次请求的 provider；不在 ids 内则回退到第一条路由。
 */
function ownerOf(ids: readonly string[], candidate: unknown): string {
  return typeof candidate === 'string' && ids.includes(candidate) ? candidate : ids[0]!
}

/** 适配器里本模块需要包装的成员（其余原样透传）。 */
interface PrunableAdapter {
  listModels?: (...args: unknown[]) => unknown
  listAllModels?: (...args: unknown[]) => unknown
  stream?: (options: { model?: unknown, provider?: unknown }) => unknown
  prepareCall?: (...args: unknown[]) => unknown
}

/** `prepareCall` 的返回值形状（dsh-llm 的 `PreparedAdapterCall`）。 */
interface PreparedAdapterCall {
  model: unknown
  stream: (options: { model?: unknown }) => AsyncIterable<unknown>
  [key: string]: unknown
}

/**
 * 包装一个异步可迭代流：迭代中抛出的错误若判定为「模型已失效」则记录，
 * **再原样抛出**（不吞错误 —— 调用方仍要看到失败，且 harness 的重试分类
 * 依赖原始错误码）。
 *
 * @param provider - 记录时归属的 provider id。
 * @param inner - 原适配器产出的流。
 * @param modelId - 本次请求的模型 id（用于写进失效表）。
 */
function trackStream(
  provider: string,
  inner: AsyncIterable<unknown>,
  modelId: unknown,
): AsyncGenerator<unknown> {
  return (async function* tracked(): AsyncGenerator<unknown> {
    try {
      yield* inner
    } catch (error) {
      if (typeof modelId === 'string' && isModelGoneError(error)) {
        recordDeadModel(provider, modelId, (error as { message?: string }).message)
      }
      throw error
    }
  })()
}

/**
 * 用「已失效模型」剔除包装一个适配器。
 *
 * 包装四处（其余原样透传）：
 *
 * - `listModels` —— 异步，等结果后过滤；
 * - `listAllModels` —— **必须保持同步**（`channel-pack-rpc` 的 `ModelCatalogSource`
 *   契约要求同步且消费者不 await，改成 async 会抛 `all is not iterable`）；
 * - `stream` —— 捕获迭代中抛出的错误，判定后记录，再原样抛出；
 * - **`prepareCall`** —— ⚠️ **这是生产环境唯一真正会走到的路径**（见下）。
 *
 * ## ⚠️⚠️ 为什么必须包 `prepareCall`（致命缺陷，2026-10-06 复审 !66 实测）
 *
 * 本仓库全部 14 个适配器的 `prepareCall` 都是这个形状：
 *
 * ```ts
 * async prepareCall(provider, model, signal) {
 *   return { model: await this.resolveModel(...), stream: (options) => this.stream(options) }
 * }
 * ```
 *
 * `prepareCall` 被 `bind` 到**原始对象**，故 `this` 是原对象，`this.stream` 拿到的是
 * **原始 stream** —— 完全绕过 Proxy 的 `stream` 拦截。而 dsh-llm 的两条运行时路径
 * **只走 prepareCall**：
 *
 * - `node_modules/@deepseek-ai/dsh-llm/lib/index.js:1597` → `adapterCall.stream(options)`
 * - 同文件 `:1667` → `dispatch = (options) => adapterCall.stream(options)`
 *
 * ⇒ 只包 `stream` 时，**失效模型永远不会被记录**（实测确认）。
 *
 * ⚠️ **只包 `prepareCall` 本身也不够**：真实错误发生在 `call.stream(options)` 的
 * **迭代过程中**（dsh-llm `:1691` `iterator = dispatch(...)[Symbol.asyncIterator]()`，
 * `:1701` `iterator.next()`），不是 `prepareCall` 自己抛的。故必须包装
 * **返回的那个 `call.stream`**。
 *
 * @param providers - 该适配器注册的 provider id 列表。
 * @param adapter - 适配器实例。
 */
export function withDeadModelPruning<T extends object>(
  providers: readonly string[],
  adapter: T,
): T {
  const ids = providers.filter((id) => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) return adapter

  const target = adapter as PrunableAdapter & object
  const bound = new Map<PropertyKey, unknown>()
  /** 懒建一次并缓存，保证每次访问返回同一个函数（下游按函数身份缓存时不会失配）。 */
  const wrapOnce = <K extends PropertyKey>(key: K, make: () => unknown): unknown => {
    if (!bound.has(key)) bound.set(key, make())
    return bound.get(key)
  }

  return new Proxy(adapter, {
    get(obj, prop, receiver) {
      if (prop === 'listModels' && typeof target.listModels === 'function') {
        return wrapOnce(prop, () => async (...args: unknown[]): Promise<unknown> =>
          filterList(ids, await target.listModels!.apply(obj, args)))
      }
      if (prop === 'listAllModels' && typeof target.listAllModels === 'function') {
        return wrapOnce(prop, () => (...args: unknown[]): unknown =>
          filterList(ids, target.listAllModels!.apply(obj, args)))
      }
      if (prop === 'stream' && typeof target.stream === 'function') {
        return wrapOnce(prop, () => (options: { model?: unknown, provider?: unknown }): unknown =>
          trackStream(
            ownerOf(ids, options?.provider),
            target.stream!.apply(obj, [options]) as AsyncIterable<unknown>,
            options?.model,
          ))
      }
      if (prop === 'prepareCall' && typeof target.prepareCall === 'function') {
        return wrapOnce(prop, () => async (...args: unknown[]): Promise<unknown> => {
          const call = await target.prepareCall!.apply(obj, args) as PreparedAdapterCall
          if (call === null || typeof call !== 'object' || typeof call.stream !== 'function') return call
          // ⚠️ 关键：包装的是**返回的 call.stream**，不是 prepareCall 自身。
          // `prepareCall(provider, model, signal)` 的第一个实参就是 provider ——
          // 用它归属，跨 provider 误过滤才不会发生（当前 14 处注册都是单元素，
          // 但 filterList 按全部 ids 取并集，两处口径必须一致）。
          return {
            ...call,
            stream: (options: { model?: unknown, provider?: unknown }): AsyncIterable<unknown> =>
              trackStream(
                // dispatch 时的 options.provider 更贴近真实路由（dsh-llm 会带上）；
                // 没有或不在 ids 内才回退到 prepareCall 的实参，最后才回退 ids[0]。
                ownerOf(ids, options?.provider ?? args[0]),
                call.stream(options),
                options?.model,
              ),
          }
        })
      }
      // 其余成员原样透传；方法需绑定原对象作为 this。
      // 缓存绑定结果：每次访问返回同一个函数，避免下游比较函数身份时失配。
      const value = Reflect.get(obj, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      return wrapOnce(prop, () => value.bind(obj))
    },
  })
}
