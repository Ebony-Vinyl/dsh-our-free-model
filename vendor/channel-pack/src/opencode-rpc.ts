/**
 * opencode 专用 RPC 的**方法处理函数**（不是自注册端点）。
 *
 * ## ⚠️⚠️ 为什么是「被主 switch 调用」而不是「自己注册」（真实事故 2026-10-02）
 *
 * 我最初在这里调 `rpc.register('channel-pack', handler)`，以为可以与
 * `channel-pack-rpc.ts` 并存。真机报障：
 *
 *     添加失败：unknown method: opencode.addAnonymous
 *
 * 根因：**Channel Pack 只有一条通道** —— `channel-pack-rpc.ts` 的
 * `connection.fetch.register({ path: CHANNEL_PACK_API_PATH })`，它把 `call.method`
 * 交给一个穷举 `switch`，`default` 分支直接回 `unknown method` 且**不让路**。
 * 仓库里 `rpc.register` 只有我这一处用到（其它 11 个 provider 全部走主 switch），
 * 所以我那条注册路径从来就没被接过请求。
 *
 * ⇒ 现在本文件只导出 {@link handleOpencodeRpc}，由 `channel-pack-rpc.ts` 的
 * `handleMethod` 在 `default` **之前**调用。文件边界的好处（评审 diff 可控）
 * 保留了，错误的注册方式去掉了。
 *
 * ## 与既有 RPC 的关系
 *
 * 账号的增删改、拖拽排序、限流标记**全部复用** `account.*` 族；
 * 这里只加 opencode 特有的五件事。其中「添加账号」是本插件第一家
 * **不跳浏览器**的登录方式（手动粘贴 API key）。
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ProviderAccountEntry } from './types.js'
import { OPENCODE } from './opencode-product.js'
import { newAccountFingerprint, nextFingerprintGeneration } from './opencode-auth.js'
import { normalizeProxy } from './opencode.js'
import { buildProxyDispatcher } from './opencode-proxy.js'

export interface RpcOpencodeAddAccountRequest {
  apiKey: string
  nickname?: string
}
export interface RpcOpencodeAddAccountResponse {
  accountId: string
  /** true = 该 key 之前已添加过，本次只是复用。 */
  existed: boolean
}
export interface RpcOpencodeProxyRequest {
  accountId: string
  proxy: string
}
export interface RpcOpencodeProxyResponse {
  proxy: string
  label: string
}
export interface RpcOpencodeTestProxyRequest {
  proxy: string
}
export interface RpcOpencodeTestProxyResponse {
  exitIp: string
  country: string
  latencyMs: number
}
export interface RpcOpencodeRotateRequest {
  accountId: string
}
export interface RpcOpencodeRotateResponse {
  generation: number
  projectId: string
}

/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface OpencodePoolLike {
  listAccountsByProvider(provider: string): Array<{ id: string; enabled: boolean; credentialRef: string }>
  // ⚠️ 入参用 `ProviderAccountEntry`（而不是 `Record<string, unknown>`）：
  // 后者与 `AccountPool.addAccount(entry: ProviderAccountEntry)` **不可赋值**
  // （参数逆变，tsc 直接报 TS2345），接线处就得写断言或 any。
  addAccount(entry: ProviderAccountEntry): Promise<void>
  updateAccount(id: string, patch: Partial<ProviderAccountEntry>): Promise<void>
  setOpencodeProxy(accountId: string, proxy: string): Promise<void>
  updateOpencodeFingerprintGeneration(accountId: string, generation: number): Promise<void>
  opencodeFingerprintGenerationFor(accountId: string): number
}

/**
 * key 形状：`sk-` 前缀 + 至少 20 位。
 *
 * ⚠️ 这只是**形状**校验（挡手滑/占位符），**不是**有效性验证：
 * 真 key 仍要等第一次真实请求才知道。形状校验的价值是让「明显没粘贴对」
 * 在入库前就被挡下，而不是等到发消息时才 401。
 */
const KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,}$/

