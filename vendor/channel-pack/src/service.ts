import { directFetch } from './direct-fetch.js'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { runLoginFlow, runOAuthFlow, startOAuthFlow, type StartedOAuthFlow } from './login.js'
import {
  RefreshTokenExpiredError,
  credentialFromTokenResponse,
  exchangeRefreshToken,
  keyPairFromStoredJwk,
} from './oauth.js'
import type { CodeArtsCredential, LoginFlowOptions, LoginFlowResult, ProviderAccountEntry } from './types.js'
import { AccountPool } from './account-pool.js'
import { SerialQueue } from './serial-queue.js'
import {
  refreshAccountWithReconcile,
  shouldRefreshNow,
  syncAccountExpiry,
  type ExpiryAccessors,
} from './expiry-sync.js'

/**
 * CodeArts 凭据是否具备**静默续期所需的全部材料**。
 *
 * 三样缺一不可：`refresh_token`（换凭据的凭据）、`code_verifier`（PKCE 校验，
 * 服务端拿它的 S256 对上授权时的 code_challenge）、`dpop_private_key_jwk`
 * （签 DPoP proof，服务端拿它与 refresh_token 里的 `cnf.jkt` 比对）。
 *
 * ⚠️ 这是**读凭据本体**的判据，不是账号池里那个 `refreshable` 布尔。
 * 后者只是「上一次判定结果的快照」，可能因为一次瞬时失败而被永久写成 false
 * —— 把调度判据建在它上面就是本次 401 的根因（见 {@link CodeArtsAuth.refreshAll}）。
 */
function isCodeArtsRefreshable(credential: CodeArtsCredential): boolean {
  return Boolean(
    credential.refresh_token
    && credential.code_verifier
    && credential.dpop_private_key_jwk,
  )
}

/**
 * CodeArts 凭据 → 账号池有效期的提取器（`refreshAll` 与按需续期共用）。
 *
 * ⚠️ `identityOf` 用 **`access_key_id`** 而非 access_token：CodeArts 凭据里
 * 根本没有 `access_token` 字段（它是 AK/SK + security_token），而
 * `AccountPool.findAccountIdByCredential` 对 codearts 比对的正是 `access_key_id`。
 * 选错字段会让反查恒失败且**静默无报错**。
 */
const CODEARTS_EXPIRY_ACCESSORS: ExpiryAccessors<CodeArtsCredential> = {
  expiresAtOf: (credential) => {
    const parsed = credential.expires_at ? Date.parse(credential.expires_at) : Number.NaN
    return Number.isFinite(parsed) ? parsed : undefined
  },
  refreshableOf: isCodeArtsRefreshable,
  identityOf: (credential) => credential.access_key_id ?? '',
}
import {
  fetchCodeArtsRemoteModels,
  saveModelsCache,
  setMemoryCache,
} from './models.js'

/**
 * CodeArts 历史单凭据 ref 常量。
 *
 * ⚠️ **单凭据模式已移除**，此常量不再有读取方 —— 保留仅为兼容既有调用签名
 * （`login` / `startLogin` 的 `refName` 缺省值）与外部可能的引用。
 * 凭据一律存放在账号池条目对应的 `CODEARTS_ACCOUNT_XXX` 下。
 */
export const CODEARTS_CREDENTIAL_REF = 'CODEARTS_ACCESS_TOKEN'

/** 一次成功登录的结果。 */
export interface LoginResult {
  /** 已存储的凭据值（原始令牌或 JSON 凭据字符串）。 */
  access: string
  /** 凭据过期的毫秒时间戳。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 打开的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token（新式 OAuth 流程为 true）。 */
  refreshable: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    codeartsAuth: CodeArtsAuth
  }
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
function parseCredential(value: string): CodeArtsCredential | undefined {
  try {
    return JSON.parse(value) as CodeArtsCredential
  } catch {
    return undefined
  }
}

