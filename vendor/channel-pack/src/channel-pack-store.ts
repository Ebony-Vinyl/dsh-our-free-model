/**
 * Channel Pack 状态持久化（账号索引 + 模型黑名单）。
 *
 * ## 为什么不能再用 settings namespace
 *
 * DSH ≤0.1.6：`ctx.settings` 是 SettingsProvider，插件用
 * `settings.register(ns, schema)` 拿到 owner scope（`get()` / `replace()`），
 * 数据落在 `$DSH_HOME/settings.yaml` 的 `channel-pack:` 段。
 *
 * DSH 0.1.7-rc.1：`ctx.settings` 换成 **SettingsForms** —— **没有 `register`**。
 * 表单命名空间只能是 **profile 条目 id**，且只投影该条目 Config 中标了
 * `.volatile()` 的字段（见 `@deepseek-ai/dsh-settings` 的 `SettingsForms`）。
 * 于是早期写法 `settings.register(...)` 在 0.1.7 上恒走
 * `typeof settings.register !== 'function'` 分支，账号列表与模型黑名单
 * **退化为纯内存**（真实缺陷：Gitee issue IKI7WT ——「DSH 0.1.7 移除
 * `settings.register()` 后，账号列表与模型黑名单无法持久化」；启动日志实证
 * `[channel-pack] settings 服务不可用，账号列表仅存在于内存中`）。
 *
 * ## 现在的策略：按能力探测两条后端
 *
 * 1. `settings.register` 可用（老 DSH）→ **沿用旧契约**，行为与数据位置完全不变；
 * 2. 否则（0.1.7+）→ 插件自有 JSON 文档 `$DSH_HOME/channel-pack/state.json`，
 *    同步读 + 原子写（tmp + rename）。
 * 3. 两者都不可用（headless / 单测替身缺服务）→ 仅内存，并**显式告警**。
 *
 * ## 为什么不把状态塞进插件 Config
 *
 * 0.1.7 的 settings 表单确实能持久化「本条目 Config 的 volatile 字段」，但
 * 账号索引与**限流重置时间戳**是运行时状态：限流每命中一次就要写一次，
 * 而写 Config 会改写 profile 的 `cordis.patch.yml` 并触发 Loader 协调 ——
 * 把易变的运行时数据混进用户手写的配置层，代价与风险都不划算。
 * 这里与 `src/models.ts` 的 `~/.cache/deveco/*.json` 是同一思路（本插件既有的
 * 文件持久化惯例）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { ProviderAccountEntry } from './types.js'
import { hasLegacyNamespaceRegistration, readService, settingsOf } from './settings-compat.js'

/** Channel Pack schema namespace（老契约的 settings 命名空间名）。 */
export const CHANNEL_PACK_NS = 'channel-pack'

/**
 * 模型黑名单：provider id → **被关闭**的模型 id → true。
 *
 * **黑名单制**：只有键存在且为 `true` 的模型被隐藏，未记录的模型默认打开。
 */
export type ModelDisableMap = Record<string, Record<string, boolean>>

/** 各 provider 的「锁定永久积分」开关：provider id → 已锁定。 */
export type PermanentLockMap = Record<string, boolean>

