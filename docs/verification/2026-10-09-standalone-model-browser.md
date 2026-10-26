# 独立端模型清单验收

## 范围与数据来源

基于主线 `1ccd9e7`，完成第二阶段第一批模型清单页面：迁入 React，
按需分包、虚拟列表、组合筛选、复制 ID、刷新、主动探测和可取消的单模型测试。
其余页面沿用现有实现。DSH 插件、十三渠道协议、EAC 与推理核心未修改。
未提升版本、创建 tag、打安装包或发布 Release。

**截图中的 1,018 个模型是隔离测试清单，不代表项目实际接入数量。**
预览脚本在 `OFM_PREVIEW_MODELS=1000` 时生成
`fixture/model-0:free` 到 `fixture/model-999:free`，另有一条匿名 MiMo 记录，
本机替身；“可接入”“已探测可用”只描述该测试环境。正式启动入口不生成这些数据。
本轮未读取或迁移真实 DSH 凭据，测试目录位于 `.verify/ui-phase1-load-data`。

## 实际验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck:standalone` | 通过 |
| `npm run build:standalone-ui` | 通过，生成五个 JS/CSS 资源及 HTML |
| `node scripts/build-standalone-ui.mjs --check` | 通过，提交产物与源码一致 |
| `node scripts/standalone-frontend-test.mjs` | 通过，分包登记、空统计及千模型组合筛选 |
| `node scripts/standalone-management-test.mjs` | 16/16 通过，含取消真实 HTTP 测试请求后上游连接关闭、管理会话仍有效 |
| `node scripts/test-all.mjs --mode contributor` | 33/33 套件通过 |
| `node scripts/test-all.mjs --mode release` | 3/3 套件通过；只运行校验，未发布 |
| `node scripts/measure-standalone-ui.mjs` | 通过，结果保存到本批验收目录 |
| `git diff --check` | 通过 |

构建仍有两条 lucide `use client` 指令被忽略警告，普通浏览器应用构建成功。
类型检查覆盖 TypeScript 组件与承载接口，保留的旧 JavaScript 未开启 `checkJs`。

## 浏览器验证

使用 Codex 内置浏览器，最终产物重建后重启预览服务并重新加载。
验收期间全部请求指向本机替身。

| 场景 | 结果 |
| --- | --- |
| 概览启动 | 模型条目 DOM 为 0；模型 JS 首次进入才导入 |
| 末尾搜索 | 搜索 `fixture/model-999:free` 得到 1/1,018，滚动位置归零 |
| 组合筛选 | 渠道、能力、状态、公开范围可组合；无结果有空状态，清空恢复 |
| 未探测状态 | 筛选结果与测试清单一致 |
| 复制 ID | 浏览器剪贴板内容与完整模型 ID 一致 |
| 刷新与主动探测 | 成功反馈明确，搜索条件保留 |
| 单模型成功 | 返回替身正文及约三秒耗时 |
| 单模型失败 | 显示指定 998 模型的具体模拟失败原因 |
| 主动取消 | UI 显示取消，上游连接关闭，没有迟到结果覆盖 |
| 切页取消 | 返回后保留筛选和取消状态，隐藏页面不挂载模型条目 |
| 退出后重新登录 | 测试取消，模型 DOM 清空；重新登录筛选重置 |
| 服务暂停/恢复 | 暂停后测试、主动探测禁用；恢复后重新可用 |
| 十三渠道与 EAC | 十三渠道可见；EAC 未授权、GitHub 登录和替身资源池入口可达 |
| 窄屏 | 长 ID 换行，控件无横向越界；末尾可达且单模型测试成功 |
| 最终浏览器日志 | 新会话检查 warn/error 列表为空 |

首轮浏览器测试包含故意失败的模型请求和退出后的鉴权请求，
不能将这些预期 HTTP 失败误报为产品运行错误。最终复查使用新浏览器会话，
未再次运行故意失败场景，其空日志也不代表真实第三方链路全部无错误。

最终布局测量见 [layout.json](standalone-model-browser/layout.json)。
宿主缩放和浏览器滚动条影响视口工具尺寸，记录实际 `innerWidth` 与文档
`scrollWidth`：桌面分别 1662/1642，窄屏分别 332/312，模型控件越界均为 0。
窄屏截图顶部未显示列表全部内容，另附包含模型条目的完整移动端截图。
验收结束恢复默认视口。

截图：

- [最终桌面列表](standalone-model-browser/models-desktop.png)
- [移动端列表](standalone-model-browser/models-mobile.png)
- [最终窄屏顶部](standalone-model-browser/models-narrow.png)
- [测试成功](standalone-model-browser/test-success.png)
- [测试失败](standalone-model-browser/test-error.png)
- [移动端测试](standalone-model-browser/test-mobile.png)

成功、失败和移动端交互截图取自最终清理废弃 CSS 前的构建；
该清理仅删除已移除旧模型 DOM 的样式，最终桌面和窄屏截图已重新取得。

## 体积与速度

比较对象为本批之前的主线和本批最终静态 HTML/JS/CSS，
不含后端、开发依赖、API JSON 或安装包。

| 指标 | 本批之前（字节） | 本批之后（字节） |
| --- | ---: | ---: |
| 全部静态资源原始体积 | 571471 | 610365 |
| 全部静态资源理论 gzip | 198884 | 211105 |
| 首屏静态资源原始体积 | 334670 | 334418 |
| 首屏静态资源理论 gzip | 106067 | 105065 |

总原始体积增加 38,894 字节，约 38.0 KiB；首屏原始体积基本持平。
模型 JS 分包 37,388 字节，理论 gzip 12,266 字节；共享供应商清单另有分包。
模型 CSS 合并进入口 CSS，因此按需加载不意味着所有模型相关字节均延后。
理论 gzip 不代表实际 HTTP 传输量，也不能据此推断安装包体积。
最终测量见 [sizes.json](standalone-model-browser/sizes.json)。

最终复查首次点击至组件可见为 284 ms，首轮为 289 ms，均包含工具往返和等待，
不是纯 React 渲染耗时，也不是持续负载基准。本轮只证明千条测试清单不会全量
挂载模型 DOM，未测低配置设备、长期内存占用或真实上游响应速度。

## 边界与回退

- 单模型取消由真实本机 HTTP 连接验证；刷新/探测为共享任务，
  前端取消等待不保证后端整个任务停止。
- 未逐家验证真实渠道授权、真实模型回答或 EAC 正式授权。
- 未在 macOS/Linux 重新执行浏览器及原生终端验收。
- “未公开”分区由离线筛选专项覆盖；此预览全部模型可接入，
  未公开模型按钮的真实账号状态变化未做浏览器实测。
- 本轮为实现者自查与实际验收，没有宣称独立 Agent 审查。
- 运行时配置与数据格式未变，无需迁移；回退本批源码和对应 `web/` 产物，
  重启服务即可恢复旧模型页，保留现有独立数据目录。
