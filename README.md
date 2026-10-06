<div align="center">
  <img src="icon.svg" alt="Our Free Model — DeepSeek Harness 免费模型插件" width="120">

# dsh-our-free-model

**简体中文** | [English](README_EN.md)

  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="零依赖" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="无构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="适配内核" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">
  <img alt="状态" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">

  <p><strong>趋势榜 · 2026-10-06 记录</strong></p>
  <!-- 自制静态卡片记录核实的名次，图片随仓库托管；点击查看对应榜单。 -->
  <a href="https://trendshift.io/?language=JavaScript"><img alt="Trendshift JavaScript 日榜第 14 名，记录于 2026-10-06" src="docs/images/trendshift-daily-2026-10-06.svg" width="300" height="118"></a>
  <a href="https://gittrend.io/trending/ai-infrastructure"><img alt="GitTrend AI Infrastructure 日榜第 14 名，记录于 2026-10-06，榜单更新于 2026-10-05" src="docs/images/gittrend-daily-2026-10-06.svg" width="300" height="118"></a>
  <p><sub>JavaScript 日榜与 AI Infrastructure 日榜均为第 14 名。GitTrend 榜单数据更新至 2026-10-05。</sub></p>
</div>

<div align="center">

> 你只需在 dsh 里装上这个插件，无需登录、注册、填 API Key 或任何其它操作，
> 就能用上包括 DeepSeek V4.1 Flash、Kimi K3 在内的前沿模型——完全免费，不限量。
>
> *All you do is install this plugin in dsh: no login, no sign-up, no API key, nothing
> else. The frontier models are just there — DeepSeek V4.1 Flash, Kimi K3 and the rest.
> Free, with no usage cap.*
>
> 模型清单跟随上游刷新，可用性由**你自己这台机器的网络出口**实测得出；思考强度
> 下发的是真实预算而不是提示词，另附一个 OpenAI 兼容的本地转发端口。
> 纯插件挂载：不改内核、无构建步骤、零依赖。当前版本：v1.4.6。

</div>

---

## 亮点

- **开箱即用，无配置环节**。装完重启一次，输入框里就有「Our Free Model」分组，选模型即可对话——不需要账号、不需要 Key、不需要在后台申请配额。
- **上游来源公开透明**。唯一来源是 OpenCode 的 Zen 网关（`https://opencode.ai`），不经任何第三方中转；请求由谁处理、数据发往何处，见「上游是哪些源」。
- **清单跟随上游**。模型集合、上下文长度与能力在每次刷新时向上游重新拉取，插件内不保存静态快照。
- **选择器只广播可用的模型**。上游声明了但网关拒绝路由的模型（`Model is unavailable`、404）不进下拉框，只在设置页保留记录与拒因；网关 5xx、429、超时、断网属转态故障，一律保持可达；被地区策略拦截的模型单独放进 region-limited 分组；整轮探测全被拒时也不清空选择器。
- **公告中心 + 实时推送**。维护者编辑推送一份 JSON，所有已安装实例在一个轮询周期内收到；正文为白名单约束下的 HTML，`urgent` 级别触发全屏弹窗，可开系统级通知。
- **应用内升级 + 热重载**。设置页一键升级：下载 → SHA-256 校验 → 备份 → 原子替换 → 校验回读 → 热重载，任一步失败自动回滚；升级与代码变更即时生效，无需重启应用。
- **按响应体形状判定流式响应**。网关在高负载下会以 200 + `application/json` 返回完整的 SSE 帧序列；插件嗅探首块按形状分流、把已读字节重新注入流，既不会整轮报废，也不会把正常模型误判为不可用。
- **思考强度实际生效**。Light / Balanced / Deep 对应 2048 / 8192 / 模型上限 token（思考不可关闭的模型整体翻倍），逐次留痕；设置页模型卡标注每档实际下发的上限。它靠硬性输出预算实现，不依赖上游那个会被忽略的 effort 参数。
- **不依赖浏览器界面**。仅 `llm` 为硬依赖，在 headless composition（如 dsh-tui）中照常启动并输出模型。
- **用量看板，数据全部留在本机**。Token 热力图、总量曲线（总计/单模型）、输出速度与首字延迟逐次采样，不上传任何数据。
- **OpenAI 兼容转发端口**。本机其它工具经 base URL + Key 调用这些模型；另有独立 Key 的局域网中继服务同一网络的其它设备。
- **EAC 渠道（桌面端专属）**。DSHEAC AIO 与 DeepSeek Harness 桌面端自动解锁协付通道，模型带 EAC 前缀；凭据加密密封、由宿主指纹闸门把守；命令行等其它宿主中该通道完全不存在。
- **接口具备鉴权围栏**。插件路由优先于内核 `/api`，自带与内核一致的信任检查（connection 服务准入优先，缺失时退回结构化围栏）。

