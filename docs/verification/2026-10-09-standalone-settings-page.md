# 独立端服务设置页迁移验收

## 范围

基于用量统计 PR #169 合并后的主线 `af7eaaa`，将已有服务设置页迁入 React，
复用现有基础组件并按需加载，不新增 npm 依赖。移除旧设置 DOM、事件和专属样式，
保留六个公开设置与原管理 API。DSH 插件、十三渠道、EAC、匿名及 Kilo 业务未改。

新增未保存提示、撤销修改、字段校验及保存成功/失败反馈；轮询与切页保留草稿，
退出后清空，保存期间禁重复操作。承载层用保存修订号防止旧摘要覆盖已确认写入。
没有配置或数据迁移，没有提升版本、创建 tag、打安装包或发布 Release。

## 数据隔离

保存、暂停/恢复、重启与失败场景使用 `OFM_PREVIEW_SETTINGS=1` 启动的
`http://127.0.0.1:18905/` 本机替身，数据目录为 `.verify/ui-settings-data`；
`OFM_PREVIEW_NO_REFRESH=1` 用于验证暂停自动任务说明。该测试进程已停止。
测试账号、配置、日志和管理链接都未提交；正式 CLI 不加载预览脚本或生成测试账号。
提交的是测试代码、文档和截图。

最终正常服务恢复在 `http://127.0.0.1:18900/`，使用独立产品原数据目录。
仅重启以载入新资源，六个设置在重启前后逐项比较一致，没有用正式配置做保存测试。
本轮未读取或迁移 DSH 凭据。

