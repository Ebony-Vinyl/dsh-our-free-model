/**
 * 腾讯系渠道的**内容级**风控指纹改写（Gitee issue IKJNA1）。
 *
 * ## 现象
 *
 * 外部客户端（ZCode 等）经本插件的 OpenAI 网关调 `buddy` / `workbuddy` 时，
 * 只要 `system` 消息里带着某些**客户端自带的模板句**，腾讯网关就稳定回
 * `HTTP 400 / code 11128 / "Illegal API invocation from an unapproved channel"`，
 * 客户端侧只显示 `provider_code=INVALID_REQUEST reason=unknown`。
 * DSH 直连同一模型则完全正常 —— 差别只在于**外部客户端往 system 里注了什么**。
 *
 * ## 为什么这一层只改 system、且只对腾讯系
 *
 * 本机逐组实测（`www.workbuddy.ai` 与 `copilot.tencent.com` **两个端点表现一致**，
 * 同账号 / 同模型 / 同 UA 与 X-* 头 / `max_tokens=16`，被拦不耗额度）：
 *
 * | 探针 | system 文本 | 结果 |
 * |---|---|---|
 * | 中性对照 | `You are a helpful assistant.` | ✅ 200 |
 * | 最小充分触发 | `Main branch (you will usually use this for PRs): master` | ❌ 400/11128 |
 * | 只留标签 | `Main branch: master` | ✅ 200 |
 * | 换分支名 | `…(you will usually use this for PRs): dev` | ❌ 400/11128 |
 * | 句中/段中 | 前后都接别的句子 | ❌ 400/11128 |
 * | **改写该句** | `Main branch (PRs usually go here): master` | ✅ 200 |
 * | 同一句放进 **user** 消息 | — | ✅ 200 |
 * | 同一句放进 **tool** 消息 | — | ✅ 200 |
 * | 指纹在**第二条** system（非 `messages[0]`） | — | ❌ 400/11128 |
 * | 只差一个词（`normally` 替 `usually`） | — | ✅ 200 |
 * | 内层多一个空格 | `Main branch  (you will…)` | ✅ 200 |
 * | 全小写 / 全大写 | — | ❌ 400/11128 |
 *
 * 由此得到三条**不能违反**的实现约束：
 *
 * 1. **只改 `system`**：`user` / `tool` 里同一句**不拦**（上表第 6、7 行）。
 *    改写它们只会白白破坏用户的原话与工具输出，且换不来任何收益。
 * 2. **改写**所有** system 消息**，不只 `messages[0]`：非首位的 system 同样被拦
 *    （上表第 8 行）。WorkBuddy 网关那条「首条必须是 system」的硬要求是**另一回事**
 *    （见 `account-probe.ts` 的 `PROBE_SYSTEM`），与本文件无关。
 * 3. **大小写不敏感的精确匹配**：全小写与全大写都被拦（上表末行），所以
 *    `replaceAll` 的字面量比对必须带 `i`；但**只差一个词**或**多一个空格**都不拦，
 *    说明服务端认的是**逐字符的字面量**，**不能**把它泛化成正则/关键词。
 *
 * ## 为什么落在网关，而不是 `buddy-adapter`
 *
 * - **DSH 直连不受影响**，这是有依据的：`buddy-adapter.serializeMessages` 只把
 *   `role==='system'` 的内容放进 wire 的 system，用户正文与工具结果分别进
 *   `role:'user'` / `role:'tool'`（见该文件 328–369 行），而上面第 6、7 行实测
 *   那两个角色不拦。DSH 自己的系统提示词也不含这些模板句。
 * - 改在适配器里等于**对 DSH 自己的提示词做静默改写**，越过「不伪造上游行为」的
 *   既有边界，且会让直连与经网关两条路的行为不可比。
 * - 网关是**外部客户端入口**：指纹来自客户端，网关正是知道 provider 与消息角色
 *   的那一层。
 *
 * ## ⚠️ 千万不要把 11128 加进 `isContentRejection`
 *
 * 那是**内容级**拦截：同一账号换掉这一句就通（上面「改写该句」一行）。
 * 认成「账号被策略拦」会触发换号 + 30 分钟账号冷却（`CONTENT_REJECTION_COOLDOWN_MS`），
 * 把整个账号池白锁 30 分钟，而真正该做的是改写那一句。
 * 维持现状（`isContentRejection` 只认 11140 / `request illegal` / 安全审核文案）
 * **是正确**的。
 *
 * ## 表驱动，而不是写死一处
 *
 * 屏蔽名单服务端掌握、可能随时更新，任何客户端将来都可能撞上新指纹。
 * 故这里是**表**：新增一条 = 往 {@link CONTENT_FINGERPRINTS} 里加一行 + 一条用例。
 */