## 界面里会看到什么

**输入框的模型选择器**

| 分组 | 内容 |
| --- | --- |
| Our Free Model | 当前网络出口可直接使用的模型 |
| Our Free Model · region-limited | 上游对该地区不放行的模型，单独隔离但保留可见 |

被判定为「已声明但不路由」的模型不出现在任何分组——只在设置页的「不在选择器中」分组保留记录（含拒因与探测时间）；后续重新通过探测后自动回到选择器。

**设置 → Our Free Model，六个分区：**

- **模型清单**——各模型可用性、是否支持视觉、上下文窗口、最长输出、各思考档位实际下发的输出上限、实测首字延迟，附单次基准测试按钮。
- **公告中心**——公告流：未读计数、紧急徽章、单条/全部已读、手动检查、系统通知开关；正文按白名单渲染 HTML。
- **用量看板**——总览计数、17 周 Token 热力图、总量曲线（Token/请求数、总计/单模型）、速度迷你图、按模型汇总表。
- **本地转发**——开关、监听地址与端口、复制 base URL、显示/复制/轮换 Key、可直接执行的 curl 示例。
- **插件设置**——总开关、是否展示地区受限模型、探测间隔、默认输出上限、当前探测到的出口 IP 与国家。
- **插件升级**——当前/最新版本、检查更新、一键升级（含进度与失败原因）、升级历史、热重载按钮与文件监视开关。

首次启动会有一条分 5 页的介绍（前言 / 模型清单 / 使用步骤 / 功能介绍 / 公告与升级），确认后不再弹出，除非文案版本号提升。

## 安装

**命令行（纯 dsh web）**

```
dsh plugin --profile web add /绝对路径/dsh-our-free-model
```

安装完成后重启应用一次。`--profile` 填实际使用的 profile 名称。

**DSHEAC AIO / 桌面端：请先读本节**

桌面端在启动 web 服务前会跑一道 profile 闸门，扫描器只放行 dsh 自身在
`.dsh-module-fallback` 下生成的链接；profile 目录里出现任何其它符号链接或
目录 junction，应用会拒绝启动并报：

```
PROFILE_UPGRADE_REQUIRED: offline dependency migration is not yet available
```

所以桌面端不要用 `link:` 依赖安装，也不要建 junction——用应用内的插件管理器，
或放一个真实目录。

以真实目录手工安装时，在 profiles 下做三件事：

1. 把发布文件复制到 `node_modules/dsh-our-free-model/`
   （`index.js`、`client.js`、`adapter/`、`src/`、`locale/`、`icon.svg`、
   `cordis.patch.yml`、`package.json`——`adapter/` 不可遗漏，`index.js` 首行即 import 它）。
2. 在 dependencies 中加入 `"dsh-our-free-model": "1.4.6"`——该版本号跟随仓库
   `package.json` 的 version，变更时同步，不要沿用旧值，也不要写 `link:`。
3. 在 `dsh.profile.bundles` 末尾追加 `"dsh-our-free-model"`。

不要再向 `cordis.patch.yml` 添加条目：被 `dsh.profile.bundles` 引用的包自带
patch 层会自动生效，两处同时注册会报 `duplicate loader entry id: our-free-model`。

**整合包（托管安装）**

集成包（EAC 整合包、Mojobox 等）安装时把 bundle config 设为
`distribution: 'managed'`（或向 settings.json 写同一字段），插件的应用内升级、
公告 feed 与热重载即停用——两个写入方同时操作同一安装目录只会损坏目录。
模型车道不受影响。相关验收见 `scripts/offline-test.mjs`。

