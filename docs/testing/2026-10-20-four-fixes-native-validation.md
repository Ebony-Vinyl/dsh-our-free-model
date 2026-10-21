# 四项修复的程序本体验证（2026-10-20）

> 本文的测试计数与原生验收为原 PR 候选的历史记录。本次更新已按用户要求移除界面降级功能；修改后的验证见下方追加记录。

## 原生程序复检

按用户要求，使用 Windows Computer Use（@oai/sky）实际点击本机窗口；没有用浏览器替身结果冒充原生程序验收。

- **DSH 插件：**本机已安装 DeepSeek Harness 0.2.0-rc.2 的同一可执行程序，使用独立 D 盘 profile 加载候选插件。index.js、client.js、测速模块、适配器和渠道 bundle 与工作区逐项哈希一致。日常 profile 的 OFM 2.1.0 保持原状。
- **OFM 原生桌面：**当前 Rust 源码以 `cargo build --release --offline --locked` 构建 Windows x64 release，使用实际 Tauri/WebView2、本地服务、内置 Node；没有下载依赖。桌面壳和当前服务资源同目录交付，最终 96 个同路径来源文件内容一致；生成根 package.json 另行校验。
- 独立测试目录、编译输出和大文件全部在 D 盘。没有将真实账号配置、登录令牌、原生二进制或截图提交进仓库。

| 复检项 | 实际操作与结果 |
|---|---|
| 托管更新 | 实际 managed 配置显示运行/磁盘 2.5.6，检查更新、热重载、自动热重载均禁用，提示从原安装方式更新 |
| 自行安装更新 | 仅复检 profile 改为 self 并重启，实际页面恢复检查更新与热重载，正常查询到版本信息；未执行安装升级 |
| 真实手动成功 | 原生模型页点击 Kilo Auto Free，远端返回 `OK`；总耗时 10952ms、首响应 10951ms，保存为 manual/available；整个服务重启后仍显示“实测可用”及原时间 |
| 真实手动失败 | 原生模型页点击 MiMo V2.6 Flash，上游以当前 IP 限制拒绝；显示原始错误，保存为 manual/unknown，不虚构速度，不报成功 |
| 取消测速 | 原生页面再次发起 Kilo 测速后实际点击取消；恢复操作按钮，显示“测试已取消”，不覆盖前一次成功记录 |
| 失败状态补修 | 本体复检发现历史手动失败行误写“未探测”；已补修为“实测失败”及可访问原因，重建资源、重启真实原生程序复检通过；从未测试项仍为“未探测” |
| CodeArts | 在真实 DSH 打开渠道管理卡，正常显示模型与操作，账号为 0/0、未接入；无本机可用 CodeArts 登录凭据，**真实账号签名调用、积分领取尚未在线验证** |

## 自动验证与独立复审

- 补修后 contributor 离线完整回归：**80/80 套件通过**。
- 补修后浏览器矩阵：**15/15 场景、153/153 断言通过**，35 张截图，页面异常/未定义接口/外部请求均为 0。它是补充覆盖，不替代上表的程序本体结果。
- 新增真实 React/虚拟表格/管理摘要测试：**4/4 通过**。覆盖桌面、390px 窄屏，先成功再失败、写盘重开、原因可访问、路由保持、筛选与虚拟行不重叠、旧 listing 摘要不误绿。
- 两项仓库既定类型检查、页面 10 个资源一致性、独立业务产物一致性和 `git diff --check` 通过。
- CodeArts 本地 TLS/代理/取消/超时签名测试 12 组、多上下文真实插件 RPC 7 组通过；不等于真实华为账号服务已成功。
- 额外渠道完整类型检查：当前与未修改基线同为完全一致的 21 条原有诊断，新增 0；没有将其记录成全量类型通过。
- 独立审查复核新增状态显示与测试，未发现阻塞项。

## 复验命令

```powershell
node scripts/test-all.mjs --mode contributor
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p packages/standalone/tsconfig.json
node scripts/build-standalone-ui.mjs --check
node scripts/build-standalone-channels.mjs --check
```

可选浏览器验证需要已有 Playwright 与浏览器，不属于 contributor 的默认依赖：

```powershell
# 如本地模块不在本仓库解析路径中，设置为你已有的模块位置。
$env:OFM_PLAYWRIGHT_MODULE = '<Playwright 模块路径>'
$env:OFM_BROWSER_PATH = '<Chromium 或 Edge 可执行文件>'
$env:OFM_UI_SCREENSHOT_DIR = '<本地证据输出目录>'
node --test scripts/standalone-model-row-test.mjs
node scripts/managed-upgrade-ui-test.mjs
```

## 范围限制

真实在线成功只证明复检时的 Kilo 路径；匿名车道被上游 IP 策略拒绝，不是此修复能够解除的限制。CodeArts 缺账号，在线成功仍需持有者复核。没有做真实 GPU、功耗或帧率测量；也没有发布安装器或签名更新源。提交内容是修复、源码对应生成物、回归测试和本记录。

本机详细证据保留于 D:/ofm-audits/20261020-computer-use：native-observations.json、evidence/、live-measurements.json、native-source-final.json、contributor-after-native-fix.log、model-row-after-native-fix.log、browser-after-native-fix/results.json。该目录含私有运行数据，不应整体上传。

## 移除界面降级功能后的验证（2026-10-20）

- 插件与独立端移除开关、样式覆盖、偏好存储及跨窗口同步，恢复上游正常动画和主题切换。
- 保留托管更新提示、CodeArts 签名传输、手动测速和结果持久化；提取模型卡片与测速回归，托管升级浏览器脚本独立保留。
- `npm run test:contributor`：79/79 套件通过。
- `npm run typecheck`、`npm run typecheck:standalone`、`node scripts/client-lint.mjs`：通过。
- `node scripts/build-standalone-ui.mjs --check`、`git diff --check`：通过。
- 已同步用户本地 DSH Desktop，80 个发布文件逐一校验一致；实机测试由用户自行进行，未在本记录中声明具体场景结果。
- 本次未重新执行浏览器矩阵、Windows 原生程序验收或真实 CodeArts 账号调用；历史 80 套件与浏览器矩阵计数不用于证明当前候选。
- 发布清单仍待维护者按仓库既有签名流程更新，本次不更改签名、公钥或发行版本。
