<div align="center">
  <img src="icon.svg" alt="Our Free Model — DeepSeek Harness 免费模型插件" width="120">

# dsh-our-free-model

**简体中文** | [English](README_EN.md)

  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="零依赖" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="无构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="适配内核" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">
  <img alt="状态" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">
  <br>
  <a href="https://trendshift.io/repositories/261203"><img alt="GITHUB TRENDING 第 1 名，日榜仓库" src="docs/images/trendshift-daily-laurel-gold.svg" width="250" height="55"></a>
  <a href="https://trendshift.io/weekly?language=JavaScript"><img alt="Trendshift JavaScript 周榜第 1 名（2026-10-05 至 2026-10-11，更新中）" src="docs/images/trendshift-weekly-2026-10-11-first-gold.svg" width="250" height="55"></a>
  <br>
  <sub>Trendshift JavaScript 周榜第 1 · 2026-10-05 至 2026-10-11 · 更新中，截至 2026-10-11</sub>

</div>

<div align="center">

> 你只需在 dsh 里装上这个插件，无需登录、注册、填 API Key 或任何其它操作，
> 就能用上包括 DeepSeek V4.1 Flash、Kimi K3 在内的前沿模型——完全免费，不限量。
>
> *All you do is install this plugin in dsh: no login, no sign-up, no API key, nothing
> else. The frontier models are just there — DeepSeek V4.1 Flash, Kimi K3 and the rest.
> Free, with no usage cap.*
>
> 模型清单跟随上游刷新，可用性由**你自己这台机器的网络出口**实测得出，
> 思考强度下发的是真实预算而不是提示词，另附一个 OpenAI 兼容的本地转发端口。
>
> 纯插件挂载：不改内核、无构建步骤、零依赖。

</div>

---

## 交流群

<div align="center">
  <img src="docs/images/qq-group-qr.png" alt="AI 技术交流学习群二维码" width="300">
  <br>
  <b>QQ 群：386179533（AI 技术交流学习群）</b>
  <br>
  扫码加入群聊，一起交流插件使用心得、反馈问题与分享玩法。
</div>

---

## 亮点

### 开箱即用

- **无需账号、Key 或后台配额** —— 装上就能用。上游来源公开：免费车道为 OpenCode 的 Zen 网关（https://opencode.ai），Kilo 渠道为 Kilo AI 的公共网关（https://kilo.ai），**均直连、不经任何第三方中转**（详见 [上游与隐私](docs/开发与上游.md) 与 [免责声明](docs/附录.md)）。

### 六条接入车道

| 车道 | 说明 |
| --- | --- |
| **免费车道** | 开箱即用，无需登录。清单每次刷新向上游重新拉取，插件内不保存静态快照。 |
| **Kilo 渠道** | 内置 Kilo AI 公共网关的免费模型池（`isFree` 清单实时拉取，含 `kilo-auto/free` 自动路由），无需账号或 Key；模型卡带 Kilo 徽章。⚠️ 该池由上游免费提供，上游声明 prompt 可能被记录用于改进服务 —— **请勿发送敏感内容**（详见 [免责声明](docs/附录.md)）。 |
| **EAC 渠道**（桌面端专属） | 在 DeepSeek Harness 桌面端与 DSHEAC AIO 桌面端中自动解锁的协付通道，模型以 `EAC ` 前缀显示；凭据加密密封，由宿主指纹闸门把守；**服务器侧校验 GitHub 授权（登录并 star 本仓库）后才放行对话**；在命令行及其它宿主中该通道完全不存在。详见 [使用指南](docs/使用指南.md)。 |
| **十三个账号渠道** | CodeArts（华为云）、CodeBuddy / WorkBuddy（腾讯）、LobsterAI（有道）、Qoder / Qoder 中国版（阿里系）、TRAE（字节）、Cline、Loomy（讯飞）、Raccoon（商汤）、MiniMax Code、ZCode（智谱）、Gemini（Google Code Assist）等，开箱即用；登录流程、账号池、每日积分领取、模型黑名单与其本地 OpenAI 网关原样挂载。凭据只写入宿主凭据库，**浏览器永远拿不到明文**。 |
| **聚合渠道**（自带 Key） | 注册表内置 **76 家**提供商（NVIDIA NIM、OpenRouter、Groq、Cerebras、**SambaNova**、Gemini、DeepSeek、Mistral、Together、Fireworks、SiliconFlow、**Nebius**、**Chutes**、Hugging Face、Cloudflare、Z.ai、Kimi、MiniMax、**QwenCloud/Alibaba**、Bedrock、Vertex、Vercel AI Gateway、Azure OpenAI，以及免账号的 Ollama / LM Studio / llama.cpp 等）。Key 只写入本机 0600 的 `settings.json`，API 只回显 `hasKey` 与 `…abcd` 指纹。每家可单独启停、**测试**（**列表探测** —— 不花一次生成）、发现模型、覆盖 Base URL 与模型清单。**OAuth 与 ADC 认证的提供商照常列出，但标注为不可驱动**。 |
| **降级链（combo）** | 把任意车道的模型串成命名链，以 `combo:<name>` 作为虚拟模型；`fallback` 从链首开始，`round-robin` 轮换起点并连续 N 轮粘滞。链接在输出正文前失败会被整段丢弃，**切换对调用方不可见**。 |

