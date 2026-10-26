# Windows 桌面端排查、修复与验收

日期：2026-10-17。源码：`dsh-our-free-model`。本机已安装版本：2.5.0。原安装位置：`D:\Our Free Modeldesktop`。

已完成本轮可复现缺陷的修复、离线回归、真实 Windows 窗口操作、安装包升级与真实上游推理验证。有限测试不能证明所有环境、所有账号和所有未来上游响应永远无缺陷；下文明确区分实际完成与尚未覆盖的步骤。

## 修复项

| 问题 | 根因与修复 | 验证 |
| --- | --- | --- |
| 桌面 Star 外链点击无反应 | Tauri 只允许本地导航，没有接管新窗口；将 HTTP(S) 外部导航和新窗口交给系统默认浏览器 | 真实桌面点击 Star，Edge 打开 `Ebony-Vinyl/dsh-our-free-model` |
| GitHub 登录未自动打开浏览器 | 独立 EAC `start()` 固定返回 `opened:false`，没有启动浏览器 | 先注册会话再调用系统浏览器；真实桌面打开 GitHub 登录页，等待和取消均验证 |
| 授权等待链接只有文本 | 等待面板改为可点击链接，浏览器打开失败时仍能手动继续 | EAC hook 回归及原生等待面板 |
| 渠道详情居中收缩、空白不均 | 亮色纵向 flex 与 `.page` 自动左右边距叠加，未约束完整宽度 | `.page` 明确 `width:100%`、`min-width:0`，安装后的亮暗主题截图 |
| 进入详情后页头被截掉 | 自动聚焦标题会滚动，且从列表底部保留旧滚动位置 | 聚焦使用 `preventScroll`；切页和进入详情回顶部，真实 Qoder 页面 |
| 详情侧栏贴边、标题橙色框与冗余间距 | Card 与共享样式相互覆盖，程序化标题聚焦被通用 focus 规则修饰 | 侧栏内边距、标题聚焦样式、渠道页面间距与窄窗口布局修正 |
| 切页丢失设置草稿、模型筛选 | 父级以 `page` 为 key 卸载整个页面区域 | 只缓存访问过的设置/模型/统计页面；非活动页暂停任务，退出清除缓存，连接密钥页面仍卸载 |
| 快速切换账号渠道/EAC 可能残留旧内容 | 嵌套 React root 复用同一个容器，旧根卸载与新根渲染竞争 | 渠道组件按类型独立 key；生命周期回归、真实窗口切换 |
| 旧请求的 401 干扰重新登录 | 401 未核对会话代数，旧 loadData promise 也可能被复用/清除新任务 | 会话代数核对、清理旧加载引用、只释放自己的 pending、渠道取消后禁止派发迟到事件 |
| 账号渠道 `/v1/messages` 无法调用 | Worker 只读取 OpenAI/Responses 请求体，忽略 Anthropic 投影后的 messages/tools/limits | 使用现有转换函数补齐 harness 请求体，真实适配器替身回归覆盖系统提示、工具、输出限制和温度 |
| 流式请求出错只返回半截 HTTP 200 | 已发送流头后，dispatch 异常只能走顶层结束分支 | Chat 发送 error + DONE，Responses 发送 response.failed；回归覆盖未知模型 |
| JSON `null`/数组/标量触发内部 500 | 解析后直接读取字段 | 非对象返回 400；Anthropic 保持自身错误结构 |
| Anthropic 非流式错误结构不兼容 | dispatch 和 body 读取错误走 OpenAI 顶层格式 | 在 Messages 入口按 Anthropic 错误格式返回 |
| `::1` 本机监听被拒绝 | authority 解析要求 IPv6 括号，与监听器支持的裸 IPv6 不一致 | 接受裸 `::1`，保留回环限制，trust/服务回归 |
| Windows 测试子进程强制退出断言 | 本地网关关闭后，强制退出与底层句柄清理竞争 | 网关关闭清理采样器，测试子进程正常退出；全量测试通过 |

新增 `open-external.mjs` 已加入桌面和独立服务打包清单；外链只接受无嵌入凭据的 HTTP(S)，Windows 启动参数经单个字面量传递。已保留仓库原有未提交修改，没有提交或推送。

## 自动化检查

- `node scripts/test-all.mjs --mode contributor`：**54/54 suites passed**，最终交付源码复跑通过。
- `npm run typecheck`：通过。
- `npm --prefix packages/standalone run typecheck`：通过。
- `node scripts/build-standalone-ui.mjs --check`：通过，10 个本地资源。
- `node scripts/build-standalone-channels.mjs --check`：通过。
- `cargo test --offline --manifest-path packages/desktop/src-tauri/Cargo.toml`：4 个 Rust 单元测试通过。
- `node scripts/desktop-test.mjs`：10/10，覆盖内置 Node、中文空格路径、端口选择、一次性登录、数据目录锁、父进程退出、崩溃恢复与并发锁竞争。
- `git diff --check`：通过。

