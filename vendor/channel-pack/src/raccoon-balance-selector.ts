/**
 * Raccoon（商汤）账号余额缓存 + 「不切换到无余额账号」的选号。
 *
 * ## 它解决什么（真实报障）
 *
 * > 商汤部分有问题，在一个账号无余额后它不会自动切到另一个账号。
 *
 * 根因是**两层**的，只修任一层都不够：
 *
 * 1. **适配器没有任何换号代码**（`raccoon-adapter.ts` 原先只有
 *    「401/403 → 续期一次 → 重发」，其余失败直接抛）。同族的 gemini /
 *    cline / lobsterai / trae 都有 `MAX_ROTATE = 3` 的换号循环，qoder 与
 *    zcode 有 `switchAccountOnQuota()`，唯独 raccoon 漏了。
 * 2. **选号不带余额信息**。即使加上换号循环，`getAvailableAccount()` 只按
 *    `enabled` 与模型级限流过滤，对「这个号还有没有钱」一无所知 —— 于是
 *    换号很可能只是从**一个没钱的号**换到**另一个也没钱的号**，用户看到的
 *    依旧是失败（甚至以为「换号也没用」）。
 *
 * 本模块补的是第 2 层：**在选号之前**把「已知没余额」的账号挡掉。
 *
 * ## 与 Loomy 的 `LoomyBalanceSelector` 的关系
 *
 * 同构，但**不共用**：Loomy 那条链分「今日额度 / 永久积分」两档并能锁定，
 * 商汤只有一个 `available_points` 总数，没有可锁的第二个池。硬套 Loomy 的
 * 分档会让语义对不上（`LoomyAccountBalance` 的两个字段在这里都是空的）。
 * 故本模块只做一件事：**判「> 0 还是 == 0」**。
 *
 * ## 缓存
 *
 * 每次选号都实时查余额会显著变慢（N 个账号 = N 次网络往返）。故加 TTL：
 * 同一轮对话内的多次请求几乎不重复查。
 *
 * ⚠️ **失败结果的 TTL 必须比成功短一个数量级**：失败（网络抖动、凭据正在
 * 续期）是瞬时状态，而成功读到的余额在 60 秒内确实不太会变。把失败也缓存
 * 满 60 秒，会让一次抖动伪装成「这个号没钱」整整一分钟 —— 那会白白跳过
 * 一个其实有钱的账号（Loomy 上实测到过：4 个号被一次抖动判成全不可用）。
 */

import { fetchRaccoonCreditBalance } from './raccoon-credits.js'
import type { RaccoonProduct } from './raccoon-product.js'
import type { RaccoonCredential } from './raccoon.js'

/** 成功结果的缓存 TTL（毫秒）。与 Loomy 同口径（60 秒）。 */
export const RACCOON_BALANCE_CACHE_TTL_MS = 60_000

/** **失败**结果的缓存 TTL（毫秒）—— 比成功短一个数量级。 */
export const RACCOON_BALANCE_ERROR_CACHE_TTL_MS = 5_000

/**
 * 余额查询的**硬超时**（毫秒）。
 *
 * ## 为什么不能用 `RACCOON_REQUEST_TIMEOUT_MS`（60 秒）
 *
 * 这条查询位于 `resolveCredential` 里，也就是**用户按下发送之后的必经路径**。
 * 用上游的 60 秒通用超时意味着：余额端点一旦挂住（或对某个账号恒定失败），
 * 用户每发一条消息都要先干等 60 秒才开始出字 —— 那是比原报障更严重的体验
 * 倒退（原报障只是「没自动换号」，至少还有一次明确的报错）。
 *
 * 8 秒足以覆盖正常往返（实测该端点在同一网络下是百毫秒级），又不会让
 * 用户以为界面卡死。超时后按「查询失败」处理：该账号**不**被跳过，只降级
 * 排序（见 `select()`），所以拿不准时仍然是「让上游去报真正的原因」。
 */
export const RACCOON_BALANCE_TIMEOUT_MS = 8_000

/** 一个账号的余额读数（含查询失败标记）。 */
export interface RaccoonAccountBalance {
  accountId: string
  /** 查询是否成功。false 时 `points` 为 undefined。 */
  ok: boolean
  /** 可用积分总数；查询失败时为 undefined（**不编造 0**）。 */
  points?: number
  /** 查询失败原因（诊断用）。 */
  error?: string
}