/** 持久化文档结构（两种后端共用）。 */
export interface ChannelPackState {
  accounts: ProviderAccountEntry[]
  disabledModels: ModelDisableMap
  /**
   * Loomy「锁定永久积分」开关 —— **镜像字段，不是权威**。
   *
   * 权威值在 `$DSH_HOME/channel-pack/permanent-locks.json`（见
   * `src/permanent-lock-store.ts`）。本字段仍**继续同源写出**，理由有两条：
   *
   * 1. **同机多 profile**：`state.json` 是 dsh home 级共享文档，另一条工作区里
   *    的**旧版本代码**只认这一个字段（它读它、也原样写回它）。镜像保持一致，
   *    web / tui / headless 侧的 Loomy 锁定才不会与 desktop 侧脱节；
   * 2. **升级前的磁盘状态只有本字段**：新文档不存在时要靠它把老用户的锁定
   *    迁移进来（迁移判据见 `permanent-lock-store.ts` —— 只在**新文档不存在**时
   *    生效，避免把已解除的锁定重新打开）。
   *
   * ⚠️ 反过来，**新字段绝不能只住在这里**：本文档是整体替换语义，旧代码全量
   * 重写时不会携带它不认识的任何键 —— 把锁定表放这儿会被静默抹掉，而解锁的
   * 后果是真把永久积分烧掉（不可撤回）。这正是把表拆到独立文档的原因。
   */
  loomyPermanentLocked?: boolean
  /**
   * 本机 OpenAI 网关开关（`false` = 不启动网关）。
   *
   * ⚠️ 与 `loomyPermanentLocked` 不同，这个字段**可以**住在这里、不需要独立
   * 文档：老版本代码整体重写 `state.json` 时会丢掉本键，后果仅仅是**网关回到
   * 默认启用**，用户再关一次即可 —— 没有任何不可逆后果（对照 `loomyPermanentLocked`
   * 丢失会把「永久积分已锁定」静默变成「已解锁」，那才是灾难）。
   *
   * 缺键语义为**启用**：老用户升级后行为与升级前完全一致。
   */
  gatewayEnabled?: boolean
  /**
   * 供应商自定义显示顺序（「供应商开关」弹窗的拖拽排序，2026-10-06）。
   *
   * ⚠️ 与 `gatewayEnabled` 同级、**可以**住在这里：老版本代码整体重写
   * `state.json` 时丢掉本键的后果仅仅是**顺序回到声明顺序**——纯展示偏好，
   * 可逆、重拖一次即恢复（对照 `loomyPermanentLocked` 的不可逆性，那才需要
   * 独立文档）。缺键 / 空数组语义为「未自定义」。
   *
   * 数组含**全部**供应商 id：拖拽提交时 = 拖后的「已打开」序列 + 已关闭的
   * 按声明序缀尾。展示侧（`plugin-src/client/provider-toggle.js` 的
   * `sortOpenProvidersByOrder`）对数组中不认识 / 缺失的 id 都有稳定兜底，
   * 故插件跨版本增删 provider 时不需要任何迁移。
   */
  providerOrder?: string[]
}

/** 持久化后端的能力标识，供调用方决定要不要告警。 */
export type ChannelPackStoreKind = 'settings' | 'file' | 'memory'

/** Channel Pack 状态存取接口（同步读、异步写）。 */
export interface ChannelPackStore {
  readonly kind: ChannelPackStoreKind
  /** 同步载入；文档不存在时返回 `undefined`（等价于"空"）。 */
  load(): ChannelPackState | undefined
  /** 整体写入（账号与黑名单必须同时携带，见 AccountPool 的说明）。 */
  save(state: ChannelPackState): Promise<void>
}

/** settings scope 的最小接口（只用到 get/replace）。 */
interface SettingsScopeLike {
  get(): unknown
  replace(section: object): Promise<void>
}

/** 老契约的 schema：必须是 schemastery（`plainSchema` 会调 `toJSON()`）。 */
const channelPackSchema = Schema.object({
  accounts: Schema.array(Schema.any()).default([]),
  disabledModels: Schema.dict(Schema.any()).default({}),
  loomyPermanentLocked: Schema.boolean().default(false),
  gatewayEnabled: Schema.boolean().default(true),
  providerOrder: Schema.array(Schema.string()).default([]),
})

/**
 * 归一化「本机 OpenAI 网关」开关。
 *
 * 判据与 `sanitizePermanentLocks` 相反：**只有显式 `false` 才算停用**，
 * 其余（缺键 / `true` / 字符串 / 对象 / 数组）一律按启用处理。
 *
 * ⚠️ 方向不能反。文档缺失、被手工编辑成脏值、或老版本代码整体重写时丢了本键，
 * 都必须**回到默认启用** —— 那正是升级前的行为；反过来（只认 `true`）会让
 * 任何一次读取失败都变成「网关被静默关闭」，而用户根本不知道自己关过它。
 */
export function sanitizeGatewayEnabled(raw: unknown): boolean {
  return raw !== false
}

