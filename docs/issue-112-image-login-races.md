# 图片工具顺序与 GitHub 登录竞态修复

## 问题与决策

### 并行图片工具结果（#112）

两个图片工具结果在原 Chat 投影中形成 `assistant → tool → user(图) → tool → user(图)`，图片消息打断并行工具结果序列，导致上游拒绝历史，后续回合也持续失败。

Chat 和 Responses 投影现在缓存连续工具结果中的图片及旧版工具包装消息附带的用户文本；所有连续工具结果发送完毕后，再统一追加用户消息。每张图片仍保留调用 ID 说明，仅发送一次；原始会话历史不变。Claude 投影沿用既有实现。

### 手动打开登录链接前被判过期

Host 现在先请求已有的 `GET /auth/github/start?link=...` 登记关联码，再打开系统浏览器或返回手动链接。使用 Node 传输，不跟随 OAuth 的 302 重定向，登记超时为 15 秒；前端启动请求超时为 20 秒。

网关重复访问 start 时保留已有等待或授权结果，不覆盖已完成的令牌领取，也不延长现有等待记录的 TTL。没有新增远端接口；部署网关时应同步 `worker/auth-github.mjs` 的幂等处理。

### 取消登录后仍被迟到响应登录

新增本机 `POST /api/our-free-model/eac/login/cancel?link=...`。Host 按关联码标记取消并中止请求，领取路径在保存前再次检查取消状态，阻止迟到响应写入用户文件及发送 ACK。取消记录保留 15 分钟，不影响新关联码的登录。

原子保存完成是提交点：如果取消到达时凭据已保存，返回已完成登录，前端显示成功；不删除已有授权，也不显示取消成功。取消请求失败时前端保留关联码并恢复串行轮询；若仅取消确认响应丢失，后续轮询可依据 Host 的取消状态结束等待。退出登录保留原有清除凭据流程，并使在途领取失效。

## 验证

- `node scripts/test-all.mjs --mode contributor`：28/28 套通过，含客户端 lint、图片投影、EAC 登录和网关授权测试。
- `node scripts/eac-login-test.mjs`：通过；实际 `index.js.apply` 注册路由、实际登录 hook 和领取模块均覆盖。临时 home、浏览器启动替身及网络替身与真实用户数据隔离。
- `node scripts/eac-auth-test.mjs`：通过；实际 Node 传输连接本地网关，验证浏览器打开前状态为 pending、重复 start 保留授权结果及原 TTL。
- `node scripts/projection-test.mjs`：通过；覆盖 V3、V4、单消息多结果、后续回合、图片去重、包装文本和历史不变。
- `/tmp/ofm-pr97-build-20261006/node_modules/.bin/tsc --noEmit -p tsconfig.json`：通过；范围仅为 adapter。
- 修改的 JS/MJS 文件均通过 `node --check`；`git diff --check` 通过。

本地受控测试不等于远端或 Desktop 验收。本轮未安装 Desktop，未调用真实 GitHub OAuth 或真实模型上游，也没有更改服务器的强制鉴权配置。匿名免费通道、用户文件格式和现有签名信任根不变。

## 发布与回退

运行文件的发布摘要发生变化，发布前由维护者按仓库流程重新签署清单。本轮未修改签名记录或信任根。

回退可恢复本轮涉及的源码与测试文件；没有用户数据迁移。网关幂等 start 与旧版 Host 兼容。更新 Host 与客户端应使用同一套插件字节，避免新客户端调用旧 Host 不存在的取消接口。
