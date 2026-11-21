/**
 * LobsterAI 上游错误分类。
 *
 * 移植自 `lobsterai2api/internal/upstream/classify.go`（Go）的 `Classify()`：
 * 把 HTTP 状态码 + 响应体文本判定成有限几类，供上层决定「该换号还是该报错」。
 *
 * ## 与 Go 版的**关键分歧**：只移植「分类」，不移植「冷却状态机」
 *
 * Go 的 `internal/pool` 会在分类之后自动执行
 * `Cooldown(CoolHard, 12h)` / `Disable(uid)` —— 表现为账号被**静默停用**，
 * 用户只能从 `/status` 的一个 `reason` 字段里看到原因。
 *
 * 本插件刻意不这样做：账号池只有 `modelRateLimits`（模型级重置时间）与
 * 用户手工的 `enabled` 开关，Channel Pack 面板上有具体的限流徽章与「重测 / 重置」
 * 按钮。设计哲学是「如实展示 + 用户可主动验证」（见 `src/account-probe.ts`
 * 模块头注释），把自动禁用搬进来会与这套 UI 语义冲突。
 *
 * 因此本模块**只有纯函数**，无副作用；`hard-credit` 的识别尤其重要 ——
 * 它是 LobsterAI 最主要的失败模式（免费积分用尽）。
 */

/**
 * 上游错误类别。
 *
 * 顺序与 Go 版 `ErrKind` 常量一致，但这里用字符串字面量而非数字：
 * 字号在日志与测试断言里可读性差，且本插件不做数值比较。
 */
export type LobsteraiErrorKind =
  /** 成功（HTTP < 400 且未命中任何关键词）。 */
  | 'none'
  /** 余额/积分不足 → Go 侧会做长冷却（12h）。本插件只标记限流。 */
  | 'hard-credit'
  /** 429 软限流 → Go 侧短冷却（60s）。 */
  | 'soft-rate'
  /** 会话终止：refresh_token 被拒（40100 / 40101），只能重新登录。 */
  | 'session-dead'
  /** 上游偶发 404。Go 侧短冷却且**不累计** errCount（防雪崩）。 */
  | 'not-found'
  /** 5xx 上游故障。 */
  | 'server'
  /** 其他 4xx / 业务错误。 */
  | 'client'
  /**
   * 上游**风控停用**：账号被平台判定异常并限制使用（403 为主）。
   *
   * 与 `hard-credit` 的区别是语义而非严重度：额度用完可以等次日，
   * 风控停用只能申诉或换号，且**换号重试同一个池子里的其他号也可能已被连带**。
   * 之所以单列一类：`hard-credit` 记的是「这个模型受限」徽章，
   * 而风控停用要记的是「这个账号被平台封了」—— 前者随时间自愈，后者不会，
   * 混在一起会让用户一直等一个不会好的徽章（issue #850）。
   */
  | 'banned'
  /**
   * 上游**临时风控停用**：账号被限制使用，但平台给了明确的恢复时刻。
   *
   * 与 `banned` 是「同一件事的两条下发路径」，不是严重度差异：
   * `banned` 走 **403 +「异常行为 / 已被限制使用」**（服务端直接拒），
   * `suspended` 走 **HTTP 200 + SSE 流内错误帧** —— 正文是「账号暂时无法使用
   * 相关服务，预计于 … 恢复 …… 再次出现异常使用可能导致永久停用」（issue #850）。
   *
   * 2.8.9 只补了前者：`LOBSTERAI_BANNED_MARKERS` 一个词都命不中这段文案
   * （「异常**使用**」≠「异常行为」），流内分类于是仍落回 `client`，
   * 继续换号、无徽章、`SERVER` 可重试 —— 而正文那句「永久停用」正是在警告
   * 不要换号硬试。单列一类的目的就是让这条路径也能止损，并写出真实的恢复时刻。
   */
  | 'suspended'

/**
 * 余额不足关键词（对齐 `classify.go:55-60` 的 `hardMarkers`）。
 *
 * 中英双通道是必需的：LobsterAI 是网易有道系产品，同一后端在不同场景下
 * 会返回中文或英文文案（实测两种都出现过），只匹配一种会漏判。
 *
 * 比较策略（见 {@link classifyLobsteraiError}）：英文走 `/i` 不区分大小写，
 * 中文走原文包含 —— 中文没有大小写概念，统一转小写再比也等价，
 * 但保留原文比较可避免极端情况下 `toLowerCase()` 改变字符数量的干扰。
 */
