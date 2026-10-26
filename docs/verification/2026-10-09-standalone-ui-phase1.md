# 独立端界面第一阶段验收

## 交付范围

完成概览、渠道管理、公共导航及窄屏布局。前端采用 React、TypeScript、
Vite、Tailwind 和项目内维护的基础组件；不是直接安装整套 shadcn 业务页面。
模型清单、用量、设置、API 接入及登录继续使用已有控制逻辑。
第一阶段到此停在可评审状态，不自动进入第二阶段。

- 概览展示实际模型数量、用户回合、Token、恢复回合、七天用量和运行状态。
- 十三个账号渠道支持搜索、已接入/待接入筛选、详情和渠道切换。
- 详情复用原渠道登录、账号池、续期、签到、模型开关和积分业务。
- 渠道用量、请求日志、供应商启停、昵称、账号优先级、积分锁定及备份入口保留。
- EAC 继续复用原授权和资源池逻辑；匿名与 Kilo 可从模型来源入口进入清单。
- React 共用一份，渠道 JS 按需导入；删除旧的独立渠道包和重复源码入口。
- 服务只公开构建清单登记的 JS/CSS，不按请求路径读取文件。
- 退出管理清空 React 页面并中断渠道 RPC；迟到的导入不挂载过期页面。
- 模型卡片和用量表只在对应页面渲染，不在概览后台生成千条隐藏卡片。

未修改插件 `client.js`、渠道协议、推理核心或真实用户数据。未提升版本、
创建 tag 或发布 Release。第一轮验收结束时尚未推送；后续按用户要求提交 PR。

## 实际验证

| 命令 | 结果 |
| --- | --- |
| `npm run build:standalone-ui` | 通过，生成 HTML、资源清单及三个静态资源 |
| `npm run typecheck:standalone` | 通过，检查新 TypeScript 组件与承载接口 |
| `node scripts/build-standalone-ui.mjs --check` | 通过，源码和提交资源一致 |
| `node scripts/standalone-frontend-test.mjs` | 通过，资源登记、动态依赖、按需分包及空统计 |
| `node scripts/standalone-management-test.mjs` | 同步最新主线后 15/15 通过，含跨平台启动器及全部分包的 GET/HEAD、方法限制和非公开路径 |
| `node scripts/standalone-channels-test.mjs` | 11/11 通过，使用真实适配器与本机替身上游 |
| `node scripts/test-all.mjs --mode contributor` | 同步主线后 33/33 个套件通过，日志位于 `.verify/ui-phase1-pr-contributor.log` |
| `node scripts/test-all.mjs --mode release` | 0/3 通过：签名清单和目录记录尚未随源码变更重新生成；日志位于 `.verify/ui-phase1-pr-release.log` |
| `node scripts/measure-standalone-ui.mjs --record` | 通过，记录原始及理论 gzip 体积 |
| `git diff --check` | 通过 |

构建产生两条来自 lucide 的 `use client` 指令被忽略警告。此处是普通浏览器
应用而非 React Server Components；构建成功，浏览器验收未出现运行错误。
原插件共享 JavaScript 与保留的控制器未开启 `checkJs`，不能把新组件的
类型检查当作这些旧代码也已严格类型化。

## 浏览器验收

使用 Codex 内置浏览器实际点击并截图，数据目录为隔离的
`.verify/ui-phase1-data`，页面始终显示替身提示。

| 场景 | 结果 |
| --- | --- |
| 概览真实零值及空用量 | 通过，没有虚构增长率或调用记录 |
| 十三个渠道全部展示 | 通过 |
| 搜索 `qoder` | 显示两个对应渠道 |
| 不存在的名称 | 显示空状态，重置后恢复全部渠道 |
| 账号详情与列表 | 通过，原账号操作和模型入口可达 |
| 供应商与备份 | 启停、积分锁定、账号选择及导入导出入口可达 |
| 渠道用量与日志 | 通过，空账本和请求记录正常显示 |
| EAC | 未授权状态、GitHub 登录入口和替身资源池正常显示 |
| 退出及重新登录 | 退出后渠道与侧栏文本清空，重新登录恢复管理 |
| 桌面 | 默认约 1123 CSS px 宽，图标及图片加载成功，未发现文字溢出 |
| 窄屏 | 实际 389 × 844 CSS px，按钮和标题无文字溢出；测量有 1px 亚像素取整差异 |
| 浏览器错误日志 | 本次检查没有 error 记录 |

浏览器继承了宿主缩放，视口工具的输入值不等于 CSS 像素。
窄屏依据 DOM 实测宽度记录，不能把第一次设置的 390 工具像素误报为
390 CSS px；实际布局测量保存在 `standalone-ui-phase1/layout.json`。