**安装失败：ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF**

与插件无关（报错发生在下载插件之前）：profile 里已有的 node_modules 由旧版
pnpm 生成，dsh 更新后内置 pnpm 版本变化，pnpm 拒绝在旧参数上继续安装。
关闭 dsh，删除该 profile 的 node_modules 与 pnpm-lock.yaml 使其重建，再重装：

```
rd /s /q "%DSH_HOME%\profiles\web\node_modules"
del "%DSH_HOME%\profiles\web\pnpm-lock.yaml"
```

随附的 Ignoring broken lockfile 警告会随重建消失。

## 使用

**选模型**：输入框的模型选择器里选 Our Free Model 分组下的模型，按会话持久化。

**调思考强度**：同一菜单的 Effort，三档 Light / Balanced / Deep。档位越高思考占用
的输出预算越多；上限强制下发，档位之间有可测量的差异。思考与正文共享输出额度，
因此思考不可关闭的模型会把三档整体上移（模型卡上标注了每档实际数值）。回答被截断时
可切到 Deep，或调高设置里的单次输出上限。

**供本机其它工具调用**：设置 → 本地转发，启用后复制 base URL 并生成 Key，支持：

- `GET /v1/models`
- `POST /v1/chat/completions`（流式与非流式）
- `POST /v1/responses`

端口被占用时插件不会静默停摆：先在同一端口重试数轮（刚关闭的监听、刚删除的
portproxy 规则通常几百毫秒内释放），仍被占用就顺延到下一个可用端口，并在设置页标注
「请求的 18899 不可用，实际监听 18900」，落盘的也是实际端口。Windows 上最常见的
占用来源是一条 `netsh interface portproxy` 规则（由 IP Helper 服务承载）：它对
0.0.0.0 的监听会让回环绑定返回 EACCES（区别于 EADDRINUSE）。`netsh interface
portproxy show all` 列出规则，`netsh interface portproxy reset` 清除规则。

转发端点是全流式：除 `data:` 帧外，思考期间的静默由周期性写出的 SSE 注释帧填充，
客户端 idle 超时不会把「上游仍在推理」误判为「连接已断开」。思考内容按
`reasoning` / `reasoning_content` / `reasoning_text` 三个字段识别（同一段思考若被
上游同时写进两个字段只计一次），`reasoning_details` 数组同样识别。上游本身不流式
输出思考的模型，这里也不会有思考帧，见「已知边界」。

**供同一网络的其它设备用**：同一面板下方的「局域网访问」，默认关闭。启用后中继绑定
一个可路由地址（默认 0.0.0.0），要求使用独立的局域网 Key——与本机 Key 互不通用，
任一泄露只需轮换对应一侧。中继把请求原样转发到本机监听，模型清单、流式行为与错误
语义跟本机一致。端口填 0 表示自动分配。启用期间任何能访问该主机的人都能用这个 Key
消耗本机免费额度，请在可信网络中使用，必要时用防火墙限制来源网段。

**重新核对地区**：点「重新探测可用性」按当前出口重新执行探测。切换 VPN/代理后再
跑一次，地区受限模型会在两个分组间自动迁移。

**换出口（可选）**：设置里的「出口代理」，默认关闭，开着就直连。两种模式：

- **订阅模式**：粘贴 Clash/V2Ray 订阅链接，插件在本机拉起 mihomo（自动找
  verge-mihomo.exe 等，也可手填路径），配一个 url-test 组每 5 分钟重新测速、走最快
  节点，挂掉的节点经健康检查自动排除。**订阅链接按凭据对待**（链接路径本身就是 token）：
  只存本地设置文件，不回显在面板上，面板只显示脱敏 host。插件只拨本机混合端口，自己不
  解析任何 vless/vmess 协议。
- **单代理模式**：填一个 `http://` / `https://` / `socks5://` / `socks5h://` 地址，
  所有上游请求都经它出站。

被接管的流量只有三类：模型推理、模型清单、出口 IP 探测；公告、升级与 EAC 车道保持直连。
出口只服务本插件的 opencode 流量：插件拉起的 mihomo 配置是 `bind-address: 127.0.0.1`、
`allow-lan: false`，不开系统代理、不建虚拟网卡——你的浏览器和其它工具不受影响。
面板在出口开启时会显示当前出口、当前最优节点与 opencode 可达性三项。

