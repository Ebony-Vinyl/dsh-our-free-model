# Our Free Model · 本地服务与桌面打包指南

## 产品入口

| 入口 | 用途 | 用户运行依赖 |
| --- | --- | --- |
| DSH 插件 | 在 DSH 内提供渠道与管理面板 | DSH；按 README 的插件安装说明安装 |
| 独立本地服务 | 脱离 DSH，通过浏览器管理并提供 API | Node.js 22.19+ 或 24+ |
| Windows 桌面壳 | 启动同一套独立服务，通过 Tauri 窗口管理 | WebView2；安装包包含 Node，无需另装 Node 或 Rust |

插件与独立服务分别有自己的入口。桌面壳是独立服务的另一种启动方式，复用现有渠道、管理 API 与前端，不把独立服务合并为 DSH 插件。

当前桌面代码用于开发和验证，构建安装包不等于发布正式 release。

## 独立服务

在仓库根目录执行：

```powershell
npm ci
npm --prefix packages/standalone ci
node scripts/build-standalone-ui.mjs
node packages/standalone/cli.mjs
```

使用终端输出的完整管理链接登录。默认尝试 18900，端口冲突时会选择其他可用端口；不要写死浏览器地址。DSH 插件请使用 README 的安装流程，不能只复制三个入口文件代替完整插件包。

## Windows 桌面构建

构建机需要：

- Windows 与对应架构的 Node.js 22.19+ 或 24+。
- Rust 的 Windows MSVC 工具链，以及 Visual Studio Build Tools 的 C++ 构建工具和 Windows SDK。使用支持当前 Cargo.lock 的工具链；Cargo.toml 的 rust-version 仅为本包声明，不代表全部锁定依赖的最低版本。
- 首次构建需要网络下载 Cargo 依赖、NSIS/WebView2 打包组件与当前 Node 版本的完整 LICENSE。

在仓库根目录执行：

```powershell
npm ci
npm --prefix packages/standalone ci
node scripts/build-standalone-ui.mjs
npm --prefix packages/desktop ci --ignore-scripts
# 指定已安装的 MSVC 工具链，避免默认 GNU 工具链缺少链接工具。
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
npm --prefix packages/desktop run build
```

工具链名称须对应本机已安装版本，也可以使用 `rustup toolchain install stable-x86_64-pc-windows-msvc` 安装。开发预览使用 `npm --prefix packages/desktop run dev`。

构建钩子运行 `scripts/prepare-desktop.mjs`，将当前 Node 可执行文件和完整许可证、后端核心、独立服务、前端、渠道模块及 WASM 复制到固定生成目录。前端源码变动后应先运行上面的前端构建命令。离线环境可以设置 `OFM_DESKTOP_NODE_LICENSE` 为同一 Node 版本的完整官方 LICENSE 路径；许可证缓存命中时无需再次下载。

Tauri 将资源明确安装到 `service/` 和 `runtime/`。只复制 `ofm-desktop.exe` 无法跨电脑运行，应分发并安装完整 NSIS 包。用户需要 WebView2；Tauri 默认安装流程可引导安装缺失的运行时，离线机器需提前准备。

默认产物位置：

```text
packages/desktop/src-tauri/target/release/ofm-desktop.exe
packages/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe
```

`resources/`、Node 许可证缓存、`target/`、`dist/` 都是生成产物，不提交到 Git。最终分发目录可单独整理到 `dist/`，无需改变 Tauri 默认输出目录。

## 启动、登录与退出

- 桌面壳从自己的 stdout 管道接收后端握手，使用实际端口及一次性登录入口，不通过探测固定端口判断服务身份。
- 默认数据目录为用户主目录下的 `.our-free-model`，可用 `OFM_HOME` 覆盖。不会覆盖已有配置或迁移用户数据。
- 如果同一数据目录已经运行独立服务，会显示占用错误，不接管其他服务、不删除它的锁；先停止原服务或选择另一个目录。
- 关闭面板隐藏到托盘；托盘菜单“退出”正常关闭自有服务并释放锁。启动期间退出也会清理自己的子进程。
- 安装和卸载钩子不会按端口强杀进程，不删除账号、配置和数据。升级或卸载前请先从托盘退出程序。
- 自定义标题栏编译进桌面程序，使用 Tauri v2 API；窗口操作权限仅授予本次服务地址及主窗口。

## 验证

```powershell
node scripts/desktop-test.mjs
node scripts/test-all.mjs --mode contributor
node scripts/build-standalone-ui.mjs --check
npm run typecheck
npm run typecheck:standalone
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

桌面回归测试在含空格和中文的临时安装目录中使用复制的 Node 和空 PATH，验证资源完整性、端口冲突、登录会话、数据锁隔离、正常退出与父进程管道关闭。外部渠道请求由测试替身处理，不消耗真实账号额度。

这些检查不能代替完整 NSIS 安装验收。对外发布前还需在没有系统 Node、使用新的用户数据目录的 Windows 环境安装，检查 WebView2、窗口按钮、托盘退出、重启和卸载；保留实际截图及结果。

## 回退

先从托盘退出桌面程序，再安装已验证的旧版完整安装包；用户数据目录保留。也可以恢复使用独立服务 CLI。不要为回退删除数据锁或强杀未知进程，先确认原服务已经停止。
