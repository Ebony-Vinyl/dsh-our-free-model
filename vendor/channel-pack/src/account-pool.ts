import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { BuddyCredential } from './buddy.js'
import type { BuddyProduct } from './product.js'
import { createChannelPackStore, mergeLegacyLoomyLock, sanitizeAccounts, sanitizeDisabledModels, sanitizePermanentLocks } from './channel-pack-store.js'
import type { ChannelPackStore, ChannelPackState, ModelDisableMap, PermanentLockMap } from './channel-pack-store.js'
import { createPermanentLockStore } from './permanent-lock-store.js'
import type { PermanentLockStore } from './permanent-lock-store.js'
import type {
  CodeArtsCredential,
  ProviderAccountEntry,
  ProviderAccountStatus,
} from './types.js'

// 兼容既有的导入路径：命名空间名与黑名单类型原本定义在本模块。
export { CHANNEL_PACK_NS } from './channel-pack-store.js'
export type { ModelDisableMap } from './channel-pack-store.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    accountPool: AccountPool
  }
}

/**
 * 空黑名单的共享只读实例。
 *
 * 适配器的 `listModels` 每次都会被模型目录调用，绝大多数 provider/时刻都
 * 没有黑名单；共享同一个冻结集合可以避免每次调用都分配一个新 Set。
 */
const EMPTY_MODEL_SET: ReadonlySet<string> = new Set<string>()

/**
 * 判定「某 provider 的启用账号是否**全部**因目标模型处于限流期」。
 *
 * ## 为什么需要它
 *
 * 选号按 `modelRateLimits[modelId]` 过滤候选（见本类的 `getAvailableAccount`
 * 与 `src/index.ts` 的 `pickBuddyCredential`）。当一个 provider 只有**一个**
 * 启用账号、而它恰好被标记了该模型的限流时，候选集变成空集，调用链一路
 * 返回 `undefined`，最终由适配器抛出「no usable credential; log in from the
 * Channel Pack panel first」—— 而**凭据其实是好的、账号也是启用的**，用户被指去
 * 重新登录，方向完全错。
 *
 * 本函数把这种情形**证明**出来：返回非 `undefined` 即表示「这批账号全都因
 * 该模型受限」，调用方据此报带解禁时刻的明确错误。
 *
 * ⚠️ **判据必须窄**，两条边界都不能松：
 * - 空 `modelId`（未知目标模型）直接返回 `undefined` —— 与选号侧约定一致
 *   （空 modelId 不做限流过滤），否则会把「未登录」误报成「限流」。
 *   这条**不是**冗余守卫：`updateModelRateLimit` 不校验 modelId，理论上可能
 *   落下一个 `modelRateLimits['']` 脏键，没有它就会被当成真实限流上报；
 * - 只要**任一**账号没有该模型的未过期标记，整体即不成立 —— 那种情况下
 *   候选本就非空，轮不到本函数说话。
 *
 * ℹ️ 空 `accounts` 无需单独早退：循环不执行 → `earliest` 保持 `undefined`
 * → 末尾守卫返回 `undefined`。（曾写过一条 `accounts.length === 0` 早退，
 * 反向验证证明它**不可区分**、纯冗余，故删除。）
 *
 * @param accounts - 该 provider 的**启用**账号（调用方负责按 `enabled` 过滤）。
 * @param modelId - 目标模型 id；空串表示不判定。
 * @param now - 当前时刻（毫秒），供测试注入。
 * @returns 最早的解禁时刻与账号数；不满足条件时为 `undefined`。
 */
export function allAccountsRateLimitedForModel(
  accounts: readonly ProviderAccountEntry[],
  modelId: string,
  now: number = Date.now(),
): { resetAtMs: number; accountCount: number } | undefined {
  if (modelId.length === 0) return undefined
  let earliest: number | undefined
  for (const account of accounts) {
    const resetAt = account.modelRateLimits?.[modelId]
    // 与选号侧同一判据：缺标记 / 0 / 已过期都算「不受限」→ 整体不成立。
    if (resetAt === undefined || resetAt === 0 || now >= resetAt) return undefined
    earliest = earliest === undefined ? resetAt : Math.min(earliest, resetAt)
  }
  return earliest === undefined ? undefined : { resetAtMs: earliest, accountCount: accounts.length }
}

/**
 * AccountPool —— 多账号管理核心
 *
 * 职责：
 * - 账号列表 CRUD（索引走 {@link ChannelPackStore}，凭据存于 ctx.credentials，
 *   两者各自独立）
 * - 获取指定 provider + 模型的下一个可用账号
 *   算法：enabled=true 且模型不在重置期内 → 取第一个
 * - 更新模型重置时间（收到限流错误后调用）
 *
 * 持久化后端按 DSH 版本能力探测（见 `src/channel-pack-store.ts`）：0.1.7 起
 * `ctx.settings` 不再允许插件注册 namespace，故改用插件自有状态文档；
 * 两者都不可用时退化为内存态，保证不抛错。
 */
export class AccountPool {
  /** 持久化后端；两个后端都不可用时是仅内存实现。 */
  private readonly store: ChannelPackStore
  /**
   * 账号列表的**权威进程内副本**。
   *
   * 不直接把后端的读取结果当读源：后端的落盘快照在写入后未必立即反映到
   * 下一次读取，而本类的每次写入都是「读 → 改 → 整体写回」。
   * 若以滞后快照为读源，并发/连续的 updateModelRateLimit 会互相覆盖
   * （典型表现：多个账号触发限流后，落盘文档里一条 modelRateLimits
   * 都没有）。因此首次载入后，这份副本即为唯一读源。
   */
  private cache: ProviderAccountEntry[] = []
  /**
   * 模型黑名单的**权威进程内副本**（与 {@link cache} 同理：载入一次后即以
   * 本副本为准）。
   */
  private modelCache: ModelDisableMap = {}
  /**
   * 「锁定永久积分」开关表的**权威进程内副本**（与 {@link cache} 同理）。
   *
   * ⚠️ 每个 provider 一项（Loomy / CodeBuddy / WorkBuddy 各自独立），
   * **只记录已锁定的**（缺键 = 未锁定）。
   *
   * ⚠️ 它的落盘位置与账号池**不是同一份文档**：住在
   * `$DSH_HOME/channel-pack/permanent-locks.json`，因为 state.json 是同机多 profile
   * 共享的文档，而另一条工作区里的旧版本代码全量重写它时**不会携带自己不认识
   * 的键** —— 放那儿会被静默抹掉，解锁的后果是真把永久积分烧掉。
   * 详见 `src/permanent-lock-store.ts` 的文件头。
   */
  private permanentLockCache: PermanentLockMap = {}
  /**
   * 「本机 OpenAI 网关」开关的进程内副本。
   *
   * 缺键语义是**启用**（与 `channel-pack-store.ts` 的 `sanitizeGatewayEnabled`
   * 同一方向）：老用户升级后网关行为与升级前完全一致，不会被静默关掉。
   *
   * ⚠️ 与 {@link permanentLockCache} 不同，它**不需要**独立文档：丢失本键
   * 的唯一后果是回到默认启用，用户再关一次即可。
   */
  private gatewayEnabledCache = true
  /**
   * 供应商自定义显示顺序（「供应商开关」弹窗拖拽排序）的进程内副本。
   *
   * ⚠️ 与 {@link gatewayEnabledCache} 同级、**不需要**独立文档：丢失本键的
   * 唯一后果是顺序回到声明顺序，用户重新拖一次即可（纯展示偏好，可逆）。
   * 数组语义见 `channel-pack-store.ts` 的 `ChannelPackState.providerOrder`。
   */
  private providerOrderCache: string[] = []
  /** 是否已完成首次载入。 */
  private loaded = false
  /**
   * 状态文档落盘的**串行链**（见 {@link queueStoreSave}）。
   *
   * ⚠ 它必须存在：内层重新读一次快照只能保证「读→改」这半原子，而
   * `store.save()` 本身是异步的，两个写者的 `save` 可以乱序完成。
   */
  private storeChain: Promise<void> = Promise.resolve()
  /** 锁定表的独立后端（权威落盘点）。 */
  private readonly lockStore: PermanentLockStore