**能买到什么，买不到什么**：按 IP 的频率/日额度和地区门会跟着出口走；按 session 的
频率限制和指纹门不管走哪个出口。切换出口会自动重新探测一次，地区受限模型跟着新出口迁移。

**接收公告**：全自动。维护者推送后，运行中的插件在一个轮询周期内（默认 30 分钟，
也可在公告中心点「检查新公告」立即拉取）收到：普通公告弹出 toast，`urgent` 级别
直接全屏弹窗，两者都进公告中心并保留未读标记。

**升级插件**：设置 → 插件升级 → 检查更新 → 立即升级。全程在应用内完成
（下载 → 校验 → 备份 → 替换 → 热重载），无需重装或重启；失败自动回滚到上一版本
并给出原因。

## 实现结构

```
index.js          Host 半身：适配器注册、清单与可用性探测、设置/用量存储、
                  webServer 路由、转发端口生命周期、公告/升级/热重载接线
adapter/          内核接缝：全包唯一允许 import @deepseek-ai/* 的位置
src/adapter.js    结构性 LlmAdapter：providerInfo、listModels、resolveModel、
                  prepareCall、stream、providerRetryPolicy
src/upstream.js   免费车道身份：凭据、session/request id 铸造、工具指纹、按线选端点
src/eac.js        EAC 车道出口：direct/worker 两种模式、HMAC 签名、独立传输
src/egress.js     出口代理：可选把上游请求改写走 mihomo 或用户代理，其余不变
src/stream.js     三种线协议解码（chat / messages / responses）归一为 StreamChunk
src/messages.js   harness 消息 -> 各线协议形态，外加工具调用配对修复
src/effort.js     思考档位 -> 输出预算
src/forward.js    独立的 OpenAI 兼容监听器 + 局域网中继
src/probe.js      可用性/出口探测
src/trust.js      插件路由的请求信任围栏（connection 桥 + 结构化围栏）
src/push.js       SSE 推送枢纽：公告到达、更新可用、升级完成
src/feed.js       远程公告 feed：多源拉取、校验、缓存、到达检测
src/updater.js    应用内升级：清单校验、SHA-256 分级校验、备份、原子替换、回滚
src/reload.js     自热重载：镜像内核 HMR 的缓存清除 + 重导入 + 重注册 + 回滚序列
client.js         浏览器半身：手写 ModuleLoader bundle，无构建步骤
```

几个值得知道的架构决定：

**一个适配器，两条 provider 路由。** harness 的模型选择器严格按 provider 路由分组，
而清单线格式里没有 group/tag/badge 字段。要呈现独立的 region-limited 标题，唯一办法
是再注册一条路由；又因为客户端丢弃空分组，一旦地区限制解除，两个分组自动合并。

**以结构化方式实现适配器，不 import @deepseek-ai/dsh-llm。** 内核不做 instanceof
检查，鸭子类型即可。这让插件不必把依赖固定在特定内核版本上，也是同一份代码能同时
跑在 0.1.5 与 0.1.7 的原因。

**使用自有 JSON 存储，不接 settings seam。** settings 注册 API 在两版内核间不一致；
私有 JSON 存储行为一致，且转发 Key 放在 0600 权限文件中，不进任何共享设置文档。

## 为什么用预算，而不是 reasoning_effort

在该车道上向上游传 reasoning-effort 字符串实测无效：对三个名义档位反复采样，
思考 token 数统计上无法区分。因此思考强度用硬性输出 token 上限实现——它确实产生
约束，留痕的思考 token 随档位单调上升。

## 为什么按 body 形状读响应，而不是 Content-Type

该车道在高负载下会以 200 + `application/json` 返回完整的 SSE 帧序列。旧实现读 header，
于是 `await response.text()` 把整条流读成字符串、JSON.parse 失败、整轮报废——而这个
错误对象带 status: 200，还会让可用性探测把完全可用的模型判为「不可路由」、从下拉框
消失一轮。当前实现先嗅探首块（≤4 KB）按形状分流，再把已读字节重新注入流，实时性
不受影响；`src/http.js` 的 sniffBody 是唯一判据。

