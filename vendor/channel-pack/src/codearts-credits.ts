/**
 * 华为云 CodeArts 积分（「每日签到得积分」活动）。
 *
 * ## 为什么与另外两个积分实现都不共用协议
 *
 * | provider    | 认证方式                    | 签到流程                          |
 * |-------------|-----------------------------|-----------------------------------|
 * | `buddy`     | Bearer + 腾讯系归属头        | 两步（状态 + 领取）                |
 * | `lobsterai` | 纯 Bearer，无签名            | 三步（slot + context + check_in）  |
 * | `codearts`  | **SDK-HMAC-SHA256 签名**     | **三步（账户类型 + 活动 + 领取+确认）** |
 *
 * 华为云这套与前两者没有一处共用，故独立成文件；但**复用 `credits.ts` 的
 * `ClaimOutcome` / `CreditBalance` / `CreditPackage` 类型**，使
 * `computeClaimSummary` 与 Channel Pack 的结果摘要 UI、`CreditBalanceRow`
 * 组件一行都不用改。
 *
 * ## 协议来源（逆向自本机安装的码道 IDE，非猜测）
 *
 * `C:\Program Files\CodeArts Agent\resources\app\out\main.js:54259`
 * 与 `out\vs\workbench\workbench.desktop.main.js:375626`（`ActivityWelfarePane`）：
 *
 * ```
 * 账户/套餐  GET  {snapEngineUrl}/snap-manager/v1/statistics/plugin
 * 活动列表   GET  {snapEngineUrl}/v1/ops/delivery?channel=IDE
 * 领取       POST {snapEngineUrl}/v1/ops/claim   { campaignId, channel: 'IDE' }
 * 领取确认   POST {snapEngineUrl}/v1/ops/confirm { campaignId }
 * ```
 *
 * `snapEngineUrl` 取自 IDE 的 `product.json`，值为
 * `https://snap-access.cn-north-4.myhuaweicloud.com` —— **与本仓库
 * `src/models.ts` 已在使用的 `SNAP_MODEL_BUILTIN_URL` 同域**。
 *
 * ## 认证：签名，不是 Cookie（关键结论）
 *
 * 官方文档给出的网页版路径（`https://codearts.huaweicloud.com/portal/...`）
 * 走的是 portal BFF，**依赖浏览器会话 Cookie**：实测不带 Cookie 时无论是否
 * 携带 AK/SK 签名，都返回 IAM 登录跳转 HTML（HTTP 200 + `text/html`）。
 * 因此插件**不能**复用那条路径 —— 它没有可用的浏览器会话。
 *
 * 而 IDE 直连的 snap-access 端点接受 **`SDK-HMAC-SHA256` 签名**
 * （IDE 的 `signer.js`：`ALGORITHM = "SDK-HMAC-SHA256"`、头 `X-Security-Token`），
 * 与 `src/sign.ts` 的实现逐字一致。故本模块走签名路径，凭据就是现有的
 * `CodeArtsCredential`（AK/SK/security_token），无需任何新登录流程。
 *
 * ## 账户类型检测（活动范围的前置条件）
 *
 * 活动文档明确「活动参与者：已经升级到**积分计费模式**的用户」。
 * `statistics/plugin` 的响应里 `package.is_credit_package === true`
 * 即表示积分账户（IDE 前端正是用它决定渲染「积分版」还是「Token 版」布局，
 * 见 `accountInfoPane.js` 的 `accountInfo.isCreditPackage`）。
 *
 * 因此领取前**必须先判账户类型**：Token 计费账户不在活动范围内，
 * 直接尝试领取只会拿到一个语义模糊的错误。
 *
 * ## 幂等
 *
 * 与 CodeBuddy 靠服务端业务码、LobsterAI 靠客户端 `idempotencyKey` 都不同：
 * 这里靠**活动列表的 `claimable` / `status`** 预检。IDE 的实现同样如此
 * （按钮在 `status` 属于已领取态时被 `disabled`）。领取后若服务端要求
 * 确认（响应 `id !== null`），再补一次 `confirm` —— 这一步是 IDE 的行为，
 * 漏掉会让积分停在「待确认」而不入账。
 */

