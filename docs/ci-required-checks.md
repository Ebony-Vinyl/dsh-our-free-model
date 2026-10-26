# PR 必需检查与发布准备

## 一直等待上报的原因

规则集 `24626699` 要求 GitHub Actions 上报以下两个完整的检查名称：

- `test / offline (pull_request)`
- `test / release-readiness (pull_request)`

GitHub 页面会组合展示工作流、任务和事件名称，但默认任务实际只上报
`offline`、`release-readiness`。规则的名称与实际上报名称不一致时，页面会
同时显示运行结果和两条 `Expected — Waiting for status to be reported`。
删除工作流任务也不会删除仓库规则中的必需检查。

`test.yml` 为这两个真实测试任务显式设置了与现有规则一致的 `name`，让
检查结果能被规则识别。`typecheck`、`standalone-frontend` 继续单独运行。
任务不会无条件返回成功；真实测试失败时仍会阻止合并。

## 源码 PR 的发布准备

修改插件发布文件后，发布清单与文件摘要可能暂时不一致。这是
`release-readiness` 的真实失败，需要准备签名记录，不是重跑就能消失。

1. 将最新 `main` 合入候选分支，完成源码审查和贡献者测试。
2. 记录候选完整提交 SHA，从可信的 `main` 启动已有的 `prepare-release`
   工作流，参数 `candidate_sha` 填该 SHA。
3. 由 `release-signing` 环境指定的审核人批准发布准备。签名私钥仅留在
   GitHub Actions；该工作流从 Git 对象读取候选文件，不执行候选代码。
4. 下载 `signed-release-<候选 SHA>` 产物，确认 `receipt.json` 中的
   `candidate` 与候选分支当前 HEAD 相同，`patchSha256` 与补丁摘要一致。
   确认补丁仅修改 `feed/manifest.json` 及三个 `catalog` 记录文件。
5. 使用 `git apply --check` 检查 `release.patch` 后应用，执行
   `npm run test:release`，另行提交签名记录并推送候选分支。
6. 确认新一轮两项必需检查实际通过。若之后再次修改发布文件，重新准备
   对应候选的签名记录，不复用旧补丁。

只修改 CI、文档等非发布文件且原签名记录仍一致的 PR，无需重新签名。
`release-sign` 在合并后继续保留原有验证和签名逻辑。

## 验收

- 检查 API 中的实际 `name` 与规则里的 `context` 一字不差。
- 两项检查均由 GitHub Actions（应用 ID `15368`）上报。
- 新运行包括两项必需测试和另外两项类型、前端检查。
- 检查真实通过后，不再出现对应的黄色 Expected 条目。
- 合并修复后，旧 PR 需要同步最新 `main` 并触发新运行；历史运行不会被删除。