/**
 * 归一化供应商自定义显示顺序（{@link ChannelPackState.providerOrder}）。
 *
 * 只保留非空字符串 id 并**去重**（保留首次出现位置）；非数组一律视为
 * 「无自定义顺序」（空数组）。⚠️ 这里**不做** provider 合法性校验：
 * 合法集合随插件版本变化，在此过滤会让「新版本加入 provider → 被旧版本
 * 代码重写文档」场景下的顺序无法保留 —— 展示层对数组中不认识 / 缺失的
 * id 自带稳定兜底，脏条目天然无害。
 */
export function sanitizeProviderOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * 归一化「锁定永久积分」开关表。
 *
 * 与 `sanitizeDisabledModels` 同款口径：**只保留显式 `true`**，其余值（`false` /
 * 字符串 / 对象）一律丢弃 —— 于是「缺键」与「值为 false」在语义上完全一致
 * （未锁定），文档也不会随开关操作累积噪音。
 * ⚠️ 单测专门覆盖「`{ loomy: 'yes' }` 不得判成已锁定」这一类脏数据。
 */
export function sanitizePermanentLocks(raw: unknown): PermanentLockMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: PermanentLockMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === true && provider.length > 0) result[provider] = true
  }
  return result
}

/**
 * 把**老的单字段**并进锁定表 —— 仅用于「独立文档尚不存在」的那一次迁移。
 *
 * 背景：锁定开关早于 `permanent-locks.json` 存在，住在 state.json 的
 * `loomyPermanentLocked` 里，老用户磁盘上只有它。不并进来的话，升级后 Loomy 的
 * 锁定会**静默消失**（用户看到的是「永久积分被烧掉了」且毫无提示）——
 * 那是最坏的一类回归。
 *
 * ⚠️ 调用方**只能在新文档不存在时**用它（`PermanentLockStore.load()` 的
 * `exists: false`）。新文档一旦存在就以它为准：否则用户在 desktop 里解锁 Loomy
 * 之后（表里没有 `loomy` 键 = 未锁定），只要镜像字段因为任何原因还留着
 * `true`，锁定就会被重新打开 —— 那种"解不掉"的开关比丢状态更难排查。
 */
export function mergeLegacyLoomyLock(
  locks: PermanentLockMap,
  legacyLoomyLocked: unknown,
): PermanentLockMap {
  if (locks.loomy === undefined && legacyLoomyLocked === true) return { ...locks, loomy: true }
  return locks
}

/**
 * 把读到的原始值归一化为 {@link ModelDisableMap}。
 *
 * 文档可能被手工编辑过、或残留老版本格式（如数组），因此逐层校验：任何一层
 * 不是对象就丢弃那一层，只保留「provider → 模型 → true」。**只把显式 `true`
 * 视为关闭**，其余值一律忽略，避免与 `disabledModelsFor` 的判定产生分歧。
 */
export function sanitizeDisabledModels(raw: unknown): ModelDisableMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ModelDisableMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const perProvider: Record<string, boolean> = {}
    for (const [modelId, flag] of Object.entries(value as Record<string, unknown>)) {
      if (flag === true) perProvider[modelId] = true
    }
    // 空表不保留：不让文档里留下 `{ provider: {} }` 这类无意义噪音。
    if (Object.keys(perProvider).length > 0) result[provider] = perProvider
  }
  return result
}

/**
 * 归一化账号条目数组。
 *
 * 判据刻意保守：只保留同时具备 `id` / `provider` / `credentialRef` 三个非空
 * 字符串的条目 —— 缺任何一个都无法解析凭据，留着只会在选号时反复失败。
 * 其余字段按原样透传（`enabled` / `modelRateLimits` 等由下游各自判空）。
 */
export function sanitizeAccounts(raw: unknown): ProviderAccountEntry[] {
  if (!Array.isArray(raw)) return []
  const accounts: ProviderAccountEntry[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const candidate = entry as Partial<ProviderAccountEntry>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) continue
    if (typeof candidate.provider !== 'string' || candidate.provider.length === 0) continue
    if (typeof candidate.credentialRef !== 'string' || candidate.credentialRef.length === 0) continue
    accounts.push({
      ...candidate,
      enabled: candidate.enabled !== false,
      refreshable: candidate.refreshable !== false,
      nickname: typeof candidate.nickname === 'string' ? candidate.nickname : candidate.id,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    } as ProviderAccountEntry)
  }
  return accounts
}

