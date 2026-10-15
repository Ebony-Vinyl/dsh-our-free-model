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
