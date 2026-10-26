# 四项修复的程序本体验证（2026-10-20）

> 本文的测试计数与原生验收为原 PR 候选的历史记录。本次更新已按用户要求移除界面降级功能；修改后的验证见下方追加记录。

## 原生程序复检

按用户要求，使用 Windows Computer Use（@oai/sky）实际点击本机窗口；没有用浏览器替身结果冒充原生程序验收。

- **DSH 插件：**本机已安装 DeepSeek Harness 0.2.0-rc.2 的同一可执行程序，使用独立 D 盘 profile 加载候选插件。index.js、client.js、测速模块、适配器和渠道 bundle 与工作区逐项哈希一致。日常 profile 的 OFM 2.1.0 保持原状。
- **OFM 原生桌面：**当前 Rust 源码以 `cargo build --release --offline --locked` 构建 Windows x64 release，使用实际 Tauri/WebView2、本地服务、内置 Node；没有下载依赖。桌面壳和当前服务资源同目录交付，最终 96 个同路径来源文件内容一致；生成根 package.json 另行校验。
- 独立测试目录、编译输出和大文件全部在 D 盘。没有将真实账号配置、登录令牌、原生二进制或截图提交进仓库。

## 自动验证与独立复审

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

本机详细证据保留于 D:/ofm-audits/20261020-computer-use：native-observations.json、evidence/、live-measurements.json、native-source-final.json、contributor-after-native-fix.log、model-row-after-native-fix.log、browser-after-native-fix/results.json。该目录含私有运行数据，不应整体上传。

## 移除界面降级功能后的验证（2026-10-20）