截图：

- [旧概览](standalone-ui-phase1/overview-before.png)
- [新概览](standalone-ui-phase1/overview-desktop.png)
- [渠道列表](standalone-ui-phase1/channels-desktop.png)
- [账号详情](standalone-ui-phase1/detail-desktop.png)
- [窄屏概览](standalone-ui-phase1/overview-mobile.png)
- [窄屏渠道](standalone-ui-phase1/channels-mobile.png)
- [窄屏详情](standalone-ui-phase1/detail-mobile.png)
- [同步主线后的 Windows 登录页](standalone-ui-phase1/login-windows.png)

提交 PR 前已同步主线 `befe365`，将新增的 macOS/Windows 系统判断、终端按钮
与手动命令迁入 `frontend/legacy.js` 和 `frontend/index.html`，重新生成资源。
本轮在 Windows 浏览器重新检查登录页、概览与十三个渠道，浏览器错误日志为空。
macOS 原生窗口的实机结果沿用主线记录，本轮未在 macOS 重新执行。

## 体积与速度

比较范围是页面静态 HTML/JS/CSS，不含管理 API 的 JSON 响应、
开发依赖、后端文件或安装包。旧版五个资源全部在首屏加载；
新版首屏只引用 HTML、入口 JS 和 CSS，渠道 JS 首次进入该页面时导入。

| 指标 | 改版前 | 改版后 |
| --- | ---: | ---: |
| 全部静态资源原始体积 | 507.8 KiB | 558.1 KiB |
| 全部静态资源理论 gzip | 168.2 KiB | 194.2 KiB |
| 首屏静态资源原始体积 | 507.8 KiB | 326.8 KiB |
| 首屏静态资源理论 gzip | 168.2 KiB | 103.6 KiB |

以上改版后体积包含同步主线的跨平台登录逻辑。
首屏原始体积减少 **35.6%**，但总体原始体积增加 **9.9%**，
理论 gzip 总体增加约 **15.5%**。不能宣称整个包变小了。
总量增长主要来自新概览、导航、筛选详情、图标及基础组件依赖，
以及统一样式；旧共享渠道组件为保持业务兼容仍保留。
当前 HTTP 资源没有开启 gzip，这里只是同一压缩方法的理论对比。
独立安装包尚未构建，因此没有 ZIP 大小结论。

第一轮验收在同步 macOS 登录改动之前，采用同一浏览器
“刷新/点击至目标可见”的自动化方法：

| 项目 | 实测 |
| --- | --- |
| 旧概览刷新三次 | 119 / 86 / 83 ms，平均 96 ms |
| 最终新概览刷新三次 | 138 / 137 / 112 ms，平均 129 ms |
| 新渠道首次进入 | 306 ms |
| 新渠道再次进入 | 274 ms |
| 1018 模型清单进入 | 462 ms |
| 搜索单个模型 | 111 ms，结果由 1018 条收敛为 1 条 |

计时包含工具往返、浏览器调度及本机服务响应，不是纯渲染耗时，
也不是冷启动 FCP/LCP。旧版平均更低约 33ms；小样本不能据此推导
稳定性能比例，也不能宣称新页面加载更快。本轮没有扩大改版范围。
千模型验收确认：概览启动时隐藏模型卡片为 0，进入清单后为 1018；
未做虚拟列表，这仍属于下一阶段模型页的优化边界。

原始数据保存在本目录下的 `standalone-ui-phase1/`：
`sizes-before.json`、`sizes.json`、`performance-before.json`、
`performance.json`、`long-list.json`。

## 未验证范围

- 没有逐家完成第三方真实账号授权、短信验证或扫码；需用户操作。
- 浏览器中的备份导入、删除账号及外部授权未在真实用户目录执行；
  相应后端链路由替身专项测试覆盖，不冒充真实账号验收。
- 没有测 Windows/macOS/Linux 全平台安装包；Linux CI 配置已添加，
  但本机未执行 GitHub Actions。
- Release 检查已运行但未通过；未更新签名或版本，未运行发布流程、
  安装制品和冷启动性能分析。合入发货主线前仍需维护者完成签名准备并使该门禁通过。
- 第一阶段不包含模型列表重设计、虚拟滚动或旧共享业务组件全面拆分。

## 预览与回退

执行 `node scripts/standalone-ui-preview.mjs` 启动隔离替身预览，
默认端口 `18901`，管理链接保存在 `.verify/ui-phase1-url.txt`。
该预览不能完成真实授权。正式使用继续按独立端 README 启动服务。

撤销本阶段时应整体恢复前端源码、构建输出、资源清单及管理资源映射，
不要只恢复 `app.js`；本阶段不迁移或重写用户数据。
