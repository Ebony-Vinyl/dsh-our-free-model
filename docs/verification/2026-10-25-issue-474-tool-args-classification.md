# 工具参数语法非法与长度截断分离验证

## 实现

`isTruncatedArguments`（渠道包 `vendor/channel-pack/src/sse.ts`，唯一真源，四个适配器共享）在 JSON.parse 失败后追加线性结构扫描（字符串/转义态 + `{[` 深度）：字符串未闭合或括号深度非零才判截断；结构完整、只是语法非法（如裸值漏引号，参数有闭合 `}`）返回 false，参数原样走 tool-calls，由宿主 schema 校验把明确错误回传给模型自修。`src/stream.js` 的 `brokenToolCall` 二次确认用同一判定收窄（新增模块级 `argumentsCutMidway`），结构完整的语法错误不再把回合降级为 max-tokens；`src/adapter.js` 未动。

自审补的两处：

- **深度非零而非大于零**：负深度是「丢了前缀只剩中段与尾部」的分片丢失形态（`"path.txt"}`，双引号俱全、`{` 丢失）——不平衡无论方向都归入实测有效的截断恢复路径。仅判 `> 0` 会让该形态漏进 tool-calls。
- **`normalizeToolArguments` 联动**：其 parse 失败分支原先无条件回退 `'{}'`。判定收窄后语法错参数会落入 normalize 通道被伪造成合法空参数——正是 `sse.ts` 注释禁止的行为。改为按同一结构判定分叉：不完整 → `'{}'`（历史序列化路径必须产出合法 JSON，保持旧行为），语法错 → 原样返回。

## 已执行

- `node scripts/channel-pack-test.mjs --source --channels-only`：20 项 ok，含三个共享适配器的断言组——完整语法错参数报 `tool-calls` 且 `arguments` 字段**逐字节原样**（非伪造 `'{}'`）、未闭合字符串报 `max-tokens`、负深度分片报 `max-tokens`。
- `node scripts/channel-pack-test.mjs`（bundle 模式）：9 项 ok，重建后行为一致。
- `node scripts/test-all.mjs --mode contributor --only forward`：2/2，插件网关侧覆盖语法错（`brokenToolCall` false）、未闭合字符串与负深度分片（均 true）。
- **断言有效性双重反向验证**：`git stash` 撤下修复（回到基线），verbatim 与 #474 原断言精确失败；再以 `sed` 临时复原第一版实现（`depth > 0` + normalize 无条件 `'{}'`），新加的 verbatim 与负深度断言在两侧精确失败。期间还发现第一版负深度用例参数（单引号形态 `path.txt"}`）实际命中「未闭合字符串」分支而非负深度分支，已改为双引号形态 `"path.txt"}` 后复验。
- 两层构建与一致性：`build-channel-pack.mjs`、`build-standalone-channels.mjs`、`--check` 通过；`pack.js` diff 仅 2 个 hunk，精确对应两处函数，未回退任何既有修复（#572 教训核对）。
- 全量：`npm run test:contributor` 83/93——**10 个失败全部为 `Cannot read private subscription storage`**，即 #456（PR #637）治愈的 whoami OEM 编码缺陷在 v2.3beta 基线的既有失败（`AGENT.md` 第 7 节有记录）；本分支从 v2.3beta 创建不含该提交，故重现。失败清单（subscriptions 三件套、workbench-management、standalone 系列、desktop）与本分支改动文件无交集，#474 相关套件全部通过。

## 边界

- 未做真实上游验证（issue 中的裸值参数取自报告原文，作为回归字面量）；宿主对 tool-calls + 非法参数的实际回传行为依赖 DSH 既有 schema 校验路径，未在原生 DSH 内端到端验收。
- issue 期望 3（把 parse 失败的原始参数回灌成提示）未实现，属新恢复机制，计划文档已记录取舍。
- 多闭合括号（`{"a":1}}`）经负深度归入截断（保守取实测有效的重试路径）；语法错参数若被宿主原样存入会话，下一轮历史序列化将原样回传上游，可能触发上游 400——这是「诚实传递错误」的代价，优于伪造空参数。