/** 老契约后端：数据仍在 settings 文档里（与 ≤0.1.6 完全一致）。 */
class SettingsStore implements ChannelPackStore {
  readonly kind = 'settings' as const

  constructor(private readonly scope: SettingsScopeLike) {}

  load(): ChannelPackState | undefined {
    const value = this.scope.get() as
      | {
        accounts?: unknown
        disabledModels?: unknown
        loomyPermanentLocked?: unknown
        gatewayEnabled?: unknown
        providerOrder?: unknown
      }
      | undefined
    if (value === undefined || value === null) return undefined
    return {
      accounts: sanitizeAccounts(value.accounts),
      disabledModels: sanitizeDisabledModels(value.disabledModels),
      // 只是**镜像**（权威表在 permanent-locks.json）；老文档没这个键 → false。
      loomyPermanentLocked: value.loomyPermanentLocked === true,
      // 老文档没这个键 → 启用，与升级前行为一致。
      gatewayEnabled: sanitizeGatewayEnabled(value.gatewayEnabled),
      // 老文档没这个键 → 空数组（未自定义），展示侧按声明顺序渲染。
      providerOrder: sanitizeProviderOrder(value.providerOrder),
    }
  }

  async save(state: ChannelPackState): Promise<void> {
    await this.scope.replace({
      accounts: state.accounts,
      disabledModels: state.disabledModels,
      // 镜像字段由 AccountPool 与独立文档**同源写出**：同机上只认这个字段的
      // 旧版本代码（其它 profile）读它、也会原样写回它，故两边不会脱节。
      loomyPermanentLocked: state.loomyPermanentLocked === true,
      // 开关丢失只会让网关回到默认启用（可逆），故接受老版本重写时丢掉本键。
      gatewayEnabled: state.gatewayEnabled !== false,
      // 顺序丢失只会回到声明顺序（可逆，重拖一次即恢复），同理接受丢失。
      providerOrder: state.providerOrder ?? [],
    })
  }
}

/** 仅内存后端：两个持久化后端都不可用时的显式降级。 */
class MemoryStore implements ChannelPackStore {
  readonly kind = 'memory' as const
  private state: ChannelPackState | undefined

  load(): ChannelPackState | undefined {
    return this.state
  }

  async save(state: ChannelPackState): Promise<void> {
    this.state = state
  }
}

/**
 * provider id ↔ 凭据 ref 前缀的**单一真相源**。
 *
 * 账号凭据一律存 `{PREFIX}_ACCOUNT_{UUID_SHORT}`（本插件的既有约定），故可据
 * ref 名反推 provider。**表与正则都由本表派生** —— 这是刻意的：
 *
 * ⚠️ 表与正则分家会漂移出「加了 provider 却漏改正则」这类缺陷。真实缺陷（**同型两次**）：
 *
 * ① 本表原先只有 **6 项**（注释也写着「六个 provider」），而插件实际有 **11 个**
 * —— `qodercn` / `cline` / `loomy` / `raccoon` / `zcode` 五个 provider 的账号在
 * `state.json`（Channel Pack 状态文档）缺失时（重装 / 迁移 / profile 重建）
 * **无法从 `.credentials.yaml` 的 `refs:` 恢复**，用户侧表现为「重装 / 迁移后
 * 这几个面板的账号凭空消失，只能重新登录」。凭据本体一直完好，只是索引建不出来。
 *
 * ② **2026-10-02 同型复发**：上游合并第 12 个 provider `minimax` 时**又漏加了本表**
 * —— `tests/unit/channel-pack-store.spec.ts` 的派生用例当场变红（期望 12 项、实得 11 项），
 * 但那条用例没在合并前跑到。⇒ 教训：**合并任何「新增 provider」的分支前先跑它**；
 * 靠人眼维护本表已经漏过两次。
 *
 * ⚠️ **必须与 `src/channel-pack-rpc.ts` 的 `account.create` 生成的 ref 前缀一致**
 * （那里是 `${provider.toUpperCase()}_ACCOUNT_${suffix}`）。**新增 provider 时
 * 漏加本表 = 该 provider 的账号在状态文档丢失后静默消失**。
 *
 * ⚠️ 本表的顺序与客户端 `plugin-src/client/channel-pack.js` 的 `PROVIDERS` **保持一致** ——
 * 派生用例不校验顺序（恢复顺序由 refs 文件决定），但两者对齐后便于逐项核对。
 */