## 为什么速度那一栏会显示 —

早期版本曾为一条实际 ~40 tok/s 的车道报告 2941 tok/s。问题不在网关——直连读包显示
64 个帧跨越 5.6 秒，确为增量投递——而在于分子与分母度量的不是同一段时间：一次调用计费
422 个输出 token，其中 291 个是未流出任何帧的 reasoning token，在第一个可见 token
之前就已生成完毕，而窗口起点正是那个 token。

当前实现只在「能容纳分子的那段时间」内输出速率：`windowTokens()` 把未流出的
reasoning token 从分子中剔除，`decodeWindow()` 拒绝过短窗口和不真实的高速率；看板与
模型表都改成 Σtoken / Σ秒，不再对各次速率取平均。因此答案集中在一两个大帧里落地的
模型，不具备可测量的输出速度，该栏显示 —。

## 长思考被截断后的自动恢复

所有模型默认启用一次有界恢复，三种上游协议共用。触发条件：首段只有非空思考、无正文、
无工具调用，且上游未发正常结束帧直接关流；或上游正常 stop 收尾但仍只有思考——宿主把
这类「空停」判为空响应，恢复流程会再请求一次正文。用户取消、已输出正文或工具调用的
正常结束、达到上限、明确的上游错误都不触发。

插件把已收到的思考作为检查点文本，与原始输入一起发新请求，要求直接输出整理后的回答。
这是基于检查点重新发起请求，与上游原生 resume 无关，也不会重放已显示的思考。恢复段
禁用工具调用；已输出正文或已开始调工具的截断回合不执行恢复，避免内容或工具重复执行。

每个逻辑回合最多两次物理请求（原始 + 一次恢复）。默认总时限 480 秒，恢复段最多 180 秒
且受剩余总时长约束；恢复输出上限 8192 token，并继续受用户与模型上限约束。首段已知的
输出 token 会从原始预算中扣除，恢复预算不足 512 token 时不发起。检查点最多 131072
字符，且需通过保守的上下文余量估算。恢复必须正常结束并产生非空白正文才算成功；失败
返回 STREAM_CUT，宿主不会把该回合整轮重发，用户取消保持 aborted。

可通过本机 settings.json 的 `streamRecovery: false` 关闭；也可用对象内的 enabled 开关
和数值限制收窄边界。默认不限制模型名单。

用量看板把物理请求与逻辑回合分开统计：上游请求数/失败数按实际发出次数计；对话回合数、
回合失败数与已恢复数按一次适配器调用的最终结果计。例如首段中断、续写成功会记为
2 次上游请求、1 次请求失败，同时记为 1 个对话回合、0 次回合失败、1 次已恢复。
最终上报宿主的 usage 只汇总上游实际报告的已知值；缺某段 usage 时不等于整轮完整 token
总量。思考检查点不写入统计文件。

## 上游是哪些源

免费车道只有一个来源，且不是中转站：OpenCode 的 Zen 网关
（`https://opencode.ai/zen/v1/*`）。会话内容从本机直达该网关，中间无第三方经手。
以下目标在 2026-09-24 逐条通过直接请求核对：

| 用途 | 目标 | 携带的凭据 |
| --- | --- | --- |
| 推理请求 | `POST …/zen/v1/chat/completions`、`/zen/v1/responses`、`/zen/v1/messages`（按模型分流） | `Authorization: Bearer public`——该车道本身是公开免密额度，插件不含属于你的密钥 |
| 模型清单 | `GET …/zen/v1/models` | 同上 |
| 公告与升级清单 | 本仓库 `feed/*.json`：raw.githubusercontent.com 优先，cdn.jsdelivr.net 兜底 | 无 |
| 出口地区判定 | api.ipify.org / ipinfo.io / ipapi.co（仅读本机公网 IP 与国家码） | 无 |

关于隐私与信任：

- 没有号池、没有中转、没有二道贩子。当前版本上表四行就是全部出网目标；`npm test`
  的离线套件完全不出网，仅 `scripts/host-selftest.mjs` 与 `scripts/probes/` 会主动请求
  这些地址，需手动运行。