import { directFetch } from './direct-fetch.js'
import { signRequestHuawei } from './sign.js'
import type { CodeArtsCredential } from './types.js'
import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'

/**
 * snap-access 网关基址。
 *
 * 与 `src/models.ts` 的 `SNAP_MODEL_BUILTIN_URL` 同域 —— 该端点已在本仓库
 * 稳定使用，故此处沿用同一 host，不另立常量来源。
 *
 * 注：IDE 的 `PackageInfoService.getFallbackUrls` 还实现了 `.com` → `.cn`
 * 的域名回退。本实现**刻意不照搬**：该回退分支无法在本机实测（`snap-access
 * .cn-north-4.myhuaweicloud.cn` 的可达性与响应形态均未验证），引入一条未验证
 * 的请求路径只会让失败原因更难定位。若将来确认 `.cn` 域名必要，再补不迟。
 */
export const CODEARTS_SNAP_ENGINE_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com'

/** 账户/套餐信息端点 —— 积分账户检测的唯一真相源。 */
export const CODEARTS_PACKAGE_INFO_PATH = '/snap-manager/v1/statistics/plugin'
/** 活动列表端点。 */
export const CODEARTS_OPS_DELIVERY_PATH = '/v1/ops/delivery'
/** 领取端点。 */
export const CODEARTS_OPS_CLAIM_PATH = '/v1/ops/claim'
/** 领取确认端点。 */
export const CODEARTS_OPS_CONFIRM_PATH = '/v1/ops/confirm'

/** 渠道标识：声明请求来自 IDE 形态（对齐 IDE 的 `channel=IDE`）。 */
export const CODEARTS_OPS_CHANNEL = 'IDE'

/**
 * 「每日签到得积分」在活动列表里的 `type` 取值。
 *
 * IDE 的 `ActivityWelfarePane.TYPE_ORDER` 把活动分为四类，其中 `USER_LOGIN`
 * 即「每日登录领取」；`INVITE_USER` / `NEW_USER_REGISTER` / `STUDENT_CERTIFIED`
 * 是邀请、新人、学生认证，**不属于**每日签到，不能混领。
 */
export const CODEARTS_DAILY_LOGIN_TYPE = 'USER_LOGIN'

/**
 * 活动 `status` 中表示「已领取/已确认/已核销」的取值。
 *
 * 取自 IDE `ActivityWelfarePane.render`：这三种状态下领取按钮被禁用。
 * 用于把「今天已领」与「活动未开始/无资格」区分开 —— 两者对用户的含义不同。
 */
const CLAIMED_STATUSES: readonly string[] = ['CLAIMED', 'CONFIRMED', 'CONSUMED']

/** 请求超时（毫秒）。与 `credits.ts` 的 30s 同口径。 */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * 所有 snap-access 请求共用的附加头（**签名后追加，不参与签名计算**）。
 *
 * ⚠️ 这两个头绝不能作为 `signRequestHuawei` 的 `extraHeaders` 传入。
 *
 * 实测（2026-09-18，真实凭据）：一旦 `Agent-Type` 进入 canonical request 与
 * SignedHeaders，服务端回
 * `401 {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`；
 * 同一个头在**签名之后**追加则请求成功（200 并返回真实数据）。
 *
 * 这与 `src/models.ts` 的 `fetchSignedGet` 一致 —— 它的参数注释明确写着
 * 「签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）」。本模块早期版本
 * 误当作签名头，导致全部 CodeArts 积分请求 401、界面显示「账户信息查询失败」。
 *
 * `Agent-Type` 本身仍是**服务端路由所需**（`/v1/model/builtin` 等端点靠它
 * 选择响应形态），只是不该被签名。
 */
const SNAP_EXTRA_HEADERS: Readonly<Record<string, string>> = {
  'Agent-Type': 'PromptCenter',
  'X-Language': 'zh-cn',
}

/**
 * 积分 metric 名 → 展示名。
 *
 * `statistics/plugin` 的 `metrics[]` 用 `name` 区分口径，IDE 从其中四项读取
 * 积分数（`accountInfoPane.js` 的 `apply`）：
 * `usageTotalPackageCredit` 是总额，其余三项是分类明细。
 */
