# 免密车道的新线缆（2026-10-14 实测）

`/zen/v1` 上的免费车道在 2026-10-13/14 之间对插件全线返回
`403 {"type":"error","error":{"type":"FreeTierError", …}}`，而官方客户端仍然可用。
本文件记录实测到的五处变化、判定依据，以及 `src/upstream.js` / `src/http.js` 里对应的修正。

## 结论：现在的闸门

| 项目 | 实测结果 |
| --- | --- |
| 聊天端点 | **`https://opencode.ai/inference/v1/chat/completions`**。`/zen/v1/chat/completions` 即使其余全对也返回 403 FreeTierError；`/inference/v1/models` 与 `/zen/v1/models` 都仍返回 85 个模型 id |
| 会话头 | **`x-opencode-session-id` 必须存在**（值与 `x-opencode-session` 相同）。去掉它 → 403 |
| 会话 id 形状 | `ses_` 后 12 位 hex 必须是**铸造**形状 `~(ms·0x1000+seq)`（低 12 位 ≈ `0xFFE`）。sha256 派生或随机 hex → 403 |
| 工具指纹 | **`bash` 与 `read` 必须同时声明**，且各自的参数 schema 至少有一个 property。只声明其一 → 403；`properties: {}` → 403；两者齐备 + 任意 property → 200，且可附带你自己的工具 |
| User-Agent | 含 `deepseek-harness`（大小写不敏感、位置无关）→ 403；`dsh/…`、`opencode/1.18.22` 均 200 |
| 其余 | `authorization: Bearer public` 必须保留；`x-opencode-request` / `x-opencode-project` / `x-opencode-client` 可省（仍照发）；HTTP/1.1 与 HTTP/2、Node 与 Bun 的 TLS 栈**无差别** |

## 判定方法

1. 在本机跑官方客户端 `opencode-ai@1.19.0`（linux-arm64-musl，Alpine 的 musl loader），确认
   `opencode run -m opencode/cat-jam-free` 可用 —— 说明闸门是客户端指纹，不是账号或配额。
2. 用自签 CA 的 TLS 中间人（`NODE_EXTRA_CA_CERTS`）把客户端指到本地，读到它真正发出的请求：
   路径是 **`/inference/v1/chat/completions`**，并携带 `x-opencode-session-id`。
3. 用**逐字节重放**做单变量对照（普通 Node `https`，不涉及任何 TLS 技巧）：
   从真实请求出发，每次只删/改一项，记录 200/403。上表即该对照的结果。
4. 工具维度另做矩阵：`bash` 单独 → 403、`read` 单独 → 403、`bash`+`read` 空 schema → 403、
   `bash`+`read` 各带一个 property → 200、`Read`/`BASH` 大小写变体 → 403。

## 修正

- `endpointFor()` / `wireFor()`：三条路径移到 `/inference/v1`；清单地址同步移动，
  测试用的 stand-in 网关（`scripts/lib/fake-kernel.mjs` 等）跟着改。
- `gatewayHeaders()`：补 `x-opencode-session-id`，`x-opencode-client` 报 `cli`。
- `sessionForConversation()`：改用 `mintSessionId()` 铸造并按会话缓存（保留
  「一个会话一个 session」的配额语义，同时满足形状校验）。
- `applyFingerprint()`：诱饵与调用者自带的 `bash`/`read` 都补齐至少一个 property；
  只补 schema，不改名字、不改描述、不复制工具。
- `http.js` 的 `userAgentWith()`：归属 UA 里的 `deepseek-harness` 改写为 `dsh`，
  并去掉重复该 token 的括号 URL；其余归属信息保留。

回归测试：`scripts/fingerprint-test.mjs`（工具指纹）与新增的
`scripts/free-lane-wire-test.mjs`（路径、会话头、会话形状、UA 净化，含一次走 stand-in 网关的
端到端断言）。两者都在 `npm run test:contributor` 内。

---

# v2 客户端指纹（2026-10-16）

上游在 2026-10-14 前后把免费车道换成了 **OpenCode v2 客户端**的形状，v1 的四项特征
逐一失效 —— 每一项单独出现都是 `403 FreeTierError`（"free tier can only be used from
within OpenCode"）。本插件在 2026-10-16 按 v2 重做，两侧实现（`src/upstream.js` 与
vendored 的 `vendor/channel-pack/src/opencode*.ts`）保持同一套形状。

## 结论：v1 → v2 的四处变化