const REF_PREFIX_TO_PROVIDER: ReadonlyArray<readonly [string, string]> = [
  ['LOBSTERAI', 'lobsterai'],
  ['QODER', 'qoder'],
  ['QODERCN', 'qodercn'],
  ['TRAE', 'trae'],
  ['CLINE', 'cline'],
  ['LOOMY', 'loomy'],
  ['RACCOON', 'raccoon'],
  // ⚠️ 第 12 个 provider（上游 2026-10-02 合并）—— 曾漏加，见上方注释 ②。
  ['MINIMAX', 'minimax'],
  ['ZCODE', 'zcode'],
  // ⚠️ 第 13 个 provider（opencode，2026-10-01）—— 与上面 minimax 同款坑：
  // 漏加会让「恢复备份」认不出 opencode 账号（见上方注释 ②）。
  ['OPENCODE', 'opencode'],
  // ⚠️ 第 14 个 provider（gemini，2026-10-03）—— 同款坑第 **三** 次。
  // 漏加 = `GEMINI_ACCOUNT_*` 的账号在 `state.json` 缺失时静默消失
  //（凭据还在 `.credentials.yaml` 里，只是索引建不出来，用户只能重新授权）。
  // 本表与客户端 `PROVIDERS` 的一致性由
  // `tests/unit/channel-pack-store.spec.ts` 的「恢复表覆盖客户端 PROVIDERS 的全部
  // provider（从真实清单派生）」用例锁死 —— 合并新增 provider 前**先跑它**。
  ['GEMINI', 'gemini'],
]

/** 已实现渠道的统一判定，拒绝未知渠道且不依赖旧产品黑名单。 */
export function isSupportedProvider(provider: unknown): provider is string {
  return typeof provider === 'string' && REF_PREFIX_TO_PROVIDER.some(([, id]) => id === provider)
}

/** 账号凭据 ref 形态：`{PREFIX}_ACCOUNT_{HEX}`（前缀由单一真相源派生）。 */
const ACCOUNT_REF_RE = new RegExp(
  // ⚠️ 按前缀长度**降序**排列：`QODERCN` 必须排在 `QODER` 之前。虽然正则的
  // 回溯最终仍能让 `QODERCN_*` 匹配成功（所以顺序错了也**暂时**看不出问题），
  // 但那时匹配结果就取决于引擎的尝试顺序而非规则 —— 一旦将来加入更多同前缀的
  // provider（如 `QODERX`），就会变成静默错归属：账号挂到 `qoder` 面板，而它的
  // 凭据是 CN 的，请求必然失败。故这里显式定序，而非依赖回溯。
  `^(${REF_PREFIX_TO_PROVIDER
    .map(([prefix]) => prefix)
    .sort((a, b) => b.length - a.length)
    .join('|')})_ACCOUNT_([0-9A-Fa-f]{6,})$`,
)

/**
 * 从 `.credentials.yaml` 的 `refs:` 段提取 ref 名（**只取键名，不读值**）。
 *
 * 判据用「缩进 ≥2 且以大写标识符开头」，并在回到顶格键时结束 —— 凭据文件是
 * 本插件**只能读不能依赖**的外部文档，故这里只做最小、保守的文本扫描，
 * 不引入 YAML 依赖（运行时不保证可解析，实证：`yaml`/`js-yaml` 从本包
 * 均不可解析）。
 */