/**
 * CodeArts 登录服务：新式 IAM OAuth（ticket 流程回退）+ refresh_token 静默续期。
 *
 * ## ⚠️ 仅支持**账号池**（单凭据模式已移除）
 *
 * 所有凭据都存放在账号池条目对应的 `CODEARTS_ACCOUNT_XXX` ref 下，由
 * Channel Pack 设置页管理。早期还存在一条「单凭据模式」（登录写固定 ref
 * `CODEARTS_ACCESS_TOKEN`，适配器在账号池取不到时回退读它）—— **已移除**：
 *
 * - 适配器的 `resolveCredential` 只查账号池；
 * - `codearts-login` / `codearts-status` / `codearts-refresh` 三个斜杠命令已删除
 *   （登录/状态/续期统一在 Channel Pack 完成，与其余五个 provider 一致）；
 * - 因此 `status()` / `refresh()` / `logout()` / 单凭据调度器等**只服务于单凭据
 *   路径**的方法一并移除，避免留下会去读写已废弃 ref 的死代码。
 *
 * 续期有两条账号池路径，都**不触碰任何「单凭据状态」**：
 * - {@link refreshAccountCredential}：按 ref 刷**指定账号**（由 RPC `account.refresh`
 *   驱动 —— ⚠️ 该端点**没有面板入口**，账号卡片的按钮是 测试/重测/重置/停用/代理/
 *   指纹/删除；调用方是仓库外的脚本/手工 RPC）；
 * - {@link refreshAll}：批量刷全部账号（`src/index.ts` 的定时调度器）。
 */
export class CodeArtsAuth extends Service {
  /** 登录会话是否仍处于活跃状态；stop() 置 false，防止在途刷新回写已登出凭据。 */
  private active = true
  /** 可注入 fetch；默认使用保留代理路由的独立签名传输。 */
  private fetchImpl: typeof fetch = directFetch
  /**
   * 按凭据 ref 分的**续期互斥队列**（进程内）。
   *
   * 为什么必须有它（本次 401 的直接成因之一）：CodeArts 有三条各自独立的续期入口
   * 会并发消费**同一份** refresh_token ——
   * ① `src/index.ts` 每 30 分钟（含启动首轮）的 `refreshAll`；
   * ② 推理路径的按需续期（`llm-adapter.ts` 的「过期预判」与「401 兜底」）；
   * ③ RPC `account.refresh`（⚠️ **无面板入口**，调用方是仓库外脚本）。
   * 而 DSH 本身还会并发发起多条模型请求（主回复 + 标题生成 + 上下文压缩），
   * 每条都可能独立走到 ②。华为 STS 在签发新凭据时**旧的那一份 refresh_token
   * 即失效**，于是并发下必然出现「1 个成功、其余全部 `invalid_grant`」，
   * 而失败方把它读成「refresh_token 已失效」并据此作废整个账号。
   *
   * ⚠️ 这把锁只在**本进程**内有效。多实例（如同一台机器上的 dsh web 与 desktop）
   * 各自持锁，跨进程互踩仍会发生 —— 那部分靠 `refreshAll` 里
   * 「判终态前先重读凭据」的防护兜住（两处都必须有，少一个都会复发）。
   */
  private readonly refreshQueues = new Map<string, SerialQueue>()
  /**
   * 已就「refresh_token 失效」告警过的 ref → 上次告警的服务端原文。
   *
   * 同一账号连续多轮撞上同一个终态错误时只说一次，避免每 30 分钟刷满日志；
   * 错误原文一变（说明状况变了）就重新告警。
   */
  private readonly terminalWarned = new Map<string, string>()

  constructor(ctx: Context, options: { fetcher?: typeof fetch } = {}) {
    super(ctx, 'codeartsAuth')
    if (options.fetcher) this.fetchImpl = options.fetcher
  }

  /** 取（或建）某个凭据 ref 的续期队列。 */
  private queueFor(refName: string): SerialQueue {
    let queue = this.refreshQueues.get(refName)
    if (queue === undefined) {
      queue = new SerialQueue()
      this.refreshQueues.set(refName, queue)
    }
    return queue
  }

