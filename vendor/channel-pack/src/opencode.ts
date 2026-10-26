/**
 * OpenCode 凭据结构、指纹派生与代理地址归一。
 *
 * ## 指纹依据（v2 客户端形状，2026-10-14 起）
 *
 * 免费车道自 2026-10-14 起按 **v2 客户端**校验，本文件与
 * `src/upstream.js`（插件自己的免费车道）保持同一套形状：
 *
 * - `User-Agent` 必须是 `opencode/<channel>/<version>/<client>`，major ≥ 2；
 *   旧的 `opencode/1.18.x` 被按名字拒掉（403 FreeTierError）。
 * - 头集是 `x-opencode-session` + `x-opencode-session-id` + `x-session-affinity`
 *   + `x-session-id`（四个同值）+ `x-opencode-project` + `x-opencode-client`。
 * - **不发 `x-opencode-request`**：那是 v1 专用头，v2 收到即 403。
 *
 * ⚠️ 本文件旧注释（1.18.22 源码逐行核对）说「不发 x-session-affinity /
 * x-session-id」—— 那条结论属于 v1 客户端，v2 已反过来要求它们，故删除。
 *
 * ## 为什么 project id 用 40 hex
 *
 * 真实取值是 `sha1("git-remote:" + 归一化 remote URL)`
 * （`packages/core/src/project.ts` 的 `resolve()`），本机 opencode.db 实测
 * 形如 `895debfe16b1fcca5ebfa2e24b7b914797e632ec`。
 * opencode2dsh 用的是 `prj_<24hex>`（无依据的服务端形状猜测），我们跟真实 CLI 同形。
 *
 * ## session id 的形状不是随意选的
 *
 * Zen 的 FreeTier 门禁对 session id 做了正则校验：
 * `ses_` + 12 位小写 hex + 14 位 base62（见 `deriveSessionId`）。形状不对就是
 * 403 FreeTierError；12 位 hex 还必须是**铸造形状**（`~(ms·0x1000+seq)`），
 * 且 seq 必须很小（上游实测 0–16 通过、≥100 拒绝）。
 */

import { createHash, randomBytes } from 'node:crypto'
import { OPENCODE } from './opencode-product.js'

/** 一份可持久化的指纹。 */
export interface OpencodeFingerprint {
  /** 40 位小写 hex，与真实 CLI project id 同形。 */
  projectId: string
  /** 轮换代次；+1 后 project id 整体变化。 */
  generation: number
}

