# 2026-10-31 全量 issue 审计与修复验证

基线：`origin/main` @ `5fcb5fa`（v2.7.3）。本轮工作分支 `audit/issues-20261031`，最终推送到 `main` @ `9b3f341`。
**已发版**：见 `docs/releases/v2.7.4.md`（2.7.4，`feed/manifest.json` 已重签）。

## 一、合并的社区修复 PR（19 个，均先本地验证再合并）

| PR | 修复 issue | 验证套件 |
|---|---|---|
| #538 | #682 聚合渠道缺 modelsUrl | aggregate |
| #675 | #701 / #213 trae 缓存命中率 0% | channel-pack |
| #622 | #621 流式 tool_calls 帧 id/name 与 index | channel-pack |
| #673 | #452 裸 index 帧 | forward |
| #661 | #548 Responses 流缺 sequence_number | forward |
| #631 | React hooks 顺序（公告 portal） | client-lint |
| #650 | #587 网络失败无 code → 不重试 | channel-pack |
| #658 | #549 上游 5xx 空响应体不说哪层失败 | free-lane-wire |
| #674 | #460 keepalive 注释帧续命空闲死线 | free-lane-wire |
| #630 | combo 静默候选阻塞整链 | combo |
| #620 | EAC 登录与 Windows 系统代理 | eac-abort / eac-login |
| #671 | #670 模型刷新接口返回各来源结果 | standalone-management |
| #575 | #532 无 sessionId 回合共享 global 会话 | aggregate-wiring |
| #644 | 渠道模型隐藏后会话选择器不刷新 | standalone-channels |
| #610 | 工具结果消息跨新旧 DSH 内核 | gateway-source / standalone-channels |
| #685 | #681 渠道账号「测试」恒失败 | channel-pack（#681 段） |
| #343 | #335 pnpm 托管安装拒绝应用内升级 | updater |
| #638 | #474 工具参数非法 JSON 与截断分离 | forward / stream-failure |
| #637 | #456 Windows 0600 经 icacls 生效 | private-file-permissions |

## 二、本轮本地新增修复（8 项）

1. **`src/magpie-policy.js` 第三方文案脱敏**（新发现的回归）
   - 上游市场 2026-10-30 后上架 `@magpie-community/page-agent-office`，其简介提到 "WorkBuddy/CodeBuddy"，使 `magpie-policy` 套件失败。
   - 修复：在管理边界对第三方内容路由做名称脱敏（保留无害插件），`/api/providers`、`/api/upstream`、`/api/importapps` 等 id 承载面豁免。
   - 验证：`magpie-policy: 16 checks passed`（新增回归用例）。
2. **`src/magpie-engine.js` 端口占用回退**（#688）
   - Windows 保留端口段（winnat/Hyper-V/WSL）跨重启漂移，`EACCES` 被误判为"已有拥有者"→ 工作台恒定"启动失败"。
   - 修复：`ownerLease` 区分 `EACCES`/`EPERM` 与 `EADDRINUSE`（前者丢弃陈旧记录重取）；保存的网关端口不可绑定时取新端口并持久化。
   - 验证：`magpie-engine: all fixture and built-binary checks passed`；实机引擎 `state: ready`。
3. **`src/catalog.js` `-vl` 段视觉标记**（#458）
   - 家族规则 `vision:false` 把 `nemotron-*-vl` 变体标成纯文本。修复：`-vl` 段视为视觉标记（`-free` 后缀场景也命中）。
   - 验证：sniff 套件新增 4 条断言通过。
4. **`src/gemini.js` 空串 enum 剔除**（#251）
   - Gemini 严格校验拒绝 `enum` 中的空串（400 `cannot be empty`）。修复：转换时剔除空串成员；全空则移除 enum 约束。
   - 验证：`gemini-gateway-test: 25 passed`。
5. **`client.js` 工作台展开不丢收起按钮 + iframe 内 Esc**（#700）
   - 展开瞬间 `portal` 尚未建立时渲染 `null`，整个 toolbar（唯一收起按钮）消失；Escape 只在父窗口监听，焦点在 iframe 内时失效。
   - 验证：`client-lint: OK`、`workbench: 17 checks passed`。
6. **`src/eac.js` undici 按需加载**（阻塞性回归）
   - `undici` 只是 devDep，顶层 import 让真实宿主与离线拷贝树直接崩（`eac-login` 套件在 main 上根本跑不起来）。
   - 修复：代理路径按需 `import('undici')`；缺 undici 时抛 `TRANSPORT` 错误（不静默直连，避免代理用户 IP 泄漏）。
   - 验证：`eac-abort`、`eac-login` 通过；真实安装后 `index.js` 可加载。
7. **`src/open-external.js` 运行时解析 execFile**
   - `promisify(execFile)` 在模块加载时固定，离线桩（`syncBuiltinESMExports`）失效。修复：调用时解析。
   - 验证：`eac-login-test: all checks passed`。
8. **打包完整性修复（本轮最重要发现）**
   - #637 新增的 `src/private-file.js` 未列入 `package.json` 的 `files`，**发布包会缺该模块，用户安装后 `src/store.js` 加载即崩**。
   - 修复：将 `restrictPermissions` 并入 `src/open-external.js`（保持 80 文件上限），同步 11 处引用、打包清单与测试。
   - 验证：`legacy-upgrade: 8/8 通过`（旧版 1.3.1、2.5.9 均能安装并加载新代码，80 文件预算内）。

## 三、测试结果

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test`（全量 109 套件） | 104/109；失败 4 项为发布签名漂移（`manifest`/`release`/`legacy-upgrade --production`/`catalog`），未发版属预期；`gateway-disconnect` 偶发退出码（10/10 重跑均 9/9 通过） |
| `legacy-upgrade`（System32 bsdtar） | 8/8 通过 |
| 真实安装（隔离 `DSH_HOME`） | `pnpm add file:*.tgz` 成功，`index.js` 可加载 |
| 真实 DSH Web 启动 | 成功，`/api/our-free-model/summary` 200，`channels: {state:"ready"}`，26 个模型 |
| 工作台引擎实机启动 | `state: ready`，`engine/ui/` 200 |
| `npm run selftest`（真实网络） | 本地链路全 200；免费车道 502 = 上游 OpenCode 额度限制（#690/#695/#708 外部封锁）；无 Bun 时返回明确的安装指引 |

## 四、遗留与需维护者决定

- **免费车道强制 Bun**（2.7.3 引入）：本机无 Bun 时免费车道不可用，需 `OUR_FREE_MODEL_BUN` 或 `OUR_FREE_MODEL_FREE_TRANSPORT=node`。上游同时在做客户端指纹校验（#708），node 回退也被拒。
- **发布签名**：`feed/manifest.json` 与源码有 57 处字节漂移，`manifest`/`release`/`catalog` 检查为红，需用私钥重签并发版。
- **超 scope / 需重写**：#341、#530（路由/组合跨适配器）、#512（国内直连）、#507（拒绝分类）、#525（与 #605 重复）。
- **需实测标注**：#264（cline step-5-preview 多模态）、#542（长工具会话）、#639（空内容 issue）、#469/#161（subagent keeplist）。
