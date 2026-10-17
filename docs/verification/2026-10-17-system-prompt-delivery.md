# 系统提示词未到达 Gemini / MiniMax 上游

> 状态：**已复现、已定位、已修复、已回归**。
> 影响面：`gemini` 与 `minimax` 两个渠道的**全部**模型；其余十一渠道与匿名免费车道不受影响。
> 修复位置：`vendor/channel-pack/src/message-shape.ts`、`gemini-messages.ts`、`minimax-messages.ts`。

## 症状

新建会话后模型**不遵守任何系统提示词** —— 人格、语言偏好、工作目录、工具使用约定
全部失效 —— 但它照常回答，不报错、不告警、日志里也看不到异常。

具体观测：在 Prime 模式下写入一条「该用户希望用孟加拉语回复」的记忆条目，
同一个工作区里：

| 会话 | provider | 日志里的提示词 | 实际回复 |
| --- | --- | --- | --- |
| `session-ac791a05` | `deepseek-account` | hasha `400265a601fd`，含孟加拉语条目 | **孟加拉语**：「হেই! 👋 কেমন আছেন, Istiak?」 |
| `session-64adf036` | `gemini` | hasha `400265a601fd`，含孟加拉语条目 | 英语 |
| `session-f3dfc8c9` | `gemini` | hasha `400265a601fd`，含孟加拉语条目 | 英语 |
| `session-121abaeb` | `gemini` | hasha `400265a601fd`，含孟加拉语条目 | 英语 |

`session/message` 事件里的提示词**逐字节相同**（长度都是 64470，sha256 前 12 位
都是 `400265a601fd`）。差别不在 harness 组装，而在适配器把组装结果交给上游的那一步。

## 根因

DSH 把系统提示词放在**两个**地方：

1. `GenerateOptions.system`（`@deepseek-ai/dsh-llm` 的契约字段）；
2. `options.messages` 首位的 `role:'system'` 消息。

**只有第 2 条是稳定成立的。** `dsh-llm` 从不写 `GenerateOptions.system` —— 全仓检索
`dsh-llm/lib/index.js` 无该字段的赋值点；`dsh-agent-loop` 把提示词作为
`system/message` 事件提交到 surface，再由 `session.deriveMessages()` 变成
`role:'system'` 消息。唯一的例外是 `dsh-llm-deepseek`，它自己做了一次提升
（`historySystem`，见 `dsh-llm-deepseek/lib/index.js:1653`，再与 `options.system`
拼成顶层 `system` 字段）。

而渠道包里的两个序列化实现**按字面相信了第 1 条**，把 system 消息显式丢掉：

`vendor/channel-pack/src/gemini-messages.ts:216`
```ts
// system 由 `options.system` 单独承载（DSH 不会把 system 放进 messages，
// 真出现时按 user 处理会让模型把它当用户指令 —— 故显式跳过）。
if (message.role === 'system') continue
```

`vendor/channel-pack/src/minimax-messages.ts:256` 同款注释、同款 `continue`。

于是 `options.system` 为空（DSH 的常态）时：

- `contents` / `messages` 里没有 system（被 `continue` 丢掉了）；
- `systemInstruction` / `system` 也不会被设置（条件 `options.system !== undefined` 不成立）。

**提示词在没有任何报错的情况下整体消失。** 模型拿到的是「一段没有系统提示词的对话」，
所以它照常回答、只是不遵守任何约定。

## 为什么只有这两个渠道

同一份代码库里，其余适配器要么自己从 messages 里取 system，要么把 messages 原样下发：

| 适配器 | 处理方式 | 结果 |
| --- | --- | --- |
| `buddy-adapter` / `llm-adapter` / `lobsterai-adapter` / `trae-adapter` | 把 messages 里的 system 当成真正内容序列化 | 保留 |
| `cline` / `loomy` / `raccoon` / `opencode` / `qoder` / `zcode` | 从 messages 取 system | 保留 |
| `dsh-llm-deepseek` | 自己把 system 消息提升到顶层字段 | 保留 |
| **`gemini-messages`** | **丢弃，且只读 `options.system`** | **丢失** |
| **`minimax-messages`** | **丢弃，且只读 `options.system`** | **丢失** |

