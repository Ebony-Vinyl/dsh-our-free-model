# TRAE 与 Qoder 积分路由调度：验收记录

日期：2026-11-13。分支：`feature/credit-routing-trae-qoder`（基线 `origin/main` @ `9aa8412`，v2.8.3）。

## 变更清单

| 文件 | 变更 |
| --- | --- |
| `vendor/channel-pack/src/credit-routing-rank.ts` | 新增：临期/常规/归零/未知四档纯函数 |
| `vendor/channel-pack/src/credit-balance-selector.ts` | 新增：60s/5s 双 TTL 缓存选号器（失败开放） |
| `vendor/channel-pack/src/trae-adapter.ts` | `nextAccount` hook + `nextAccountFor` 统一取号（HTTP 层与流内层） |
| `vendor/channel-pack/src/qoder-adapter.ts` | `switchAccountOnQuota` / `switchAccountOnQueue` 接 hook |
| `vendor/channel-pack/src/index.ts` | `makeCreditRouting` / `makeCreditNextAccount` 工厂；qoder / qodercn / trae 三实例注入 |
| `scripts/credit-routing-test.mjs` | 新增独立套件（进 `test-all.mjs`） |
| `scripts/channel-pack-test.mjs` | `--source` 模式挂载接线回归 |
| `vendor/channel-pack/pack.js`、`packages/standalone/channels/business.mjs` | 重新构建（`npm run channel-pack` / `npm run build:standalone-channels`） |
| `vendor/channel-pack/NOTICE.md`、`README.md`、`docs/plans/2026-11-13-credit-routing-trae-qoder.md` | 文档 |

## 实际验证

| 命令 | 结果 |
| --- | --- |
| `node scripts/credit-routing-test.mjs` | 通过：分档边界、双 TTL、选号、凭据失败 |
| `node scripts/test-all.mjs --only credit-routing` | 1/1 通过 |
| `node scripts/channel-pack-test.mjs --source --channels-only` | 通过（含 TRAE/Qoder 两站接线回归） |
| `npm run typecheck` | 通过 |
| `node scripts/test-all.mjs --mode contributor` | 114/115 通过（TEMP 盘 worktree）。唯一失败 `legacy-upgrade`：浅克隆（depth=1）缺历史 commit `f14d261…`，基线 `9aa8412` 同样失败（基线对照已复现），与本分支改动无关 |
| `git diff --check` | 通过 |

### 环境注记（F 盘 / 浅克隆）

- 本机对 github.com 的链路极慢（~3 KiB/s）：`git fetch` 六次超时后以 `--filter=blob:none` 成功；blobless 仓库的 lazy-fetch 使 `git status/commit` 反复挂起，最终通过逐对象水合补齐全部 792 个 blob。
- magpie 系列套件（magpie-plugin / magpie-policy / forward）在 **F 盘**主工作区稳定失败（引擎写临时原子文件 `Access is denied`），同一提交在 **TEMP 盘** worktree 稳定通过；`src/magpie-*.js` 与基线逐字节一致（git diff 为空），引擎二进制 SHA-256 一致。判定为 F 盘路径的环境问题（杀软/文件系统过滤驱动），非代码回归。

## 接线断言细节

- TRAE：402 + `{code:4008}` → `nextAccount` 换号 + 限流标记；402 而非 403 是为避开 401/403 的「刷新凭据同账号重发」分支。
- Qoder（qoder + qodercn）：HTTP 200 + SSE 内嵌**顶层** `{code:110, message:"Billing daily count exceeded"}` 帧（真实形态，见 `openai-compat.ts:584` 注释）→ 换号 + 限流标记 + `ensureUid`。
- 加密端点的 Authorization 是 WASM 生成的 `Bearer COSY.<加密载荷>`，无明文 token —— 断言按发送顺序判定账号，`nextAccount` 调用记录独立断言。
- 回退路径：不传 `nextAccount` 时行为与基线一致（池序换号）。

## 边界与未验证项

- 未调用真实 TRAE / Qoder 上游，未消耗额度，未动签到/领取路径。
- `test:release` 未运行（签名清单对齐属持钥维护者流程，贡献者分支不触碰，`docs/contributor-ci-signing.md` 约定）。
- 余额查询并发的防风控影响未知（与签到的「逐号顺序」约定不同接口；Loomy 先例同为并发）。
- 未做真实 DSH 宿主挂载验收与桌面 E2E。