| 项目 | v1（旧） | v2（现在） |
| --- | --- | --- |
| User-Agent | `opencode/1.18.31` | **`opencode/latest/2.0.26/cli`**（`opencode/<channel>/<version>/<client>`，major ≥ 2；整串匹配，任何前后缀都不再算 v2 客户端） |
| 请求头 | 带 `x-opencode-request` | **不带**（v1 专用头，带了即 403）；改带 `x-session-affinity` / `x-session-id`，与 `x-opencode-session` / `x-opencode-session-id` 四个同值 |
| 工具闸门 | `bash`/`glob`/`grep`/`read` 四个名字，各带至少一个 property | **`read` 与 `shell` 两个名字，且 description 与参数 schema 必须与官方客户端逐字一致** |
| `tool_choice` | 无工具时补 `none` 压住诱饵 | **`none` 即 403**，绝不下发；只有 Responses 线补官方的 `auto` |

会话 id 的形状不变（`ses_` + 12 位铸造 hex + 14 位 base62），但多了一条**计数器约束**：
上游会解码那 12 位 hex，里面的 seq 必须很小（实测 0–16 通过、≥100 拒绝），
`mintSessionId()` 每毫秒归零的写法正好满足。

## 判定方法（依据）

- 本仓库的 v1 判定来自 2026-10-14 的 TLS 中间人 + 逐字节重放（见上一节）。
- v2 的形状取自 **9router v0.5.104**（`open-sse/executors/opencode.js` 与
  `open-sse/utils/opencodeFingerprint.js`，2026-10-15 提交
  `5bdcd5e`「move free tier to /inference/v1 with the v2 client fingerprint」）——
  该项目对同一上游做了逐项实测，并写明 v1 UA 与 `x-opencode-request` 都被 403。
- 2026-10-16 本机复核：`GET /inference/v1/models` 与 `/zen/v1/models` 均 200
  （88 条，12 条免费）；**对话请求当次被 `429 FreeUsageLimitError` 挡住**
  （retry-after ≈ 12h），故 v2 的逐项对照以 9router 的实测为准，本机未重测。
  出口恢复后应补一次直连验证：一条 200 即证明 v2 形状被接受。

## 修正

- `CLIENT_UA` → v2 串；`http.js` 的 `userAgentWith()` 不再拼接归属 UA
  （v2 整串匹配，拼接串不再是 v2 客户端）。归属仍保留在其余车道。
- `gatewayHeaders()`：去掉 `x-opencode-request`，补 `x-session-affinity` / `x-session-id`。
- `applyFingerprint()`：重写为 v2 —— 注入官方 `read`/`shell` 定义（逐字），调用方
  同名但定义不同的工具改名成 `<name>_client[N]` 并在响应侧还原，历史里的同名调用
  一起改名，注入后补一句「别调它们」的系统提示，并兜底清除 `tool_choice: 'none'`。
  v1 的「把调用方的 shell 提升进 `bash` 槽位」与「空 schema 补占位 property」都已删除
  （v2 比对定义，两者都会 403）。
- 续写回合不再下发 `tool_choice: 'none'`：压制手段回到续写指令正文里本来就有的
  「Do not call tools」。
- channel pack（`opencode*.ts`）：同一套改动，另加 `resolveOpencodeEffort()` 把请求档位
  就近收敛到模型声明过的档位（9router 的 `normalizeOpenAILevel` 同义，改用本仓库
  自己的强度序实现）。

回归测试：`scripts/fingerprint-test.mjs`（v2 工具闸门，含别名/重复/三种线形状）、
`scripts/free-lane-wire-test.mjs`（四条会话头、UA、无 v1 头）、新增
`scripts/opencode-parity-test.mjs`（`src/` 与 channel pack 两侧的指纹一致性 ——
名字、定义逐字、UA、头集、别名、`tool_choice`、档位收敛）。三者都在
`npm run test:contributor` 内。

---

# 对齐参考网关 opencode2api v1.4.6（2026-10-31）

10 月下旬的几次 429/403 复发把三件新事实钉死（每次都有单变量实测）：

1. **词汇闸门**：请求体里只要还带另一个客户端的工具词汇——Claude Code 的
   `ReportFindings` + `ScheduleWakeup` 同时出现即可——上游就 429
   （2026-10-30 实测；当时只给 DSH 的两个工具建了别名表，是同一发现的特例）。
2. **官方提示闸门**：工具与请求头全对、IP 干净，缺官方 CLI 系统提示仍 429；
   补上 base prompt + `<env>` + skills 即 200（2026-10-28 实测，先用裸 env 块
   压住；完整提示是参考实现的形状）。