  constructor(private readonly ctx: Context) {
    this.store = createChannelPackStore(ctx)
    this.lockStore = createPermanentLockStore(ctx)
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[channel-pack] 无可用持久化后端，账号列表与模型黑名单仅存在于内存中')
    }
  }

  /** 首次访问时从后端载入账号列表、黑名单与锁定表。 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const state = this.store.load()
    if (state !== undefined) {
      this.cache = state.accounts
      // 黑名单是后来才加入的字段：老文档里没有它，缺失时保持空表
      // （等价于"全部模型默认打开"），而不是报错或让整次载入失败。
      this.modelCache = state.disabledModels
      // 网关开关同理：老文档没有该键 → 保持默认启用。
      this.gatewayEnabledCache = state.gatewayEnabled !== false
      // 供应商顺序同理：老文档没有该键 → 空数组（未自定义）。
      this.providerOrderCache = state.providerOrder ?? []
    }
    this.loadLocks(state)
  }

  /**
   * 载入锁定表：独立文档是权威；它**不存在**时才从 state.json 的镜像字段迁移。
   *
   * ⚠️ 迁移判据必须是「文档不存在」而不是「表里没有某键」：表里的缺键语义是
   * 「用户明确解锁了」，此时若还回看镜像字段那个陈旧的 `true`，就会出现
   * **解不掉的开关** —— 比丢状态更难排查。
   *
   * ⚠️ 迁移出的内容立即固化到独立文档：否则每次冷启动都要重新读镜像，
   * 而镜像随时可能被另一条工作区的旧代码改回旧值。
   */
  private loadLocks(state: ChannelPackState | undefined): void {
    const read = this.lockStore.load()
    if (read.exists) {
      this.permanentLockCache = read.locks
      return
    }
    this.permanentLockCache = mergeLegacyLoomyLock({}, state?.loomyPermanentLocked)
    if (Object.keys(this.permanentLockCache).length > 0) {
      // 冷启动路径上的尽力而为：失败只意味着本次进程内生效，下一次仍会重新迁移。
      void this.persistLocks().catch(error => {
        this.ctx.logger?.warn?.(`[channel-pack] 锁定状态迁移未能落盘: ${String(error)}`)
      })
    }
  }

  /** 读取账号列表（进程内权威副本）。 */
  private readAccounts(): ProviderAccountEntry[] {
    this.ensureLoaded()
    return this.cache
  }

  /**
   * 串行化状态文档的落盘，并在**轮到本次时**重新取一次快照。
   *
   * ## 为什么 `removeAccount` 里的重读不够（真实缺陷，审查发现）
   *
   * `await this.writeAccounts(this.readAccounts().filter(...))` 只保证了
   * 「读 → 改」之间没有 `await`（内存那半确实原子），但
   * {@link writeAccounts} 内部的 `await this.store.save(...)` 是**异步**的
   * （`SettingsStore.save` → `await this.scope.replace(...)`）。两个写者各自的
   * `save` 可以**乱序完成**：后完成者带着它更早的快照覆盖磁盘 ⇒ 磁盘与
   * `this.cache` 分叉。实测形态（探针复现真实 IO 交错）：
   *
   * - 并发 `removeAccount('a')` / `removeAccount('b')`（先发起的后完成）：
   *   `cache=["keep"]` 而 `disk=["b","keep"]` ⇒ **已删除的账号在磁盘上复活**，
   *   下次进程启动它又回来；
   * - `removeAccount('victim')` 与 `addAccount(added)` 交错：
   *   `cache=["added","keep"]` 而 `disk=["keep"]` ⇒ **新增账号被静默丢失**。
   *
   * ⚠ 仅 `SettingsStore` 这类**异步** `replace` 后端中招；`FileStore.save` 是
   * 同步的 `writeFileSync` + `renameSync`（见 `src/channel-pack-store.ts`），整段
   * RMW 本来就原子、免疫此竞态。故不能靠「换个后端」绕过，只能在
   * `AccountPool` 这一层把写排队。
   *
   * ## 做法
   *
   * 把本次写挂到 {@link storeChain} 尾部，**在轮到它执行时**才从进程内权威副本
   * 取快照，于是「取快照」与「写磁盘」之间隔着前面所有已排队的写。磁盘上因此
   * 永远是「最后一次排队的写」的内容，与 `this.cache` / `this.modelCache` 收敛。
   *
   * ⚠ 三条数据**必须取自同一时刻**：账号、黑名单、锁定镜像字段共用一次快照，
   * 否则会出现「同一份文档里两个字段自相矛盾」（与 {@link lockFields} 的约定一致）。
   *
   * ⚠ 失败**照常向调用方抛出**（与改造前的 `writeAccounts` 一致：登录成功后落盘
   * 失败必须让 `account.create` 报错，不能静默假装成功）。同时用一条
   * `.catch()` 派生量更新 {@link storeChain}，让**链本身不被一次失败打断**
   * ——否则后续所有写都会跟着拒绝，账号池进入永不落盘状态。
   */
  private queueStoreSave(): Promise<void> {
    if (this.store.kind === 'memory') return Promise.resolve()
    const next = this.storeChain.then(async () => {
      await this.store.save({
        accounts: this.cache,
        disabledModels: this.modelCache,
        ...this.lockFields(),
        // ⚠️ 必须与账号、黑名单取自**同一时刻**的快照（见本方法的注释）：
        // 分两次快照会让同一份文档里的字段互相矛盾。
        gatewayEnabled: this.gatewayEnabledCache,
        providerOrder: this.providerOrderCache,
      })
    })
    this.storeChain = next.catch(() => {})
    return next
  }

  /**
   * 持久化账号列表（同时更新进程内权威副本）。
   *
   * **必须连同黑名单一起写回**：两种后端都是整体写入，
   * 只写 `{ accounts }` 会把同一文档里的 `disabledModels` 抹掉。
   */
  private async writeAccounts(accounts: ProviderAccountEntry[]): Promise<void> {
    this.cache = accounts
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[channel-pack] 无持久化后端，账号变更未落盘')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 读取某 provider 的模型黑名单（被关闭的模型 id 集合）。
   *
   * 适配器只调用这一个方法，因此进程内副本就是它们的读源：设置页改开关
   * 后，下一次 `listModels` 立即生效，无需重启或重新注册适配器。
   */
  disabledModelsFor(provider: string): ReadonlySet<string> {
    this.ensureLoaded()
    const perProvider = this.modelCache[provider]
    if (perProvider === undefined) return EMPTY_MODEL_SET
    const disabled = Object.keys(perProvider).filter((id) => perProvider[id] === true)
    return disabled.length > 0 ? new Set(disabled) : EMPTY_MODEL_SET
  }

  /**
   * 列出某 provider 的模型黑名单，供设置页渲染开关。
   *
   * 返回**全部键**（含显式设为 false 的），以便 UI 区分"从未设置过"与
   * "曾被关闭又打开"——两者对用户都是"开"，但保留记录便于排查。
   */
  listDisabledModels(provider: string): Record<string, boolean> {
    this.ensureLoaded()
    return { ...(this.modelCache[provider] ?? {}) }
  }

  /**
   * 「本机 OpenAI 网关」当前是否启用。
   *
   * 缺键语义为**启用**（老用户升级后行为不变），见
   * {@link gatewayEnabledCache}。
   */
  gatewayEnabled(): boolean {
    this.ensureLoaded()
    return this.gatewayEnabledCache
  }

  /**
   * 打开/关闭本机 OpenAI 网关并落盘。
   *
   * ⚠️ 这里**只改状态**，不负责启停 HTTP server —— 真正的启停由
   * `src/openai-gateway/runtime.ts` 在调用方做完持久化后接手。两者分开是为了
   * 让「存开关」与「跑进程」各自可单测，且启停失败不会把已写入的开关回滚成
   * 看似没生效的样子。
   */
  async setGatewayEnabled(enabled: boolean): Promise<void> {
    this.ensureLoaded()
    if (this.gatewayEnabledCache === enabled) return
    this.gatewayEnabledCache = enabled
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[channel-pack] 无持久化后端，网关开关仅本次会话有效')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 读取供应商自定义显示顺序（进程内权威副本）。
   *
   * 空数组 = 用户尚未自定义（或老文档没有该键），展示侧按声明顺序渲染。
   */
  providerOrder(): string[] {
    this.ensureLoaded()
    return this.providerOrderCache
  }

  /**
   * 写入供应商自定义显示顺序并落盘。
   *
   * ⚠️ 入参**原样保存**、不在池里做 provider 合法性过滤：合法集合随插件版本
   * 变化，在此过滤会让「新版本加入 provider → 被旧版本代码重写文档」场景下
   * 的顺序无法保留。脏值防护由两层承担：RPC 层校验 `string[]`，
   * store 层 `sanitizeProviderOrder` 去重/剔除非字符串。
   */
  async setProviderOrder(order: string[]): Promise<void> {
    this.ensureLoaded()
    const next = Array.isArray(order) ? [...order] : []
    if (this.providerOrderCache.length === next.length
      && this.providerOrderCache.every((id, index) => id === next[index])) return
    this.providerOrderCache = next
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[channel-pack] 无持久化后端，供应商顺序仅本次会话有效')
      return
    }
    await this.queueStoreSave()
  }

  /**
   * 打开/关闭某个模型。
   *
   * 关闭时写入 `true`；打开时**删除该键**而不是写 `false` —— 保持黑名单
   * 里只留真正被关闭的模型，`disabledModelsFor` 的语义因此始终是
   * "键存在且为 true 即隐藏"，配置文件也不会随开关操作无限膨胀。
   */
  async setModelDisabled(provider: string, modelId: string, disabled: boolean): Promise<void> {
    const next: ModelDisableMap = { ...this.modelCache }
    const perProvider = { ...(next[provider] ?? {}) }
    if (disabled) perProvider[modelId] = true
    else delete perProvider[modelId]
    if (Object.keys(perProvider).length === 0) delete next[provider]
    else next[provider] = perProvider
    await this.writeModels(next)
  }

  /**
   * 批量关闭一批模型（Channel Pack 模型列表的「关闭全部」）。
   *
   * 语义是**按当前列表逐项加入黑名单**，与 {@link setModelDisabled} 的关闭方向
   * 一致，只是**一次落盘**：逐条调用会写 N 次完整文档（30 个模型就是 30 次
   * 整体重写 + 30 次目录广播），且中途失败会留下「关了一半」的黑名单。
   *
   * 空列表直接返回、不落盘：没有变更就不该产生一次无意义的写入与广播。
   * 注意这与 {@link clearDisabledModels} **不对称** —— 后者的语义是「清空」，
   * 即使传入空列表也仍有事可做（详见该方法注释）。
   */
  async setModelsDisabled(provider: string, modelIds: readonly string[]): Promise<void> {
    if (modelIds.length === 0) return
    // ⚠️ 必须先确保已载入：本类只在**读**方法里调 `ensureLoaded()`，若首次访问
    // 就是写操作，`this.modelCache` 还是初始空表 —— 一次「关闭全部」会把
    // 磁盘上已有的黑名单整体覆盖掉。
    this.ensureLoaded()
    const next: ModelDisableMap = { ...this.modelCache }
    // 与已有条目合并：先前单独关闭的模型不能因为一次「关闭全部」而丢失。
    const perProvider = { ...(next[provider] ?? {}) }
    for (const id of modelIds) perProvider[id] = true
    next[provider] = perProvider
    await this.writeModels(next)
  }

  /**
   * 批量**打开**一批模型（Channel Pack 模型列表里**按分组**的「本组全开」）。
   *
   * ## 与 {@link clearDisabledModels} 的区别是**范围**（勿混）
   *
   * 后者清空该 provider 的**全部**键，并刻意顺带清掉「已下线模型」的历史死键；
   * 本方法**只删传入的 id**。分组开关必须用本方法 —— 用「清空」会把用户特意
   * 关着的其它组一起打开（那正是分组开关要避免的事）。
   *
   * ⚠️ **无实际变更不落盘**：传进来的 id 若本来就不在黑名单里（例如该组已经
   * 全开），删不掉任何键，此时不该产生一次文档重写与目录广播 ——
   * 与 {@link setModelsDisabled} 的「空列表不落盘」是同一条精神。
   */
  async clearModelsDisabled(provider: string, modelIds: readonly string[]): Promise<void> {
    if (modelIds.length === 0) return
    // 同 setModelsDisabled：写路径必须自己保证已载入，否则会拿未载入的空表
    // 去判「有没有变更」，进而漏掉磁盘上真实存在的关闭项。
    this.ensureLoaded()
    const perProvider = this.modelCache[provider]
    if (perProvider === undefined) return
    const nextPerProvider = { ...perProvider }
    let changed = false
    for (const id of modelIds) {
      if (nextPerProvider[id] === true) {
        delete nextPerProvider[id]
        changed = true
      }
    }
    if (!changed) return
    const next: ModelDisableMap = { ...this.modelCache }
    // 与 setModelDisabled 同约定：该 provider 一个关闭项都不剩时删掉整个键，
    // 配置文件不随开关操作膨胀。
    if (Object.keys(nextPerProvider).length === 0) delete next[provider]
    else next[provider] = nextPerProvider
    await this.writeModels(next)
  }

  /**
   * 批量启用/停用某 provider 的**全部**账号（Channel Pack 左侧供应商一键开关）。
   *
   * ## 为什么需要批量方法
   *
   * 供应商级开关的语义是「关闭该供应商」= 关掉它的全部模型（黑名单）+
   * 停用它的全部账号。前者复用 {@link setModelsDisabled}，后者没有现成路径 ——
   * 逐账号调 {@link updateAccount} 会写 N 次完整文档（且每次都可能与其它
   * provider 的改动互相覆盖），故这里一次落盘。
   *
   * ## 与「账号级开关」的区别（勿混）
   *
   * 账号级开关（账号卡片上的「停用/启用」）只动**单个**账号，且带
   * 「是否连带关闭该 provider 模型」的询问（见前端 `toggleAccount`）。
   * 本方法只动 `enabled`，**不碰模型黑名单**、不做任何询问 ——
   * 模型那侧由调用方（`provider.setEnabled` 端点）按固定顺序显式处理。
   *
   * ## 语义要点
   *
   * - **只改本 provider 的账号**：账号存在一个全局数组里（各 provider 混排），
   *   与 {@link reorderAccounts} 的隔离约定一致，绝不波及其它 provider。
   * - **幂等且无变更不落盘**：全部已是目标状态时直接返回 0，不产生无意义的
   *   文档重写（与 {@link setModelsDisabled} 的「空列表不落盘」同精神）。
   * - ⚠️ **返回「实际变更数」而非「命中数」**：调用方用它给用户提示
   *   （如「已停用 2 个账号」）。若返回命中数，全部本就停用时也会报「已停用 2 个」，
   *   用户会以为发生了他没预料到的改动。
   *
   * @param provider - provider id（`this.product.id`，不要写死字面量）
   * @param enabled - 目标状态：true 启用 / false 停用
   * @returns 实际被改变的账号数
   */
  async setAccountsEnabled(provider: string, enabled: boolean): Promise<number> {
    // ⚠️ 必须先确保已载入：本类只在**读**方法里调 `ensureLoaded()`，若首次访问
    // 就是写操作，`this.cache` 还是初始空数组 —— 这里虽然会按 provider 过滤后
    // 才写，但 `writeAccounts` 是**整体替换**，未载入时写回等于把磁盘上其它
    // provider 的账号全部抹掉（与 setModelsDisabled 的教训同型，后果更严重）。
    this.ensureLoaded()
    const accounts = this.cache
    let changed = 0
    const next = accounts.map((entry) => {
      if (entry.provider !== provider) return entry
      // 只把「显式 boolean」与目标比较：老文档里 enabled 可能缺失，
      // 缺失语义等同启用（与适配器 `enabled !== false` 的判定保持一致）。
      const current = entry.enabled !== false
      if (current === enabled) return entry
      changed++
      return { ...entry, enabled }
    })
    // 无实际变更不落盘：避免一次「没有任何改动」的开关操作产生文档重写。
    if (changed === 0) return 0
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[channel-pack] 已${enabled ? '启用' : '停用'} ${provider} 的 ${changed} 个账号`,
    )
    return changed
  }

  /**
   * 清空某 provider 的全部关闭项（Channel Pack 模型列表的「打开全部」）。
   *
   * ⚠️ **刻意不看模型目录**：直接删掉该 provider 在黑名单里的**全部**键，
   * 而不是按当前目录逐个删。理由是「曾被关闭、后来从服务端目录里下线」的
   * 历史遗留键 —— 按目录删的话它们永远清不掉，黑名单会积累死键，残留键
   * 将来若被同名模型复用还会莫名隐藏它。
   *
   * 该 provider 本就无关闭项时直接返回、不落盘。
   */
  async clearDisabledModels(provider: string): Promise<void> {
    // 同 setModelsDisabled：写路径必须自己保证已载入，否则「本就为空」的判据
    // 会建立在未载入的空表上（磁盘上有黑名单却被判成无事可做）。
    this.ensureLoaded()
    if (this.modelCache[provider] === undefined) return
    const next: ModelDisableMap = { ...this.modelCache }
    delete next[provider]
    await this.writeModels(next)
  }

  /** 持久化模型黑名单（同时更新进程内权威副本）。 */
  private async writeModels(disabledModels: ModelDisableMap): Promise<void> {
    this.modelCache = disabledModels
    this.loaded = true
    if (this.store.kind === 'memory') {
      this.ctx.logger?.warn?.('[channel-pack] 无持久化后端，模型黑名单变更未落盘')
      return
    }
    // 与 writeAccounts 对称：整体写入必须携带账号列表，否则会被清空 ——
    // 快照由 queueStoreSave 在轮到本次时统一取（三份数据同源）。
    await this.queueStoreSave()
  }

  /**
   * 状态文档里那份**镜像字段**（`loomyPermanentLocked`）。
   *
   * ⚠️ 它只是镜像，权威表在独立文档（见 {@link persistLocks}）。仍继续同源写出
   * 有两个理由：① 同机其它 profile 里的**旧版本代码**只认这个字段（它读它、
   * 也原样写回它），保持一致才能让那一侧的 Loomy 面板显示正确的锁定态；
   * ② 回退到老版本时用户不会看到「锁定悄悄失效」。
   * 二者**取自同一次快照**，于是「同一份状态里两个字段自相矛盾」这种隐性分歧
   * 从结构上就不可能出现。
   */
  private lockFields(): Pick<ChannelPackState, 'loomyPermanentLocked'> {
    return { loomyPermanentLocked: this.permanentLockCache.loomy === true }
  }

  /**
   * 某 provider 的「锁定永久积分」是否开启。
   *
   * 锁定后选号**只允许消耗会近期作废的积分**，永久积分不参与 ——
   * 只剩永久积分的账号在锁定期间等同于不可用（用户语义：「没有临时积分后
   * 找可用账号就是没有可用账号」）。
   *
   * ⚠️ 「什么算永久积分」各 provider 不同（Loomy 看服务端给的每日池；两个 buddy
   * 看资源包的扣费截止距今是否满 15 天），但**开关本身是同一件事**，故共用本表。
   */
  permanentLocked(provider: string): boolean {
    this.ensureLoaded()
    return this.permanentLockCache[provider] === true
  }

  /**
   * 设置某 provider 的「锁定永久积分」开关（持久化）。
   *
   * ⚠️ 解锁时**删除该键**而不是写 `false`（与模型黑名单同款约定）：表里只留
   * 真正处于锁定态的 provider，`permanentLocked` 的判据因此始终是
   * 「键存在且为 true 即锁定」。
   */
  async setPermanentLocked(provider: string, locked: boolean): Promise<void> {
    if (provider.length === 0) return
    this.ensureLoaded()
    const next: PermanentLockMap = { ...this.permanentLockCache }
    if (locked) next[provider] = true
    else delete next[provider]
    this.permanentLockCache = next
    await this.persistLocks()
  }

  /**
   * 落盘锁定表：先写**权威**（独立文档），再同步**镜像**（state.json）。
   *
   * ⚠️ 顺序与容错都是有意的：
   * - 权威先落 —— 独立文档才是本 profile 选号的依据；镜像写失败只让另一条
   *   工作区的面板显示旧值，不会让我们**误烧用户的永久积分**；
   * - 镜像失败只 warn，不向上抛 —— 否则一次 settings 后端抖动会让面板上的
   *   「锁定」按钮报错，而实际开关已经生效。
   *
   * 写镜像沿用「读 → 改 → 整体写回」的既有约定：必须连同账号与黑名单一起带，
   * 否则那份文档里的另外两份数据会被抹掉。
   */
  private async persistLocks(): Promise<void> {
    if (this.lockStore.kind === 'memory') {
      this.ctx.logger?.warn?.('[channel-pack] 无法定位 DSH home，永久积分锁定仅存在于内存中')
    } else {
      await this.lockStore.save({ ...this.permanentLockCache })
    }
    if (this.store.kind === 'memory') return
    // 走同一条写队列，避免与账号/黑名单的写乱序覆盖（见 {@link queueStoreSave}）。
    // ⚠ 这里**必须吞掉**异常（与改造前一致）：镜像写失败只让另一条工作区的面板
    // 显示旧值，不该让面板上的「锁定」按钮报错 —— 权威文档已经落好了。
    await this.queueStoreSave().catch(error => {
      this.ctx.logger?.warn?.(
        `[channel-pack] 锁定镜像字段写入失败（独立文档已保存，不影响本侧选号）: ${String(error)}`,
      )
    })
  }

  /** 锁定表的当前快照（备份导出用；权威来自独立文档）。 */
  permanentLocksSnapshot(): PermanentLockMap {
    this.ensureLoaded()
    return { ...this.permanentLockCache }
  }

  /** 全部处于锁定态的 provider（供设置页一次性读取）。 */
  listPermanentLocked(): string[] {
    this.ensureLoaded()
    return Object.keys(this.permanentLockCache).filter(p => this.permanentLockCache[p] === true)
  }

  /** 列出某个 provider 的所有账号（含状态信息） */
  async listAccounts(provider: string): Promise<ProviderAccountStatus[]> {
    const filtered = this.readAccounts().filter(a => a.provider === provider)
    const results: ProviderAccountStatus[] = []
    for (const entry of filtered) {
      const status: ProviderAccountStatus = { ...entry }
      try {
        const info = await this.ctx.credentials.describe(credentialRef(entry.credentialRef))
        status.source = info.source
      } catch {
        // 凭据可能已被外部删除
      }
      results.push(status)
    }
    return results
  }

  /** 列出所有 provider 的账号 */
  async listAllAccounts(): Promise<ProviderAccountEntry[]> {
    return this.readAccounts()
  }

  /**
   * 清理「凭据域名与当前产品配置不符」的账号。
   *
   * 用途：WorkBuddy provider 从中国版（copilot.tencent.com）改造为国际版
   * （www.workbuddy.ai）后，旧账号存的仍是中国版凭据 —— 它们的
   * `token.domain` 指向旧端点，用新 endpoint 发请求必然失败（且会一直续期失败）。
   * 这类条目已无修复价值，直接删除，让用户在 Channel Pack 重新登录。
   *
   * 判据是**凭据里记录的 domain 与产品配置的 apiDomain 不一致**（而不是简单按
   * provider 名删），这样只清理真正失配的条目，不会误删已在新端点登录的账号。
   *
   * @returns 被删除的账号 id 列表（供调用方记日志）。
   */
  async pruneAccountsWithForeignDomain(product: BuddyProduct): Promise<string[]> {
    const removed: string[] = []
    for (const entry of this.readAccounts()) {
      if (entry.provider !== product.id) continue
      let domain = ''
      try {
        const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
        if (resolved === undefined) continue
        const parsed = JSON.parse(resolved.value) as { domain?: unknown }
        domain = typeof parsed.domain === 'string' ? parsed.domain : ''
      } catch {
        // 凭据缺失或损坏：留给「凭据未配置」的正常报错路径处理，这里不删
        continue
      }
      // domain 为空表示历史凭据未记录域名，无法判定，保守保留。
      if (domain.length === 0) continue
      if (domain !== product.apiDomain) {
        await this.removeAccount(entry.id)
        removed.push(entry.id)
      }
    }
    return removed
  }

  /** 添加新账号（登录成功后调用） */
  async addAccount(entry: ProviderAccountEntry): Promise<void> {
    const accounts = [...this.readAccounts(), entry]
    await this.writeAccounts(accounts)
  }

  /** 更新账号部分字段 */
  async updateAccount(
    id: string,
    patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled' | 'expiresAt' | 'refreshable'>>,
  ): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === id)
    if (idx === -1) throw new Error(`Account ${id} not found`)
    const next = [...accounts]
    next[idx] = { ...next[idx], ...patch }
    await this.writeAccounts(next)
  }

  /** 删除账号（同时清理凭据） */
  async removeAccount(id: string): Promise<void> {
    const entry = this.readAccounts().find(a => a.id === id)
    if (!entry) return
    try {
      await this.ctx.credentials.unset(credentialRef(entry.credentialRef))
    } catch { /* 凭据可能已被删除 */ }
    // ⚠ **必须重新读一次**（真实缺陷，审查发现）：`credentials.unset` 会挂起若干
    // 微任务/IO，期间并发的 `addAccount` 已经把新条目写进 `this.cache` 与磁盘。
    // 若此时拿 `await` **之前**的快照做 filter 再整体写回，那个新账号会被静默丢失
    // —— 而 `account.create`（登录成功即 addAccount）与 `account.delete` 天然可并发。
    // 重新读之后到 `writeAccounts` 之间没有 `await`，因而这一段是原子的。
    await this.writeAccounts(this.readAccounts().filter(a => a.id !== id))
  }

  /**
   * 重排某 provider 下账号的顺序（Channel Pack 拖拽排序）。
   *
   * ## 为什么顺序有实际意义
   *
   * 账号列表的数组顺序就是 {@link getAvailableAccount} 的**候选优先级**：
   * 自动选号、限流后的换号重试都按这个顺序取「第一个可用账号」。
   * 因此拖拽不是 UI 装饰，它直接决定实际用哪个账号发请求。
   *
   * ## 只动本 provider 的槽位
   *
   * 账号存在**一个全局数组**里（各 provider 混排，靠 `provider` 字段区分），
   * 而设置页是按 provider 分组渲染的。因此这里取「该 provider 账号原本占用的
   * 那些下标」，把新顺序填回这些下标 —— 其他 provider 的账号**位置不变**。
   *
   * 不这么做（例如把该 provider 的账号整体挪到数组头部）会让拖拽 CodeArts
   * 的顺序顺带改变 Buddy 账号的相对位置，属于跨面板的意外副作用。
   *
   * ## 校验：必须是同一集合的一个排列
   *
   * `orderedIds` 必须恰好包含该 provider 的**全部**账号 id（顺序可变、集合不可变）。
   * 不满足就抛错而不是「尽力而为」：
   * - 少了某个 id（前端列表过期，期间账号被别处新增）→ 若静默忽略，那个账号
   *   会莫名其妙掉到末尾，用户看到的是"顺序自己变了"；
   * - 多了未知 id → 说明前端状态与服务端不一致。
   * 两种情况都让用户刷新重试，比悄悄改数据安全。
   *
   * @param provider - provider id
   * @param orderedIds - 该 provider 全部账号 id 的目标顺序
   */
  async reorderAccounts(provider: string, orderedIds: readonly string[]): Promise<void> {
    const accounts = this.readAccounts()
    const indices: number[] = []
    const currentIds: string[] = []
    accounts.forEach((entry, index) => {
      if (entry.provider === provider) {
        indices.push(index)
        currentIds.push(entry.id)
      }
    })

    // 集合一致性校验（顺序无关）。
    const expected = new Set(currentIds)
    const got = new Set(orderedIds)
    const sameSet = orderedIds.length === currentIds.length
      && got.size === orderedIds.length
      && orderedIds.every(id => expected.has(id))
    if (!sameSet) {
      throw new Error(
        `账号列表已变化，请刷新后重试（期望 ${currentIds.length} 个账号，收到 ${orderedIds.length} 个）`,
      )
    }

    const next = [...accounts]
    // 按新顺序回填到该 provider 原本占用的下标上。
    indices.forEach((accountIndex, position) => {
      const id = orderedIds[position]
      const source = accounts.find(a => a.id === id)
      // 上面的集合校验已保证 source 必定存在；这里的判断只为类型收窄。
      if (source !== undefined) next[accountIndex] = source
    })
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(`[channel-pack] 已重排 ${provider} 账号顺序: ${orderedIds.join(', ')}`)
  }

  /**
   * 按凭据内容反查账号 id（供适配器记录"当前用的是哪个账号"）。
   *
   * 适配器不持有 ctx，也不该直接访问本类的私有凭据存储，
   * 因此这里集中做「遍历已启用账号 → 解析凭据 → 比对标识字段」。
   * @param provider - provider 名称（'buddy' | 'workbuddy' | 'codearts'）。
   * @param identity - 比对用的标识值：CodeBuddy 系传 access_token，CodeArts 传 access_key_id。
   * @returns 匹配到的账号 id；无匹配返回空串。
   */
  async findAccountIdByCredential(provider: string, identity: string): Promise<string> {
    if (identity.length === 0) return ''
    // 凭据中的唯一标识字段：CodeBuddy 系（buddy / workbuddy）用 access_token，
    // CodeArts 用 access_key_id。选错字段会导致匹配恒失败，限流记录无法归属账号。
    const identifierKey = provider === 'codearts' ? 'access_key_id' : 'access_token'
    for (const entry of this.readAccounts()) {
      if (entry.provider !== provider || !entry.enabled) continue
      const resolved = await this.resolveCredentialByRef(entry.credentialRef)
      if (resolved === undefined) continue
      if (resolved[identifierKey] === identity) return entry.id
    }
    return ''
  }

  /** 解析某个 credentialRef 下的凭据 JSON；不可用时返回 undefined。 */
  private async resolveCredentialByRef(refName: string): Promise<Record<string, unknown> | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
      if (!resolved) return undefined
      const parsed = JSON.parse(resolved.value) as unknown
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 按凭据里的**任意身份字段**查找同 provider 的已有账号。
   *
   * ## 与 {@link findAccountIdByCredential} 的区别
   *
   * 那个是**限流记录归属**专用，写死了「codearts 用 access_key_id、
   * 其余用 access_token」两套字段名，且**只看已启用账号**。
   * 本方法是**通用去重**用：调用方给字段名与值，且**不看 `enabled`** ——
   * 停用的账号同样占着一个条目的位置，重复添加它仍是重复。
   *
   * ## 为什么必须容忍「字段缺失」
   *
   * 早期登录的凭据里可能**没有**该字段（例如 zcode 的 `user_id` 是
   * 2026-10-02 才补上的）。此时**跳过该条目**（视为「无法判断」），
   * 而不是把它当成「不匹配」或直接报错 —— 前者会漏判，
   * 后者会让老用户根本添加不了账号。
   *
   * @param provider - provider id（如 `zcode`）。
   * @param field - 凭据里用作身份判据的字段名（如 `user_id`）。
   * @param identity - 要比对的值（空串直接返回 `''`，调用方据空串放弃去重）。
   * @returns 匹配到的账号 id；无匹配返回空串。
   */
  async findAccountIdByIdentityField(
    provider: string,
    field: string,
    identity: string,
  ): Promise<string> {
    if (identity.length === 0) return ''
    for (const entry of this.readAccounts()) {
      if (entry.provider !== provider) continue
      const resolved = await this.resolveCredentialByRef(entry.credentialRef)
      if (resolved === undefined) continue
      const value = resolved[field]
      // ⚠ 缺失该字段 ⇒ 无法判断，**跳过**（不是「不匹配」）。
      if (typeof value !== 'string' || value.length === 0) continue
      if (value === identity) return entry.id
    }
    return ''
  }

  /** 按 id 查找账号条目（含已停用账号）。 */
  findAccount(id: string): ProviderAccountEntry | undefined {
    return this.readAccounts().find(a => a.id === id)
  }

  /** 列出某 provider 的全部账号（含已停用），供「重测所有 / 重置所有」使用。 */
  listAccountsByProvider(provider: string): ProviderAccountEntry[] {
    return this.readAccounts().filter(a => a.provider === provider)
  }

  /**
   * 该 provider 是否**至少有一个已登录（凭据可用）的账号**。
   *
   * 供适配器的 `listModels` 做门控：没有已登录账号时返回空目录，让 DSH 的
   * `buildModelCatalog` 把整个 provider 分组隐藏（它显式
   * `.filter(group => group.models.length > 0)`），从而显著减少模型选择
   * 列表里用不上的条目（用户需求：「没有已登录账号就不显示该供应商的所有
   * 模型」）。
   *
   * ## 为什么判据是「凭据可解析」而不是「有条目」
   *
   * 1. **`logout()` 只清凭据、保留账号条目**（删除条目是另一条路径
   *    `removeAccount`）。若只看「有没有条目」，用户登出后模型仍会显示，
   *    门控形同虚设。
   * 2. **不看 `enabled`**：停用只应影响「自动选号」，与「是否已登录」无关。
   *    这与续期调度器「只按 `refreshable` 过滤、不看 `enabled`」是同一条
   *    既有约定（停用账号同样参与积分领取），故这里保持一致。
   *
   * ⚠️ **这是异步的**：需要逐个解析凭据。但只解析到**第一个可用账号**即返回
   * （短路），多账号场景下通常第一次就命中。
   *
   * ⚠️ **本方法只用于「目录展示」的门控**，绝不能用于路由判定 ——
   * DSH 约定 `listModels` 结果仅供参考，隐藏目录不等于拒绝请求
   * （被隐藏的模型仍可 `resolveModel` / 正常收发）。
   */
  async hasLoggedInAccount(provider: string): Promise<boolean> {
    for (const entry of this.listAccountsByProvider(provider)) {
      const credential = await this.resolveCredentialByRef(entry.credentialRef)
      if (credential !== undefined) return true
    }
    return false
  }

  /**
   * 按账号 id 解析凭据（**不检查 enabled**）。
   *
   * 限流重测必须能对已停用账号发请求（用户明确要求"停用的账号也能发送"），
   * 因此这里刻意与 {@link getAvailableAccount} 的过滤条件区分开：自动选择
   * 只认启用账号，而按 id 的显式探测认全部账号。
   * @returns 凭据对象；账号不存在或凭据不可用时返回 undefined。
   */
  async resolveCredentialForAccount(
    id: string,
  ): Promise<CodeArtsCredential | BuddyCredential | undefined> {
    const entry = this.findAccount(id)
    if (entry === undefined) return undefined
    const parsed = await this.resolveCredentialByRef(entry.credentialRef)
    if (parsed === undefined) return undefined
    return parsed as unknown as CodeArtsCredential | BuddyCredential
  }

  /**
   * 清除限流标记。
   *
   * @param accountId - 目标账号。
   * @param modelIds - 要清除的模型；省略时清除该账号的**全部**标记。
   * @returns 实际清除的标记数。
   */
  async clearModelRateLimits(accountId: string, modelIds?: readonly string[]): Promise<number> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) return 0
    const entry = accounts[idx]
    const current = entry.modelRateLimits
    if (!current || Object.keys(current).length === 0) return 0

    const limits = { ...current }
    let removed = 0
    const targets = modelIds ?? Object.keys(limits)
    for (const modelId of targets) {
      if (Object.prototype.hasOwnProperty.call(limits, modelId)) {
        delete limits[modelId]
        removed++
      }
    }
    if (removed === 0) return 0

    const next = [...accounts]
    const updated = { ...entry }
    // 清空后删除字段本身，避免 settings 里留下空对象噪音。
    if (Object.keys(limits).length === 0) delete updated.modelRateLimits
    else updated.modelRateLimits = limits
    next[idx] = updated
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[channel-pack] 已清除限流标记: 账号 ${accountId} 模型 ${targets.join(', ')}（共 ${removed} 条）`,
    )
    return removed
  }

  /**
   * 获取指定 provider + 模型的下一个可用账号。
   *
   * `modelId` 为空串时**不做限流过滤**——调用方（provider 的
   * resolveCredential 入口）此时还不知道要发哪个模型，只能退化为
   * "任取一个启用账号"。但 `enabled` 过滤在任何情况下都生效：
   * 停用账号绝不参与自动选择，空 modelId 也不例外。
   *
   * @param provider - provider id（`this.product.id`，不要写死字面量）
   * @param modelId - 目标模型；空串表示不按模型过滤
   * @param excludeAccountIds - 需要跳过的账号 id。
   *
   * **为什么需要 `excludeAccountIds`**：调用方在「请求级轮换」时会逐个换号
   * 重试，必须能拿到**下一个**账号而不是每次都拿回同一个。
   * 本池默认按「重置时间最早到期」排序，当失败类别**不写限流标记**时
   * （如 5xx / 请求错误 —— 它们不是限流，不该留徽章），
   * 刚失败的账号仍是排序第一，调用方若不排除它就会原地打转、
   * 换号形同虚设。Go 侧对应的是 `PickExcluding(tried)`（`pool.go:131`）。
   *
   * 在池这一层排除（而非让调用方自己跳过）是必要的：调用方只能拿到
   * 「池认为最优的一个」，无法枚举候选自己去重。
   */
  async getAvailableAccount(
    provider: string,
    modelId: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ entry: ProviderAccountEntry; credential: CodeArtsCredential | BuddyCredential } | null> {
    const candidates = this.readAccounts()
      .filter(a => a.provider === provider && a.enabled)
      .filter(a => excludeAccountIds === undefined || !excludeAccountIds.has(a.id))
      .filter(a => {
        // 空 modelId（未知目标模型）：无可比对的键，保持候选不变。
        if (modelId.length === 0) return true
        if (!a.modelRateLimits) return true
        const resetAt = a.modelRateLimits[modelId]
        return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
      })
    if (candidates.length === 0) return null
    // 候选顺序即**用户在 Channel Pack 拖拽设定的手动顺序**（`reorderAccounts` 写入）。
    //
    // 为什么不再按「限流重置时间最早到期」重排（早期实现如此）：
    // 那个排序会让手动顺序形同虚设 —— 用户把某账号拖到首位，只要另一个
    // 账号的限流重置时间更早，实际选中的仍是后者，拖拽变成纯 UI 装饰。
    // 现在的语义是「手动顺序优先，限流豁免」：顺序完全由用户决定，
    // 而当前正处于限流期的账号已被上面的 filter 排除，不会选到。
    //
    // 注意 candidates 来自 readAccounts() 的 filter，而 filter 保持原数组
    // 顺序，故这里天然就是手动顺序，无需任何排序。
    //
    // 逐个尝试解析凭据，跳过占位/损坏条目（并记录原因，避免静默失败）
    const failures: string[] = []
    for (const entry of candidates) {
      let resolved
      try {
        resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
      } catch (error) {
        failures.push(`${entry.id}: 读取凭据失败 (${String(error)})`)
        continue
      }
      if (!resolved) {
        failures.push(`${entry.id}: 凭据未配置`)
        continue
      }
      try {
        const credential = JSON.parse(resolved.value) as CodeArtsCredential | BuddyCredential
        if (failures.length > 0) {
          this.ctx.logger?.warn?.(
            `[channel-pack] ${failures.length} 个 ${provider} 账号不可用，已跳过：${failures.join('; ')}`,
          )
        }
        return { entry, credential }
      } catch (error) {
        failures.push(`${entry.id}: 凭据 JSON 损坏 (${String(error)})`)
        continue
      }
    }
    if (failures.length > 0) {
      this.ctx.logger?.warn?.(
        `[channel-pack] 没有可用的 ${provider} 账号：${failures.join('; ')}`,
      )
    }
    return null
  }

  /**
   * 更新某账号某模型的重置时间。
   *
   * 关键：基于**读取到的最新账号列表**做局部合并，再把整个列表写回。
   * settings scope 的 get() 返回的是服务内部快照，可能滞后于磁盘；
   * 但 replace() 是整体替换，因此这里每次都在最新快照上合并，
   * 避免"写 A 的限流 → 读旧快照 → 写 B 的限流"把 A 的记录抹掉。
   *
   * ⚠️ **只接受比现值更大的解禁时刻**（与
   * {@link updateTraeCheckinDeviceGeneration} 同一约定）：
   *
   * 各 provider 的限流解析都有「解析不出时长 → 退回一个兜底值」的末端，而那个兜底
   * 通常是**短**的（cline 是 1 小时，而真实等待可能是 19 小时 39 分）。于是同一个
   * (账号, 模型) 上先写入的**真值**会被后写入的**兜底**覆盖 ——
   * cline「倒计时结束了还是失败，显示又 60 分钟」正是这样无限循环的。
   *
   * 并发场景最容易踩：同一 provider 的两个请求，一个拿到可解析的报文（写 19h39m），
   * 另一个拿到被 CDN 包成 HTML 的 429（写 1h），**后写的赢**。
   *
   * ⇒ 这里取「更长者」。真值被丢掉的风险不用担心：所有调用方写入的都是**未来**
   * 时刻，而过期的标记由 {@link sweepExpiredRateLimits} 清理。
   */
  async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[channel-pack] updateModelRateLimit: 账号 ${accountId} 不在账号列表中（已知: ${accounts.map(a => a.id).join(', ') || '空'}）`,
      )
      return
    }
    // ⚠️ 无效时刻（NaN / ±Infinity）必须**直接拒绝**，不能当「很短的解禁时刻」处理：
    // 写进去之后所有比较都恒为 false（该模型被永久限流、sweep 也清不掉），
    // 而 `new Date(NaN).toISOString()` 还会让下面那条日志直接抛 `Invalid time value`。
    if (!Number.isFinite(resetAtMs)) {
      this.ctx.logger?.warn?.(
        `[channel-pack] updateModelRateLimit: 账号 ${accountId} 模型 ${modelId} 收到非有限的解禁时刻 `
        + `${String(resetAtMs)}，已忽略（否则该模型会被永久限流）`,
      )
      return
    }
    const current = accounts[idx]!.modelRateLimits?.[modelId]
    // ⚠️ 判据用 `>=`：相等时无需写盘（省一次 IO），语义上也无差别。
    // 现值非有限（旧数据损坏）时**允许**被新值修掉 —— 那正是写它的机会。
    if (Number.isFinite(current) && current! >= resetAtMs) {
      this.ctx.logger?.info?.(
        `[channel-pack] updateModelRateLimit: 账号 ${accountId} 模型 ${modelId} 已有更长的限流标记 `
        + `(${new Date(current!).toISOString()} ≥ ${new Date(resetAtMs).toISOString()})，本次不覆盖`,
      )
      return
    }
    const next = [...accounts]
    const entry = { ...next[idx]! }
    entry.modelRateLimits = { ...entry.modelRateLimits, [modelId]: resetAtMs }
    next[idx] = entry
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[channel-pack] 已记录限流: 账号 ${accountId} 模型 ${modelId} 重置于 ${new Date(resetAtMs).toISOString()}`,
    )
  }

  /** 清理已过期的重置时间记录 */
  async sweepExpiredRateLimits(): Promise<void> {
    const accounts = this.readAccounts()
    let changed = false
    const next = accounts.map((entry) => {
      if (!entry.modelRateLimits) return entry
      const limits = { ...entry.modelRateLimits }
      for (const [modelId, resetAtMs] of Object.entries(limits)) {
        if (resetAtMs > 0 && Date.now() >= resetAtMs) {
          delete limits[modelId]
          changed = true
        }
      }
      return { ...entry, modelRateLimits: limits }
    })
    if (changed) await this.writeAccounts(next)
  }

  /**
   * 记录 TRAE 签到设备轮换代次（命中 9074 后由积分领取流程调用）。
   *
   * 与 {@link updateModelRateLimit} 同款：在**最新快照**上做局部合并后整体
   * 写回，避免与并发的账号操作互相覆盖。
   *
   * 只接受比现值**更大**的代次，防止乱序/重复回调把代次写回小值而让同一个
   * 被限流的设备号复活。
   */
  async updateTraeCheckinDeviceGeneration(accountId: string, generation: number): Promise<void> {
    if (!Number.isFinite(generation) || generation <= 0) return
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[channel-pack] updateTraeCheckinDeviceGeneration: 账号 ${accountId} 不在账号列表中`,
      )
      return
    }
    const current = accounts[idx]!.traeCheckinDeviceGeneration ?? 0
    if (generation <= current) return
    const next = [...accounts]
    next[idx] = { ...next[idx]!, traeCheckinDeviceGeneration: generation }
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(`[channel-pack] 账号 ${accountId} 签到设备代次 → ${generation}`)
  }

  /** 读取 TRAE 签到设备轮换代次（未设置时为 0）。 */
  traeCheckinDeviceGenerationFor(accountId: string): number {
    const entry = this.readAccounts().find(a => a.id === accountId)
    const value = entry?.traeCheckinDeviceGeneration
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }

  /**
   * 设置/清除某 opencode 账号的出口代理。
   *
   * ⚠️ **空串是合法输入**（用户显式清除代理 → 回到「与其它无代理账号共享
   * 本机出口」），故这里**不能**用 `if (!proxy) return` 早退，否则「清除」
   * 按钮点了会静默无效。清除时**删键**而不是写空串，避免下游把空串误当成
   * 「配了一个空地址」。
   *
   * 与 `updateModelRateLimit` 同款：在**最新快照**上做局部合并后整体写回，
   * 避免与并发的账号操作互相覆盖。
   */
  async setOpencodeProxy(accountId: string, proxy: string): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[channel-pack] setOpencodeProxy: 账号 ${accountId} 不在账号列表中`,
      )
      return
    }
    const next = [...accounts]
    const entry = { ...next[idx]! }
    if (proxy.trim().length === 0) delete entry.opencodeProxy
    else entry.opencodeProxy = proxy
    next[idx] = entry
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[channel-pack] 账号 ${accountId} 代理 → ${proxy.trim().length === 0 ? '直连' : proxy}`,
    )
  }

  /** 读取某 opencode 账号的代理（未设置时为空串）。 */
  opencodeProxyFor(accountId: string): string {
    const entry = this.readAccounts().find(a => a.id === accountId)
    return entry?.opencodeProxy ?? ''
  }

  /**
   * 记录 opencode 指纹轮换代次。
   *
   * ⚠️ 只接受**比现值更大**的代次：乱序/重复回调把代次写回小值会让用户
   * 以为已轮换、实际指纹没换（TRAE 同款判据，见 `updateTraeCheckinDeviceGeneration`）。
   */
  async updateOpencodeFingerprintGeneration(accountId: string, generation: number): Promise<void> {
    if (!Number.isFinite(generation) || generation <= 0) return
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[channel-pack] updateOpencodeFingerprintGeneration: 账号 ${accountId} 不在账号列表中`,
      )
      return
    }
    const current = accounts[idx]!.opencodeFingerprintGeneration ?? 0
    if (generation <= current) return
    const next = [...accounts]
    next[idx] = { ...next[idx]!, opencodeFingerprintGeneration: generation }
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(`[channel-pack] 账号 ${accountId} 指纹代次 → ${generation}`)
  }

  /** 读取 opencode 指纹代次（未设置时为 0）。 */
  opencodeFingerprintGenerationFor(accountId: string): number {
    const entry = this.readAccounts().find(a => a.id === accountId)
    const value = entry?.opencodeFingerprintGeneration
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }

  /**
   * 读取当前完整状态快照（账号列表 + 模型黑名单 + Loomy 镜像字段）。
   *
   * 供备份导出使用：返回的副本与进程内权威副本解耦，调用方修改返回值
   * 不会污染池的运行时状态。`disabledModels` 是嵌套结构，必须深拷贝
   * （浅拷贝会让内层 provider 表仍共享引用）。
   *
   * ⚠️ 这里**不含**锁定表本体（它住在独立文档里），备份导出要走
   * {@link permanentLocksSnapshot}。
   */
  getStateSnapshot(): ChannelPackState {
    this.ensureLoaded()
    const disabledModels: ModelDisableMap = {}
    for (const [provider, models] of Object.entries(this.modelCache)) {
      disabledModels[provider] = { ...models }
    }
    return {
      accounts: [...this.cache],
      disabledModels,
      ...this.lockFields(),
    }
  }

  /**
   * 整体替换账号列表与模型黑名单（备份导入用）。
   *
   * 与 {@link writeAccounts} / {@link writeModels} 的约定一致：整体写入时
   * 必须同时携带账号与黑名单，否则会把另一份数据抹掉。这里一次落盘完成
   * 两件事，避免中间态。
   *
   * ⚠️ 导入数据来自用户提供的备份文件（可能被手工编辑），因此先经
   * `sanitizeAccounts` / `sanitizeDisabledModels` 归一化：只保留可用的
   * 账号条目与显式 `true` 的黑名单项，坏条目直接丢弃而不是写进池里
   * 反复触发选号失败。
   */
  async replaceAll(
    accounts: readonly ProviderAccountEntry[],
    disabledModels: ModelDisableMap,
    permanentLocks?: PermanentLockMap,
  ): Promise<void> {
    const next = sanitizeAccounts(accounts)
    this.cache = next
    this.modelCache = sanitizeDisabledModels(disabledModels)
    // 备份文件可能来自不含该字段的旧版本：`undefined` 时**保持当前值**，
    // 而不是重置为空表 —— 否则导入一份老备份会静默解锁用户的永久积分。
    // 给出表时**整体替换**（备份就是完整状态快照），并同样过滤脏值。
    if (permanentLocks !== undefined) {
      this.permanentLockCache = sanitizePermanentLocks(permanentLocks)
    }
    this.loaded = true
    // 一次落盘三件事：锁定表进**独立文档**，账号与黑名单进 state.json，
    // 同时把 Loomy 的镜像字段同步过去（persistLocks 内部就是这套顺序）。
    await this.persistLocks()
  }
}

