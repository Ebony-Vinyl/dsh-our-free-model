/**
 * MiniMax Code 认证服务。
 *
 * 登录走 **OAuth 设备码 + PKCE**（见 `minimax-oauth.ts`），
 * 续期走 `refresh_token` grant。
 *
 * ⚠️ **`refreshAll` 只按 `refreshable` 过滤，不看 `enabled`**
 * （AGENTS.md「续期不得按 enabled 过滤」的真实缺陷教训）。
 */

import { Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountPool } from './account-pool.js'
import {
  refreshAccountWithReconcile,
  type ExpiryAccessors,
} from './expiry-sync.js'
import {
  MINIMAX,
  MINIMAX_MODELS_PATH,
  MINIMAX_REQUEST_TIMEOUT_MS,
  type MinimaxProduct,
} from './minimax-product.js'
import {
  fallbackToEntry,
  isMinimaxRefreshable,
  minimaxCredentialExpiresAtMs,
  minimaxHeaders,
  normalizeMinimaxModel,
  type MinimaxCredential,
  type MinimaxModelEntry,
} from './minimax.js'
import {
  pollMinimaxDeviceToken,
  refreshMinimaxCredential,
  startMinimaxDeviceAuthorization,
  type MinimaxDeviceAuthorization,
} from './minimax-oauth.js'

/**
 * 过期信息提取器（供共享实现 `refreshAccountWithReconcile` 用）。
 *
 * ⚠️ `identityOf` 的语义是「**凭据内容**」（这里是 access_token）而**不是** ref 名
 * —— 传 ref 名会恒匹配失败且**静默无报错**（`src/expiry-sync.ts:67` 记录的坑）。
 *
 * ⚠️ `refreshableOf` 提供时共享实现会据此写池里的 `refreshable`。
 * MiniMax **确实有** refresh 端点，故提供它是**诚实**的
 *（与 Loomy 相反 —— 那边恒 false 故刻意不提供）。
 */
export const MINIMAX_EXPIRY_ACCESSORS: ExpiryAccessors<MinimaxCredential> = {
  expiresAtOf: (credential) => minimaxCredentialExpiresAtMs(credential),
  refreshableOf: (credential) => isMinimaxRefreshable(credential),
  identityOf: (credential) => credential.access_token,
}