两者都是「丢弃 + 只读一个恒为空的字段」，叠加后没有任何兜底路径。

## 修复

在共享模块 `message-shape.ts` 里新增 `collectHarnessSystem(messages)` —— 唯一的判据，
避免两个适配器各写一份而漂移。它只收集 `role:'system'` 的文本块，
	extbf{不}收集 `developer`（那个角色只承载工具增删元数据）。

两个适配器改为**两条来源都收**，按「显式字段在前」拼接，与
`dsh-llm-deepseek` 的 `[options.system, historySystem].filter(Boolean).join('\n\n')`
口径一致：

```ts
const systemText = [options.system, collectHarnessSystem(normalized)]
  .filter((text): text is string => typeof text === 'string' && text !== '')
  .join('\n\n')
if (systemText !== '') {
  request.systemInstruction = { role: 'system', parts: [{ text: systemText }] }
}
```

system 消息**仍然不进入 `contents`** —— 它一旦被当作 user 轮次下发，模型会
把它当用户指令。跳过与收集是两件事，早前版本把后者一起省掉了。

## 验证

### 回归测试

新增 `scripts/channel-system-prompt-test.mjs`（已注册进 `scripts/test-all.mjs`），
用一句**只可能来自提示词**的哨兵文本，对 Gemini 与 MiniMax 各断言：

- 只给 system 消息 → 提示词出现在 `systemInstruction` / `system`（**回归项**）；
- 只给 `options.system` → 仍然生效（无回归）；
- 两者都给的且不同 → 拼接顺序为「字段在前」，各自**恰好出现一次**（不漏不重）；
- 两者都空 → 该字段整体不出现在请求体里；
- 反向断言：哨兵文本**没有**落进 `contents` / `messages`；
- 对话本身（user/assistant 轮次、工具配对）逐项未变。

```
$ node scripts/channel-system-prompt-test.mjs
  ok  collects a system message
  …
  ok  gemini carries a message-borne prompt (the regression)
  ok  gemini carries both, options.system first, exactly once each
  ok  gemini never lets a system message leak into contents as a user turn
  ok  minimax carries a message-borne prompt (the regression)
  …
channel-system-prompt-test: all checks passed
```

**反向剔除验证**：把两处 `collectHarnessSystem` 分别换回 `[options.system]` 后重跑，
测试**失败**（`gemini carries a message-borne prompt`、`minimax carries a
message-borne prompt` 两项 FAIL，退出码 1），其余断言仍通过；恢复后重新全绿。
即该测试确实锁住了这个缺陷，不是装饰。

### 真实上游对照

在本机 harness 上用同一个 Gemini 账号（`gemini-dccf29ee`）实测：把一句哨兵文本
写进 profile 的 `system-prompt.config.personaSuffix`，该文本只存在于提示词里。

```
session dcbdf273   provider=gemini  model=gemini-3.8-flash
systemChars=2796   promptHasCodeword=true
reply: ZQ7-GEMINI-SYSTEM-OK
```

修复前同一路径下模型不可能复述出这句话。修复后逐字返回。

### 全量套件

- `node scripts/test-all.mjs --mode contributor`：**53/53 通过**。
- `node scripts/channel-pack-test.mjs`：通过（挂载重建后的发布包）。
- `node scripts/build-channel-pack.mjs`：成功，生成包 2.75 MiB。

## 影响与遗留

- 已用 `options.system` 的调用方（如 `account-probe.ts` 的探测路径）行为不变；
  拼接只在两条来源都存在且不同时发生。
- 本次只修 Gemini 与 MiniMax —— 其余渠道经逐文件核对确实从 messages 或原样
  序列化中保留了 system，未发现同类缺陷。
- `pack.js` 按仓库流程由 `src/` 重新打包，未手工编辑生成代码。构建命令即
  `NOTICE.md` 记录的那一条（`OFM_ESBUILD_DIR` 指向仓库外的 esbuild，
  `vendor/channel-pack/node_modules` 只暂存 jose / undici 供内联，构建后删除）。
  构建依赖版本与上游一致：esbuild 0.24.2、jose 6.2.9、undici 8.11.2。
- `npm run typecheck`：通过。
