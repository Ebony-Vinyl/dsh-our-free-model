# TRAE 与 Qoder 积分路由调度

日期：2026-11-13。分支：`feature/credit-routing-trae-qoder`，基线 `origin/main` @ `9aa8412`（v2.8.3）。

## 范围

用户确认：为 TRAE 与 Qoder 两家提供商建立积分路由调度方案；新开分支、遵循贡献规范（`docs/contributor-ci-signing.md`）。

覆盖 TRAE（trae）、Qoder 国际版（qoder）、Qoder 中国版（qodercn）三个实例。其余渠道不触碰：Loomy 已有等效实现（`LoomyBalanceSelector`，语义不同不共用），其它渠道无积分概念。

## 调度模型

**问题**：TRAE 的每月登录赠送 500 与签到包带条目级 `expire_time`（到期即焚）；Qoder 的领取积分「30 天有效」。既有选号（`AccountPool.getAvailableAccount`）只按 `enabled` + `modelRateLimits` 过滤，不看余额 —— 临期积分被手动顺序里靠前的常规号挡住，在沉默中浪费。

**档位**（`credit-routing-rank.ts`，数字越小越优先）：

| 档 | 判据 |
| --- | --- |
| 0 expiring | 有效包 `remaining>0` 且 `deductionEndTime ≤ now + 15天窗`（含已过期未清零） |
| 1 usable | 有效包 remaining 合计 > 0，无临期包（`deductionEndTime` 缺失 = 到期未知，不算临期） |
| 2 zero | 查询**成功**且归零 |
| 3 unknown | 查询失败 / 凭据读不出 —— 与归零严格分开 |

档内保持手动拖拽顺序（稳定排序）。临期窗复用 `DSH_CREDIT_EXPIRING_WINDOW_DAYS`（默认 15 天，与余额展示同源）。

**选号器**（`credit-balance-selector.ts`）：60s 成功 / 5s 失败双 TTL 缓存（对齐 Loomy 实测教训：失败缓存满 60s 会让一次网络抖动伪装「没分」一分钟）；并发查余额（账号数个位数）；`pick` 返回 undefined 当且仅当无 tier<2 候选。

**失败开放（与 Loomy 的关键差异）**：Loomy 阻断的根因是「额度尽→静默扣永久积分」；这三家额度耗尽都显式报错（TRAE 4008 / Qoder 110），既有反应式换号已兜底。本调度只重排候选，选不出时退回池路径 —— 最坏等于引入前的行为。

**只接换号 hook，不动初始选号**：初始选号查余额会给每轮对话首请求加 N 次余额查询延迟；「临期先烧」的价值集中在失败换号时（撞墙账号被标记限流后，下一号选谁正是分档用武之地）。初始选号保持池序（零开销）。

## 接入点

| # | 路径 | 改动 |
| --- | --- | --- |
| 1 | `trae-adapter.ts` HTTP 层轮换 | `nextAccountFor` 统一取号（hook 优先 → 池兜底） |
| 2 | `trae-adapter.ts` 流内层轮换 | 同上（两调用点共用一个私有方法，不漂移） |
| 3 | `qoder-adapter.ts` `switchAccountOnQuota` | hook 优先，凭据仍过 `ensureUid` |
| 4 | `qoder-adapter.ts` `switchAccountOnQueue` | 同上，保留坏凭据/同 token 跳过防御 |
| 5 | `index.ts` 三实例 | `makeCreditRouting`（候选过滤镜像池语义）+ `makeCreditNextAccount`（分档 + 凭据解析 + 账本回报） |

TRAE 经 `withQueueAccountRotation` 透传 `nextAccount`，排队轮换自动同档。qoder/qodercn 不经过该 wrapper（排队逻辑在适配器内部），故 3/4 两处都要接。

## 决策记录

| 决策 | 理由 |
| --- | --- |
| 档内保持手动顺序 | 与 `getAvailableAccount` / Loomy 语义一致，拖拽是用户最高优先级表达 |
| tier 2/3 不阻断 | 显式报错的渠道不需要前置阻断；失败开放与 token-saver 同原则 |
| 余额查询并发 | 账号数个位数；签到路径的「逐号顺序防风控」不被触碰 |
| 初始选号不查余额 | 首请求零开销；价值集中在换号时机 |
| `deductionEndTime` 缺失不算临期 | 「不知道」≠「永久」，宁可漏一次先烧机会也不把未知当已知 |

## 验证

- 独立套件 `credit-routing`（进 `test-all.mjs`）：分档 4 档 × 边界（窗口边界 ≤、已过期、失效包、total 不信）、双 TTL（60s/5s、失败重查、invalidate 单/全）、选号（临期优先、排除已试、zero/unknown 不选出）、凭据解析失败不抛错。
- 接线回归（`channel-pack-test --source`）：TRAE HTTP 层 402/4008 换号吃 hook、无 hook 回退池序；Qoder 两站 SSE 内嵌 110 顶层帧（真实形态：HTTP 200 + 顶层 code/message，非 `{error:{}}` 包裹）换号吃 hook、限流标记、`ensureUid` 保留、无 hook 回退池序。
- 全量门禁见 `docs/verification/2026-11-13-credit-routing.md`。

## 边界

- 未调用真实 TRAE/Qoder 上游、未消耗额度、未动签到路径。
- 加密端点的请求头无明文 token，接线断言按发送顺序判定账号（nextAccount 调用记录独立断言）。