/** refresh_token 已失效，需要重新登录。 */
export class MinimaxRefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    // ⚠️ `name` **必须**是 `'RefreshTokenExpiredError'`（真实缺陷，2026-09-29 修正）。
    //
    // `src/refresh.ts:23` 的终态判据是结构化比较：
    //   `if (error.name === 'RefreshTokenExpiredError') return true`
    //   `return /refresh[_ ]?token/i.test(error.message)`
    //
    // 早期这里写 `'MinimaxRefreshTokenExpiredError'` ⇒ 第一个分支**恒不命中**，
    // 只能靠第二个分支的**文案正则**兜底。而 `refresh()` 里
    // 「凭据未配置，请先登录」不含 `refresh_token` ⇒ 一旦走到那里，
    // `RefreshScheduler` 会把它当成**可重试**错误而**无限重试**。
    // 文案一改即静默退化，极难排查。
    //
    // 八个既有 provider 的同类类**一律**用 `'RefreshTokenExpiredError'`
    // （`cline-auth.ts:79`、`qoder-auth.ts:83`、`lobsterai-auth.ts:88`、
    // `loomy-auth.ts:78`、`raccoon-auth.ts:79`、`trae-auth.ts:81`、

    // 之所以能跨模块这样判，是因为判据是**字符串**而非 `instanceof`
    //（各模块的同名类是不同 identity，`instanceof` 会穿透）。
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 解析凭据 JSON；形状不对返回 undefined（不抛错）。 */
export function parseMinimaxCredential(value: string): MinimaxCredential | undefined {
  try {
    const parsed = JSON.parse(value) as MinimaxCredential
    return typeof parsed === 'object' && parsed !== null
      && typeof parsed.access_token === 'string' && parsed.access_token.length > 0
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 认证服务选项。 */
export interface MinimaxAuthOptions {
  /** 产品配置；默认 {@link MINIMAX}。 */
  product?: MinimaxProduct
  /** 服务名覆盖（默认由产品 id 派生为 `minimaxAuth`）。 */
  serviceName?: string
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 注入的 sleep（测试用）。 */
  sleep?: (ms: number) => Promise<void>
}

/** 登录流程句柄。 */
export interface StartedMinimaxLoginFlow {
  /** 用户点开的授权链接（**含 user_code**）。 */
  loginUrl: string
  /** 授权完成后的凭据。 */
  result: Promise<MinimaxCredential>
  /** 放弃本次登录。 */
  close: () => void
}

/** MiniMax Code 认证服务。 */
export class MinimaxAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: MinimaxProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  private lastRefreshError: string | undefined

  constructor(ctx: Context, private readonly options: MinimaxAuthOptions = {}) {
    const product = options.product ?? MINIMAX
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /** 申请设备码（供 RPC 提前拿到 loginUrl）。 */
  async fetchDeviceAuthorization(): Promise<MinimaxDeviceAuthorization> {
    return startMinimaxDeviceAuthorization(this.fetchImpl, this.product)
  }

  /**
   * 两步式登录：**立即**返回 `loginUrl`，后台轮询。
   *
   * ⚠️ 不能在这里阻塞等授权完成 —— 前端 `window.open` 只在
   * transient activation 窗口内有效（见 AGENTS.md「两步式登录」）。
   */
  async startLogin(): Promise<StartedMinimaxLoginFlow> {
    const auth = await this.fetchDeviceAuthorization()
    let aborted = false
    const controller = new AbortController()
    const result = pollMinimaxDeviceToken(auth, {
      fetcher: this.fetchImpl,
      ...this.options.sleep === undefined ? {} : { sleep: this.options.sleep },
      signal: controller.signal,
      product: this.product,
    })
    // 与 `cline-auth.ts:230-233` 同理：结果可能早于调用方 `await` 而落定，
    // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
    //
    // ⚠️ 本例**必然**会走到这里：`close()` → `controller.abort()` →
    // `pollMinimaxDeviceToken` 里的 `options.signal?.throwIfAborted()`
    // 会 reject（用户关掉登录弹窗就是这条路径）。缺这一句时，
    // 若调用方在 `await result` 之前就放弃，Node 会报 `unhandledRejection`。
    result.catch(() => {})
    return {
      loginUrl: auth.verificationUriComplete,
      result,
      close: () => {
        aborted = true
        controller.abort()
      },
    }
  }

  /**
   * 落盘凭据（登录成功后调用）。
   *
   * ⚠️ 返回 `accountId` 供调用方构造展示名。
   */
  async persistLogin(
    credential: MinimaxCredential,
    options: { refName: string; nickname?: string },
  ): Promise<{ accountId?: string }> {
    const payload: MinimaxCredential = {
      ...credential,
      ...options.nickname === undefined ? {} : { nickname: options.nickname },
    }
    await this.ctx.credentials.set(credentialRef(options.refName), JSON.stringify(payload))
    this.lastRefreshError = undefined
    return { ...credential.account_id === undefined ? {} : { accountId: credential.account_id } }
  }

  /** 解析默认单凭据。 */
  private async resolveDefaultCredential(): Promise<MinimaxCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return undefined
    return parseMinimaxCredential(resolved.value)
  }

  /** 续期默认单凭据。 */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) {
      throw new MinimaxRefreshTokenExpiredError('凭据未配置，请先登录')
    }
    if (!isMinimaxRefreshable(credential)) {
      throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    try {
      const next = await refreshMinimaxCredential(
        credential.refresh_token as string,
        this.fetchImpl,
        this.product,
      )
      await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next))
      this.lastRefreshError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastRefreshError = message
      throw error
    }
  }

  /**
   * 续期**指定 ref**（RPC `account.refresh` / 定时器）。
   *
   * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref。
   * ⚠️ **走共享实现 `refreshAccountWithReconcile`** —— 它保证「凭据仍有效」时
   * 也把池值对账（见 `refreshAll` 的注释）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseMinimaxCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isMinimaxRefreshable(credential)) {
      throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    // 无账号池时退化为「直接续期 + 落盘」（单凭据路径）
    if (pool === undefined) {
      const next = await this.refreshCredentialFor(credential)
      await this.ctx.credentials.set(ref, JSON.stringify(next))
      return
    }
    await refreshAccountWithReconcile({
      pool,
      provider: this.product.id,
      tag: `[${this.product.id}]`,
      accountId: accountId ?? '',
      credential,
      accessors: MINIMAX_EXPIRY_ACCESSORS,
      refresh: (c) => this.refreshCredentialFor(c),
      save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
      warn: (message) => this.ctx.logger?.warn?.(message),
      info: (message) => this.ctx.logger?.info?.(message),
    })
  }

  /**
   * 批量续期：**只按 `refreshable` 过滤，不看 `enabled`**。
   *
   * 照 `src/cline-auth.ts` 的 `refreshAll` 形态（它是最规范的一份）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      // ⚠️ 判据只看 refreshable，不看 enabled
      if (!entry.refreshable) continue
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const credential = parseMinimaxCredential(resolved.value)
        if (!credential || !isMinimaxRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        await refreshAccountWithReconcile({
          pool,
          provider: this.product.id,
          tag: `[${this.product.id}]`,
          accountId: entry.id,
          credential,
          accessors: MINIMAX_EXPIRY_ACCESSORS,
          current: entry,
          refresh: (c) => this.refreshCredentialFor(c),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
      } catch (error) {
        if (error instanceof MinimaxRefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false })
          } catch {
            // 忽略 updateAccount 本身的错误
          }
          this.ctx.logger?.warn?.(
            `[minimax] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`,
          )
        } else {
          // 非终态失败（网络抖动、5xx…）**必须留下日志** ——
          // 静默失败会让账号在 UI 上仍显示「可续期」却永远刷不动，无从排查。
          this.ctx.logger?.warn?.(
            `[minimax] 账号 ${entry.id} 续期失败：`
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  /**
   * 续期给定凭据（供 `refreshAccountWithReconcile` 的 `refresh` 回调）。
   *
   * ⚠️ **不落盘** —— 落盘由共享实现的 `save` 回调负责。
   */
  async refreshCredentialFor(credential: MinimaxCredential): Promise<MinimaxCredential> {
    if (!isMinimaxRefreshable(credential)) {
      throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    try {
      return await refreshMinimaxCredential(
        credential.refresh_token as string,
        this.fetchImpl,
        this.product,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/invalid_grant|expired|revoked/i.test(message)) {
        throw new MinimaxRefreshTokenExpiredError('refresh_token 已失效，请重新登录')
      }
      throw error
    }
  }

  /**
   * 拉取远端模型目录（给定凭据）。
   *
   * ⚠️ **测试专用入口**（无需账号池）：`fetchModels` 是它的薄包装。
   */
  async fetchModelsWith(credential: MinimaxCredential): Promise<readonly MinimaxModelEntry[]> {
    const raw = await this.fetchRawModels(credential)
    return raw ?? this.product.fallbackModels.map(fallbackToEntry)
  }

  /**
   * 拉取**裸**远端目录：拿到就是拿到，拿不到一律 `undefined`（**不**回退兜底表）。
   *
   * 这是全插件唯一一处真正解析远端模型目录的地方；两个公开入口的差别只在
   * 「拿不到时回吐什么」：
   * - {@link fetchModelsWith} / {@link fetchModels} ⇒ **展示侧**语义，回退兜底表；
   * - {@link fetchRemoteModelsOnly} ⇒ **接线侧**语义，回 `[]`。
   *
   * ⚠ 把这个区分做在**这里**（而不是让接线自己去比对结果与兜底表）是刻意的：
   * 兜底表内容可以被改写，若远端下发的恰好与兜底表相同，「比较内容」的判据会把
   * 一次成功的拉取误判为失败。只有「解析函数返回了几个条目」这个**内部事实**
   * 能可靠区分两者。
   */
  private async fetchRawModels(credential: MinimaxCredential): Promise<readonly MinimaxModelEntry[] | undefined> {
    try {
      const url = new URL(`${this.product.apiHost}${MINIMAX_MODELS_PATH}`)
      url.searchParams.set('region', this.product.region)
      url.searchParams.set('buildEnv', this.product.buildEnv)
      const response = await this.fetchImpl(url.toString(), {
        headers: minimaxHeaders(credential),
        signal: AbortSignal.timeout(MINIMAX_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return undefined
      const body: unknown = await response.json().catch(() => undefined)
      const entries = parseMinimaxModelsPayload(body)
      // ⚠️ 远端成功但解析出 0 条时也回退兜底表（避免空列表让整个 provider 消失）
      if (entries.length === 0) {
        // ⚠️ **必须留日志**：否则无法区分「远端坏了」与「远端返回 0 条」，
        // 两者都静默给出兜底表，排查时只知道「模型列表不对」却找不到原因。
        // 目录是展示信息，故仍不抛错（不该让整个 provider 报错）。
        this.ctx.logger?.warn?.(
          `[${this.product.id}] 远端模型目录解析出 0 条，已回退兜底表`,
        )
        return undefined
      }
      return entries
    } catch (error) {
      // ⚠️ 远端失败静默回退，但**必须留日志**（同上：否则无从排查）。
      this.ctx.logger?.warn?.(
        `[${this.product.id}] 远端模型目录获取失败，已回退兜底表：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /** 拉取远端模型目录（账号池版本）。 */
  async fetchModels(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]> {
    const credential = await this.resolveModelsCredential(pool)
    if (credential === undefined) return this.product.fallbackModels.map(fallbackToEntry)
    return this.fetchModelsWith(credential)
  }

  /** 目录拉取用哪份凭据：账号池优先，其次插件自存的默认凭据。 */
  private async resolveModelsCredential(
    pool?: AccountPool,
  ): Promise<MinimaxCredential | undefined> {
    if (pool !== undefined) {
      // ⚠ `getAvailableAccount` 返回 **`{ entry, credential }`**（两层），
      // **不是**「账号条目本身」—— 照抄既有 provider 的写法：
      // `const available = await pool.getAvailableAccount(id, ''); available?.credential`
      const available = await pool.getAvailableAccount(this.product.id, '')
      if (available) return available.credential as unknown as MinimaxCredential
    }
    return await this.resolveDefaultCredential()
  }
  /**
   * 只取**真远端**目录；未登录 / 上游失败 / 解析出 0 条 ⇒ `[]`。
   *
   * ⚠ 与 {@link fetchModels} 的区别是**不回退兜底表**，专供适配器与本地桥使用。
   *
   * 为什么必须有这条：适配器判「这次拿到目录了吗」的判据是「返回空数组」。
   * 若接线用 `fetchModels()`（失败时回吐兜底表），那个判据**永不命中**
   * ⇒ 兜底表被当成远端结果写进 `remoteModels` 并永久缓存，用户登录 /
   * 网络恢复后**再也不会重拉**（连失败冷却都不会开），只能重启 DSH。
   * 「回退兜底表」这件事只应由**展示侧**（适配器）做一次。
   *
   * 日志语义与 {@link fetchModelsWith} 一致（失败 / 解析 0 条都留 warn），
   * 只是**不**把兜底表当结果返回。
   */
  async fetchRemoteModelsOnly(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]> {
    const credential = await this.resolveModelsCredential(pool)
    if (credential === undefined) return []
    return (await this.fetchRawModels(credential)) ?? []
  }
}

/**
 * 解析远端目录响应。
 *
 * 校验（照 asar `parseSnapshot`）：`providers[]` 含 `providerId === 'minimax'`、
 * `config.models` 是非空对象；逐条经 {@link normalizeMinimaxModel} 归一。
 */
export function parseMinimaxModelsPayload(payload: unknown): readonly MinimaxModelEntry[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const providers = (payload as Record<string, unknown>).providers
  if (!Array.isArray(providers)) return []
  const minimax = providers.find(
    (p): p is Record<string, unknown> =>
      typeof p === 'object' && p !== null && (p as Record<string, unknown>).providerId === 'minimax',
  )
  if (minimax === undefined) return []
  const config = minimax.config
  if (typeof config !== 'object' || config === null) return []
  const models = (config as Record<string, unknown>).models
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return []

  const out: MinimaxModelEntry[] = []
  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    // ⚠️ 把对象的 **key** 注入为 `id`（长名），条目自带的 `name` 是短名。
    // 两者都要保留 —— 合并会丢失官方展示名。
    const withId = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...raw as Record<string, unknown>, id }
      : { id }
    const entry = normalizeMinimaxModel(withId)
    if (entry !== undefined) out.push(entry)
  }
  // ⚠️ 按远端 model_order 排序（若提供），否则保持对象插入序
  const order = (config as Record<string, unknown>).model_order
  if (Array.isArray(order)) {
    const index = new Map<string, number>()
    order.forEach((id, i) => { if (typeof id === 'string') index.set(id, i) })
    out.sort((a, b) => (index.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      - (index.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }
  return out
}
