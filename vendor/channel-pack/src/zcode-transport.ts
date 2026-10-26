/**
 * ZCode 的**通道传输层**：只回答「这个模型走哪条腿、用什么凭据」。
 *
 * ## 为什么单独一个文件
 *
 * ZCode 的两条通道（`start-plan` 积分 / `coding-plan` 订阅）**响应格式完全相同**
 * —— 官方配置 `resources/config/provider/zcode-builtin.json` 里两条
 * `providerRules` 的 `api.type` 都是 `anthropic-messages`（2026-10-03 实测）。
 * 只有**端点与凭据**不同。
 *
 * ⇒ 本文件只管选路与组装；SSE 解析复用 `zcode-anthropic.ts`（**不改动它**）。
 *
 * ## 通道定义（全部来自 2026-10-03 的实测与官方配置逆向）
 *
 * | 通道 | 端点 | 凭据 |
 * |---|---|---|
 * | `start-plan` | `zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | `zcode_jwt` |
 * | `coding-plan` | `api.z.ai/api/anthropic/v1/messages` | `coding_plan_key_zai` / `_bigmodel` |
 *
 * ⚠ **积分制（`start-plan`）无论账号是 bigmodel 还是 zai，都发 `zcode.z.ai`**
 * （官方分派表规则 2/5）—— **不要**因为账号是国际版就改域名。
 *
 * ⚠ `coding-plan` 的 api-key **不是登录时下发的**，是用 OAuth access_token 换取的
 * （逆向官方 `AccountProviderApiKeyResolver`），见 {@link fetchCodingPlanApiKey}。
 */

import type { ZcodeCredential } from './zcode.js'
import { buildZcodeHeaders, zcodeMessagesUrl } from './zcode-upstream.js'

/** ZCode 的两条上游通道。 */
export type ZcodeChannel = 'start-plan' | 'coding-plan'

/** 一条通道的可用性与它承载的模型。 */
export interface ZcodeChannelInfo {
  readonly channel: ZcodeChannel
  /** 凭据是否具备该通道所需的字段。 */
  readonly available: boolean
  /** 该通道承载的模型（小写 model id）。 */
  readonly models: readonly string[]
}

/**
 * 换取 coding-plan api-key 时用的 biz origin。
 *
 * ⚠ 2026-10-03 实测：两个候选里只有它通（`chat.z.ai` 的
 * `/api/biz/customer/getCustomerInfo` 回 404）。
 */
export const ZCODE_BIZ_ORIGIN = 'https://api.z.ai'

/** 两条通道各自承载的模型（键为小写 model id）。 */
const CHANNEL_MODELS: Readonly<Record<ZcodeChannel, readonly string[]>> = {
  'start-plan': ['glm-5.3-flash', 'glm-5.2', 'glm-5-turbo'],
  // ⚠ 只开官方 `builtinModelIds` 确认过的两个（`GLM-5.3` / `GLM-5.3-Flash`）。
  //   远端 `GET api.z.ai/api/anthropic/v1/models` 实测有 11 个，但官方做了白名单
  //   限制；其余 9 个订阅是否覆盖**未验证**（见设计文档 §9 的待实测清单）。
  'coding-plan': ['glm-5.3', 'glm-5.3-flash'],
}

/** 该凭据能否走这条通道。 */
function available(credential: ZcodeCredential, channel: ZcodeChannel): boolean {
  if (channel === 'start-plan') {
    return typeof credential.zcode_jwt === 'string' && credential.zcode_jwt.length > 0
  }
  return (typeof credential.coding_plan_key_zai === 'string' && credential.coding_plan_key_zai.length > 0)
    || (typeof credential.coding_plan_key_bigmodel === 'string' && credential.coding_plan_key_bigmodel.length > 0)
}