/** 一条待选账号（调用方从账号池取出）。 */
export interface RaccoonCandidate {
  /** 账号池里的 id（`raccoon-xxxxxxxx`）。 */
  id: string
}

/** 选号依赖（便于单测注入）。 */
export interface RaccoonSelectionDeps {
  product: RaccoonProduct
  /**
   * 按**账号 id** 解析凭据；返回 undefined 表示不可用。
   *
   * ⚠️ 传 id 而不是 `credentialRef`：池的 `resolveCredentialForAccount(id)`
   * 是既有的公开入口，而 ref → 凭据那条路是私有的。走公开入口既少一层
   * 映射（ref 与 id 各存一份、可能不同步），也不必为了本模块去扩大池的
   * 公开面。
   */
  resolveCredential: (accountId: string) => Promise<RaccoonCredential | undefined>
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 当前时间（测试用）。 */
  now?: () => number
  /** TTL 覆盖（测试用）。 */
  ttlMs?: number
  /** **失败**结果的 TTL 覆盖（测试用）。 */
  errorTtlMs?: number
  /** 余额查询超时覆盖（测试用）。 */
  timeoutMs?: number
}

/** 一个账号的缓存条目。 */
interface CacheEntry {
  at: number
  value: RaccoonAccountBalance
}

/**
 * 余额缓存 + 选号器。
 *
 * 生命周期与调用方一致（接线侧建一个），故不需要全局状态、
 * 也不会跨 provider 串味。
 */