function extractCredentialRefNames(text: string): string[] {
  const names: string[] = []
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(line)) break
    const match = /^\s{2,}([A-Z][A-Z0-9_]*):/.exec(line)
    if (match?.[1] !== undefined) names.push(match[1])
  }
  return names
}

/** 由一个账号凭据 ref 合成账号条目（昵称缺失时退回账号 id）。 */
function accountFromCredentialRef(ref: string): ProviderAccountEntry | undefined {
  const match = ACCOUNT_REF_RE.exec(ref)
  if (match === null) return undefined
  const prefix = match[1]
  const suffix = match[2]
  if (prefix === undefined || suffix === undefined) return undefined
  // 查表也走同一份真相源：正则捕获组只证明「前缀被登记过」，provider 仍由表给出，
  // 避免这里再写一份「前缀 → provider」的映射。
  const provider = REF_PREFIX_TO_PROVIDER.find(([candidate]) => candidate === prefix)?.[1]
  if (provider === undefined) return undefined
  const id = `${provider}-${suffix.toLowerCase()}`
  return {
    id,
    provider,
    nickname: id,
    enabled: true,
    credentialRef: ref,
    createdAt: Date.now(),
    refreshable: true,
  }
}

/** 文件后端：`$DSH_HOME/channel-pack/state.json`（原子写）。 */
class FileStore implements ChannelPackStore {
  readonly kind = 'file' as const

  constructor(
    /** DSH home（状态目录与旧凭据文件都相对它定位）。 */
    private readonly home: string,
    /** 状态文档绝对路径。 */
    private readonly path: string,
    private readonly logger: { warn(message: string): void; info(message: string): void } | undefined,
  ) {}

  load(): ChannelPackState | undefined {
    try {
      if (!existsSync(this.path)) return this.bootstrapFromCredentialRefs()
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const value = parsed as {
        accounts?: unknown
        disabledModels?: unknown
        loomyPermanentLocked?: unknown
        gatewayEnabled?: unknown
        providerOrder?: unknown
      }
      return {
        accounts: sanitizeAccounts(value.accounts),
        disabledModels: sanitizeDisabledModels(value.disabledModels),
        // 只是镜像（权威表在 permanent-locks.json）；老文档没这个键 → false。
        loomyPermanentLocked: value.loomyPermanentLocked === true,
        // 老文档没这个键 → 启用，与升级前行为一致。
        gatewayEnabled: sanitizeGatewayEnabled(value.gatewayEnabled),
        // 老文档没这个键 → 空数组（未自定义），展示侧按声明顺序渲染。
        providerOrder: sanitizeProviderOrder(value.providerOrder),
      }
    } catch (error) {
      this.logger?.warn(`[channel-pack] 读取 ${this.path} 失败，本次以空列表启动: ${String(error)}`)
      return undefined
    }
  }

  async save(state: ChannelPackState): Promise<void> {
    this.write(state)
  }