Vite 对 lucide-react 的 `use client` 指令输出忽略警告，不影响构建。Windows 环境无法创建符号链接，release-preparation 套件中的该环境相关检查按原逻辑跳过。

## 已安装程序的真实交互

通过 Windows UI Automation 操作安装目录中的 `ofm-desktop.exe`，使用独立数据目录，完成 **40/40** 检查：

- 概览、模型清单、用量统计、账号渠道、EAC、API 接入和服务设置。
- 30 天统计、模型空搜索、清空筛选、切页保留筛选。
- 编辑设置、离开/返回保留草稿、保存、服务端实际设置持久化。
- 亮暗主题来回切换。
- 13 个供应商详情逐一切换，渠道用量、请求日志、供应商与备份子页。
- API Key 查看/隐藏。
- 最小化/恢复、隐藏到托盘/恢复。

另有专项实机验证：Star 打开正确 GitHub 仓库；GitHub 登录启动并到达登录页面；等待面板取消恢复登录按钮；退出测试程序后子 Node 退出、`service.lock` 被清理。窗口尝试覆盖正常大小和最小支持大小，Windows 显示缩放为 125%，像素尺寸与 CSS 尺寸并不相同。

截图与机器记录保存在 `.verify/desktop-20261017/`：`final-qoder-light.png`、`final-qoder-dark.png`、`installed-native-regression-results.json`、`contributor-tests.log`、`native-rust-tests.log`、`desktop-build.log`。亮暗主题截图为实际安装版 Qoder 页面。最小窗口的截图受到并行桌面会话抢焦点影响，不把该截图作为视觉验收证据；最小窗口操作检查与 UI 元素记录仍可用。

## 真实上游推理

从安装版服务调用 `mimo-v2.6-flash-free`，仅使用固定公开测试句“Reply only with OK.”，没有发送用户文件或账号内容：

| 接口 | 状态 | 回答 | 时间 |
| --- | --- | --- | --- |
| `/v1/chat/completions` 非流式 | 200 | OK | 2908ms |
| `/v1/responses` 流式 | 200，包含完成事件 | OK | 3455ms |
| `/v1/messages` 非流式 | 200 | OK | 9325ms |

完整结果：`.verify/desktop-20261017/installed-live-api-results.json`。

## 构建、安装与数据

最终 `npm --prefix packages/desktop run build` 成功生成 Windows x64 NSIS 安装包，约 24.86 MiB：

`packages/desktop/src-tauri/target/release/bundle/nsis/Our Free Model_2.5.0_x64-setup.exe`

安装包 SHA-256：`e4c0fddc20bf678f077d860710391021c734eff3f0082bfaad3508971bb0f38d`。

已安装至原目录 `D:\Our Free Modeldesktop`，注册表版本为 2.5.0。6 项关键程序/资源与本次构建一致。Tauri 安装器将 EXE 的 `TAURI_BUNDLE_TYPE_VAR_UNK` 改为 `TAURI_BUNDLE_TYPE_VAR_NSS`；校验明确只容许该 3 字节差异，其余字节完全一致。

升级前备份：`.verify/desktop-20261017/installed-2.4.0-backup/`。安装前后对真实数据目录中 3 个现存 JSON 文件做 SHA-256 比较，均保持不变；升级没有重置用户 API Key、账号或配置。测试写入仅发生在隔离数据目录。验收结束后已关闭隔离实例，并从安装目录以正常用户数据重新启动，原工作空间概览和 v2.5.0 状态正常显示。

## 验证边界

1. GitHub 已验证到真实登录页、等待和取消；没有代替用户输入密码、完成二次验证或新建真实授权。完整 GitHub 身份授权/Star 判定仍需用户本人登录确认。
2. 13 个渠道的页面、适配器及本地协议由离线替身和实机 UI 覆盖，没有逐个供应商用真实账号完成短信/扫码/套餐额度/续期/真实扣费验收。
3. 用户第一张局部图中的“kiro 上游自建池”字样未能在本仓库桌面前端、9router 或 free-claude-code 源码中定位，不能据此宣称该特定标签问题已修复。本轮实际修复并验证的是独立桌面渠道页的收缩、滚动裁切、侧栏贴边及跨页状态问题。
4. 未执行发布签名、GitHub 发布、提交或推送。`test:release` 的签名元数据属于发布流程，本轮使用 contributor 完整代码回归与独立 Windows 安装包验收。