/**
 * `listModels` 的门控：**该 provider 是否应在模型目录中展示**。
 *
 * ## 需求来源
 *
 * 「如果某供应商没有已登录的账号，就不显示该供应商的所有模型 —— 这样对大多数
 * 用户来说模型选择选项卡臃肿的问题能改善很多。」
 *
 * ## 为什么可行：DSH 原生支持「空目录即隐藏」
 *
 * `dsh-api-session-controller` 的 `buildModelCatalog` 显式做了
 * `.filter(group => group.models.length > 0)`（注释：*"successful non-empty
 * provider groups"*）。因此适配器返回 `[]` 就能让整个 provider 分组从模型
 * 选择器中消失 —— **无需任何前端改动**。
 *
 * ⚠️ **必须返回空数组，不能抛错**：`buildModelCatalog` 的 `catch` 会把抛错
 * 归入 `failures`，界面上会多出一条 provider 报错，比「不显示」更糟。
 *
 * ⚠️ **不影响路由**：`catalog.routableProviders` 由 `listProviders()` 单独
 * 生成（不经过该 filter），且 DSH 明确约定 *"Catalog membership is advisory
 * and never changes routing"* —— 隐藏目录不等于拒绝请求，已持久化的模型
 * 仍能 `resolveModel` / 正常收发。
 *
 * ## 判定语义
 *
 * - **默认开启**（`DSH_HIDE_MODELS_WITHOUT_ACCOUNT=0` 可关）：与
 *   `DSH_TRAE_MAX_MODE` 同为「默认开、显式假值才关」的语义，故单列解析函数。
 * - `accountPool` 缺失（headless / CLI / 单测）或替身未实现
 *   `hasLoggedInAccount` 时**视为可见** —— 门控是**展示优化而非安全边界**，
 *   判定不可用时宁多勿少（否则会让整个 provider 的模型凭空消失）。
 * - **六个 provider 判据完全一致**：都只看账号池。早期 CodeArts 有一个「单凭据
 *   例外」（额外认固定 ref `CODEARTS_ACCESS_TOKEN`），该模式已移除，故
 *   `extraCredentialRefs` 参数也一并删除，避免留下无人使用的分支。
 *
 * @param accountPool - 适配器的账号池（可能为 undefined）。
 * @param provider - provider id。
 */
export async function providerCatalogVisible(
  accountPool: AccountPool | undefined,
  provider: string,
): Promise<boolean> {
  if (!resolveHideWithoutAccountFlag(process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT)) return true
  if (accountPool === undefined) return true
  // 能力检测：单测替身通常只 mock 了 disabledModelsFor 等少量方法。
  if (typeof accountPool.hasLoggedInAccount !== 'function') return true
  try {
    return await accountPool.hasLoggedInAccount(provider)
  } catch {
    // 读凭据异常（存储损坏等）时保守展示：宁可多显示，也不要让用户
    // 因为一次读取抖动而「所有模型都不见了」且无从排查。
    return true
  }
}

/**
 * 解析 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT`；**默认开启**。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭。与 `isTruthyFlag`
 * 的「默认关」语义相反，故单列一个函数，**不要混用**。
 */
function resolveHideWithoutAccountFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}