  private write(state: ChannelPackState): void {
    mkdirSync(join(this.home, 'channel-pack'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }

  /**
   * 首次启动的数据恢复（**仅在状态文档不存在时**执行一次）。
   *
   * 背景：0.1.7 启动时 `SettingsForms.importLegacyDocument()` 把
   * `$DSH_HOME/settings.yaml` 改名为 `settings.yaml.imported`，并按「section id
   * = profile 条目 id」逐段导入 —— `channel-pack` 不对应任何条目，该段导入失败、
   * 只留在改名后的文件里。于是老用户的账号索引成了孤儿（凭据本体仍在
   * `.credentials.yaml` 中，完好无损）。
   *
   * 这里据凭据 ref 名重建索引：能恢复「有哪些账号、属于哪个 provider、用哪个
   * credentialRef」，**恢复不了**昵称/顺序/限流时间戳（那三项只在旧 settings
   * 文档里，而本项目没有 YAML 解析依赖）。重建结果立即落盘，故只做一次。
   */
  private bootstrapFromCredentialRefs(): ChannelPackState | undefined {
    const credentialsPath = join(this.home, '.credentials.yaml')
    try {
      if (!existsSync(credentialsPath)) return undefined
      const accounts = extractCredentialRefNames(readFileSync(credentialsPath, 'utf-8'))
        .flatMap(ref => accountFromCredentialRef(ref) ?? [])
      if (accounts.length === 0) return undefined
      const state: ChannelPackState = {
        accounts,
        disabledModels: {},
        // 凭据文件里没有任何锁定信息 → 镜像写 false（权威表另有其文档）。
        loomyPermanentLocked: false,
        // 恢复出的文档本来就不含任何开关信息 → 启用（与全新安装一致）。
        gatewayEnabled: true,
        // 凭据文件里也没有顺序信息 → 空数组（未自定义，与全新安装一致）。
        providerOrder: [],
      }
      try {
        this.write(state)
      } catch (error) {
        this.logger?.warn(`[channel-pack] 恢复出的账号未能落盘（仅本次有效）: ${String(error)}`)
      }
      this.logger?.info(
        `[channel-pack] 已从 .credentials.yaml 恢复 ${accounts.length} 个账号`
        + '（昵称/顺序/限流标记无法恢复；旧数据仍在 settings.yaml.imported 的 channel-pack 段）',
      )
      return state
    } catch (error) {
      this.logger?.warn(`[channel-pack] 账号恢复失败（忽略）: ${String(error)}`)
      return undefined
    }
  }
}

/**
 * 解析状态文档所在目录。
 *
 * 优先级：`DSH_CHANNEL_PACK_STATE_DIR`（单测隔离用）→ `profileContext.home`
 * → `$DSH_HOME` → `~/.dsh`。与 `dsh-home-paths` 的 `resolveDshHome` 同序。
 *
 * ⚠️ `ctx` **必传**（2026-10-06 复审 !66 收紧）：本函数是**所有**插件状态文档
 * （`state.json` / `permanent-locks.json` / `badge-preferences` / `auto-checkin` /
 * `gemini-sigstore` / `dead-models`）的**唯一** home 解析入口，必须保证它们落在
 * 同一目录。PR !66 曾把它放宽成可选、并在 `dead-model-store` 里传 `undefined` ——
 * 那会**跳过优先级更高的 `profileContext.home`**，在 profile home 与 `$DSH_HOME`
 * 不相等时把失效表写到另一个目录，造成「账号池在 A、失效表在 B」的分裂，
 * 正是 `permanent-lock-store.ts:129-133` 明确警告过必须避免的情况。
 */
export function resolveChannelPackHome(ctx: Context): string | undefined {
  const override = process.env.DSH_CHANNEL_PACK_STATE_DIR
  if (override !== undefined && override.trim().length > 0) return override.trim()
  const profileHome = (readService(ctx, 'profileContext') as { home?: unknown } | undefined)?.home
  if (typeof profileHome === 'string' && profileHome.length > 0) return profileHome
  const envHome = process.env.DSH_HOME
  if (envHome !== undefined && envHome.trim().length > 0) return envHome.trim()
  return join(homedir(), '.dsh')
}

/**
 * 按能力探测创建持久化后端（见文件头）。
 *
 * 顺序刻意是「老契约优先」：在 ≤0.1.6 上必须继续把数据写在 settings 文档里，
 * 否则升级/回退版本会看到两套互不相识的数据。
 */
export function createChannelPackStore(ctx: Context): ChannelPackStore {
  const settings = settingsOf(ctx)
  if (hasLegacyNamespaceRegistration(settings) && settings !== undefined) {
    try {
      const scope = (settings.register as NonNullable<typeof settings.register>)(CHANNEL_PACK_NS, channelPackSchema)
      return new SettingsStore(scope as SettingsScopeLike)
    } catch (error) {
      // 重复注册（插件热重载）等：退回文件后端，而不是降级为内存。
      ctx.logger?.warn?.(`[channel-pack] settings namespace 注册失败，改用本地状态文档: ${String(error)}`)
    }
  }
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[channel-pack] 无法定位 DSH home，账号列表与模型黑名单仅存在于内存中')
    return new MemoryStore()
  }
  return new FileStore(home, join(home, 'channel-pack', 'state.json'), ctx.logger)
}