export const LOBSTERAI_HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit', 'freecreditsused', 'free credits used',
  // 2026-09 补充（真实缺陷，用户报障）：额度耗尽的**实际文案**是
  // 「免费额度已用完，请升级套餐」，而早期表里只有「额度用尽」「积分用完」
  // ——「已用完」与「用尽」字面不同，于是这个最主要的失败模式判成 `none`
  // （不换号、不记徽章），用户看到「一个账号用完出错但没有切换」。
  // 英文侧同理补上同类文案。
  'free quota', 'quota used up', 'upgrade your plan', 'upgrade to continue',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分', '积分耗尽',
  '额度已用完', '升级套餐',
]

/**
 * 会话终止标记（对齐 `classify.go:63` 的 `sessionDeadMarkers`）。
 *
 * `40100` / `40101` 是 LobsterAI 刷新被拒的业务码 —— 终态，重试无意义。
 */
export const LOBSTERAI_SESSION_DEAD_MARKERS: readonly string[] = [
  '40100', '40101', 'token rejected', 'refresh token was rejected',
]

/**
 * 风控停用标记（issue #850）。
 *
 * 上游对「账号存在异常行为，已被限制使用」这类响应给的是 **403**，且
 * 文案里既有「异常行为 / 限制使用」也有英文的 abnormal / restricted。
 * 这类错误**不是**额度问题，也不是会话过期 —— 反复换号重试只会把同一批
 * 账号一起打进风控，所以必须单独识别、单独记徽章、并且**止损**。
 *
 * ⚠️ 关键词必须同时包含「账号主体」与「限制动作」两层语义，避免把
 * 「该模型当前不可用」这类普通 403 也判成封号。
 */
export const LOBSTERAI_BANNED_MARKERS: readonly string[] = [
  'abnormal behavior', 'abnormal behaviour', 'restricted use', 'account restricted',
  'account suspended', 'account disabled', 'account banned', 'risk control',
  '违反', '异常行为', '已被限制使用', '账号存在异常', '账号已被限制', '风控',
]

/**
 * 「账号暂时无法使用相关服务」的**共现**判据（issue #850）。
 *
 * 2.8.9 的 `LOBSTERAI_BANNED_MARKERS` 面向 403 的「异常行为 / 已被限制使用」，
 * 而 #850 报的这段文案里一个词都不在表内：它说的是「异常**使用**」，且以
 * **HTTP 200 + 流内错误帧**下发。直接把「异常使用」加进关键词表是不行的 ——
 * 普通的 4xx 正文里也会出现「异常使用频率过高，请稍后再试」，那会把服务抖动
 * 判成封号（`shouldRotate = false` 立刻停止换号，用户手上即使还有好号也不会被使用）。
 *
 * 所以这里要求**三层共现**，缺一不认：
 * 1. 主体：`暂时无法使用相关服务`
 * 2. 归因：`第三方反向代理` / `插件转接` / `共享本账号的服务额度` / `异常使用`
 * 3. 后果：`预计于 … 恢复` 或 `永久停用`
 *
 * 宁可漏判（退回旧的 `client` 行为），也不误判 —— 误判会让一个还能用的账号池
 * 直接停摆。
 */
const LOBSTERAI_SUSPENDED_SUBJECT = '暂时无法使用相关服务'
const LOBSTERAI_SUSPENDED_ATTRIBUTIONS: readonly string[] = [
  '第三方反向代理', '插件转接', '共享本账号的服务额度', '异常使用',
]

/** 正文是否命中「临时停用」的三层共现判据。 */
export function isLobsteraiSuspendedNotice(body: string): boolean {
  if (!body.includes(LOBSTERAI_SUSPENDED_SUBJECT)) return false
  if (!LOBSTERAI_SUSPENDED_ATTRIBUTIONS.some(marker => body.includes(marker))) return false
  return (body.includes('预计于') && body.includes('恢复')) || body.includes('永久停用')
}

/**
 * 从停用文案里抽出**上游声明的解封时刻**（epoch ms）；抽不到返回 `null`。
 *
 * 为什么不复用 `parseRateLimitError`（`rate-limit.ts:24`）：它只对 **JSON**
 * `msg` 字段做匹配，且 `RESET_TIME_PATTERN` 要求「将在 / reset at」；
 * #850 的正文是**纯文本**、时刻写成「预计于 2026-11-18 11:08:21 (UTC+08:00) 恢复」，
 * 两个条件都不满足，它只会返回 `null`。调用方若据此落 1 小时兜底，徽章会显示
 * 一个假的恢复时刻 —— 比没有徽章更糟。
 *
 * 捕获到的时间与时区拼成 `Date.parse` 能识别的形式（实测 `UTC+8` 与
 * `UTC+08:00` 均可解析）；仍解析失败则返回 `null`，交给调用方兜底。
 */
export const LOBSTERAI_SUSPENDED_RESUME_PATTERN =
  /预计于\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*\((UTC[+-]\d{1,2}(?::\d{2})?)\)\s*恢复/

