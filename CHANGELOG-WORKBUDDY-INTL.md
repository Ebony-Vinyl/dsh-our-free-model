# WorkBuddy 国际版恢复 · 更新日志

**分支** `feat/workbuddy-intl-on-2.8.3` · **PR** [#790](https://github.com/Ebony-Vinyl/dsh-our-free-model/pull/790)
**基线** 已 rebase 到 `upstream/main` @ `dcb9cc7`（含上游 12 个新提交）

---

## 新增

- **恢复 WorkBuddy 国际版渠道**（`www.workbuddy.ai`）。上游 PR #555 因国内版风控把两个渠道一起移除，但国际版一直可用（实测 HTTP 200 + SSE）。
- **不恢复 CodeBuddy 国内版**：服务端按账号封禁（403 / 11140），客户端无法绕过；仅保留历史凭据识别，避免账号在状态文件重建时丢失。
- **补全添加账号**：实现完整的两阶段登录（立即返回登录 URL，后台完成轮询），此前该 provider 从未有过 `account.create` 分支。
- **补齐渠道能力**：余额查询、签到状态、每日领取、账号测试、续期全部可用。
- **保留代理环境修复**：国内域名经 DoH 取真实 IP 直连，避开 fake-ip 把国内流量路由到海外；79 处出网点接线，`OFM_DOMESTIC_DIRECT=0` 可关闭。

## 修复

- 接通 provider 的 **8 处接线遗漏**：恢复表、RFC 签名、probe 选择器、`credits.*` 三个分派、`account.refresh`、前端能力矩阵。此前症状依次为「不支持此渠道」→「Unsupported probe adapter」→「unsupported provider」→「Unknown provider」→「unknown provider」。
- **适配 2.8.3 重构**：`llm-adapter.ts` → `rate-limit.ts`；WorkBuddy 专属积分逻辑拆到 `buddy-credits.ts`；模型饱和判定（14003）内联回适配器。
- **测试夹具同步**：渠道数 10 → 11，并关闭直连以便替身生效。

## 验证

```
类型检查   21 项错误，与基线完全一致，无新增
整库测试   109/114，与未改动的 main 相同（上游新增 1 个套件）
接线核查   12/12 通过
实机       卡片显示、余额可查、可添加账号、可对话
```

## 风险

恢复的是上游主动移除的第三方网关接入。账号能否继续使用由腾讯的客户端准入策略决定，可能随时变化。任何账号限制或封禁由使用者自行承担；合并本 PR 不免除该风险。

> 注：`14018 Credits exhausted`（积分耗尽）、`429 频率限制` 属服务端业务响应，说明链路已通，不是接线问题。