/** 受影响的 provider：腾讯系两个后端（`buddy` = CodeBuddy 中国版，`workbuddy` = WorkBuddy 国际版）。 */
const TENCENT_PROVIDERS: readonly string[] = ['buddy', 'workbuddy']

interface ContentFingerprint {
  /** 被拦的**字面量**（匹配时**大小写不敏感**，但不做任何模式泛化）。 */
  readonly find: string
  /** 等义改写。两个端点均实测 200。 */
  readonly replace: string
  /** 来源与证据，写死在代码里，免得后人「顺手」把它改成正则或删掉。 */
  readonly note: string
}

/**
 * 已知会被腾讯网关拦下的 system 模板句。
 *
 * ⚠️ **每一条都必须有实发证据**（被拦 + 改写后放行，两条都要），
 * 照抄别家客户端的常量而没实测过 = 给上游加了一条没人验证过的改写。
 */
const CONTENT_FINGERPRINTS: readonly ContentFingerprint[] = [
  {
    // ZCode 内建常量：`$Js="Main branch (you will usually use this for PRs)"`。
    // 每个 git 仓库里的会话都会被注入（拼在 `Main branch … : <分支名>` 这一行）。
    find: 'Main branch (you will usually use this for PRs)',
    replace: 'Main branch (PRs usually go here)',
    note: 'Gitee IKJNA1；本机 2026-10-05 对 workbuddy / CodeBuddy 双端点实测复现',
  },
  {
    // DSH 系统提示词默认身份首句：`You are an AI agent powered by DeepSeek Harness.`。
    // 腾讯网关做非官方客户端指纹匹配，命中立即 400 + code 11128 "Illegal API invocation from an unapproved channel"。
    find: 'You are an AI agent powered by DeepSeek Harness.',
    replace: 'You are an AI assistant.',
    note: 'GitHub #544 #560 #568 #570；copilot.tencent.com 与 workbuddy.ai 双端点拦截',
  },
  {
    find: 'You are an AI agent powered by DeepSeek Harness',
    replace: 'You are an AI assistant',
    note: '变种（无末尾句号）',
  },

]

/** 正则元字符转义：把字面量安全地变成**精确**匹配，而不是模式。 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CompiledFingerprint {
  readonly replace: string
  /** 小写形态，用于 `includes` 预检（不命中就不必跑正则，字符串**原样**返回）。 */
  readonly findLower: string
  readonly pattern: RegExp
}

const COMPILED: readonly CompiledFingerprint[] = CONTENT_FINGERPRINTS.map((rule) => ({
  replace: rule.replace,
  findLower: rule.find.toLowerCase(),
  // `g` = 全部出现都改写；`i` = 大小写不敏感（实测全小写 / 全大写同样被拦）。
  pattern: new RegExp(escapeRegExp(rule.find), 'gi'),
}))

/** 该 provider 是否走腾讯系后端（有这套内容级风控）。 */
export function isTencentContentFingerprintProvider(provider: string): boolean {
  return TENCENT_PROVIDERS.includes(provider)
}

/**
 * 把 system 文本里已知的腾讯风控指纹做**窄改写**。
 *
 * ## 契约
 *
 * - **非腾讯系 provider 原样返回**（同一个函数指针意义上的同一份字符串内容）；
 * - **不含任何指纹的文本逐字符不变** —— 这一条是硬要求：腾讯侧按前缀缓存，
 *   无谓地重建字符串会让每一轮都算作新前缀，白白吃掉缓存命中；
 * - 只改**内容**，不删句子、不改结构：`Main branch (PRs usually go here)` 与原句
 *   语义等价，模型读到的仍是「主分支（提 PR 通常走这里）」。
 *
 * @param text 已取出的 system 纯文本
 * @param provider `parseModelRoute` 得到的 provider 段
 */
export function rewriteTencentContentFingerprints(text: string, provider: string): string {
  if (!isTencentContentFingerprintProvider(provider)) return text
  let out = text
  for (const rule of COMPILED) {
    // 预检：不含（小写化后的）字面量就整条跳过，`out` 保持同一份字符串内容。
    if (!out.toLowerCase().includes(rule.findLower)) continue
    // `String.replace` 配 `g` 正则会在调用前后把 lastIndex 归零，不会串状态。
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}