/** 列出两条通道的可用性与模型。 */
export function describeChannels(credential: ZcodeCredential): ZcodeChannelInfo[] {
  return (['start-plan', 'coding-plan'] as const).map((channel) => ({
    channel,
    available: available(credential, channel),
    models: CHANNEL_MODELS[channel],
  }))
}

/**
 * 这个模型优先走哪条通道。
 *
 * ⚠ **start-plan 优先**（用户 2026-10-03 决定）：积分是白给的，
 * 不该被「订阅额度」先消耗掉。失败时的换腿重试由调用方（适配器）负责。
 *
 * ⚠ 判据是**模型是否属于该通道**；凭据缺失时退回 `start-plan`
 * （保守：那是已验证可用的一条腿），**不抛错**。
 */
export function resolveChannelFor(credential: ZcodeCredential, model: string): ZcodeChannel {
  const key = model.trim().toLowerCase()
  const inChannel = (channel: ZcodeChannel): boolean => CHANNEL_MODELS[channel].includes(key)
  if (inChannel('start-plan') && available(credential, 'start-plan')) return 'start-plan'
  if (inChannel('coding-plan') && available(credential, 'coding-plan')) return 'coding-plan'
  return 'start-plan'
}

/**
 * 组装一条通道的请求（URL + 头 + 凭据）。
 *
 * ## 凭据按通道取
 * | 通道 | Authorization |
 * |---|---|
 * | `start-plan` | `Bearer <zcode_jwt>` |
 * | `coding-plan` | `Bearer <coding_plan_key_zai ?? coding_plan_key_bigmodel>` |
 *
 * ⚠ **缺 key 时不返回 `Authorization`，而不是抛错** —— 调用方据此判定
 * 「该通道不可用」并换腿，不该在这里炸掉整条请求。
 * `describeChannels` 已经能提前判，这里是最后一道。
 *
 * ⚠ **coding-plan 不带 `HTTP-Referer`** —— 那是 `zcode.z.ai` 专属头，
 * 发到 `api.z.ai` 上没有意义（2026-10-03 实测该网关只认
 * `Authorization` + `anthropic-version`）。
 *
 * @param body 请求体。**仅供将来加通道专属头时用**，当前两条通道都用
 *   调用方自己带上的 body，故不参与组装。
 */
export function buildChannelRequest(
  credential: ZcodeCredential,
  channel: ZcodeChannel,
  body: string,
): { url: string, headers: Record<string, string> } {
  // ⚠ 每次都新建（`buildZcodeHeaders` 内部即新建对象），调用方改返回值
  //   不会污染下一次调用。
  const headers = buildZcodeHeaders(credential, { json: true })
  const token = channel === 'coding-plan'
    ? (credential.coding_plan_key_zai ?? credential.coding_plan_key_bigmodel)
    : credential.zcode_jwt
  if (typeof token === 'string' && token.length > 0) headers.Authorization = `Bearer ${token}`
  if (channel === 'coding-plan') delete headers['HTTP-Referer']
  void body
  return { url: zcodeMessagesUrl(channel), headers }
}

/** 换取结果；`key` 为 undefined 时 `reason` 说明卡在哪一步。 */
export interface ZcodeApiKeyResult {
  readonly key: string | undefined
  readonly reason?: 'no-oauth-token' | 'no-org' | 'no-key' | 'no-secret' | 'http-error'
}

/**
 * 官方写死取用的那个 key 名。
 *
 * ⚠ 正式值是 **`zcode-api-key`**（官方 `resolveBizApiKey` 里 `g.name === yE`，
 * 其中 `yE = "zcode-api-key"`，2026-10-03 从 `app.asar` 的 `out/host/index.js`
 * 常量表读出）—— **不是 `zcode`**。写错会让换取永远返回 `no-key`。
 */
const API_KEY_NAME = 'zcode-api-key'

/** 官方挑「默认机构 / 默认项目」时用的名字关键词（常量 `F2` / `B2`）。 */
const DEFAULT_ORG_NAME = '默认机构'
const DEFAULT_PROJECT_NAME = '默认项目'