const CREDIT_METRIC_LABELS: Readonly<Record<string, string>> = {
  usageTotalPackageCredit: '总积分包',
  usageBasicPackageCredit: '基础积分包',
  usageOnDemandPackageCredit: '按需积分包',
  usageBonusPackageCredit: '赠送积分包',
}

/** 总额 metric 的名字（其余分类明细不参与总额计算，避免重复累加）。 */
const TOTAL_CREDIT_METRIC = 'usageTotalPackageCredit'

/** 账户/套餐信息（`statistics/plugin` 解析结果）。 */
export interface CodeArtsAccountInfo {
  /**
   * 是否为**积分计费账户**（活动文档所说的「已升级到积分计费模式」）。
   *
   * 这是能否领取积分的前置条件。为 false 时是 Token 计费账户，
   * 不在「每日签到得积分」活动范围内。
   */
  isCreditPackage: boolean
  /** 是否为旧的 Token 计费账户（`package.is_token_package`）。 */
  isTokenPackage: boolean
  /** 套餐规格码（如 `codearts.agent.enterprise.ultimate_pro`）。 */
  specCode: string
  /** 套餐展示名（优先中文名）。 */
  packageName: string
  /** 套餐状态（`package.status`）。 */
  packageStatus: string
  /**
   * 积分余额；非积分账户或无 credit metric 时为 `undefined`。
   *
   * 与 `total` 为 0 严格区分：`undefined` 表示「这个账户没有积分口径」，
   * 而 `{ total: 0 }` 表示「有积分口径但当前为 0」。
   */
  credit?: CreditBalance
}

/** 活动列表中的一项（只保留签到所需字段）。 */
export interface CodeArtsOpsActivity {
  /**
   * 活动 ID，领取时回传。
   *
   * ⚠️ **服务端下发的是数字**（实测 `campaignId = 1`），不是字符串。
   * 早期实现用只接受字符串的 `readString` 解析，结果恒为空串，
   * 领取被判为 `failed`「活动缺少 campaignId，无法领取」
   * —— 用户看到「1 个失败」而积分实际没领到。
   */
  campaignId: string
  /** 活动类型（如 `USER_LOGIN`）。 */
  type: string
  /** 活动标题。 */
  title: string
  /** 当前是否可领取 —— 领取判定的权威依据。 */
  claimable: boolean
  /** 活动状态（如 `ENTRY` / `CLAIMED`）；不可领取时可能为 null。 */
  status: string
  /**
   * 该活动可领积分。
   *
   * 字段名是 **`benefitAmount`**（实测 1000），不是 `amount`。
   * 早期实现读 `amount` 而服务端不返回该字段，导致回退成 0。
   */
  amount: number
}

/** 一次请求的解析结果（与 `credits.ts` 的 `PostResult` 同构）。 */
type SnapResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: number; message: string }

/** 响应体可解析为对象、但缺少必要字段时的统一失败说明。 */
const UNPARSABLE_RESPONSE_MESSAGE = '请求失败或响应无法解析'

/**
 * 把非 2xx 响应整理成**带服务端原因**的说明。
 *
 * 为什么不能只写 `HTTP 401`：华为网关的错误体里带着真正的原因，例如
 * `{"error_code":"APIG.0301","error_msg":"Incorrect IAM authentication
 * information: verify ak sk signature fail"}`。丢掉它会让「签名头位置不对」
 * 「凭据过期」「AK 无权限」这些**处置方式完全不同**的问题看起来一模一样
 * —— 本模块就因此把一次 401 显示成了笼统的「账户信息查询失败」。
 */
function describeHttpFailure(status: number, text: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const code = typeof parsed.error_code === 'string' ? parsed.error_code : ''
    const msg = typeof parsed.error_msg === 'string' ? parsed.error_msg : ''
    detail = [code, msg].filter(part => part.length > 0).join(' ')
  } catch {
    // 非 JSON（网关 HTML 错误页等）：截断原文，避免把整页 HTML 塞进 UI。
    detail = text.trim().slice(0, 200)
  }
  return detail.length > 0 ? `HTTP ${status}：${detail}` : `HTTP ${status}`
}

