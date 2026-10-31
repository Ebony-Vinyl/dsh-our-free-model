# 工具参数「语法非法」与「长度截断」分离判定

## 要求与假设

- 结构完整、只是语法非法的工具参数（如裸值 `{"pattern": **/*x, "limit": 50}`）不得再冒充「已达到输出 token 上限」：UI 不撒谎，回合走 tool-calls 正常路径，由宿主 schema 校验把错误回传给模型自修。
- 结构不完整的参数（字符串未闭合、括号不平衡——分片丢失或真被 max_tokens 切断）保持现状：判为截断、报 max-tokens，让宿主丢弃残缺调用并重试。`sse.ts` 注释记录的实测结论（重试一次即恢复）继续生效。
- 不新增恢复机制、不回灌原始参数（issue 期望 3 是 nice-to-have，依赖对宿主回合协议的新假设，不做）；`src/adapter.js` 的 brokenToolCall 降级与续写排除逻辑不动，靠 stream.js 判定收窄自然修正。
- 判定逻辑必须在两处同步收窄：渠道包 `sse.ts`（finishReason 判类与 arguments 字段选择）与插件 `src/stream.js`（brokenToolCall 二次确认）。vendor 与插件源码是两个构建边界，各持一份实现。

## 方案与取舍

`isTruncatedArguments` 在 JSON.parse 失败后追加一次线性结构扫描：跟踪字符串内/转义态与 `{[`
深度。扫描结束时「在未闭合字符串内」或「深度大于零」才算截断；括号成对、字符串全闭合的语法错误返回 false。选扫描而非启发式（数引号个数、看首尾字符），因为它对转义、嵌套、字符串内括号都正确，且 O(n) 无依赖。`{"a":1}}` 这类多闭合括号判为非截断——它不是被切断的产物，交给 schema 校验暴露。

stream.js 的 brokenToolCall 语义同步收窄：它存在的理由（注释已记）是「上游在输出上限切断 JSON 时仍报 tool_calls」——这正是结构不完整的场景；结构完整的语法错误执行时会得到明确的 schema 错误，是比静默丢弃更强的恢复信号。

## 验证

- `channel-pack-test.mjs --source`：`verifySourceRegressions` 中对三个共享适配器断言——完整语法错参数 + `finish_reason: tool_calls` 报 `tool-calls`（修复前为 `max-tokens`）；真截断参数报 `max-tokens`（不变）。
- `forward-test.mjs`：插件网关侧——完整语法错参数不标 brokenToolCall；未闭合字符串标 brokenToolCall。
- 渠道包两层构建后，bundle 模式 `channel-pack-test` 全量 + `build-standalone-channels --check`；`npm run test:contributor` 全量。