export class RaccoonBalanceSelector {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: RaccoonSelectionDeps) {}

  /** 清空缓存（凭据变化、手动刷新余额、领取积分后调用）。 */
  invalidate(accountId?: string): void {
    if (accountId === undefined) this.cache.clear()
    else this.cache.delete(accountId)
  }

  /** 查一个账号的余额（带 TTL 缓存）。 */
  async balanceOf(account: RaccoonCandidate): Promise<RaccoonAccountBalance> {
    const now = this.deps.now?.() ?? Date.now()
    const cached = this.cache.get(account.id)
    if (cached !== undefined) {
      // 成功与失败用不同的 TTL —— 失败结论过期得快得多（见模块注释）。
      const ttl = cached.value.ok
        ? (this.deps.ttlMs ?? RACCOON_BALANCE_CACHE_TTL_MS)
        : (this.deps.errorTtlMs ?? RACCOON_BALANCE_ERROR_CACHE_TTL_MS)
      if (now - cached.at < ttl) return cached.value
    }

    const value = await this.fetchBalance(account)
    this.cache.set(account.id, { at: now, value })
    return value
  }

  /** 真正发请求查一次余额。 */
  private async fetchBalance(account: RaccoonCandidate): Promise<RaccoonAccountBalance> {
    let credential: RaccoonCredential | undefined
    try {
      credential = await this.deps.resolveCredential(account.id)
    } catch (error) {
      return {
        accountId: account.id,
        ok: false,
        error: `读取凭据失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (credential === undefined) {
      return { accountId: account.id, ok: false, error: '凭据未配置或已失效' }
    }

    // ⚠️ 必须在**这里**再套一层超时：`fetchRaccoonCreditBalance` 内部用的是
    // 上游通用超时（60 秒），而本函数位于用户按下发送后的必经路径上 ——
    // 端点挂住时用户会干等一分钟才开始出字（见 RACCOON_BALANCE_TIMEOUT_MS）。
    // 竞速而非改那个共享常量：那个 60 秒还被积分查询、领取等**非关键路径**
    // 复用，为这里调小会让那些操作更容易莫名失败。
    const timeoutMs = this.deps.timeoutMs ?? RACCOON_BALANCE_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const balance = await Promise.race([
      fetchRaccoonCreditBalance(
        this.deps.product,
        credential,
        this.deps.fetcher ?? fetch,
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
        // ⚠️ **刻意不调 `unref()`**：unref 过的定时器在「事件循环里没有其它
        // 被引用的工作」时**不会触发**，而那恰好是我们要兜底的场景 ——
        // 一个既不返回也不持有 socket 的挂起请求，进程会直接退出，
        // 超时形同虚设（写这个文件的行为测试时实测到：裸 node 下表现为
        // "unsettled top-level await"，测试挂死）。`.finally()` 里已经
        // `clearTimeout`，正常路径不留残留定时器，故没有拖住退出的风险。
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })

    if (balance === null) {
      return {
        accountId: account.id,
        ok: false,
        error: `余额查询超时（>${timeoutMs}ms）或响应异常`,
      }
    }
    return { accountId: account.id, ok: true, points: balance.total }
  }

  /**
   * 从候选账号里挑一个**已知还有余额**的。
   *
   * ## 判据（用户明确要求：「不切换到无余额的账号」）
   *
   * | 余额读数 | 处理 |
   * |---|---|
   * | `ok && points > 0` | ✅ 可用，按传入顺序取第一个 |
   * | `ok && points === 0` | ❌ **跳过** —— 这就是用户说的「无余额的账号」 |
   * | `!ok`（查询失败） | ⚠️ **不跳过**，但排在有余额的之后 |
   *
   * ## ⚠️ 为什么查询失败**不能**直接跳过
   *
   * 查询失败既可能是「这个号真的没了」，也可能只是一次网络抖动 / 凭据正在
   * 续期。直接跳过会让**一次抖动**把整个账号池判空，用户看到「所有账号均
   * 不可用」而实际每个号都还有额度 —— 那比不换号更糟。
   *
   * 故查询失败者只**降级排序**：有余额的优先，都没余额时才轮到它们，
   * 让上游去报真正的失败原因（错误信息更准确，也符合本插件在 Loomy 上
   * 定下的同一口径）。
   *
   * @param candidates - 已按 `enabled` / 限流 / `tried` 过滤过的候选（顺序即手动优先级）。
   * @returns 选中的账号；全部候选都确定没余额时返回 `undefined`。
   */
  async select(candidates: readonly RaccoonCandidate[]): Promise<RaccoonCandidate | undefined> {
    if (candidates.length === 0) return undefined

    // 并发查余额：账号数通常个位数，并发比串行快得多。
    const balances = await Promise.all(candidates.map((c) => this.balanceOf(c)))

    let fallback: RaccoonCandidate | undefined
    for (let i = 0; i < candidates.length; i += 1) {
      const account = candidates[i]!
      const balance = balances[i]!
      // 确定没钱 → 跳过（用户的硬要求）。
      if (balance.ok && (balance.points ?? 0) <= 0) continue
      if (balance.ok) return account
      // 查询失败：记住它作为兜底，但继续向后找一个**确定有钱**的。
      fallback ??= account
    }
    return fallback
  }

  /**
   * 候选**是否全部因「确定没余额」而被挡掉**。
   *
   * ## 为什么调用方需要这个
   *
   * `select()` 返回 `undefined` 有两种截然不同的原因：
   *
   * - 没有候选（全被 `enabled` / 限流 / `tried` 滤掉）
   * - 有候选，但**每个都确定没余额**
   *
   * 后者若被当成前者处理，调用方会退到「单凭据 ref」那条路，最终报出
   * `no usable credential; log in first` —— 而用户的账号明明登录着、只是没钱。
   * 那句错误会把人指去**重新登录**，方向完全错（与 cline 上那条
   * 「凭据明明在、账号也登录着，用户却被指去重新登录」的同款缺陷）。
   *
   * 故调用方在退到单凭据之前先问一次本方法，把真实原因说清楚。
   *
   * @param candidates - 与刚才传给 {@link select} 的**同一批**候选。
   * @returns true 仅当候选非空、且每一个都查到了余额、且余额为 0。
   */
  async allExhausted(candidates: readonly RaccoonCandidate[]): Promise<boolean> {
    if (candidates.length === 0) return false
    const balances = await Promise.all(candidates.map((c) => this.balanceOf(c)))
    // 只要有一个「查询失败」，就不能断言「都没钱了」—— 我们对它一无所知，
    // 那种情况该按「未知」处理（让上游去报真正的原因）。
    return balances.every((b) => b.ok && (b.points ?? 0) <= 0)
  }
}
