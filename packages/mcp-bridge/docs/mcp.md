# MCP Bridge — 接入指南

`packages/mcp-bridge` 是独立本地服务（`packages/standalone`）的官方 MCP stdio 桥。
任何支持自定义 MCP 服务器的客户端（如 WorkBuddy、Claude Code、Codex CLI 等）都可以通过它使用本地网关的模型。

> **支持分级**
> - `standalone` 服务本体：稳定支持
> - `mcp-bridge`：官方维护，beta
> - 第三方客户端的具体行为：best-effort
>
> 本项目与文中提到的任何客户端厂商均无隶属或背书关系（Not affiliated with or endorsed by any client vendor or model provider）。

## 工具

| 工具 | 作用 |
|---|---|
| `ofm_models` | 列出本地网关可用模型（含上下文窗口元数据） |
| `ofm_chat` | 单轮对话：prompt 进、回答出；传 `save_to` 可把长输出落盘、只回预览，避免撑大宿主上下文 |
| `ofm_task` | 多步任务委派：模型在桥内部的沙箱目录里自循环（list/read/write、JSON 协议），中间思考不进宿主对话，只返回简短摘要与产出文件清单 |
| `ofm_usage` | 本地用量统计（今日 / 近 7 天 / 累计），纯本地读取，不发上游请求 |
| `ofm_channels` | 账号渠道总览：各渠道账号、模型数、积分余额与 EAC 资源池（只读） |
| `ofm_checkin` | 渠道每日签到领积分（`credits.claimAll`），可指定单渠道，未登录渠道自动跳过 |
| `ofm_ledger` | Token 账本快照 + 指定渠道积分余额 |

`ofm_chat` 不暴露 `max_tokens` 参数：输出预算由桥内部管理（默认不传、由上游决定；可经环境变量覆盖），并对上游拒绝、推理耗尽预算、模型误发 tool_calls 等情况做有限次自动纠正。

`ofm_task` 说明：

- 默认沙箱在 `OFM_DATA_DIR/tasks/` 下按任务新建；也可显式传 `workdir`（默认 12 轮、上限 24 轮）。
- 路径逃逸防护：读写只允许落在沙箱内；单次读取截断于 20000 字符，全程累计读取预算 100000 字符。
- **隐私红线**：被委派模型读到的文件内容会作为上下文发给上游（第三方，可能留日志）——不要把 `workdir` 指向含隐私/敏感数据的目录；长交付物请让模型写入沙箱文件，宿主随后用本地工具按需读取。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OFM_URL` | `http://127.0.0.1:<OFM_PORT>` | 独立服务地址 |
| `OFM_PORT` | `18900` | 独立服务端口（自动拉起时使用） |
| `OFM_DATA_DIR` | `~/.our-free-model` | 独立服务数据目录（含 `stats.json`） |
| `OFM_REPO` | — | 本仓库的本地路径；设置后服务不可达时才会自动拉起 |
| `OFM_KEY` | 自动读取数据目录 `settings.json` 的 `forwardKey` | 推理 Bearer Key；该 Key 仅用于本机回环鉴权，非上游凭据 |
| `OFM_MAX_TOKENS` | 不传 | 输出预算上限；不设置时交由上游决定 |
| `OFM_DISABLE_PROMPT_REWRITE` | `0` | 设为 `1` 时模型误发 tool_calls 不做严格提示重试，直接报错 |
| `OFM_BRIDGE_STOP_ON_EXIT` | `0` | 设为 `1` 时桥退出时停止其拉起的服务（默认保留，供多客户端共享） |
| `OFM_MAX_SERVICE_RESTARTS` | `3` | 服务自动拉起次数上限，超出后报错 |
| `OFM_MIN_SERVICE_VERSION` | — | 校验服务最低版本，不满足仅告警 |
| `OUR_FREE_MODEL_BUN` / `OFM_BUN` | — | Bun 可执行文件路径（上游免费车道需要） |

## 客户端配置样例

WorkBuddy（`~/.workbuddy/mcp.json`）与 Claude Code（`claude mcp add`）等，均按标准 stdio MCP 配置：

```json
{
  "mcpServers": {
    "ofm-mcp-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-our-free-model/packages/mcp-bridge/src/index.mjs"],
      "env": {
        "OFM_REPO": "/absolute/path/to/dsh-our-free-model",
        "OFM_DATA_DIR": "/absolute/path/to/data-dir"
      }
    }
  }
}
```

调试要点：把桥的 stderr 接出来看（所有诊断都在 stderr，stdout 只允许 JSON-RPC）。

## 故障排查

- **服务不可达且 OFM_REPO 未设置**：按 `packages/standalone` 文档手动启动服务，或设置 `OFM_REPO` 让桥拉起。
- **上游 429**：匿名车道按会话限速，桥会尊重 `Retry-After` 做有限次退避重试；持续 429 请降低调用频率。
- **`Service temporarily overloaded`**：上游瞬时过载，稍后重试即可。
- **残留锁**：桥只在确认锁内 pid 已死亡时才清理 `service.lock`；若锁内进程仍活着但服务不可达，请先人工确认。
- **多窗口共用**：多个 MCP 客户端各自 spawn 桥是安全的——它们共享同一个服务实例（健康即 attach，绝不杀重建）。

## 安全与免责

- 桥不在环境变量或日志中暴露密钥；本地网关 Key 由独立服务生成并保存在其数据目录，桥仅在同目录读取用于回环鉴权。
- 日志不记录 prompt、回答或 Authorization 头。
- 免费额度、限流与可用性不受本项目控制，无 SLA，随时可能失效；模型清单以 `ofm_models` 实时返回为准。
- 自动重试会放大上游请求量，请自行遵守各上游服务条款；本项目不鼓励绕过上游配额或付费墙。
- 上游输出不保证正确，版权与合规责任在使用者。项目按 MIT "AS IS" 提供。

## 测试

```
npm install --prefix packages/mcp-bridge
npm test --prefix packages/mcp-bridge
```

离线 stdio 冒烟测试：spawn 桥 → initialize → tools/list → 断言 stdout 只含合法 JSON-RPC、工具面正确、缺 stats 时优雅降级。