## 实际命令

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck:standalone` | 通过 |
| `npm run build:standalone-ui` | 通过，生成 11 个 JS/CSS 资源及 HTML |
| `node scripts/build-standalone-ui.mjs --check` | 通过，产物与源码一致 |
| `node scripts/standalone-frontend-test.mjs` | 通过，四页面分包、六字段校验、草稿同步及承载层交错请求 |
| `node scripts/standalone-management-test.mjs` | 16/16，含立即落盘、暂停恢复、写入失败、重启持久化和周期调度 |
| `node scripts/test-all.mjs --mode contributor` | 最终版本 33/33 套件通过 |
| `node scripts/test-all.mjs --mode release` | 3/3 套件通过；只校验，未发布 |
| `node scripts/measure-standalone-ui.mjs` | 通过，记录静态资源体积 |
| `git diff --check` | 通过 |
| `git ls-files .verify` | 空，无跟踪测试数据 |
| `git check-ignore .verify/ui-settings-data/settings.json .verify/settings-preview.log` | 两文件均被忽略 |

前端专项覆盖空值、空白、小数、非数字、两端边界、越界、字段白名单、
草稿与最新基线同步、修改后改回原值。承载层测试执行实际 `legacy.js`，
以 DOM 替身和可控异步请求验证旧轮询晚到、服务端保存失败不提交乐观状态、
退出后保存结果晚到不能恢复页面；不向产品加入测试接口。

构建仍有两条 lucide `use client` 指令被忽略警告，应用构建成功。
类型检查覆盖 TypeScript 页面和接口；保留的旧 JavaScript 未开启 `checkJs`。

## 浏览器验收

使用 Codex 内置浏览器完成以下场景：

| 场景 | 实际结果 |
| --- | --- |
| 首次进入 | 概览时设置 DOM 为 0；首次进入设置正常加载 |
| 六项回显与保存 | 四个开关、两个数字正确回显，保存后显示成功并逐项核对磁盘值 |
| 校验 | 空输出 Token、越界刷新间隔显示中文字段错误，输入仍保留 |
| 草稿与刷新 | 等待跨越轮询周期，切至概览主动刷新再返回，六项草稿保留 |
| 隐藏与返回 | 隐藏时设置输入 DOM 为 0，返回恢复草稿 |
| 暂停与恢复 | 保存关闭推理后管理页仍可用，状态显示暂停；再次启用成功 |
| 重启 | 8192 Token、12 分钟和四项开关与保存值一致 |
| 禁用自动任务 | 以预览的 `refresh: false` 选项重启，正确显示 `--no-refresh` 等效说明 |
| 撤销 | 从 16384 撤销为已保存 8192 |
| 退出与重新登录 | 退出后设置输入 DOM 为 0，重新登录显示已保存 8192，未恢复 16384 草稿 |
| 服务断开 | 停止隔离服务后保存显示中文错误，16384 草稿保留且保存按钮可重试 |
| 桌面与窄屏 | 数字字段在窄屏换行，按钮可见，控件越界数为 0 |
| 共享分包复查 | 正常服务模型页、用量页、十三渠道和 EAC GitHub 登录入口仍可见 |

自动任务的“不发送请求”与调度行为由管理专项覆盖；浏览器验证的是说明、保存和回显。
保存期间的禁用由页面代码核对，未刻意延迟真实浏览器保存请求实测重复点击。
旧摘要与退出交错由可控异步专项覆盖，不宣称全面实测所有浏览器网络竞态。

布局记录见 [layout.json](standalone-settings-page/layout.json)。
受宿主缩放和滚动条影响，桌面实际 `innerWidth`/文档 `scrollWidth` 为 1054/1035，
移动端为 506/487，最窄复查为 332/312；控件越界均为 0。
验收结束已恢复默认视口，浏览器停留在 18900 正常服务设置页。

截图：

- [正常服务设置页](standalone-settings-page/settings-live-desktop.png)
- [隔离设置页](standalone-settings-page/settings-fixture-desktop.png)
- [字段错误](standalone-settings-page/settings-validation.png)
- [保存成功且推理暂停](standalone-settings-page/settings-saved-paused.png)
- [重启与自动任务暂停](standalone-settings-page/settings-restart-no-refresh.png)
- [移动端](standalone-settings-page/settings-fixture-mobile.png)
- [实际 332 px 窄屏](standalone-settings-page/settings-fixture-narrow.png)
- [保存连接失败与草稿保留](standalone-settings-page/settings-save-error.png)

停止测试服务后可能同时出现现有全局轮询的 `Failed to fetch` 提示；
设置页保存错误为中文，本批未扩展到全局提示翻译或去重。最终正常服务检查
浏览器 warn/error 列表为空，不代表故意断开场景或真实第三方链路没有错误。

## 体积

比较本批前后静态 HTML/JS/CSS，不含后端、API 数据、开发依赖或安装包。

| 指标 | 本批之前（字节） | 本批之后（字节） |
| --- | ---: | ---: |
| 全部静态资源原始体积 | 621926 | 628763 |
| 全部静态资源理论 gzip | 215219 | 218029 |
| 首屏静态资源原始体积 | 335085 | 335122 |
| 首屏静态资源理论 gzip | 104665 | 104221 |

全部原始体积增加 6837 字节，约 6.7 KiB；首屏增加 37 字节。
设置 JS 分包 6564 字节，理论 gzip 为 2976 字节。
设置 CSS 合并进入口 CSS，公共图标产生共享分包，因此其他分包文件名发生变化。
测量记录见 [之前](standalone-settings-page/sizes-before.json)与
[之后](standalone-settings-page/sizes.json)。
理论 gzip 不是实际 HTTP 传输量，未测安装包大小或纯 React 性能，不能据此推断运行速度。

## 未验证范围与回退

- 本批为实现者自查与实际验收，未执行独立 Agent review。
- 未逐家实测真实渠道登录、推理或 EAC 正式授权，未在 macOS/Linux 复验。
- 未测低配置设备、长期内存、多管理会话同时编辑以及所有迟到请求排列。
- 配置仍沿用原管理 API 的保存规则，没有新增多会话冲突合并机制。
- 回退本批源码和对应 `web/` 产物并重启即可；保留独立数据目录，
  不删除配置、账号或统计。服务端已有保存值不会因前端回退自动恢复。