/** 出口 IP 查询（公开服务，仅用于「测试代理」按钮，不承载业务流量）。 */
const EXIT_IP_URL = 'http://ip-api.com/json/?fields=status,query,country'

/** 探测连接用的超时（测试按钮不能无限等）。 */
const TEST_TIMEOUT_MS = 10_000

/** 账号 id / credentialRef 由 key 尾段派生，使重复 key 落到同一账号。 */
function slotNamesOf(apiKey: string): { id: string; refName: string } {
  const tail = apiKey.slice(-8)
  return { id: `${OPENCODE.id}-${tail.toLowerCase()}`, refName: `OPENCODE_ACCOUNT_${tail.toUpperCase()}` }
}

/**
 * 处理一个 opencode RPC 方法。
 *
 * @param method 来自主 `handleMethod` 的方法名。
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（这样它自己的 `default`
 *          分支仍能给出 `unknown method`，语义归属清晰）。
 *
 * ⚠️ 不认识时**必须**返回 `undefined` 而不是 `{ok:false}`：主 switch 会在
 * `default` 之前调用本函数，若本函数对未知方法也回信封，别的 provider 的
 * 方法名就会被误判成「格式错误」而不是「没这个方法」。
 */
export async function handleOpencodeRpc(
  ctx: Context,
  pool: OpencodePoolLike,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const fail = (message: string) => ({ ok: false as const, error: { code: 'bad-request', message } })
  const done = <T>(value: T) => ({ ok: true as const, value })
  const call = { method, payload }
  try {
    switch (method) {

            case 'opencode.addAccount': {
              const req = call.payload as RpcOpencodeAddAccountRequest
              const apiKey = typeof req?.apiKey === 'string' ? req.apiKey.trim() : ''
              if (!KEY_PATTERN.test(apiKey)) {
                return fail('API key 形状不对（应以 sk- 开头、至少 20 位；可在 https://opencode.ai/auth 生成）')
              }
              const { id, refName } = slotNamesOf(apiKey)
              // ⚠️ 重复 key 必须**复用**同一账号：同 key 加两次会让用户误以为是
              // 两个独立配额桶，实际请求仍会打到同一份额度上（并在限额时一起被跳过）。
              if (pool.listAccountsByProvider(OPENCODE.id).some((a) => a.id === id)) {
                return done({ accountId: id, existed: true } satisfies RpcOpencodeAddAccountResponse)
              }
              const nickname = typeof req.nickname === 'string' && req.nickname.trim().length > 0
                ? req.nickname.trim()
                : `OpenCode ${apiKey.slice(-6)}`
              await ctx.credentials.set(credentialRef(refName), JSON.stringify({
                api_key: apiKey,
                nickname,
                // 指纹在此**首次固化**，之后由池里的代次权威重算（见 index.ts 接线注释）。
                fingerprint: newAccountFingerprint(apiKey),
              }))
              await pool.addAccount({
                id,
                provider: OPENCODE.id,
                nickname,
                enabled: true,
                credentialRef: refName,
                // ⚠️ 手动粘贴的 key 没有 refresh_token 概念（Zen key 不过期），
                // 标 true 会让 UI 显示「可自动续期」——那是不实承诺。
                refreshable: false,
                createdAt: Date.now(),
              })
              return done({ accountId: id, existed: false } satisfies RpcOpencodeAddAccountResponse)
            }

            case 'opencode.addAnonymous': {
              // 匿名通道 = 池里一条 api_key 为 `public` 的**普通条目**。
              // ⚠️ 与账号槽走完全相同的账号池机制（排序/停用/删除/代理/指纹代次），
              // 只是凭据不同 —— 这正是「多条匿名通道各走各的出口」的实现点。
              //
              // ⚠️ 指纹**不增加配额**：匿名通道按出口 IP 限额（实测：换 key、
              // 换伪装头、换指纹全部无效）。用户要多份额度必须给不同匿名通道
              // 配不同代理；指纹分离的价值是防关联。面板文案按此口径。
              const req = call.payload as { nickname?: string } | undefined
              const id = `${OPENCODE.id}-anon-${randomBytes(3).toString('hex')}`
              const refName = `OPENCODE_ANON_${randomBytes(4).toString('hex').toUpperCase()}`
              const count = pool.listAccountsByProvider(OPENCODE.id)
                .filter((a) => a.id.startsWith(`${OPENCODE.id}-anon-`)).length
              const nickname = typeof req?.nickname === 'string' && req.nickname.trim().length > 0
                ? req.nickname.trim()
                : `匿名通道 ${count + 1}`
              await ctx.credentials.set(credentialRef(refName), JSON.stringify({
                api_key: OPENCODE.anonymousKey,
                nickname,
              }))
              await pool.addAccount({
                id,
                provider: OPENCODE.id,
                nickname,
                enabled: true,
                credentialRef: refName,
                refreshable: false,
                createdAt: Date.now(),
              })
              return done({ accountId: id, existed: false } satisfies RpcOpencodeAddAccountResponse)
            }

            case 'opencode.setProxy': {
              const req = call.payload as RpcOpencodeProxyRequest
              if (typeof req?.accountId !== 'string' || req.accountId.length === 0) {
                return fail('缺少 accountId')
              }
              const raw = typeof req.proxy === 'string' ? req.proxy : ''
              if (raw.trim().length === 0) {
                // 空串 = 清除：账号回到「与其它无代理账号共享本机出口」。
                await pool.setOpencodeProxy(req.accountId, '')
                return done({ proxy: '', label: '直连（本机出口）' } satisfies RpcOpencodeProxyResponse)
              }
              const normalized = normalizeProxy(raw)
              if (!normalized.ok) return fail(normalized.reason)
              await pool.setOpencodeProxy(req.accountId, normalized.proxy.url)
              return done({ proxy: normalized.proxy.url, label: normalized.proxy.label } satisfies RpcOpencodeProxyResponse)
            }

            case 'opencode.testProxy': {
              const req = call.payload as RpcOpencodeTestProxyRequest
              const normalized = normalizeProxy(typeof req?.proxy === 'string' ? req.proxy : '')
              if (!normalized.ok) return fail(normalized.reason)
              const startedAt = Date.now()
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
              try {
                const response = await fetch(EXIT_IP_URL, {
                  signal: controller.signal,
                  dispatcher: buildProxyDispatcher(normalized.proxy) as never,
                } as RequestInit)
                if (!response.ok) return fail(`测试失败：代理返回 HTTP ${response.status}`)
                const body = (await response.json()) as { status?: string; query?: string; country?: string }
                if (body.status !== 'success' || typeof body.query !== 'string') {
                  return fail('测试失败：代理未能返回出口 IP（可能被目标站点拒绝）')
                }
                return done({
                  exitIp: body.query,
                  country: body.country ?? '',
                  latencyMs: Date.now() - startedAt,
                } satisfies RpcOpencodeTestProxyResponse)
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return fail(`测试失败：${controller.signal.aborted ? '连接超时' : message}`)
              } finally {
                clearTimeout(timer)
              }
            }

            case 'opencode.rotateFingerprint': {
              const req = call.payload as RpcOpencodeRotateRequest
              if (typeof req?.accountId !== 'string' || req.accountId.length === 0) {
                return fail('缺少 accountId')
              }
              const current = pool.opencodeFingerprintGenerationFor(req.accountId)
              // ⚠️ 用**当前代次**派生下一代的 projectId，接线层再按
              // `deriveProjectId(api_key, generation)` 用池里的代次重算权威值。
              // 这里返回的 projectId 只用于 UI 即时回显，不作为请求依据。
              const next = nextFingerprintGeneration({ projectId: current === 0 ? 'anonymous' : String(current), generation: current })
              await pool.updateOpencodeFingerprintGeneration(req.accountId, next.generation)
              return done({ generation: next.generation, projectId: next.projectId } satisfies RpcOpencodeRotateResponse)
            }

            default:
              // ⚠️ 返回 `undefined`（不是错误信封）：方法不属于 opencode，
              // 让主 switch 继续匹配 —— 它自己的 `default` 会给出
              // `unknown method`，那才是准确的归属。
              return undefined
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