### 模型按实际情况呈现

| 行为 | 说明 |
| --- | --- |
| **清单跟随上游** | 模型集合、上下文长度与能力每次刷新重新拉取，不保存静态快照。 |
| **选择器只广播可用的模型** | 上游已声明但网关明确拒绝路由的模型（`Model is unavailable` / 404）从下拉框移除，仅在设置页保留记录并注明拒因；网关故障（5xx）、配额限制（429）、超时与断网**不属于对模型的判定**，一律保持可达；被地区策略拦截的归入 `region-limited` 分组。整轮探测全部被拒时同样保留，**选择器不会为空**。 |
| **思考强度实际生效** | Light / Balanced / Deep 对应输出 token 预算 **2 048 / 8 192 / 模型上限**，逐次调用留痕；思考不可关闭的模型三档整体翻倍为 4 096 / 16 384 / 模型上限。通过**硬性输出上限**实现，不依赖上游 effort 参数（原因见 [设计说明](docs/设计说明.md)）。 |
| **按响应体形状判定流式响应** | 网关在高负载下会以 `application/json` 返回完整的 SSE 帧序列。插件按**响应体形状**判定，并把已嗅探的字节重新注入流 —— 既不会整轮失败，也不会因 header 与实际内容不符而把可用模型判为不可用。 |
| **不依赖浏览器界面** | 仅将 `llm` 作为硬依赖，在没有 web server 的 composition（如 `dsh-tui`）中同样完成启动并输出模型；看板模块挂载在独立 fiber 上，待 webServer 就绪后再注册路由。 |

### 省 Token 与本地转发

| 能力 | 说明 |
| --- | --- |
| **工具输出压缩（RTK）** | 在请求发出前就地重写 `tool_result`（git diff / status / log、grep、find、ls、tree、构建日志、编号转储、搜索清单、重复日志行）。实测 40 KB 的 `git diff` 移除 **90%** 的字节，模型仍能就它作答。 |
| **提示词瘦身** | `caveman` 与 `ponytail` 两族、多档位，**默认全关**；注入幂等且可撤销。 |
| **五个本地应答** | 不占用上游请求，各自独立开关。 |
| **OpenAI 兼容转发端口** | 本机其它工具通过 base URL 与 Key 即可调用这些模型；本地网关**原生说 Anthropic**（`POST /v1/messages` 流式与非流式、`count_tokens`），网关页按实际端口生成 Claude Code / Codex / OpenAI SDK / Anthropic SDK / curl 的可复制配方。 |
| **局域网转发中继** | 渠道网关本身只监听本机；本插件另开一扇门：调用方用插件签发的中继密钥，转发跳由宿主换用网关凭据（**凭据不出宿主进程**），仅放行 `/v1/*` 并带环路保护。 |

### 可靠性与界面