/** `getCustomerInfo` 里与挑 org/project 有关的子集。 */
interface CustomerInfoProject {
  projectId?: unknown
  projectName?: unknown
  projectType?: unknown
}
interface CustomerInfoOrg {
  organizationId?: unknown
  organizationName?: unknown
  projects?: unknown
}

/**
 * 从响应里挑出 `{organizationId, projectId}`。
 *
 * ## 逐字对应官方 `pickOrgAndProject`（`out/host/index.js` 的 `l_e`）
 * ```js
 * organizations.map(o => ({ organization: o,
 *   projects: (o.projects ?? []).filter(p => String(p.projectType ?? '').trim() !== '2') }))
 *   .filter(({organization, projects}) => organization.organizationId && projects.length)
 * org  = 第一个 organizationName 含「默认机构」的，否则 [0]
 * proj = 该 org 内第一个 projectName 含「默认项目」的，否则 projects[0]
 * ```
 *
 * ⚠ **响应是 `data.organizations`（数组）**，不是 `data.organizationId` ——
 *   2026-10-03 实测确认（`HTTP 200` + `msg "Operation successful"`，但顶层取不到）。
 *   按后者写会永远取不到 org，换取必然失败。
 *
 * ⚠ **`projectType === '2'` 必须过滤** —— 那是非项目类条目，
 *   不过滤会取到错的 `projectId`。
 */
function pickOrgAndProject(data: unknown): { organizationId: string, projectId: string } | undefined {
  // ⚠ 只认 `data.organizations`（官方响应形状，2026-10-03 实测）。
  //   早期实现还兼容「直接传裸数组」，但那个分支**没有调用方、也没有测试覆盖**
  //   （反向验证：改掉它，全部用例仍绿 ⇒ 它是不可验证的死分支）⇒ 已删。
  const orgs = Array.isArray((data as { organizations?: unknown })?.organizations)
    ? (data as { organizations: CustomerInfoOrg[] }).organizations
    : []
  const candidates = orgs
    .map((o) => ({
      organization: o,
      projects: (Array.isArray(o.projects) ? o.projects as CustomerInfoProject[] : [])
        .filter((p) => String(p.projectType ?? '').trim() !== '2'),
    }))
    .filter((c) => typeof c.organization.organizationId === 'string'
      && c.organization.organizationId.length > 0
      && c.projects.length > 0)
  if (candidates.length === 0) return undefined
  const target = candidates.find((c) => String(c.organization.organizationName ?? '').includes(DEFAULT_ORG_NAME))
    ?? candidates[0]
  if (target === undefined) return undefined
  const organizationId = String(target.organization.organizationId)
  const project = target.projects.find((p) => String(p.projectName ?? '').includes(DEFAULT_PROJECT_NAME))
    ?? target.projects[0]
  const projectId = project?.projectId
  if (typeof projectId !== 'string' || projectId.length === 0) return undefined
  return { organizationId, projectId }
}

/** 换取链路的请求头（官方 `createBizAuthHeaders` 同款）。 */
function bizHeaders(token: string, credential: ZcodeCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': `ZCode/${credential.app_version ?? '3.14.4'}`,
    'X-Platform': 'win32',
    ...(typeof credential.device_mid === 'string' && credential.device_mid.length > 0
      ? { 'X-Device-Mid': credential.device_mid }
      : {}),
  }
}

/** 发一个 GET 并解 JSON；任何失败都返回 undefined（**不抛**）。 */
async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  try {
    const res = await fetchImpl(url, { method: 'GET', headers })
    if (!res.ok) return undefined
    return await res.json() as unknown
  } catch {
    return undefined
  }
}

