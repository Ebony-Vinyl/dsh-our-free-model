# Gemini / MiniMax 渠道丢失整段系统提示词

## 症状

模型照常回答，但不遵守任何系统提示词（人格、语言偏好、工作目录、工具约定），无报错。

同一工作区、同一条「用孟加拉语回复」的记忆条目，`session/message` 里的提示词
**逐字节相同**（64470 字符，sha256 前 12 位 `400265a601fd`）：

| 会话 | provider | 回复语言 |
| --- | --- | --- |
| `session-ac791a05` | `deepseek-account` | 孟加拉语 |
| `session-64adf036`、`f3dfc8c9`、`121abaeb` | `gemini` | 英语 |

## 根因

DSH 把提示词放在 `options.messages` 首位的 `role:'system'` 消息里；
`GenerateOptions.system` 虽在契约中，但 `dsh-llm` 从不设置它 —— 只有
`dsh-llm-deepseek` 自行提升（`dsh-llm-deepseek/lib/index.js:1653`）。

`gemini-messages.ts:219` 与 `minimax-messages.ts:259` 只读 `options.system`，
并把 system 消息 `continue` 掉。字段为空时（DSH 常态）提示词整体消失。

其余十一渠道与匿名免费车道逐个核对，均从 messages 或原样序列化中保留 system。

## 修复

`message-shape.ts` 新增 `collectHarnessSystem()` 作唯一判据；两个适配器改为
`[options.system, collectHarnessSystem(normalized)]` 以空行拼接，与 deepseek 适配器
口径一致。system 消息**仍不进入** `contents` —— 收集与跳过是两件事。

## 验证

- `scripts/channel-system-prompt-test.mjs`：两渠道各 6 项断言（消息承载 / 字段承载 /
  两者拼接顺序与不重复 / 两者皆空 / 不泄漏进对话 / 对话本身不变）。
  **反向剔除后回归项 FAIL、退出码 1**，恢复后全绿。
- 真实上游：哨兵文本写入 profile 的 `system-prompt.config.personaSuffix`，
  `gemini-3.8-flash` 逐字返回 `ZQ7-GEMINI-SYSTEM-OK`。
- `node scripts/test-all.mjs --mode contributor`：53/53 通过。
- `npm run typecheck`：通过。
- `node scripts/channel-pack-test.mjs`：通过（挂载重建后的发布包）。
- `node scripts/build-channel-pack.mjs`：2.76 MiB，按 `NOTICE.md` 流程，
  依赖版本不变（esbuild 0.24.2 / jose 6.2.9 / undici 8.11.2）。

## 遗留

只修此二渠道；其余渠道核对后无同类缺陷。