/** 从 JSON 安全读取布尔值（兼容 `true` / `'true'` 两种形态）。 */
function readBool(source: Record<string, unknown>, key: string): boolean {
  const value = source[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return false
}

/** 从 JSON 安全读取数字（兼容数字字符串；缺失或非法返回 0）。 */
function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** 从 JSON 安全读取字符串。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 读取一个**标识符类**字段并统一成字符串（兼容数字与字符串两种形态）。
 *
 * 为什么需要它：华为服务端对同一语义字段的类型并不一致 —— 实测
 * `campaignId` 下发的是**数字** `1`，而活动 `status` 下发的是字符串
 * （不可领取时甚至为 `null`）。用只接受字符串的 {@link readString} 去读
 * `campaignId` 会得到空串，领取流程据此判定「缺少 campaignId」而失败
 * （真实缺陷：用户点「一键领取积分」后看到「1 个失败」）。
 *
 * 数字转字符串用 `String(value)`：`1` → `'1'`，正是回传服务端所需的形态。
 * 对象/数组/布尔等非标量一律返回空串，避免把 `[object Object]` 当作 ID 发出去。
 */
function readIdentifier(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 取出一个非数组的对象值；不是对象时返回空对象。 */
function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * 解包响应信封。
 *
 * **必须兼容两种形态**，因为两个端点的信封结构不同（逆向所得）：
 *
 * - `ops/*`（`ActivityWelfarePane.request`）返回 `{ code, message, data }`，
 *   且 `code !== 0` 即业务失败；
 * - `statistics/plugin`（`PackageInfoService.doFetch`）**直接返回裸对象**
 *   （`toPackageInfo(JSON.parse(body))`，没有 `data` 解包步骤）。
 *
 * 判定顺序：先看 `code`（存在且非 0 即失败），再取 `data`，没有 `data`
 * 就认为 body 本身即数据。这样两种形态都能正确解析，且不会把业务失败
 * 当成成功 —— 那会让「活动未开始」被误报成「领取成功」。
 */
function unwrapSnapEnvelope(raw: Record<string, unknown>): SnapResult {
  const code = raw.code
  const hasCode = typeof code === 'number'
  if (hasCode) {
    if (code !== 0) {
      const message = readString(raw, 'message') || readString(raw, 'msg')
      return { ok: false, code, message: message.length > 0 ? message : `业务码 ${code}` }
    }
    const data = raw.data
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      return { ok: true, data: data as Record<string, unknown> }
    }
    return { ok: false, code, message: '响应缺少 data 字段' }
  }
  // 无 code 字段：裸对象形态（statistics/plugin）。
  return { ok: true, data: raw }
}

/**
 * 发起一次带 SDK-HMAC-SHA256 签名的 snap-access 请求。
 *
 * 网络失败与非 2xx 都返回带**原因说明**的失败，而不是笼统的 undefined ——
 * 与 `credits.ts` 同款取舍：调用方需要能如实呈现「为什么查不到」。
 */
async function signedSnapRequest(
  method: 'GET' | 'POST',
  url: string,
  credential: CodeArtsCredential,
  body: string | undefined,
  fetcher: typeof fetch,
): Promise<SnapResult> {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential
  if (!ak || !sk) {
    return { ok: false, code: -1, message: '凭据缺少 AK/SK' }
  }
  try {
    const payload = body === undefined ? new Uint8Array() : new TextEncoder().encode(body)
    // 签名**不含** SNAP_EXTRA_HEADERS：那两个头在下面签名后追加。
    // 把它们传进来会进 canonical request，服务端验签失败（见该常量注释）。
    const signed = await signRequestHuawei(ak, sk, st, method, url, payload)
    const headers = new Headers()
    // `host` 由运行时按实际连接目标生成，手工设置会被 fetch 拒绝/忽略。
    signed.forEach((value, key) => {
      if (key !== 'host') headers.set(key, value)
    })
    for (const [key, value] of Object.entries(SNAP_EXTRA_HEADERS)) headers.set(key, value)
    const response = await fetcher(url, {
      method,
      headers,
      ...body === undefined ? {} : { body },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      // 把服务端的错误码/原因带出来。实测 401 时响应体是
      // `{"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`，
      // 只报 `HTTP 401` 会让「签名头放错位置」这类问题极难定位。
      return { ok: false, code: response.status, message: describeHttpFailure(response.status, text) }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, code: -1, message: UNPARSABLE_RESPONSE_MESSAGE }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, code: -1, message: UNPARSABLE_RESPONSE_MESSAGE }
    }
    return unwrapSnapEnvelope(parsed as Record<string, unknown>)
  } catch (error) {
    return {
      ok: false, code: -1,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 从 `metrics[]` 解析积分余额。
 *
 * 总额取 `usageTotalPackageCredit` 的 `package_credit_remain`，**不累加各分类**
 * —— 分类（基础/按需/赠送）是总额的构成明细，相加会重复计算。
 * 总额 metric 缺失时才回退为分类求和。
 *
 * 没有任何 credit metric 时返回 `undefined`（= 该账户没有积分口径），
 * 与 `total: 0`（有口径但余额为 0）严格区分。
 */
function parseCreditBalance(metrics: unknown): CreditBalance | undefined {
  if (!Array.isArray(metrics)) return undefined
  const packages: CreditPackage[] = []
  let totalRemain: number | undefined
  let sawAnyCreditMetric = false

  for (const item of metrics) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const name = readString(record, 'name')
    const label = CREDIT_METRIC_LABELS[name]
    if (label === undefined) continue
    sawAnyCreditMetric = true

    const amount = readNumber(record, 'package_credit_amount')
    const used = readNumber(record, 'package_credit_used')
    const remain = readNumber(record, 'package_credit_remain')
    if (name === TOTAL_CREDIT_METRIC) totalRemain = remain
    // 额度为 0 的分类不列为资源包：列出来只会让「N 个资源包」虚高。
    if (amount <= 0 && remain <= 0) continue
    packages.push({
      name: label,
      unit: 'credit',
      remaining: remain,
      total: amount,
      used,
      // `statistics/plugin` 不下发资源包的有效性/周期字段（那是腾讯侧的形态）。
      // 这里如实置为有效、周期留空，而不是臆造一个到期时间。
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    })
  }

  if (!sawAnyCreditMetric) return undefined
  const total = roundCredits(
    totalRemain ?? packages.reduce((sum, pkg) => sum + pkg.remaining, 0),
  )
  return { total, packages, expiredTotal: 0 }
}

/**
 * 查询账户/套餐信息 —— 含**积分账户检测**。
 *
 * 返回 `null` 表示查询失败（网络/签名/结构问题），与「查到了但非积分账户」
 * （返回 `isCreditPackage: false` 的对象）严格区分：前者要用户排查网络或
 * 重新登录，后者是正常的账户类型差异。
 *
 * 需要**失败原因**时用 {@link fetchCodeArtsAccountInfoDetailed}。
 */
export async function fetchCodeArtsAccountInfo(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = directFetch,
): Promise<CodeArtsAccountInfo | null> {
  const result = await fetchCodeArtsAccountInfoDetailed(credential, fetcher)
  return result.ok ? result.info : null
}

/** {@link fetchCodeArtsAccountInfo} 的带原因版本。 */
export type CodeArtsAccountInfoResult =
  | { ok: true; info: CodeArtsAccountInfo }
  | { ok: false; message: string }

/**
 * 查询账户/套餐信息，失败时**保留底层原因**。
 *
 * 为什么需要带原因的版本：领取流程里「账户信息查询失败」可能源于网络超时、
 * 签名错误或凭据过期，把它们统一压成一句笼统文案，会让用户与排查者都拿不到
 * 线索（本仓库在 `credits.ts` / `lobsterai-credits.ts` 都刻意保留原始错误消息）。
 */
export async function fetchCodeArtsAccountInfoDetailed(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = directFetch,
): Promise<CodeArtsAccountInfoResult> {
  const url = `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_PACKAGE_INFO_PATH}`
  const result = await signedSnapRequest('GET', url, credential, undefined, fetcher)
  if (!result.ok) return { ok: false, message: result.message }

  const data = result.data
  const pkg = readRecord(data, 'package')
  const packageNameCn = readString(pkg, 'package_name_cn')
  const packageNameEn = readString(pkg, 'package_name_en')
  return {
    ok: true,
    info: {
      isCreditPackage: readBool(pkg, 'is_credit_package'),
      isTokenPackage: readBool(pkg, 'is_token_package'),
      specCode: readString(pkg, 'spec_code'),
      packageName: packageNameCn.length > 0 ? packageNameCn : packageNameEn,
      packageStatus: readString(pkg, 'status'),
      credit: parseCreditBalance(data.metrics),
    },
  }
}

/** 把活动列表的一项解析为 {@link CodeArtsOpsActivity}。 */
function parseActivity(item: Record<string, unknown>): CodeArtsOpsActivity {
  return {
    // 用 readIdentifier 而非 readString：实测 campaignId 是**数字** 1。
    campaignId: readIdentifier(item, 'campaignId'),
    type: readString(item, 'type'),
    title: readString(item, 'title'),
    claimable: readBool(item, 'claimable'),
    status: readString(item, 'status'),
    // 可领积分数：实测字段名是 `benefitAmount`（值 1000）。
    // 保留另两个候选名作兼容回退，取不到才为 0。
    amount: readNumber(item, 'benefitAmount')
      || readNumber(item, 'amount')
      || readNumber(item, 'creditAmount'),
  }
}

/**
 * 查询活动列表。
 *
 * 返回 `null` 表示查询失败；返回数组（可能为空）表示查询成功。
 * 与 `credits.ts` 的取舍一致：把「查不到」与「没有活动」分开，
 * 否则网络故障会显示成「活动未开启」，把用户引向错误的排查方向。
 *
 * 需要**失败原因**时用 {@link fetchCodeArtsOpsActivitiesDetailed}。
 */
export async function fetchCodeArtsOpsActivities(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = directFetch,
): Promise<CodeArtsOpsActivity[] | null> {
  const result = await fetchCodeArtsOpsActivitiesDetailed(credential, fetcher)
  return result.ok ? result.activities : null
}

/** {@link fetchCodeArtsOpsActivities} 的带原因版本。 */
export type CodeArtsActivitiesResult =
  | { ok: true; activities: CodeArtsOpsActivity[] }
  | { ok: false; message: string }

/** 查询活动列表，失败时保留底层原因。 */
export async function fetchCodeArtsOpsActivitiesDetailed(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = directFetch,
): Promise<CodeArtsActivitiesResult> {
  const url = `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_DELIVERY_PATH}?channel=${CODEARTS_OPS_CHANNEL}`
  const result = await signedSnapRequest('GET', url, credential, undefined, fetcher)
  if (!result.ok) return { ok: false, message: result.message }
  const items = result.data.items
  if (!Array.isArray(items)) return { ok: false, message: '响应缺少 items 字段' }
  return {
    ok: true,
    activities: items
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && !Array.isArray(item))
      .map(parseActivity),
  }
}

/** 在活动列表里找「每日签到」那一项；没有则返回 undefined。 */
export function findDailyCheckinActivity(
  activities: readonly CodeArtsOpsActivity[],
): CodeArtsOpsActivity | undefined {
  return activities.find((activity) => activity.type === CODEARTS_DAILY_LOGIN_TYPE)
}

/**
 * 执行每日签到领取（完整流程）。
 *
 * 步骤与判定顺序（每一步都对应一个**对用户含义不同**的结果）：
 *
 * 1. 查账户类型 —— 查询失败 → `failed`；非积分账户 → `inactive`
 *    （活动范围明确限定「已升级到积分计费模式的用户」，Token 账户不该被
 *    报成「领取失败」）；
 * 2. 查活动列表 —— 查询失败 → `failed`；无 `USER_LOGIN` 活动 → `inactive`；
 * 3. 活动不可领取且状态属已领取态 → `already-claimed`；其余不可领取 → `inactive`；
 * 4. `POST /v1/ops/claim` —— 失败 → `failed`；
 * 5. 响应 `id !== null` 时补 `POST /v1/ops/confirm`（漏掉会让积分停在待确认）；
 * 6. 成功 → `claimed`。
 *
 * 注意第 3 步是**唯一的幂等保护**：本协议没有幂等键，也没有服务端
 * 「今天已签到」业务码可依赖，因此预检不能省。
 */
export async function claimCodeArtsDailyCheckin(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = directFetch,
): Promise<ClaimOutcome> {
  const infoResult = await fetchCodeArtsAccountInfoDetailed(credential, fetcher)
  if (!infoResult.ok) {
    return { kind: 'failed', code: -1, message: `账户信息查询失败：${infoResult.message}` }
  }
  const info = infoResult.info
  if (!info.isCreditPackage) {
    return {
      kind: 'inactive',
      message: info.isTokenPackage
        ? 'Token 计费账户，不在积分活动范围'
        : '非积分计费账户，不在积分活动范围',
    }
  }

  const activitiesResult = await fetchCodeArtsOpsActivitiesDetailed(credential, fetcher)
  if (!activitiesResult.ok) {
    return { kind: 'failed', code: -1, message: `活动列表查询失败：${activitiesResult.message}` }
  }
  const activity = findDailyCheckinActivity(activitiesResult.activities)
  if (activity === undefined) {
    return { kind: 'inactive', message: '未找到每日签到活动' }
  }
  if (!activity.claimable) {
    return CLAIMED_STATUSES.includes(activity.status)
      ? { kind: 'already-claimed', message: '今天已领取' }
      : { kind: 'inactive', message: `当前不可领取（status=${activity.status}）` }
  }
  if (activity.campaignId.length === 0) {
    return { kind: 'failed', code: -1, message: '活动缺少 campaignId，无法领取' }
  }

  const claimResult = await signedSnapRequest(
    'POST',
    `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_CLAIM_PATH}`,
    credential,
    JSON.stringify({ campaignId: activity.campaignId, channel: CODEARTS_OPS_CHANNEL }),
    fetcher,
  )
  if (!claimResult.ok) {
    return { kind: 'failed', code: claimResult.code, message: claimResult.message }
  }

  // 服务端要求确认时才补 confirm：IDE 的判据是 `benefit.id !== null`。
  // confirm 失败**不**把整体判为失败 —— 积分已进入待确认态，报 failed 会让
  // 用户以为没领到而重复点击；这里如实返回 claimed，把确认异常留在日志层。
  const benefitId = claimResult.data.id
  if (benefitId !== null && benefitId !== undefined) {
    await signedSnapRequest(
      'POST',
      `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_CONFIRM_PATH}`,
      credential,
      JSON.stringify({ campaignId: activity.campaignId }),
      fetcher,
    )
  }

  // 积分取多级回退：领取响应 → 活动条目。两处都没有时如实记 0，
  // 不臆造「1000」——文档里的 1000 是活动规则，不是本次发放的实测值。
  //
  // `benefitAmount` 排在首位：活动列表用的就是这个字段名（实测 1000），
  // 领取响应大概率同源；其余候选名保留作兼容。
  const claimCredit = readNumber(claimResult.data, 'benefitAmount')
    || readNumber(claimResult.data, 'credit')
    || readNumber(claimResult.data, 'credits')
    || readNumber(claimResult.data, 'creditAmount')
    || readNumber(claimResult.data, 'amount')
  return {
    kind: 'claimed',
    credit: claimCredit > 0 ? claimCredit : activity.amount,
    // CodeArts 的活动不下发连续签到天数概念（那是 CodeBuddy 的机制）。
    streakDays: 0,
    isStreakDay: false,
  }
}

/**
 * 把额度规整为两位小数。
 *
 * 与 `credits.ts` / `lobsterai-credits.ts` 同口径：多包相加会把服务端的
 * 浮点尾数（如 55.67000031）显式化，金额展示到分即可。
 */
function roundCredits(value: number): number {
  return Math.round(value * 100) / 100
}