export function parseLobsteraiSuspendedResetAt(text: string): number | null {
  const match = LOBSTERAI_SUSPENDED_RESUME_PATTERN.exec(text)
  if (!match) return null
  const parsed = Date.parse(`${match[1]} ${match[2]}`)
  return Number.isNaN(parsed) ? null : parsed
}

/** HTTP 402 Payment Required：最直接的「余额不足」信号。 */
const HTTP_PAYMENT_REQUIRED = 402
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_NOT_FOUND = 404

/**
 * 按 HTTP 状态码 + 响应体判定错误类别。
 *
 * **判定顺序即优先级**（完全对齐 `classify.go:66-93`），不要重排：
 *
 * 1. `402` → hard-credit（状态码最权威）
 * 2. body 含 hard 关键词 → hard-credit
 * 3. body 命中「暂时无法使用相关服务 + 归因 + 恢复/永久停用」共现 → suspended
 * 4. body 含风控停用标记 → banned
 * 5. body 含 session-dead 标记 → session-dead
 * 6. `429` → soft-rate
 * 7. `404` → not-found
 * 8. `>= 500` → server
 * 9. `>= 400` → client
 * 10. 否则 none
 *
 * 为什么 body 关键词要**排在状态码之前**（除 402）：实测上游用 400 + 中文
 * 「积分不足」表达余额耗尽，只按状态码会把这类错误误判成 `client`（可重试），
 * 于是反复重试一个永远不会成功的账号。
 *
 * 又为什么 session-dead 要排在 429/404 之前：40100/40101 可能与 4xx 同时出现，
 * 会话已死时任何「换号重试」都没意义（该账号需重新登录），
 * 必须优先识别出来。
 *
 * @param status - HTTP 状态码
 * @param body - 响应体原文（JSON 或纯文本均可，只做子串匹配）
 */
export function classifyLobsteraiError(status: number, body: string): LobsteraiErrorKind {
  if (status === HTTP_PAYMENT_REQUIRED) return 'hard-credit'

  const lower = body.toLowerCase()
  for (const marker of LOBSTERAI_HARD_CREDIT_MARKERS) {
    // 英文走小写比较，中文走原文比较（中文无大小写，lower 后仍相等，属冗余保险）。
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard-credit'
  }
  // 临时停用与 403 封号是同一件事的两条下发路径，都排在 session-dead 之前：
  // 两者都要求「别再拿这个号重试」。这里用**共现判据**而不是往关键词表里
  // 加词 —— 原因见 `isLobsteraiSuspendedNotice` 上方（#850）。
  if (isLobsteraiSuspendedNotice(body)) return 'suspended'
  // 风控停用排在 session-dead 之前：两者都要求「别再拿这个号重试」，
  // 但封号连重新登录都救不回来，先认出来才能记对徽章（#850）。
  for (const marker of LOBSTERAI_BANNED_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'banned'
  }
  for (const marker of LOBSTERAI_SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session-dead'
  }

  if (status === HTTP_TOO_MANY_REQUESTS) return 'soft-rate'
  if (status === HTTP_NOT_FOUND) return 'not-found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'none'
}

/**
 * 判定**流内错误帧**（HTTP 200 + SSE `{error:{message}}`）的类别。
 *
 * ## 为什么不能直接复用 {@link classifyLobsteraiError}
 *
 * 该函数的优先级里**状态码排在最前**（402 / 429 / 404 / 4xx / 5xx），
 * 而流内错误的 HTTP 状态是 **200** —— 那些分支全部失效，只剩关键词表可用。
 * 传 200 进去只会得到 `none`（未命中关键词时），而 `none` 意味着
 * **不换号**，正是用户报障的行为。
 *
 * ## 真实缺陷（用户报障）
 *
 * 「lobsterai 一个账号用完出错但是没有从账号切换 …… 账号还有 2 个能用的」。
 * 额度耗尽正是以 **HTTP 200 + 流内错误帧** 表达的，而换号循环整体位于
 * `if (!response.ok)` 之内，流内错误根本走不到换号逻辑。
 *
 * ## 默认值为什么是 `client`（可轮转）而不是 `none`
 *
 * 对齐 Go `handler.go:218-243`：那个 switch 的**每个分支都以 `continue` 结尾**，
 * 含 default 分支，注释明写「轮转下一个账号，不直接返回（防雪崩）」。
 * 流内错误既然是明确的业务失败（该账号此刻没能服务这个请求），
 * 就应当换号再试，而不是把错误原地抛给用户。
 *
 * 因此本函数只做两件事：
 * 1. 命中本模块任一关键词/共现判据（hard-credit / suspended / banned /
 *    session-dead）→ 返回对应类别（用于**记徽章**或**止损**）；
 * 2. 其余一律 → `client`（可轮转，但**不**记徽章，见
 *    {@link recordsLobsteraiRateLimit}：徽章的含义必须是「这个模型受限」，
 *    而不是「这个账号出过错」）。
 *
 * @param message - 流内错误帧的 message 文本（**原文**，勿先改写）
 */
