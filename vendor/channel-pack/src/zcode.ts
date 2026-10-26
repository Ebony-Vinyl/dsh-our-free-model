/**
 * ZCode 凭据类型与判据（**纯类型 + 纯函数，不碰磁盘**）。
 *
 * ## ⚠⚠ 本文件**不再**读取官方 ZCode 客户端的本机数据（2026-10-05，用户决策）
 *
 * ### 被删掉的是什么
 *
 * 初版（PR #17 起）有一整套「复用官方客户端登录态」的能力，**已整体移除**：
 *
 * | 已删除 | 原来读的本机数据 |
 * |---|---|
 * | `readZcodeCredential()` | — |
 * | `readRawCredentials()` / `credentialFileCandidates()` | `~/.zcode/v2/credentials.json` |
 * | `decryptCredentialValue()` / `deriveCredentialKey()` | 同上（AES-256-GCM 解密） |
 * | `readDeviceMid()` | `~/.zcode/v2/telemetry-state.json` |
 * | `detectZcodeAppVersion()` | `%LOCALAPPDATA%\Programs\ZCode\.zcode-install-manifest` |
 * | `labelFromUserInfo()` / `identityFromUserInfo()` / `readUserIdFromUserInfo()` | 只服务于上面那条路 |
 *
 * ### 为什么删（**别改回去**）
 *
 * 1. **安全**：那条路等价于「任何本地进程都能解密 ZCode 的登录凭据」——
 *    官方用一套**公开可复现**的派生密钥（`zcode-credential-fallback:<平台>:<家目录>:<用户名>`
 *    过 `sha256`）加密 `enc:v1:` 密文，插件等于把「读别人应用登录态」的能力
 *    复制进了 DSH。**不做**这件事，用户就不必担心 DSH 拿到的是自己点的那个授权。
 * 2. **正确性**：它只对 **bigmodel 渠道**认 `oauth:bigmodel:user_info`，
 *    zai 渠道写的是 `oauth:zai:user_info`（键名不同）⇒ 读出来 `user_id` 恒缺、
 *    账号名退化成「设备xxxxxxxx」，且因 `user_id` 是账号去重与
 *    「防跨账号覆盖」的唯一判据，这条路实际走不通
 *    （Gitee issue IKJNPZ，2026-10-04 实机复现）。
 * 3. **一致性**：插件**本来就有**自己的完整 OAuth 流程（`zcode-login.ts` 的
 *    `runZcodeLogin`，bigmodel / zai 两个渠道都跑得通，且
 *    `zcode-auth.ts` 的 `startLogin` 会写出**带 `user_id` / `account_name`** 的
 *    完整凭据）。旧路径是条**功能更差的旁路**，留着只会让人误以为不用登录。
 *
 * ### 留下的唯一影响
 *
 * **coding-plan（ultra）通道对纯插件登录用户不可用** —— `coding_plan_key_zai` /
 * `coding_plan_key_bigmodel` 过去**只**由 `readZcodeCredential()` 填，而唯一能
 * 给它补 key 的 `fetchCodingPlanApiKey()`（`zcode-transport.ts`）**至今没有任何
 * 调用方**。⇒ 这**不是**本次删除造成的回退：纯插件登录用户本来就拿不到该通道。
 * 两个 key 字段**保留**在类型里，因为存量凭据（早期从本机读进来的那批）
 * 仍可能带着它们，`zcode-transport.ts` 的通道判定依赖它们。
 */

/**
 * ZCode 账号凭据（全部由**插件自己的 OAuth 流程**产出，见 `zcode-login.ts`）。
 */
