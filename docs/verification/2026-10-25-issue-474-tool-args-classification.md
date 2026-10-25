# 工具参数语法非法与长度截断分离验证

## 实现

`isTruncatedArguments`（渠道包 `vendor/channel-pack/src/sse.ts`，唯一真源，四个适配器共享）在 JSON.parse 失败后追加线性结构扫描（字符串/转义态 + `{[` 深度）：字符串未闭合或深度大于零才判截断；结构完整、只是语法非法（如裸值漏引号，参数有闭合 `}`）返回 false，参数原样走 tool-calls，由宿主 schema 校验把明确错误回传给模型自修。`src/stream.js` 的 `brokenToolCall` 二次确认用同一判定收窄（新增模块级 `argumentsCutMidway`），结构完整的语法错误不再把回合降级为 max-tokens；`src/adapter.js` 未动，brokenToolCall 语义收窄后降级与续写排除自然只覆盖真截断。

## 已执行

- `node scripts/channel-pack-test.mjs --source --channels-only`：20 项 ok，含三个共享适配器的新断言（完整语法错参数报 `tool-calls`、未闭合字符串报 `max-tokens`）。
- `node scripts/channel-pack-test.mjs`（bundle 模式）：9 项 ok，重建后的 `pack.js` 行为一致。
- `node scripts/test-all.mjs --mode contributor --only forward`：2/2，含插件网关侧新用例（`brokenToolCall` false/true 两分支）。
- **反向验证**：`git stash` 撤下两处修复后重跑，channel-pack source 模式与 forward 套件均精确失败在新加断言上（`shared: complete-but-invalid arguments are not a cut` / `a complete-but-invalid argument must not flag the turn`），用例确认可复现原缺陷；恢复后全部转绿。
- 两层构建：`build-channel-pack.mjs` 写出 `pack.js`（2.47 MiB）、`build-standalone-channels.mjs` 产物校验通过、`--check` 一致性通过。
- `npm run test:contributor`：94/94 套件通过。

## 边界

- 未做真实上游验证（issue 中的裸值参数取自报告原文，作为回归字面量）；宿主对 tool-calls + 非法参数的实际回传行为依赖 DSH 既有 schema 校验路径，未在原生 DSH 内端到端验收。
- issue 期望 3（把 parse 失败的原始参数回灌成提示）未实现，属新恢复机制，计划文档已记录取舍。
- 多闭合括号（`{"a":1}}`）判为非截断——它不是被切断的产物，交 schema 校验暴露；此语义为本次新引入，若有上游反向案例需回看。