3. **时间戳合理性**：会话 id 形状/编码全对但内嵌日期不可信（纯哈希落到 1970）
   → 429；真实近日期 → 200（2026-10-28 A/B）。

这三条正是 [opencode2api](https://github.com/jasonxu114514/opencode2api)
（本仓库自 2026-10-17 起跟随的参考实现）在其 v1.4.x 里逐项解决的事实。因此
2026-10-31 起匿名道的请求整形层整体换成它的 **v1.4.6** 移植：`src/o2a/`
（文件对照、七条有意偏差、升级手册见 `src/o2a/SYNC.md`）。`src/upstream.js`
保留为适配层，公开导出不变。

## 本次的线上形状（v1.4.6）

| 项目 | 之前（2026-10-28 形状） | 现在（v1.4.6 移植） |
| --- | --- | --- |
| 客户工具 | 原名保留（两个已知坏名进别名表） | **全部改名**为 `clint_<sha256[:12]>`，`tool_choice`/历史/`input` 调用行同步改名，响应侧折叠还原 |
| 官方工具集 | `read` + `shell` 两个逐字定义 | **13 个官方工具全量**（捕获自 2.1 CLI 的 `opencode_tools.json`；chat 线带 `strict:false`，Windows 主机 shell 描述写 powershell） |
| 系统提示 | 裸 `<env>` 块 | **官方 CLI 提示全量**：base prompt + `<env>`（模型/目录/平台/日期）+ 内置 skills；已带 marker 的请求体跳过 |
| `x-opencode-project` | 恒 `global`（共享配额桶） | **每会话一个稳定的 40-hex**（默认由会话派生，调用方给的 `global`/git commit 直通，其余哈希成 40-hex；重试/续写不换项目） |
| 端点 | `/inference/v1/…` | **族路径** `/inference/openai/v1/…`、`/inference/anthropic/v1/messages?beta=true`（2.1 客户端形状；旧扁平路径仍可用） |
| UA | `opencode/latest/2.0.26/cli` | `opencode/latest/2.1.1/cli`（跟随参考实现的 `v2ClientVersion`） |
| Chat 体 | — | 流式补 `stream_options.include_usage:true`；无上限时补 `max_completion_tokens:32000` |
| 会话铸造 | 真时间戳铸造 + 持久化 | 慢钟铸造（今日 UTC 零点 − ≤30 天哈希偏移，降序编码，进程盐）；持久化保留，日期离窗（±400 天）的旧 id 重铸 |

Anthropic 线新增 `anthropic-beta: interleaved-thinking-2025-05-14` 头。保留的
插件侧偏差（占位提示、`tool_choice:'none'` 兜底清除、幂等整形、块对象保留、
非流式不强制、跨重启会话、copy-on-write）逐条列在 `src/o2a/SYNC.md` 第 2 节。

## 依据

- 参考实现 v1.4.6 源码（release 2026-10-29，commit `58f5667`）逐文件对照；
  它对本车道上游做过同样的单变量实测，其 release 说明与本文件第 1–3 条事实一致。
- **线字节对照（同日）**：让 v1.4.6 网关把整形后的请求发给本机明文 echo 服务
  器，抓到它的最终 outbound（头集、24868B body、13 工具、9579B 系统提示），
  与本移植逐字段 diff：键集、工具集、系统提示、UA/project/会话形状全部一致；
  唯一差异是它**不发 `accept` 头** —— 本移植已对齐（默认不发，显式覆盖才发）。
- **重放判定无效（同日）**：同出口同刻，v1.4.6 自己的字节经 Go 客户端 200、
  经 curl/python 转发 429（同为 `FreeUsageLimitError`）—— 上游对 TLS/HTTP 客
  户端指纹敏感，且 429 报文不区分「IP 配额烧尽」与「非官方客户端」。用 curl
  重放本车道做 200/429 结论（包括本文件早年的手写对照）须以「客户端指纹相同」
  为前提；跨客户端的对照一律无效。判定只能用本车道自己的客户端（插件 =
  Node/Bun）或参考网关本体。

回归测试：`scripts/fingerprint-test.mjs`（不透明改名 + 13 工具集 + 幂等）、
`scripts/free-lane-wire-test.mjs`（族路径、40-hex project id、UA、四会话头、
无 accept 头）、`scripts/opencode-parity-test.mjs`（lane 与 channel pack 的重叠契约）、
`scripts/wire-tool-alias-test.mjs`（改名 → 流式还原 → 宿主分发）、
`scripts/free-lane-compat-test.mjs`（三线提示注入 + 传输层）。全部在 `npm test` 内。