export interface ZcodeCredential {
  /** ZCode JWT（`zcodejwttoken`）—— 免费额度通道的 `Authorization: Bearer`。 */
  zcode_jwt: string
  /**
   * 设备标识。
   *
   * 由 `generateDeviceMid()`（`zcode-login.ts`）**自己随机生成**。
   *
   * ⚠ **必需**：`billing/balance` 等端点缺它会返回
   * `400 {"code":3001,"msg":"parameter error"}`（实测）。
   * 实测依据：同一 JWT 换任意随机 UUID，`billing/balance` 都回 200 ⇒
   * 它的**值**不被服务端绑定校验，只需**稳定**（生成后持久化在凭据里）。
   *
   * ⚠⚠ **它不是账号标识，别拿它去重 / 认账号**：
   * 我们随机生成，同一账号**每次重新登录都会得到一个新值** ——
   * 拿它判「是否同一账号」会把同一账号判成不同账号。
   */
  device_mid: string
  /**
   * ★ **账号标识**（服务端下发的 `user.user_id`）。
   *
   * 它是**唯一**能判断「两条账号记录是不是同一个账号」的稳定标识
   * （`device_mid` 每次登录都变，见上）。账号去重（`channel-pack-rpc.ts` 的
   * `findAccountIdByIdentityField`）与「防跨账号覆盖」全靠它。
   *
   * ⚠ 老凭据里可能**没有**这个字段 —— 读取时按 `undefined` 处理，
   * 去重逻辑必须容忍缺失（回退或放弃去重，**不能报错**）。
   */
  user_id?: string
  /** 大模型 access token（`bigmodel` 渠道登录时拿到的），备用身份。 */
  bigmodel_access_token?: string
  /** z.ai access token（`zai` 渠道登录时拿到的），备用身份。 */
  zai_access_token?: string
  /**
   * Coding Plan api-key（zai 侧），仅 ultra 通道需要。
   *
   * ⚠ **新登录路径不会填**（上游不在登录时下发它，见
   * `zcode-transport.ts` 的 `fetchCodingPlanApiKey` 说明）。
   * 保留字段是因为**存量凭据**可能带着它。
   */
  coding_plan_key_zai?: string
  /** Coding Plan api-key（bigmodel 侧），仅 ultra 通道需要。保留理由同上。 */
  coding_plan_key_bigmodel?: string
  /** 展示用标签（脱敏手机号 / 用户名）。 */
  account_label?: string
  /**
   * 账号名（用户在智谱侧的用户名，如 `mylzscy4`）。
   *
   * 与 `account_label` 分开存的理由：`account_label` 可能是兜底链的占位串，
   * 而 `account_name` 始终是真实用户名，供账号卡片展示。
   */
  account_name?: string
  /**
   * 脱敏手机号（`159****0100`）。
   *
   * ⚠ 它是**从 17 位 `user_id` 前 11 位派生**的，不是独立字段
   * （上游不下发手机号；智谱把手机号编进了 id 前缀）⇒
   * **取不到合法前缀时不设该字段**（宁可不显示，也不猜）。
   */
  phone?: string
  /** 客户端版本，随请求头下发（`X-ZCode-App-Version` / `User-Agent`）。 */
  app_version?: string
  /**
   * 凭据来源。
   *
   * ⚠ **新凭据恒为 `'plugin'`**（本文件顶部说明了为何不再有 `'ide'`）。
   * 保留该字段是因为**存量凭据**里可能已经写着 `'ide'`，
   * 且它仍供排查时区分「这批凭据是哪条路来的」。
   */
  source?: 'plugin' | 'ide'
  /** 不可续期（静态凭据；失效需用户重新登录 ZCode）。 */
  refresh_token?: undefined
}

/**
 * 手机号：11 位、以 1 开头、第 2 位 3-9（中国大陆移动号段）。
 */
const PHONE_RE = /^1[3-9]\d{9}$/

/**
 * 从 17 位 `user_id` 派生脱敏手机号，取不到返回 `undefined`。
 *
 * ## ⚠ 为什么要「派生」而不是「读取」
 *
 * 上游**不下发**手机号字段。实测（扫遍 `~/.zcode/v2/*.json`、解两个 JWT 的
 * payload）：`user_info` 只有 `{id, username, displayName, rawProfile}`，
 * `zcodejwttoken` 的 payload 只有 `{user_id, token_version, sub, iat}` ——
 * 唯一命中 11 位手机号形状的字符串就是 `user_info.id` 的**前 11 位**。
 *
 * ⇒ 智谱把手机号编进了 `user_id` 的前缀。故这里取前 11 位校验后脱敏；
 * **校验不过就不显示**（有些账号的 id 前缀并非手机号，不能硬套）。
 */
export function phoneFromUserId(userId: string | undefined): string | undefined {
  if (typeof userId !== 'string' || userId.length < 11) return undefined
  const head = userId.slice(0, 11)
  if (!PHONE_RE.test(head)) return undefined
  return `${head.slice(0, 3)}****${head.slice(-4)}`
}

/** 客户端版本的兜底值（请求头 `X-ZCode-App-Version` 用）。 */
export const ZCODE_APP_VERSION_FALLBACK = '3.14.3'

/**
 * 凭据是否「够用」。
 *
 * 判据是**上游真正需要的两个字段**：JWT 与 device_mid。
 * 其余（access token、coding-plan key 等）都是可选的 ——
 * 缺了只影响 ultra 通道。
 */
export function isUsableZcodeCredential(value: unknown): value is ZcodeCredential {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.zcode_jwt === 'string' && record.zcode_jwt.length > 0
    && typeof record.device_mid === 'string' && record.device_mid.length > 0
}

/**
 * 凭据是否过期 —— **恒为 `false`**。
 *
 * ZCode 凭据是静态的：JWT 的 payload 里**没有 `exp`**（实测只有
 * `{user_id, token_version, sub, iat}`）。真失效时上游回 401/1002，
 * 由适配器归为 AUTH 并提示用户重新登录 —— 不做本地猜测。
 *
 * 保留该函数是为了让适配器无条件调用（与其它 provider 同形），
 * 而不是到处写 `provider === 'zcode'` 的特例。
 */
export function isZcodeExpired(_credential: ZcodeCredential): boolean {
  return false
}

/** ZCode 是否可续期 —— 见 {@link isZcodeExpired}，**否**。 */
export const ZCODE_REFRESHABLE = false
