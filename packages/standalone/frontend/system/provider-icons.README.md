# 供应商图标

`provider-icons.ts` 是生成产物，不要手改。它保存 69 个供应商/客户端图标的
SVG 几何与品牌色，供 `components/provider-icon.tsx` 渲染。

## 图标从哪来

全部取自仓库内已经固定版本的 magpie 引擎二进制
（`vendor/magpie/bin/magpie-win32-x64.exe`，revision 见
`vendor/magpie/engine.json`）。magpie 把图标当静态资源随引擎一起打包，由
`/api/icons/{name}` 本地提供，**运行时不联网抓 favicon**。这里沿用同一思路：
图标进源码树，随前端一起打包，离线、断网、自建域名都不通时也画得出来。

引擎的 MIT 许可与依赖声明在 `vendor/magpie/LICENSE` 与 `NOTICE.md`。

## 为什么保留品牌色

界面本身是单色体系（背景、文字、描边、按钮全部黑白灰），但图标保留原始
品牌色，理由有三条：

1. 这是 magpie 自己的做法，也是这类"供应商目录"的通行处理；
2. 品牌标志是第三方资产，重上色本身不合适；
3. **工程上不可行**：HuggingFace、腾讯云、Kiro 这些图标的层次完全靠颜色
   区分（每一层形状盖住下一层），压成单色后最上面那层会把整张图抹成一个
   纯色块。试过灰度阶梯（按明度排 `fill-opacity`），结果只是把纯色块变成
   灰噪点，反而更糟。

图标住在中性容器里（`.wb-app-icon` / `.provider-logo` 有灰底和描边），
只有那一小块是彩色的，不会把列表变成调色盘。

## 怎么重新生成

生成脚本是一次性的，不进仓库（避免把引擎二进制解析逻辑变成长期维护负担）。
需要重建时：

1. 从引擎二进制里抽出所有带 `<title>` 的内联 SVG，存成
   `{ "DeepSeek": "<svg…>", … }` 的 JSON；
2. 按下面两张映射表把 `provider id` 对到 magpie 的图标标题；
3. 去掉 `<title>`、`<filter>`、`<mask>` 及其引用者，给渐变 id 加
   `ofm-icon-<providerId>-` 前缀（否则同一页里多个图标会互相覆盖渐变定义），
   压缩空白；
4. 写入 `provider-icons.ts`。

映射表（provider id → magpie 图标标题，`null` 表示 magpie 也没有，走字母兜底）：

- **聚合渠道**（`src/providers/registry.json` 的 id）：见脚本里的 `MAP`。
  当前 61 个有图标，15 个没有（Agnes AI、Cheaper Inference、Experiential、
  FleetRelay、Lightning、NaraRoute、Opper、OrcaRouter、Poolside、Scaleway、
  TokenRouter、Wafer、BazaarLink、Kimchi、LLaMA.cpp）。
- **EAC 渠道**（`client.js` 的 `CHANNEL_PROVIDERS`）：Qoder、Qoder 中国版、
  TRAE、Cline、MiniMax Code、Gemini 有图标；LobsterAI、Loomy、Raccoon、
  ZCode 没有。
- **客户端**（`src/plugins.js` 的 `WORKBENCH_CLIENTS`）：Codex CLI、
  Codex Desktop、Claude Code、Gemini CLI 有图标；CC Switch、Codex++ 没有。

新增一个没有图标的供应商时不需要改这里 —— `ProviderIcon` 会退回显示名称
首两字母，不会留空框。