/** 账号凭据（存 `ctx.credentials`，不进 settings 明文）。 */
export interface OpencodeCredential {
  /** Zen API key（`sk-…`），身份本体；匿名槽用字面量 `public`。 */
  api_key: string
  nickname?: string
  /** 首次添加时生成；旧账号缺失时由 `newAccountFingerprint` 补。 */
  fingerprint?: OpencodeFingerprint
  /** 代理 URL；空/缺省 = 直连（与其它无代理账号共享本机出口）。 */
  proxy?: string
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * session id 尾段的**总长度**（12 位 hex 时间戳 + 随机段）。
 *
 * ⚠️ 取值 26 直接来自官方 `id/index.ts` 的 `const LENGTH = 26`；
 * 随机段长度 = `LENGTH - 12` = **14**。别把 26 当成随机段长度
 * （我第一版就是这么错的，代价是匿名通道全线 403）。
 */
const SESSION_TAIL_LENGTH = 26
/** 随机段长度（26 - 12 = 14）。 */
const SESSION_RANDOM_LENGTH = SESSION_TAIL_LENGTH - 12

/** 固定长度 base62 随机串（对齐官方 id 模块的 `randomBase62`）。 */
function randomBase62(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += BASE62[bytes[i]! % BASE62.length]
  return out
}

/**
 * 派生 project id。
 *
 * @param identity  账号标识（接线层传 API key；匿名槽传固定串 `'anonymous'`）。
 * @param generation 轮换代次。
 *
 * 刻意**不**把 key 全文直接进哈希链的明文位置：identity 先过 SHA-256，
 * 再以 `git-remote:` 前缀走 SHA-1 —— 既复用真实 CLI 的派生外形，
 * 又使明文 key 片段不出现在任何可从 project id 反推的中间量。
 */
export function deriveProjectId(identity: string, generation: number): string {
  const inner = createHash('sha256').update(`${identity} ${generation}`).digest('hex')
  return createHash('sha1').update(`git-remote:opencode/${inner}`).digest('hex')
}

/**
 * 派生 session id：`ses_` + 12 位小写 hex（6 字节时间戳）+ **14** 位 base62。
 *
 * ## ⚠️⚠️ 尾段是 14 而不是 26（真实报障 2026-10-01）
 *
 * 官方 `id/index.ts` 里写的是 `const LENGTH = 26`，但那是**整段尾部长度**
 * （`randomBase62(LENGTH - 12)`），不是随机段长度。我第一版误读成「随机 26 位」，
 * 产出 `ses_` + 38 字符，形状不对 ⇒ 匿名通道一律 403 `FreeTierError`
 * （"free tier can only be used from within OpenCode"）。此外，前 12 位也不能
 * 只是任意随机 hex，网关会校验它是否来自官方的时间铸造算法。
 *
 * ⚠️ **每次调用都是新值**：调用方负责在**一次 DSH 会话内**缓存复用
 * （见 `opencode-adapter.ts` 的 `sessionIds`）。每次都随机会让同一会话
 * 在服务端被看成多个独立会话，反而破坏亲和。
 */
export function deriveSessionId(): string {
  const timestamp = Date.now()
  if (timestamp !== lastSessionStamp) {
    lastSessionStamp = timestamp
    sessionSequence = 0
  }
  sessionSequence += 1
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(sessionSequence))
  let hex = ''
  for (let i = 0; i < 6; i += 1) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  }
  // ⚠️ 随机段固定 14 位（26 - 12）；写成 26 会让总长变成 38 而被门禁拒绝。
  return `ses_${hex}${randomBase62(SESSION_RANDOM_LENGTH)}`
}

let lastSessionStamp = 0
let sessionSequence = 0

/**
 * v2 客户端 UA 的形状：`opencode/<channel>/<version>/<client>`。
 *
 * 与 9router 的 `hasValidOpencodeVersion` 同一判据（整串匹配、major ≥ 2）：
 * 只有真长这样的串才允许透传，其余一律回落到产品常量。
 */
const OPENCODE_V2_UA = /^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i

/** UA：本机版本探测值（若已是 v2 形状）或产品常量。 */
export function opencodeUserAgent(override?: string): string {
  const value = override?.trim()
  if (value !== undefined && value.length > 0 && OPENCODE_V2_UA.test(value)) return value
  return OPENCODE.defaultUserAgent
}

/**
 * 本机 `opencode --version` 的输出（形如 `2.0.26`）→ v2 UA。
 *
 * ⚠️ 旧实现直接拼 `opencode/${version}`，那是 v1 形状，v2 门禁一律 403。
 * 探测不到版本（本机没装 opencode 是**正常情况**）时返回 undefined，由
 * {@link opencodeUserAgent} 回落到产品常量。
 */
export function opencodeUserAgentForVersion(version?: string): string | undefined {
  const value = version?.trim()
  if (value === undefined || !/^\d+\.\d+\.\d+$/.test(value)) return undefined
  const [major] = value.split('.')
  if (Number(major) < 2) return undefined
  return `opencode/latest/${value}/cli`
}

/** 构造发往 Zen 的完整指纹头集（v2 形状）。 */
export function opencodeHeaders(
  fingerprint: OpencodeFingerprint,
  sessionId: string,
  userAgent: string,
): Record<string, string> {
  return {
    'x-opencode-project': fingerprint.projectId,
    'x-opencode-session': sessionId,
    // v2：这四个头同值，缺一即 403。
    'x-opencode-session-id': sessionId,
    'x-session-affinity': sessionId,
    'x-session-id': sessionId,
    'x-opencode-client': 'cli',
    'user-agent': userAgent,
  }
}