  /** 读取某个凭据 ref 下的当前凭据；缺失或不可解析时 undefined。 */
  private async readCredential(refName: string): Promise<CodeArtsCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    return parseCredential(resolved.value)
  }

  /**
   * 判断两份凭据是否「同一份」（用于识别他处是否已经续过）。
   *
   * ⚠️ 必须**按值**比：`parseCredential` 每次都产生新对象，引用比较恒为「不相等」，
   * 会让幂等短路在每一轮都误判成「凭据已更新」。
   */
  private sameCredential(a: CodeArtsCredential, b: CodeArtsCredential): boolean {
    return a.access_key_id === b.access_key_id
      && a.expires_at === b.expires_at
      && a.refresh_token === b.refresh_token
  }

  /** 运行登录流程（默认新式 OAuth；flow: 'ticket' 走旧流程回退）并持久化凭据。 */
  async login(options: { flow?: 'oauth' | 'ticket'; refName?: string; accountId?: string; pool?: AccountPool } & LoginFlowOptions = {}): Promise<LoginResult> {
    this.active = true
    const flow: LoginFlowResult = options.flow === 'ticket'
      ? await runLoginFlow(options)
      : await runOAuthFlow(options)
    return this.persistLogin(flow, options)
  }

  /**
   * **两步式登录**：起回调服务器并立即返回登录 URL，由调用方先打开窗口。
   *
   * 为什么需要它（真实缺陷）：Channel Pack 的「+ 新建账号」原先调用阻塞式
   * {@link login}，而浏览器只在用户点击后的短暂窗口（transient activation，
   * 约 5 秒）内允许 `window.open`。等阻塞调用返回时手势早已过期，
   * `window.open` 被弹窗拦截器拒绝并返回 `null`，前端兜底逻辑便执行
   * `window.location.href = loginUrl`，把**整个设置页**跳转到登录页
   * ——用户看到的正是「主页面直接跳转过去了」。
   *
   * 与 CodeBuddy 系的做法对齐（那边是后端不 await、立即返回 loginUrl），
   * 因此三者现在都是「点击 → 弹出小窗 → 轮询等待」的同一交互。
   *
   * 调用方拿到 `loginUrl` 后应当**立即** `window.open`，再 await `result`。
   */
  async startLogin(
    options: { refName?: string; accountId?: string; pool?: AccountPool } & LoginFlowOptions = {},
  ): Promise<{ loginUrl: string; result: Promise<LoginResult>; close: () => Promise<void> }> {
    this.active = true
    const started: StartedOAuthFlow = await startOAuthFlow(options)
    const result = started.result.then((flow) => this.persistLogin(flow, options))
    // 与 startOAuthFlow 同理：结果可能早于调用方 await 而落定，
    // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
    result.catch(() => {})
    return { loginUrl: started.loginUrl, result, close: started.close }
  }

  /**
   * 持久化一次登录结果：写凭据、按需登记账号池。
   *
   * 抽成独立方法供 {@link login} 与 {@link startLogin} 共用 ——
   * 两条路径的差别只在「何时返回 loginUrl」，落库逻辑必须完全一致，
   * 否则两步式路径会静默缺少账号登记。
   *
   * ⚠️ 单凭据模式移除后，**凭据一律写入账号池条目对应的 ref**
   * （Channel Pack 传入的 `CODEARTS_ACCOUNT_XXX`）。`refName` 缺省时仍回退到历史常量
   * `CODEARTS_CREDENTIAL_REF`，但**已无任何读取方**，仅为兼容既有调用签名。
   */
  private async persistLogin(
    flow: LoginFlowResult,
    options: { refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<LoginResult> {
    const refName = options.refName ?? CODEARTS_CREDENTIAL_REF
    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, flow.access)
    // 目录是账号无关的，登录后顺手刷新一次。
    //
    // ⚠️ **必须捕获拒绝**：这是 fire-and-forget 调用，未处理的 rejection 会冒泡成
    // 进程级 unhandled rejection（测试里表现为「Errors 1 error」）。
    // 刷新失败不影响登录结果 —— 目录下次仍会重新拉。
    if (options.pool) {
      void this.refreshModels(options.pool).catch(() => {})
    }
    const credential = parseCredential(flow.access)
    // 多账号：accountId 提供时自动注册到 pool
    if (options.accountId && options.pool) {
      const expiresAt = credential?.expires_at ? Date.parse(credential.expires_at) : undefined
      await options.pool.addAccount({
        id: options.accountId,
        provider: 'codearts',
        nickname: options.accountId,
        enabled: true,
        credentialRef: refName,
        createdAt: Date.now(),
        expiresAt: Number.isNaN(expiresAt) ? undefined : expiresAt,
        refreshable: Boolean(credential?.refresh_token),
      })
    }
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: Boolean(credential?.refresh_token),
    }
  }

  /**
   * 按凭据 ref 续期**指定账号**的凭据。
   *
   * 这是 RPC `account.refresh` 与定时调度器走的路径，读写的是账号池条目
   * 对应的 `CODEARTS_ACCOUNT_XXX`。
   *
   * ⚠️ `account.refresh` **没有面板入口**（issue IKJOZA 取证：36 处 `rpcCall(` 里没有它，
   * `git log -S "rpcCall('account.refresh'"` 零命中），别照着旧注释去找「刷新」按钮。
   *
   * ⚠️ 早期这里的方法注释在对比一个 `refresh()` —— 那个方法读写固定单凭据 ref
   * `CODEARTS_ACCESS_TOKEN`，**已随单凭据模式一并移除**。当时用 `refresh()`
   * 去刷账号池里的账号会刷到另一个凭据上（真实缺陷），这也是 `account.refresh`
   * RPC 一定要按 `entry.credentialRef` 分派的原因。现在只剩本方法这一条路径。
   *
   * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT）：UI 读的是池值，
   * 只更新凭据会让「已过期」的红字在续期成功后**依然挂着**。
   *
   * @param pool 账号池；提供时把新 `expiresAt` / `refreshable` 写回。
   * @param accountId 账号 id，调用方已知时显式传入（反查会跳过已停用账号）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    await this.queueFor(refName).run(async () => {
      const ref = credentialRef(refName)
      const credential = await this.readCredential(refName)
      if (credential === undefined) throw new Error('凭据未配置')
      if (!isCodeArtsRefreshable(credential)) throw new Error('无 refresh_token，请重新登录')
      // 排队等锁期间，别处（另一条续期入口）可能已经把它续好了：
      // 有效期内就直接对账返回，不再发第二次请求。
      if (!shouldRefreshNow(CODEARTS_EXPIRY_ACCESSORS.expiresAtOf(credential))) {
        await syncAccountExpiry({
          pool,
          provider: 'codearts',
          credential,
          accessors: CODEARTS_EXPIRY_ACCESSORS,
          accountId,
          tag: '[codearts]',
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
        return
      }
      const refreshed = await this.refreshCredential(credential)
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
      await syncAccountExpiry({
        pool,
        provider: 'codearts',
        credential: refreshed,
        accessors: CODEARTS_EXPIRY_ACCESSORS,
        accountId,
        tag: '[codearts]',
        warn: (message) => this.ctx.logger?.warn?.(message),
      })
    })
  }

  /**
   * 加锁续期：拿到锁后**重读凭据**，只在他处还没续过的时候真的发请求。
   *
   * 与 {@link refreshAccountCredential} 共用同一条 per-ref 队列，因此
   * 「批量续期」「按需续期」「手动刷新」三条入口在同一进程内必然串行；
   * 锁内重读则是为了跨进程场景（同一台机器上 dsh web 与 desktop 两个实例）
   * 少烧一次 refresh_token —— 那种互斥锁管不到，只能靠「先看当前值」兜。
   *
   * @param credential 调用方读到的那份凭据（可能已经在等锁期间过期于他处）。
   * @returns 应当落盘并回写账号池的凭据。
   */
  private async refreshCredentialUnderLock(
    refName: string,
    credential: CodeArtsCredential,
  ): Promise<CodeArtsCredential> {
    return await this.queueFor(refName).run(async () => {
      const latest = (await this.readCredential(refName)) ?? credential
      if (!this.sameCredential(latest, credential)
        && !shouldRefreshNow(CODEARTS_EXPIRY_ACCESSORS.expiresAtOf(latest))) {
        this.ctx.logger?.info?.(
          `[codearts] 凭据已被他处续期，跳过本次续期请求（避免重复消费 refresh_token）`,
        )
        return latest
      }
      return await this.refreshCredential(latest)
    })
  }

  /**
   * 用 refresh_token 换取一份新凭据（**不触碰存储**）。
   *
   * 抽出来供 `refreshAccountCredential()` 与 `refreshAll()` 共用 ——
   * 两处原先各写一遍「取密钥对 → 换取 → 合并无变化字段」，
   * 一旦字段合并逻辑分叉就会出现「某条路径丢了 `model_rate_limits`」。
   */
  private async refreshCredential(credential: CodeArtsCredential): Promise<CodeArtsCredential> {
    const refreshToken = credential.refresh_token
    const codeVerifier = credential.code_verifier
    const dpopJwk = credential.dpop_private_key_jwk
    // 三样缺一即不可静默续期（与调用方的 `refreshableOf` 判据同源）。
    if (!refreshToken || !codeVerifier || !dpopJwk) {
      throw new Error('无 refresh_token，请重新登录')
    }
    const keyPair = keyPairFromStoredJwk(dpopJwk)
    const token = await exchangeRefreshToken(refreshToken, codeVerifier, keyPair, this.fetchImpl)
    const refreshed = credentialFromTokenResponse(token, { codeVerifier, codeChallenge: '' }, keyPair)
    // 保留无变化字段（domain_id/user_id/user_name 等）。
    refreshed.domain_id = credential.domain_id
    refreshed.user_id = credential.user_id
    refreshed.user_name = credential.user_name
    if (credential.model_rate_limits) refreshed.model_rate_limits = credential.model_rate_limits
    return refreshed
  }

  /**
   * 批量续期所有 codearts 账号。
   *
   * **包含已停用账号**（只按凭据是否具备续期材料过滤）：停用只应影响账号池的自动
   * 选号，不该让凭据烂掉 —— 否则用户重新启用时只能重新登录。
   * 详见 `BuddyAuth.refreshAll` 的注释（同一缺陷）。
   *
   * 单账号失败不影响其他账号，但**必须留日志**：CodeArts 是九个 provider 里
   * 唯一整份文件没有一处 `logger` 的（issue !IKIRTT 的可观测性条目），
   * 而它的 access_token 只有约 2 小时寿命、最容易撞过期，失败无痕最难查。
   *
   * ⚠️ **lead-time 过滤**：距过期不足 1 小时才真的发续期请求（与单凭据时代
   * `REFRESH_LEAD_MS` 同语义），跳过的账号只做有效期对账。详见
   * `refreshAccountWithReconcile`。
   *
   * ## ⚠️ 调度判据读**凭据**，不读账号池里的 `refreshable`（本次 401 的根因）
   *
   * 旧实现第一行是 `if (!entry.refreshable) continue`。那让这个布尔变成一道
   * **单向门**：任何一次把它写成 false 的路径（服务端拒绝、并发重放烧掉
   * refresh_token、DPoP 校验没过被误判成终态……）都会让该账号在此后
   * **永远不进这条循环** —— 定时续期跳过它、启动首轮也跳过它，于是
   * 「自动续期没工作、重启也还是 401」，而凭据本体可能完全健康
   * （实测：refresh_token 还有 18 天寿命、`code_verifier` 与 DPoP 私钥都在）。
   *
   * 现在的口径：`refreshable` 只是**凭据材料的镜像**，由本方法每轮对账得出，
   * 不是「曾被服务端拒绝过」的案底。凭据有材料就照常尝试续期，缺材料才写 false；
   * 一旦被别的路径误写成 false 而凭据其实齐全，本轮会**自动改回 true**（自愈）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts('codearts')
    for (const entry of accounts) {
      const ref = credentialRef(entry.credentialRef)
      let credential: CodeArtsCredential | undefined
      try {
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          // 凭据确实不存在：这才是「不可续期」的真实含义（写盘前先判，避免每轮重复写）。
          if (entry.refreshable) await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        credential = parseCredential(resolved.value)
        if (credential === undefined || !isCodeArtsRefreshable(credential)) {
          if (entry.refreshable) await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        if (!entry.refreshable) {
          // 池里说不能续、凭据说能续 —— 以凭据为准。这里**只记日志不回写**：
          // 下面 `refreshAccountWithReconcile` 的有效期对账（`syncAccountExpiry`
          // 会比较 `refreshableOf(credential)` 与池里的现值）本来就会把它改回来，
          // 多写一次只会让账号列表多一次无谓的整体落盘。
          this.ctx.logger?.info?.(
            `[codearts] 账号 ${entry.id} 的凭据具备续期材料，本轮恢复自动续期（此前的标记与凭据不符）`,
          )
        }
        await refreshAccountWithReconcile({
          pool,
          provider: 'codearts',
          tag: '[codearts]',
          accountId: entry.id,
          credential,
          accessors: CODEARTS_EXPIRY_ACCESSORS,
          current: entry,
          refresh: (c) => this.refreshCredentialUnderLock(entry.credentialRef, c),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          warn: (message) => this.ctx.logger?.warn?.(message),
          info: (message) => this.ctx.logger?.info?.(message),
        })
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          const detail = error instanceof Error ? error.message : String(error)
          // ⚠️ **判终态前先确认「我刚才用的那一份 refresh_token 还是不是当前那一份」**。
          // 并发下服务端拒的是**旧的**那一份（它已经因为别人的成功请求而失效），
          // 而磁盘上此刻躺着一份**新的、可用**的凭据。这属于「他处已续成功」，
          // 不是「本账号不能续期」—— 不加这层判据，一次交错就会把好账号永久标死
          // （这正是本次两个账号 401 不自愈的成因）。
          const latest = await this.readCredential(entry.credentialRef).catch(() => undefined)
          if (latest !== undefined
            && isCodeArtsRefreshable(latest)
            && credential !== undefined
            && latest.refresh_token !== credential.refresh_token) {
            this.ctx.logger?.info?.(
              `[codearts] 账号 ${entry.id} 续期被拒但凭据已被他处更新（并发重放），`
              + `按最新凭据对账，不标记为不可续期`,
            )
            await syncAccountExpiry({
              pool,
              provider: 'codearts',
              credential: latest,
              accessors: CODEARTS_EXPIRY_ACCESSORS,
              accountId: entry.id,
              current: entry,
              tag: '[codearts]',
              warn: (message) => this.ctx.logger?.warn?.(message),
            })
            continue
          }
          if (entry.refreshable) {
            try {
              await pool.updateAccount(entry.id, { refreshable: false })
            } catch {
              // 忽略 updateAccount 本身的错误
            }
          }
          // 同一个账号、同一个服务端原因只告警一次：真失效时用户需要重新登录，
          // 每 30 分钟重复同一行日志只会把有用的信息埋掉。
          const last = this.terminalWarned.get(entry.credentialRef)
          if (last !== detail) {
            this.terminalWarned.set(entry.credentialRef, detail)
            this.ctx.logger?.warn?.(
              `[codearts] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`
              + `；服务端原文：${detail}`,
            )
          }
        } else {
          // 非终态失败（网络抖动、5xx、429、DPoP 校验没过…）也必须留日志：静默会让账号
          // 在 UI 上永远显示「可续期」却刷不动，无从排查。
          this.ctx.logger?.warn?.(
            `[codearts] 账号 ${entry.id} 续期失败：`
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // 单账号失败不中断循环
      }
    }
  }

  /**
   * 停止服务：置 inactive，阻止在途刷新回写。
   *
   * 单凭据模式移除后这里不再需要停调度器 —— 登录态与续期都归属账号池条目，
   * 续期由 `src/index.ts` 的多账号调度器（{@link refreshAll}）驱动。
   */
  stop(): void {
    this.active = false
  }

  /**
   * 用**账号池里某个可用账号**的凭据从远端拉取模型列表；非空时更新内存缓存与磁盘。
   *
   * ⚠️ **必须传 `pool`**：CodeArts 已移除「单凭据模式」，不再有
   * `CODEARTS_ACCESS_TOKEN` 那样的固定 ref 可读 —— 凭据一律来自账号池条目
   * （`CODEARTS_ACCOUNT_XXX`）。早期签名不接收 `pool` 并直接读固定 ref，
   * 移除单凭据后那样会恒返回空列表。
   *
   * 为什么用「可用账号」而不是遍历全部账号：模型目录是**账号无关**的（同一个
   * 华为云账号体系下发同一份目录），取第一个能解析出 AK/SK 的账号即可，
   * 无需为每个账号各拉一次。
   */
  async refreshModels(pool: AccountPool): Promise<Array<{ id: string; name: string }>> {
    if (!this.active) return []
    const credential = await this.firstUsableCredential(pool)
    if (credential === undefined) return []
    const models = await fetchCodeArtsRemoteModels(credential, this.fetchImpl)
    if (models.length > 0) {
      setMemoryCache(models)
      saveModelsCache(models)
    }
    return models
  }

  /**
   * 取账号池里第一个**凭据可解析且含 AK/SK** 的账号凭据。
   *
   * 按 `readAccounts()` 的既有顺序（用户的 Channel Pack 拖拽顺序）遍历，短路返回。
   * `getAvailableAccount` 不适合这里：它会按 `enabled` 与限流状态过滤，而
   * 「拉模型目录」既不需要账号处于启用状态、也与限流无关。
   */
  private async firstUsableCredential(pool: AccountPool): Promise<CodeArtsCredential | undefined> {
    for (const entry of pool.listAccountsByProvider('codearts')) {
      const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
      if (!resolved) continue
      const credential = parseCredential(resolved.value)
      if (credential?.access_key_id && credential.secret_access_key) return credential
    }
    return undefined
  }

}
