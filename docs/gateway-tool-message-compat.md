# 网关工具消息的新旧内核兼容

Chat 的 `role: tool` 和 Responses 的 `function_call_output` 都必须转成当前宿主的工具结果消息。DSH ≤0.1.6 使用 `user` 消息内的 `tool-result` 块，0.1.7+ 使用顶层带 `toolCallId` 的 `tool` 消息。外部 provider 不经过 channel-pack 的消息归一化层，固定输出任一格式都会破坏另一代内核的工具调用。

网关的共享入口 `createGatewayToolMessage()` 委托宿主导出的 `createToolResultMessage()` 处理这些差异，内容块、调用 ID、消息 ID 和 source 都由既有宿主契约承载。Chat 与 Responses 继续共用图片入站逻辑。`isError` 的断言覆盖内部 helper；它不表示新增了 OpenAI 入站 `is_error` 扩展。

## 回归检查

```powershell
npm ci --ignore-scripts
node scripts/gateway-source-test.mjs
npm run test:contributor
npm run typecheck
```

网关检查已纳入 `test:contributor`，不需要模型凭据或网络调用。测试分别加载固定的真实旧内核包 `dsh-llm-legacy`（`@deepseek-ai/dsh-llm@0.1.5-rc.2`）和项目安装的当前宿主；对 TypeScript 源码、已提交的 `pack.js` 分别执行两个端点的转换，检查：

- 宿主消息角色、工具调用 ID 与结果文本；
- 并行工具调用和带图结果经现有序列化器后仍完整配对；
- helper 的错误标记、系统消息来源、思考回传及普通历史保持正确。

旧宿主的开发依赖固定到同批次 `0.1.5-rc.2`，避免后续 `rc.3` 收紧 Cordis peer 范围导致两个测试内核冲突。该别名只用于测试，不会打包进运行时。

修改 vendored 源码后需要运行 `node scripts/build-channel-pack.mjs` 同步生成包；网关回归也会捕获源码已修而生成包未更新的情况。

独立端通过 `channels/contracts.mjs` 提供同名消息工厂，并用 `node scripts/build-standalone-channels.mjs` 同步业务产物。`node scripts/standalone-channels-test.mjs` 检查该产物的两个端点仍保留工具 ID 与结果；`node scripts/build-standalone-channels.mjs --check` 检查它与渠道包一致，避免重建后缺少工厂导出或继续运行旧转换代码。

这些检查证明消息转换和本地序列化行为，不替代真实远端模型或完整桌面宿主验收。签名发布清单与 `release-readiness` 仍按 [贡献者和发布签名流程](contributor-ci-signing.md) 由持钥维护者准备。