| 能力 | 说明 |
| --- | --- |
| **应用内升级** | 一键升级：下载 → SHA-256 校验 → 备份 → 原子替换 → 校验回读 → 热重载，**任一步失败自动回滚**至上一版本。 |
| **热重载** | 升级与代码变更即时生效、无需重启；也可手动触发或启用文件监视。 |
| **公告中心 + 实时推送** | 维护者推送后，所有已安装实例最迟一个轮询周期内收到；正文为**白名单约束下的 HTML**；`urgent` 触发全屏弹窗；可选系统级通知。 |
| **用量看板，数据全留本机** | Token 热力图、总量曲线（总计 / 单模型）、输出速度与首字延迟逐次采样；**不上传任何数据**。 |
| **九页毛玻璃界面** | 设置页九个页面（免费模型 / EAC 模型 / 白嫖模型接入 / 数据看板 / 运行日志 / 网关设置 / 聚合渠道 / 省 Token / 路由），页面切换与卡片入场 150–250 ms 短动效，`prefers-reduced-motion` 下整体关闭。每页都有直达仓库的 Star 按钮。 |
| **接口具备鉴权围栏** | 插件 HTTP 路由优先级高于内核 `/api`，因此内置与内核一致的信任检查（优先复用 connection 服务，缺失时退回结构化围栏）。 |


---

## 快速开始

**前置条件**：Node.js `^22.19.0 || >=24.0.0`（见 `package.json` 的 `engines`）。

```
dsh plugin --profile web add /绝对路径/dsh-our-free-model
```

装完**重启应用一次**，然后开一个新会话 —— 输入框的模型选择器里应出现 **Our Free Model** 分组。

> **桌面端（DSHEAC AIO / DeepSeek Harness 桌面端）先看** [使用指南](docs/使用指南.md)：那里有一条 profile 闸门，**不要用 `link:` 依赖安装，也不要创建 junction**，否则应用会拒绝启动并报 `PROFILE_UPGRADE_REQUIRED`。
>
> 安装失败（`ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`、`git ls-remote`、desktop profile 被独占等）的处置，以及模型选择 / 思考档位 / 本地转发 / 局域网 / EAC 渠道 / 公告接收的完整说明，都在 [使用指南](docs/使用指南.md)。

### 详细文档

| 想了解 | 看这里 |
| --- | --- |
| 安装全流程、桌面端闸门、自检、安装失败排查 | [docs/使用指南.md](docs/使用指南.md) |
| 模型选择、思考档位、本地转发、局域网、EAC、公告 | [docs/使用指南.md](docs/使用指南.md) |
| 已知边界（延迟、额度、信任边界） | [docs/常见问题.md](docs/常见问题.md) |
| 实现结构、设计取舍、聚合渠道 / 省 Token / 路由 / 本地网关 | [docs/设计说明.md](docs/设计说明.md) |
| 离线测试套件、发布签名、上游来源、安全与隐私 | [docs/开发与上游.md](docs/开发与上游.md) |
| 逐轮验收记录 | [docs/验收记录.md](docs/验收记录.md) |
| 免责声明、独立本地服务 | [docs/附录.md](docs/附录.md) |
## 许可证

MIT，见 LICENSE。

本项目为独立插件，与任何模型提供方无隶属、认可或赞助关系。使用该插件访问免费额度受各提供方
自身条款约束；在超出个人机器的场景中部署前，请先确认这些条款。


---

## Star 趋势

图表由 Star History 自动更新，无需手动提交图片。受服务缓存（当前为 24 小时）和 GitHub 图片缓存影响，显示可能延迟，并非秒级实时；点击图表可查看在线趋势。

<a href="https://www.star-history.com/?type=date&amp;repos=Ebony-Vinyl%2Fdsh-our-free-model">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Ebony-Vinyl/dsh-our-free-model&amp;type=Date&amp;theme=dark" />
    <img alt="dsh-our-free-model 的 GitHub Star 增长趋势" src="https://api.star-history.com/svg?repos=Ebony-Vinyl/dsh-our-free-model&amp;type=Date" />
  </picture>
</a>
