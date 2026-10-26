# 独立端用量统计页验收

## 范围与数据来源

基于模型清单 PR #164 合并后的主线 `2a1c366`，将独立端用量统计迁入
React，按需加载，复用现有组件且不增加 npm 依赖。展示六项累计指标、
物理失败请求与思考 Token、7/14/30 天趋势、按模型搜索排序和每页 20 条分页，
补齐空状态、刷新反馈及窄屏布局。

DSH 插件、十三渠道协议、EAC、匿名及 Kilo 业务和后端统计口径未修改。
未读取或迁移真实 DSH 凭据；未提升版本、创建 tag、打安装包或发布 Release。

**非零截图中的 47 个统计模型为隔离测试记录，不代表实际模型接入或实际用量。**
预览脚本仅在 `OFM_PREVIEW_USAGE=1` 时为隔离目录首次生成统计，
默认测试目录为 `.verify/ui-usage-data`，历史窗口场景使用
`.verify/ui-usage-history-data` 和 `OFM_PREVIEW_USAGE_DAYS_AGO=60`。
这些生成的数据受 Git 忽略，未提交。提交的是测试生成脚本、文档和截图；
正式 CLI 不加载测试脚本、不生成测试统计。

最终交付预览恢复为 `http://127.0.0.1:18900/` 正常服务，
使用独立产品默认数据目录，显示实际零用量。两个隔离统计测试服务已停止。

## 实际验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck:standalone` | 通过 |
| `npm run build:standalone-ui` | 通过，生成八个 JS/CSS 资源及 HTML |
| `node scripts/build-standalone-ui.mjs --check` | 通过，源码与提交产物一致 |
| `node scripts/standalone-frontend-test.mjs` | 通过，包含三页面分包登记、累计与趋势分离、搜索排序和分页 |
| `node scripts/test-all.mjs --mode contributor` | 33/33 套件通过，含管理专项 16/16、渠道专项 11/11 |
| `node scripts/test-all.mjs --mode release` | 3/3 套件通过；仅校验，未发布 |
| `git diff --check` | 通过 |
| `git ls-files .verify` | 输出为空，无测试数据被跟踪 |
| `git check-ignore .verify/ui-usage-data/stats.json .verify/ui-usage-history-data/stats.json` | 两个文件均被忽略 |

贡献者及发布校验在最终日期宽度、滚动提示和中文连接错误微调前完成；
微调后重新通过类型检查、构建、产物一致性与前端专项。发布校验在文档收尾时再次运行。
前端专项含跨月、跨年、上海及纽约夏令时边界、缺失日期补零、47 条模型分页
20/20/7、页码夹紧、输入不变，以及历史累计非零而当前趋势为零的场景。

构建仍有两条 lucide `use client` 指令被忽略警告，浏览器应用构建成功。
类型检查覆盖 TypeScript 组件与承载接口，保留的旧 JavaScript 未开启 `checkJs`。

## 浏览器验证

使用 Codex 内置浏览器验收正常服务和本机隔离测试服务。正常服务不生成模拟用量。

| 场景 | 结果 |
| --- | --- |
| 首次进入及按需挂载 | 首次进入正常加载；概览和切页后统计模型 DOM 为 0 |
| 正常服务 | 六项累计值均为 0，展示无记录说明 |
| 47 条模型统计 | 初页 20 行，末页 7 行，末页下一页禁用 |
| 搜索与排序 | 支持 ID、名称、大小写及空白处理；清空恢复，无匹配有独立说明 |
| 7/14/30 天趋势 | 测试窗口合计分别为 126000/203000/231000 Token，累计值不随窗口变化 |
| 刷新 | 成功反馈明确，搜索保留，操作期间禁重复点击 |
| 性能值 | 测试模型 `fixture/usage-20` 显示 TTFT 500 ms、TPS 60；未知值显示“—” |
| 切页及退出 | 返回保留搜索；退出清空统计 DOM，重新登录重置搜索 |
| 历史累计 | 累计非零但当前窗口为 0，显示窗口无记录说明 |
| 连接失败 | 停止隔离服务后刷新，显示“无法连接本地服务，请确认服务正在运行后重试。” |
| 桌面及窄屏 | 控件无横向越界；图表和表格在自身区域滚动，并有提示 |
| 原有渠道入口 | 最终正常服务核对十三渠道及 EAC GitHub 登录入口可见 |

最终移动端实际视口和文档宽度均为 405 CSS px，窄屏均为 332 CSS px，
控件越界数均为 0。移动端图表内容宽度 498、容器 333，
表格内容宽度 1000、容器 333。详见
[布局记录](standalone-usage-dashboard/layout.json)。验收结束已恢复默认视口。

截图：

- [正常服务桌面](standalone-usage-dashboard/usage-live-desktop.png)
- [正常服务空记录](standalone-usage-dashboard/usage-live-empty.png)
- [隔离非零统计](standalone-usage-dashboard/usage-fixture-desktop.png)
- [按模型筛选](standalone-usage-dashboard/usage-filtered.png)
- [405 px 移动端](standalone-usage-dashboard/usage-fixture-mobile.png)
- [332 px 窄屏](standalone-usage-dashboard/usage-fixture-narrow.png)
- [历史累计与空窗口](standalone-usage-dashboard/usage-history-empty-window.png)
- [刷新连接错误](standalone-usage-dashboard/usage-refresh-error.png)

最终检查浏览器 warn/error 日志列表为空；故意停止服务后的网络失败属于测试场景，
空日志不能证明真实第三方链路无错误。手动刷新错误与现有全局轮询提示可能同时出现，
本批未对这两类提示去重。

## 体积

比较本批之前主线与最终静态 HTML/JS/CSS，不含后端、开发依赖、API JSON 或安装包。

| 指标 | 本批之前（字节） | 本批之后（字节） |
| --- | ---: | ---: |
| 全部静态资源原始体积 | 610365 | 621926 |
| 全部静态资源理论 gzip | 211105 | 215219 |
| 首屏静态资源原始体积 | 334418 | 335085 |
| 首屏静态资源理论 gzip | 105065 | 104665 |

全部原始体积增加 11561 字节，约 11.3 KiB；首屏原始体积增加 667 字节，
约 0.65 KiB。统计 JS 分包为 10710 字节，理论 gzip 为 4245 字节。
统计 CSS 合并进入口 CSS，部分图标共享分包；不能认为所有统计资源都延迟加载。
测量记录见 [之前](standalone-usage-dashboard/sizes-before.json)与
[之后](standalone-usage-dashboard/sizes.json)。理论 gzip 不代表实际 HTTP 传输量，
不用于推断安装包大小或运行速度。未新增依赖，未做纯 React 渲染性能计时。

## 局限与回退

- 迟到导入和刷新回调的保护已做实现者静态核对，未人为延迟请求全面实测竞态。
- 未逐家验证真实账号登录、真实模型推理或 EAC 正式授权。
- 未在 macOS/Linux 重新验收，未测低配置设备和长时间内存占用。
- 本批为实现者自查与实际验收，未执行独立 Agent 审查。
- 无配置或统计数据格式迁移。回退本批源码和对应 `web/` 产物，
  重启服务即可恢复旧统计页，保留独立数据目录中的配置、账号和统计。