export function classifyLobsteraiStreamError(message: string): LobsteraiErrorKind {
  // 传 200 表示「状态码不可用」，只让关键词分支参与判定。
  const byKeyword = classifyLobsteraiError(200, message)
  return byKeyword === 'none' ? 'client' : byKeyword
}

/**
 * 该类别是否应当触发「换下一个账号」（而不是直接把错误抛给用户）。
 *
 * **除成功外的每一类都换号**，严格对齐 Go 的 `handler.go:218-243`：
 * 那个 switch 的**每一个分支都以 `continue` 结尾**（`ErrHardCredit`、
 * `ErrSoftRate`、`ErrSessionDead`、`ErrNotFound`、default 全是），
 * 也就是「任何非 2xx 都轮转到下一个账号」，最多换 `MaxRotate`(3) 次，
 * 全部失败才把 `lastErr` 抛给客户端。注释里写得很直白：
 * default 分支「轮转下一个账号，不直接返回（防雪崩）」。
 *
 * ⚠️ 曾经的实现只对 `hard-credit` / `soft-rate` 换号，并在这段注释里
 * 声称「Go 对这种错误也是不换号（靠 NoteError 累计 3 次）」—— 那是**错的**：
 * `NoteError` 之后紧跟的就是 `continue`，计数只决定「换完之后要不要冷却」，
 * 不决定「要不要换」。少换号会让一个账号的偶发错误直接暴露给用户，
 * 而参考实现靠多账号掩盖它。
 *
 * 与 D2（不照搬自动冷却状态机）不冲突：**轮转**与**冷却**是两件事 ——
 * 前者是「这次请求换个人试试」，后者是「把这个账号标记为不可用一段时间」。
 * 本插件采纳前者（对齐 Go），不用后者（复用已有的 `modelRateLimits`）。
 *
 * ## 两处例外：`banned` / `suspended`
 *
 * 上游按**账号主体**判定风控，同批同源账号往往已被连带停用。逐个换号只会把
 * 剩下还能用的号一起打进风控 —— 正文那句「再次出现异常使用可能导致永久停用」
 * 正是在警告这件事（issue #850）。所以这两类**不轮转**：如实报错，由用户决定
 * 申诉还是换号。
 *
 * ⚠️ 止损的判定**只在这里**。2.8.9 让本函数对 `banned` 返回 true，却在适配器里
 * 手写 `if (lastKind === 'banned') throw` 来刹车 —— 两处判断迟早漂移，后来者
 * 只看本函数会以为封号仍该换号。现在适配器统一读本函数的返回值。
 */
export function shouldRotateLobsteraiAccount(kind: LobsteraiErrorKind): boolean {
  // 与成功率无关，与「换号会不会扩大损失」有关：这两类换号是有害的。
  if (kind === 'banned' || kind === 'suspended') return false
  return kind !== 'none'
}

/**
 * 该类别的失败是否应**记为该模型的限流标记**（让 UI 亮出「限额重置」徽章）。
 *
 * - `hard-credit` / `soft-rate` / `not-found` → 对齐 Go 里三处 `Cooldown(...)`
 *   （`handler.go:221-237`：12h / 60s / 60s）；
 * - `banned`（403 封号）/ `suspended`（200 流内临时停用）→ 本插件新增：都要落
 *   一份「不可自愈」的快照，否则选号每次都会再选中它、UI 也看不出原因（#850）。
 *
 * `session-dead` 与 default（server/client）在 Go 里分别走 `Disable` 与
 * `NoteError`，**都不写冷却时间**。本插件没有这两套机制（见 D2），
 * 因此它们只轮转、不留徽章 —— 否则一个 400 请求错误会被显示成
 * 「该模型限流 1 小时」，那是虚假信息。徽章的含义必须是
 * 「这个模型受限」，而不是「这个账号出过错」。
 */
export function recordsLobsteraiRateLimit(kind: LobsteraiErrorKind): boolean {
  return kind === 'hard-credit' || kind === 'soft-rate' || kind === 'not-found'
    || kind === 'banned' || kind === 'suspended'
}

/**
 * 该类别是否属于**终态**（重试无意义，只能重新登录）。
 *
 * 用途：`LobsteraiAuth.refresh()` 据此抛 `RefreshTokenExpiredError`，
 * 让 `RefreshScheduler` 停止续期并提示重新登录；其余错误走可重试路径。
 * 这是相对 Go 版的一处改进 —— Go 只判「响应里有没有 accessToken」，
 * 把网络抖动也当成了终态。
 */
export function isLobsteraiTerminalError(kind: LobsteraiErrorKind): boolean {
  return kind === 'session-dead'
}