- 你的 prompt、工具结果与随附图像会作为正常推理请求发往该上游——与调用任何模型 API
  相同。除此之外插件不上传任何内容：用量看板数据、设置、转发 Key 都只落在本机
  `DSH_HOME/our-free-model/`。
- 免密不等于无人管理：该车道通过 `x-opencode-*` 指纹识别客户端、按会话统计免费额度，
  会因地区返回 403、因超量返回 429。模型集合与额度政策由上游决定，随时可能变更；插件
  只能如实把不可用的模型从选择器中移除。

## EAC 渠道（桌面端专属）

除免费车道外，插件内置一条协付渠道（EAC），只在两个桌面宿主中解锁：

- **DSHEAC AIO（Tauri 壳）**：内核路径、内嵌 node、web-desktop profile 三重信号同时命中才解锁。
- **DeepSeek Harness 桌面端（Electron 壳）**：内核提供的 desktop profile 上下文（CLI 按设计拒绝该 profile）加桌面壳给内核进程设的运行标记。

在命令行、纯 dsh web 及其它任何运行方式中，该通道整体不存在：没有模型、没有请求、没有
报错，也不发生解密尝试。

显示规则：模型名只显示模型本名并带渠道前缀，如 `EAC DeepSeek V4.1 Flash`；设置页模型卡
上有独立的 EAC 渠道徽章。模型清单跟随上游刷新。

**加密密封**：渠道凭据与端点从不以可读形式出现在插件里——只以 AES-256-GCM 密文存在，
解密密钥由分散在两个文件中的三片掩码分片在解锁时即时派生；非授权宿主不进派生路径。
凭据不落盘、不出进程：解锁按请求即时发生，明文只存在于构造请求的那一帧中，不写文件、
不进日志、不出现在任何 API 响应或错误消息里。

**签名网关（推荐形态）**：`worker/` 附带一个网关实现——插件密封的只有网关地址和 HMAC
签名密钥，请求按 时间戳 + HMAC-SHA256(方法/路径/body 摘要) 签名，中继的真实 key 只存
在网关环境变量里；防重放时间窗、模型白名单、可选按 IP 限速都在网关执行，签名密钥泄露
只需在网关侧轮换即可全体吊销。网关的部署与轮换见 `worker/README.md`。

## 已知边界

- **「不限量」指不存在额度体系**：无需充值、不按 token 计费、没有套餐。但该车道按
  session 统计速率，短时间内打满会返回 429。插件把该模型标记为「已达限额」，不做隐藏，
  下一轮探测自动恢复。
- **部分模型上游本身延迟较高**。曾实测首字延迟超过 30 秒；思考阶段可静默 60–70 秒（并
  计费 reasoning token 但不发思考帧）。看板如实显示。此类回合可能以 stop 收尾而正文为空，
  客户端容易报「空响应」：把单次输出上限提到 16k 以上，或改用模型卡中标注
  `reasoning: false` 的模型。
- **思考与正文共享输出预算**。思考不可关闭的模型档位整体上移，见「思考强度」。
- **自动恢复有次数、时间与上下文边界**。只恢复纯思考 EOF 与纯思考空停，最多追加一次
  请求；不保证成功，缺失 usage 时用量仅为已知部分。
- **能力标注以探测可证明者为限**。公开清单与实测都拿不到证据的，不予标注。
- **源码是明文 JavaScript**。作为本地插件必须如此，能访问该目录的人即可读懂网关逻辑；
  混淆解决不了这个问题。
- **桌面端安装需要真实目录**，原因见安装一节。
- **升级与热重载的信任边界**：应用内升级的信任根是插件内 pin 的 Ed25519 公钥，不再依赖
  「HTTPS 到仓库」。镜像（含 jsDelivr）被投毒只会导致升级失败，不会执行其中的代码。持有
  发布私钥者可推送任意代码——这与「可推送仓库者」等价，但把「仓库账号被接管」从直接 RCE
  降级为「所有用户升级失败」。
- **DSHEAC AIO 的 WebView2 权限策略可能拒绝通知授权**（本机实测 denied）。被拒时公告中心
  的开关会如实提示；纯浏览器访问 dsh web 不受影响。