/**
 * 用 OAuth access_token 换取 coding-plan 的 api-key（**三步，只 GET**）。
 *
 * ## 链路来源（逆向官方 `app.asar` 的 `AccountProviderApiKeyResolver`）
 * ```
 * ① GET {origin}/api/biz/customer/getCustomerInfo                    → org + project
 * ② GET {origin}/api/biz/v1/organization/{o}/projects/{p}/api_keys  → 找名为 zcode-api-key 的
 * ③ GET {origin}/…/api_keys/copy/{apiKey}                           → secretKey
 * ④ key = `{apiKey}.{secretKey}`
 * ```
 *
 * ⚠ **api-key 不是登录时下发的** —— 官方用 OAuth access_token 现换
 * （`loadCodingPlanApiKey` → `resolveProviderApiKey`）。这也正是
 * 「装了 IDE 的用户走 ② 路径有 key、纯插件登录用户需要自己换」的原因。
 *
 * ⚠ **只用 GET**（用户 2026-10-03 决定："不在云上建 key"）。
 * 官方实现在 ② 找不到时会 `POST` 建一个 —— **本实现不复刻那一支**。
 * 代价：从未建过 key 的账号拿不到（`reason='no-key'`），
 * 该账号的 coding-plan 通道标记为不可用，**不影响 start-plan**。
 */
export async function fetchCodingPlanApiKey(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeApiKeyResult> {
  const token = credential.zai_access_token ?? credential.bigmodel_access_token
  if (typeof token !== 'string' || token.length === 0) return { key: undefined, reason: 'no-oauth-token' }
  const headers = bizHeaders(token, credential)

  // ① 组织与项目
  const info = await getJson(
    `${ZCODE_BIZ_ORIGIN}/api/biz/customer/getCustomerInfo`,
    headers,
    fetchImpl,
  ) as { data?: { organizations?: unknown } } | undefined
  const picked = pickOrgAndProject(info?.data)
  if (picked === undefined) return { key: undefined, reason: 'no-org' }
  const { organizationId: org, projectId: proj } = picked

  // ② 列出 api_keys（★ 只 GET，不建）
  const listUrl = `${ZCODE_BIZ_ORIGIN}/api/biz/v1/organization/${encodeURIComponent(org)}`
    + `/projects/${encodeURIComponent(proj)}/api_keys`
  const list = await getJson(listUrl, headers, fetchImpl)
  const entries = Array.isArray(list) ? list as Array<{ name?: unknown, apiKey?: unknown }> : []
  const apiKeyRaw = entries.find((e) => e.name === API_KEY_NAME)?.apiKey
  const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw.trim() : ''
  if (apiKey.length === 0) return { key: undefined, reason: 'no-key' }

  // ③ copy 取 secretKey
  const copied = await getJson(
    `${listUrl}/copy/${encodeURIComponent(apiKey)}`,
    headers,
    fetchImpl,
  ) as { secretKey?: unknown } | undefined
  const secret = typeof copied?.secretKey === 'string' ? copied.secretKey.trim() : ''
  if (secret.length === 0) return { key: undefined, reason: 'no-secret' }

  return { key: `${apiKey}.${secret}` }
}

/**
 * 是否因「额度/资源包用尽」而换另一条通道重试。
 *
 * ## 只认这两个业务码（且必须配 429）
 * - `1005` 余额不足
 * - `1113` 无可用资源包（ultra/coding-plan 侧的余额不足）
 *
 * ⚠ **必须连状态码一起判**：这两个码只在 429 里表示「额度用尽」；
 * 别的端点复用同一码时语义不同，无脑换腿会白烧另一条通道的额度。
 *
 * ⚠ **不认**：
 * - `401` / `1002`（凭据失效）—— 换通道也是**同一份凭据**，救不了；
 * - `3012`（风控）—— 重试会**加重账号冷却惩罚**：30 分钟 → 24 小时 → 停用；
 * - `3009`（并发限流）—— 走既有退避即可，换腿治不了并发。
 */
export function shouldFallbackToOtherChannel(status: number, body: string): boolean {
  if (status !== 429) return false
  return body.includes('1005') || body.includes('1113')
}