export type OpencodeProxyKind = 'http' | 'socks5'

export interface NormalizedProxy {
  kind: OpencodeProxyKind
  /** 可直接交给 dispatcher 的完整 URL。 */
  url: string
  /** 展示用（脱敏，密码以 *** 代替）。 */
  label: string
}

/** 脱敏 URL 中的密码（面板与日志都只回显这个）。 */
function maskLabel(url: string): string {
  return url.replace(/^(\w+:\/\/[^:@/]+):[^@/]*@/, '$1:***@')
}

/**
 * 从**原始输入**里取权威段（scheme 之后、path 之前）。
 *
 * ⚠️ 端口校验必须走这里而不是 `new URL(...).port`：WHATWG URL 会把
 * **显式的默认端口抹掉**（`new URL('https://h:443').port === ''`），
 * 于是「用户确实填了 443」会被误判成「缺端口」而拒绝一个完全合法的地址。
 */
function authorityOf(raw: string): string {
  const afterScheme = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  const cut = afterScheme.search(/[/?#]/)
  return cut === -1 ? afterScheme : afterScheme.slice(0, cut)
}

/** 权威段里是否带了显式端口（已剥掉 `user:pass@` 前缀）。 */
function hasExplicitPort(authority: string): boolean {
  const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  return /:\d+$/.test(hostPart)
}

/**
 * 归一用户输入的代理地址。
 *
 * 接受三类（设计文档 §3）：本地代理客户端端口（裸 `host:port`）、HTTP(S)、SOCKS5。
 * 空串表示「清除代理」，返回 `ok: false` 让调用方走清理分支。
 */
export function normalizeProxy(input: string): { ok: true; proxy: NormalizedProxy } | { ok: false; reason: string } {
  const raw = input.trim()
  if (raw.length === 0) return { ok: false, reason: '代理地址为空（如需清除，请点「清除代理」）' }

  // 裸 host:port 补 http://（本地代理客户端端口最常见的填法）
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`
  // socks5h:// 是 socks5 的「由代理解析 DNS」变体，undici 侧行为一致，归一为 socks5://
  const url = withScheme.replace(/^socks5h:\/\//, 'socks5://')

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: '无法解析为 URL（形如 http://host:port）' }
  }

  const kind: OpencodeProxyKind | undefined =
    parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? 'http'
      : parsed.protocol === 'socks5:'
        ? 'socks5'
        : undefined
  if (kind === undefined) {
    return { ok: false, reason: `不支持的协议 ${parsed.protocol.replace(':', '')}（仅支持 http/https/socks5）` }
  }
  if (parsed.hostname.length === 0) return { ok: false, reason: '缺少主机名' }
  // ⚠️ 端口存在性从**原始串**的权威段判（见 `hasExplicitPort` 的注释），
  // 不用 `parsed.port` —— 后者会把用户显式写的 443/80 抹成空串。
  if (!hasExplicitPort(authorityOf(raw))) return { ok: false, reason: '缺少端口（如 http://127.0.0.1:7897）' }

  // ⚠️ 手工拼接而非直接用 `parsed.toString()`：后者会规范化默认端口、
  // 补尾斜杠，产生与用户输入不一致的 URL。这里只取已确认存在的 host:port。
  const scheme = kind === 'socks5' ? 'socks5' : parsed.protocol.replace(':', '')
  const auth = parsed.username.length > 0
    ? `${parsed.username}${parsed.password.length > 0 ? `:${parsed.password}` : ''}@`
    : ''
  // ⚠️ 端口用权威段里解析出来的**原始数字**（`parsed.port` 可能是空串）。
  const rawHostPort = authorityOf(raw)
  const hostOnly = auth.length > 0 ? rawHostPort.slice(rawHostPort.lastIndexOf('@') + 1) : rawHostPort
  const portMatch = /:(\d+)$/.exec(hostOnly)
  const port = portMatch?.[1] ?? parsed.port
  const normalized = `${scheme}://${auth}${parsed.hostname}:${port}`
  return { ok: true, proxy: { kind, url: normalized, label: maskLabel(normalized) } }
}
