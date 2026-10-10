# issue #151：含图片工具结果落盘修复

## 范围与方案

修复基于 2026-10-10 查询到的仓库主线 `720aa6e`。同时查询 npm 的宿主发布标签：`next` 为 `0.2.0-rc.2`，`alpha` 为 `0.2.1-alpha.2`；没有把 npm 的旧 `latest` 标签误当作当前候选版本。

采用 issue 建议的最小修复方向：缺少图片计价协议时同步返回兜底计价器。每个仍在请求中的图片出现位置估算 1024 个视觉 Token，已 offload 的图片估算 0 个视觉 Token并返回占位文本，文本部分交由宿主估算。不同厂商实际视觉 Token 可能高于或低于该估算，1024 不代表真实账单或所有模型的上限。

匿名免费与区域路由直接返回共享计价器；13 个账号渠道在既有适配器注册包装中补齐缺失能力。厂商已有计价器优先，真实异常继续传播，调用时保留原对象的 `this`。共享实现只做内存计算，无网络、文件读取或异步操作。

只修改 `src/adapter.js` 无法修复 issue 所用的 `buddy`：它由渠道包内的 BuddyAdapter 注册，继承宿主 LlmAdapter 默认的空计价实现。因此两条注册路径均需覆盖。插件渠道包与独立服务渠道产物使用现有脚本重新生成，没有手工修改生成代码。

## 修复前复现

在隔离目录安装官方发布的 `dsh-llm`、`dsh-spill-policy` 及依赖；以实际发布渠道包注册适配器，使用真实 LlmRuntime 的计价转发方法和真实 spill-policy 的 `tools/post-execute` 处理器。周边上下文、文件映射及存储接口为隔离替身，saveText 实际写入测试文件。没有使用完整桌面工具执行器或真实模型服务。

输入为 512000 字节固定文本，附图场景增加一张有效的 1×1 PNG，落盘预算为 12500 Token。

| 宿主版本 | 纯文本对照 | buddy 含图 | 匿名免费含图 | 仅补计价器的对照 |
| --- | --- | --- | --- | --- |
| 0.1.7-rc.2 | 落盘，约 50KB 预览 | 不落盘 | 不落盘 | 恢复落盘 |
| 0.2.0-rc.2 | 落盘，约 50KB 预览 | 不落盘 | 不落盘 | 恢复落盘 |
| 0.2.1-alpha.2 | 落盘，约 50KB 预览 | 不落盘 | 不落盘 | 恢复落盘 |

三版本均出现：`spill-policy: Error: the current model has no image token calculator; keeping the inline content`。附图后整段文本保留，证明错误发生在保存之前。

## 修复后验证

`scripts/image-pricing-host-test.mjs` 提供可重复的真实宿主集成检查。命令第二个参数是包含对应宿主 `node_modules` 的隔离目录；脚本不会自行安装依赖。每个宿主版本验证 13 个账号路由、匿名免费和区域路由的含图落盘，以及纯文本对照。

实际执行：

- `node scripts/image-pricing-host-test.mjs .verify/issue151-host`：0.1.7-rc.2，15 路由全部通过。
- `node scripts/image-pricing-host-test.mjs .verify/issue151-host-next`：0.2.0-rc.2，15 路由全部通过。
- `node scripts/image-pricing-host-test.mjs .verify/issue151-host-alpha`：0.2.1-alpha.2，15 路由全部通过。
- 各组均实际保存完整文本及图片读取地址，返回缩短预览和恢复地址，没有计价失败警告。
- `node scripts/channel-pack-test.mjs`：通过；覆盖同步返回、空图片、重复出现位置、offload 图片、结果对象不相互污染、宿主默认空方法、厂商实现优先及异常传播。
- `node scripts/build-channel-pack.mjs`、`node scripts/build-standalone-channels.mjs`：成功，生成包约 2.74 MiB。
- `node scripts/build-standalone-channels.mjs --check`：通过。
- `npm run typecheck`、`npm run typecheck:standalone`：通过。
- `node --check scripts/image-pricing-host-test.mjs`、`node --check src/image-pricing.js`：通过。

- `node scripts/test-all.mjs --mode contributor`：33/33 通过。
- `git diff --check`：通过。
- `node scripts/test-all.mjs --mode release`：最终 0/3，manifest、release 和 catalog 未通过；新增共享计价文件及修改后的 adapter/pack 尚未写入签名清单，catalog revision 也需要同步。维护者应按仓库既有 `release-sign` 流程更新清单和签名。本次没有更改信任公钥、伪造签名或发布 release。

## 限制、迁移与回退

没有验证真实桌面会话中累积到 100000 Token 后的 `/compact` 恢复，不声称能挽救已经超限的历史会话。本次解决含图工具结果因缺计价器而无法执行预算和落盘的问题。

无 UI 改动，无账号数据或配置迁移。兜底估算会影响宿主显示的图片 Token 预算，但不改变模型模态、请求图片内容或厂商计费。已有原生图片计价继续优先。

测试依赖、图片、文件与日志均在隔离目录；正式源码没有引入宿主版本依赖。回退本 PR 并重建两个渠道产物即可恢复原行为，无需删除用户数据。