- **鉴权级别取决于 composition**。挂了 connection 服务的 composition（dsh web、AIO
  桌面端）下与内核 `/api` 同级（需要应用自身 cookie/token）；不挂 connection 的极简
  composition 退回结构化围栏（loopback + 同源检查），本机其它进程仍可访问——这与内核在
  同类 composition 下的行为一致。这种 composition 下，本机任意进程一次请求即可拿到转发
  Key 与局域网 Key；这两把 Key 应视作本机进程可读文件（与 settings.json 同信任级别），
  需要更强隔离请在部署时挂载 connection 服务。

## 安全与隐私

- 所有状态写入 `DSH_HOME/our-free-model/`；用量与设置只落在本机，不上传。
- 转发监听只绑回环地址（默认 127.0.0.1），无 Key 请求一律拒绝；把地址改成可路由接口会被
  直接拒绝（POST /settings 返回 400 并注明原因）。`localhost` 这类主机名先经 `dns.lookup`
  解析、全部结果均为回环才放行，绑定用的是解析出的 IP——hosts 文件或企业 DNS 把 localhost
  指向可路由接口时，校验与监听不会各自为政。
- 局域网访问是另开的一扇门，不放松上述规则：本机监听仍只绑回环；跨机器必须显式启用
  「局域网访问」，中继绑定可路由地址，且每个请求都要带局域网 Key——连 `/`、`/health` 存活
  探针也一并鉴权（仅本机监听免 Key 应答存活探测）。中继只转发 `/v1/models`、
  `/v1/chat/completions`、`/v1/responses` 三条白名单路径，不代理任意 loopback 服务；
  入口处把局域网 Key 换成本机 Key，两把 Key 互不通用；带跳数标记的请求直接拒绝（508），
  端口配成本机同一端口也不会自环。局域网 Key 由 crypto 生成、timingSafeEqual 比对、放在
  同一 0600 文件中，可在面板上单独轮换。
- 转发 Key 由 crypto 运行时生成、timingSafeEqual 比对、存放在 0600 权限文件中。仓库不含
  任何硬编码凭据。`/` 与 `/health` 为存活探针，先于 Key 检查应答，但只回答「是否在线」。
- 插件的 HTTP 路由带请求信任围栏：`/api/our-free-model` 前缀在 webServer 最长前缀分发下
  优先于内核 `/api`，曾绕过内核鉴权。现在每个请求先经 composition 的 connection 服务准入
  （与内核 /api 同级）；connection 缺失的 composition 退回结构化围栏——loopback Host、
  拒绝跨站 sec-fetch-site、Origin/Referer 必须与 Host 同源同端口，Host 缺失或为空也拒绝
  （fail closed）。connection 逐请求获取，因为浏览器半身要等插件加载后才把它 provide 出来。
- 公告 HTML 在客户端经严格白名单渲染（XSS 语料全部被丢弃，无 innerHTML sink）；feedUrl
  可被指向任意 URL，渲染器按不可信输入处理。
- 应用内升级的完整性链：清单 Ed25519 签名验证（公钥 pin 在 src/updater.js）→ 清单校验
  （semver、路径逃逸、哈希格式、base 必须为清单相对路径）→ 逐文件 SHA-256 与字节数校验 →
  staging 回读 → 安装后回读 → 任一步失败恢复备份；安装前强制重新拉取清单。
- 更新通道与 feedUrl 彻底解耦：feedUrl 只重定向公告 feed，永不再指向升级清单。公告
  override 只允许 https（回环 http 除外），不得内嵌凭据。在不含 connection 服务的
  composition 中，能改设置的本机调用者可让进程持续请求任意外部地址——这与插件的其余
  外联一样按「设置即信任」对待：能改 settings.json 的人本来就能装代码。
- 卸载只需移除 bundle 条目，插件不留任何补丁；数据目录是纯 JSON，可直接删除。

## EAC 网关的部署与轮换

`worker/` 目录包含网关实现（Cloudflare Worker 与自建 Node 版同一份逻辑）和完整的部署/
密钥轮换文档，见 `worker/README.md`。要点：

- 网关是协付渠道的**唯一持密方**：插件里密封的只有网关地址和签名密钥，中继真实 key 只存
  在网关环境变量里；插件被逆向得到的只是一个可随时吊销的间接入口。
- 签名契约：`x-ofm-timestamp`（unix 毫秒）+ `x-ofm-signature`
  `hex(HMAC-SHA256(secret, "<ts>\n<METHOD>\n<path>\n<hex(sha256(body))>"))`；时间戳偏离
  超过窗口即拒（防重放）；仅放行 GET /v1/models 与 POST /v1/chat/completions。
- 自建网关带三层自防滥用（.env 配置）：单 IP 并发上限（CONCURRENCY_PER_IP=5）、单 IP
  频率与日额度（RATE_LIMIT_PER_MINUTE=60 / RATE_LIMIT_PER_DAY=1000）、管理看板
  （ADMIN_TOKEN，`/eac/stats?t=…`：请求热力图、72h 曲线、按 IP/模型 Token 扇形图、每 IP
  明细表，数据落盘 stats.json，IP 盐值哈希存储）。
- SSE 预冲刷（SSE_PRELUDE_SECONDS=15）：验签一通过就回 200 + `text/event-stream` + 注释
  帧，上游出 token 后再灌真实帧——给 Cloudflare 源站超时和 nginx 默认 60s 读超时准备的，
  推理型模型首 token 经常要 30–140 秒。

## 开发

```
npm test # 全部离线套件 + 清单一致性检查，一条命令
node scripts/client-lint.mjs      # 浏览器半身：文案键与样式键双向覆盖、bundle 可执行
node scripts/retry-safety-test.mjs # 交给内核的失败对象、退避策略与 usage 计数可持久化
node scripts/speed-stat-test.mjs   # 任何一次调用都不得被平均成虚假的 tok/s
node scripts/sanitize-test.mjs     # 公告 HTML 白名单渲染器：XSS 语料必须全部被丢弃
node scripts/trust-test.mjs        # 插件路由的请求信任围栏
node scripts/feed-test.mjs         # 公告 feed：解析、故障转移、缓存、到达检测
node scripts/updater-test.mjs      # 应用内升级：清单校验、SHA-256、备份/回滚
node scripts/effort-test.mjs       # 思考档位 = 实际下发的 max_tokens，且与留痕档位一致
node scripts/sniff-test.mjs        # 200 响应按 body 形状分流：SSE 帧、单包 JSON、空 body、跨 chunk、中途 abort
node scripts/release-e2e.mjs       # 用真实 feed/manifest.json 执行一次升级，验证虚报字节的清单被拒
node scripts/picker-test.mjs       # 选择器只广播可用模型，永不广播空集合
node scripts/tui-test.mjs          # 无 web server 的 composition 中插件仍能启动并输出模型
node scripts/host-selftest.mjs     # Host 半身端到端，会真实出网
node scripts/build-manifest.mjs    # 发布：重新生成 feed/manifest.json（发布文件哈希清单）
```

发布清单必须用发布私钥签名（`--key` 或 `OFM_MANIFEST_KEY` 环境变量），未签名清单会被
构建器直接拒绝——应用内升级自 v1.3.2 起只安装能与插件内公钥验签通过的清单。私钥不进仓库、
不进任何分发物；更换密钥等于更换信任根，需同时改 `src/updater.js` 里 pin 的公钥并走一轮
完整发布流程。

`scripts/probes/` 是逆向过程中的一次性取证脚本（能力矩阵、地区门、reasoning_effort 无效性
采样、预算方言、悬空工具调用等）。其中基于本插件自身代码的那几个可在仓库根直接执行
（如 `node scripts/probes/pairing-repair.mjs`）；其余借助第三方 SSE 客户端直连上游，模块
路径按取证时的仓库结构编写，仅作记录，不属于测试套件、未接入 npm test。

需要 Node `^22.19.0 || >=24.0.0`，无安装步骤、无依赖。`npm run typecheck`（`tsc --noEmit`）
可做严格类型检查（可选，需要 typescript）。

## 许可证

MIT，见 LICENSE。

本项目为独立插件，与任何模型提供方无隶属、认可或赞助关系。使用该插件访问免费额度受各
提供方自身条款约束；在超出个人机器的场景中部署前，请先确认这些条款。