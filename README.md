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
  <img src="docs/images/qq-group-883073874.jpg" alt="ai技术交流群8 入群二维码（群号：883073874）" width="300">
  <br>
  <b>QQ 群：883073874（ai技术交流群8）</b>
  <br>
  扫码或搜索群号加入群聊，一起交流插件使用心得、反馈问题与分享玩法。
</div>

---

## 它是什么

这是一个纯挂载的 dsh 插件：不改内核，没有构建步骤，也没有运行时依赖。

模型来自 OpenCode 的免密网关、Kilo 的公共免费池、桌面端专属的 EAC 协付渠道、自备 Key 的聚合渠道（内置 76 家提供商），以及十个可以登录接入的账号渠道。

选择和调节都在 dsh 里完成：模型选择器按可用性分组，Effort 菜单下发真实的思考预算，设置页有模型清单、数据看板、本地转发、网关、公告和升级。用量、设置、账号凭据都只落在本机。

## 安装

```bash
dsh plugin --profile web add /绝对路径/dsh-our-free-model
```

装完重启一次应用，`--profile` 换成你实际在用的 profile 名。

> **⚠️ 不要通过 npm 安装本插件。**
>
> npm 上的 `dsh-our-free-model` 包**不是本仓库发布的**。它由第三方打包，内容与本仓库
> 不一致：`index.js`、`client.js` 被改动，并额外包含本仓库从未有过的
> `src/channel-visibility.js`。装到它得不到本项目审核过的构建，也拿不到本仓库的签名
> 清单校验与应用内升级。
>
> 请只按本文档下方的方式安装：使用本仓库的 Release 发布包，或本地源码目录。
> 其它渠道出现的同名包一律以本仓库为准。

桌面端还有一条限制：Electron 的 `desktop` profile 只允许桌面应用自己管理，请在设置 → 插件里安装或升级；命令行只适用于纯 web profile。

<details>
<summary>桌面整合包的 profile 闸门与手工 tarball 安装</summary>

部分 DSHEAC AIO / 旧版桌面整合包在启动 web 服务前会检查 profile，禁止符号链接和目录 junction，遇到时可能报：

```
PROFILE_UPGRADE_REQUIRED: offline dependency migration is not yet available
```

这种宿主请用应用内插件管理器，或者按下面的方式用本地 tarball 安装：

1. 在 `<DSH_HOME>/profiles/<profile>/vendor/` 放下用可信源码打出的包：
   `npm pack --ignore-scripts --pack-destination "<DSH_HOME>/profiles/<profile>/vendor"`（也可以直接用 Release 里的同版本 tarball）。
2. 在 profile 的 `package.json` 里加入 `"dsh-our-free-model": "file:./vendor/dsh-our-free-model-2.5.9.tgz"`，再走宿主自己的依赖安装流程。
3. 在 `dsh.profile.bundles` 末尾追加 `"dsh-our-free-model"`。

如果包管理器接管了这份安装，把 bundle config 或插件 `settings.json` 的 `distribution` 设为 `managed`。此时应用内升级、公告 feed 与热重载会停用，模型功能不受影响；两个写入方同时改同一个目录会把安装弄坏。

手工复制时务必复制完整包，包括 `adapter/`、`src/`、`locale/`、`vendor/channel-pack/` 下的 `pack.js`、WASM、LICENSE 与 NOTICE。只复制入口脚本会导致渠道加载失败。

不要再往 `cordis.patch.yml` 里加条目。被 `dsh.profile.bundles` 引用的包，其 patch 层会自动生效，重复注册会报 `duplicate loader entry id: our-free-model`。

</details>

<details>
<summary>常见安装报错</summary>

**`ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`**
这是 profile 里旧的 pnpm 状态造成的，跟插件无关。关掉 dsh，删掉该 profile 的 `node_modules` 和 `pnpm-lock.yaml` 让它重建，再重新安装。

**插件市场自动安装时 `git ls-remote "git+ssh://git@github.com/..."` 失败**
pnpm 解析 git 源时会调用本机 git。如果 git 配置过 `insteadOf` 重写（常见的是把 https 改成 ssh），或者本机没有可用的 SSH key，就会在下载插件之前失败。可以修正 git 配置，确认 `git ls-remote https://github.com/Ebony-Vinyl/dsh-our-free-model.git` 能跑通；或者改用 Release 包，解压后 `dsh plugin add <目录>`。

**`profile "desktop" is managed exclusively by the Electron application`**
宿主的保护机制。桌面端只能在应用内管理插件，命令行安装只适用于纯 web profile。

</details>

## macOS 桌面安装包（社区构建）

桌面安装包官方只发 Windows 版。macOS 版是社区构建，改动见 [PR #421](https://github.com/Ebony-Vinyl/dsh-our-free-model/pull/421)，也可以自己编：`npm --prefix packages/desktop run build`，流水线在 `.github/workflows/build-macos.yml`。目前只有 Apple Silicon 包。

社区构建没有 Apple 签名和公证，首次打开会被 Gatekeeper 拦下，提示“已损坏”并不是文件真的坏了：

```bash
# 先试右键 → 打开；不行再清隔离属性
xattr -cr "/Applications/Our Free Model.app"
# 较新的 macOS 可能需要
sudo xattr -rd com.apple.quarantine "/Applications/Our Free Model.app"
```

## 使用

**选模型**：输入框的模型选择器里选 `Our Free Model` 分组。被上游按地区拦下的模型会单独放在 `region-limited` 分组，仍然可见；被判定为“已声明但不路由”的模型不会出现在选择器里，只在设置页保留记录和拒因。

**调思考强度**：同一个菜单的 Effort。上游声明了档位的模型（DeepSeek V4.1 Flash、GLM 5.3 Flash 等）会给出它自己的档位，选中值原样下发；其余模型用 Light / Balanced / Deep 三档，对应 2K / 8K / 模型上限的输出预算。思考不可关闭的模型三档整体上移。设置页的模型卡上标了每档实际下发的数值。

**给本机其它工具用**：设置 → Our Free Model → 本地转发，打开后复制 base URL 并生成 Key。支持：

- `GET /v1/models`
- `POST /v1/chat/completions`（流式与非流式）
- `POST /v1/responses`
- `POST /v1/messages`（Anthropic Messages，流式与非流式）
- `POST /v1/messages/count_tokens`（本地估算，插件里没有 tokenizer）

端口被占用时不会静默失效：先重试几轮，仍然占用就顺延到下一个可用端口，并把实际端口写回设置。Windows 上最常见的占用原因是 `netsh interface portproxy` 规则，`netsh interface portproxy show all` 可以查看。

**局域网访问**：同一面板下方，默认关闭。开启后中继绑定一个可路由地址，使用独立的局域网 Key（跟本机 Key 不通用），只转发上面五条 `/v1/*` 路径。任何能访问这台机器的人都能用它消耗本机的免费额度，请只在可信网络里开。

**公告与升级**：公告由仓库推送，默认 30 分钟轮询一次，`urgent` 会弹全屏。升级在设置页一键完成：下载、校验、备份、替换、热重载，失败自动回滚。

设置页里的页面：模型清单、EAC 授权、公告、数据看板、本地转发、网关、聚合渠道、省 Token、路由、升级、推荐项目。

## 独立本地服务

不想装 dsh 的话，`packages/standalone` 是一个独立的本地服务，默认用 `~/.our-free-model` 和 18900 端口，自带 API Key 与网页管理，支持同样的免费车道、EAC 和账号渠道。

```bash
npm run start:standalone
```

启动后打开终端打印的一次性管理链接即可。参数与验证见 [packages/standalone/README.md](packages/standalone/README.md)。安装制品和 Release 还没发布。

## 功能

- **聚合渠道**：把第三方端点接进同一条模型清单。内置 76 家提供商（`src/providers/registry.json`），写入 Key 后模型以 `provider/model` 出现。Key 只写进本机 0600 的 `settings.json`，接口只回显 `hasKey` 和 `…abcd`。测试按钮只做列表探测，不花生成额度。
- **省 Token**：工具输出压缩（git diff/log、grep、find、ls、tree、构建日志等）在请求发出前重写 `tool_result`，报错内容和小于阈值的内容不碰；另有 caveman / ponytail 两族提示词档位（默认关闭）和五个本地应答。
- **路由**：把不同车道的模型串成 `combo:<name>`，支持固定从链首开始的 `fallback` 和轮换起点的 `round-robin`。在任何正文输出之前失败的链接会被整段丢弃，调用方看不到切换。
- **本地网关**：除了 Chat Completions 和 Responses，还提供原生 Anthropic Messages 接口（含 thinking、tool_use、真实的 stop_reason 和流内 error 事件），网关页会按实际端口生成 Claude Code、Codex、SDK 和 curl 的接入配方。
- **十个账号渠道**：LobsterAI、Qoder 与 Qoder 中国版、TRAE、Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini，登录后可用，凭据只进宿主凭据库。具体登录方式与限制见设置页。
- **用量看板**：Token 热力图、总量曲线、输出速度、首字延迟，数据全部在本机。
- **公告中心与热重载**：公告支持白名单 HTML、未读标记、系统通知；升级和代码变更可以热重载，不必重启。

## 代码结构

```
index.js                 Host 半身：适配器注册、探测、存储、路由、转发、升级
adapter/kernel.js        唯一允许 import @deepseek-ai/* 的地方
src/adapter.js           结构化 LlmAdapter
src/upstream.js          上游凭据、会话 id、按线协议选端点
src/stream.js            chat / messages / responses 三种协议归一
src/forward.js           本机 OpenAI 兼容监听 + Anthropic Messages
src/aggregate.js         聚合渠道：清单、Key 脱敏、列表探测
src/token-saver/         工具输出压缩与提示词注入
src/combos.js            降级链
src/updater.js           应用内升级：签名、哈希、备份、回滚
client.js                浏览器半身，手写的 ModuleLoader bundle
```

几个实现上的选择：

- **一个适配器，两条 provider 路由。** 选择器按 provider 分组，而清单格式里没有分组字段，所以 `region-limited` 只能再注册一条路由；地区限制解除后，空分组会被客户端丢掉，两组合并。
- **结构化实现适配器，不 import `@deepseek-ai/dsh-llm`。** 内核不做 `instanceof` 检查，鸭子类型就够了，同一份代码能同时跑在 0.1.5 和 0.1.7 上。
- **按响应体形状判断流，不看 Content-Type。** 上游高负载时会用 `200 + application/json` 返回完整的 SSE 帧，按 header 判断会把整轮读成字符串再解析失败，还会把可用模型误判为不可路由。现在先嗅探首块，再把已读字节注回流里。
- **Token 压缩只在一个收口上，且失败开放。** 压缩器出错就跳过，过滤器出错就放行，认不出的形状不动。请求不能因为一个本来为了让调用更便宜的功能而失败。
- **长思考被截断时只补一次。** 触发条件是首段只有思考、没有正文也没有工具调用；补写时禁用工具调用，最多 800 词，失败就返回 `STREAM_CUT`。细节和实测记录在 [docs/issue-12-recovery.md](docs/issue-12-recovery.md)。

## 已知边界

- “不限量”指没有额度体系，不是没有限流。这条车道按 session 统计速率，短时间打满会返回 429，下一轮探测会自动恢复。
- 部分模型上游本身很慢，`nemotron-3.5-lightning-free` 实测首字延迟超过 30 秒。看板会如实显示。
- 输出速度有时显示 `—`：答案集中在一两个大帧里落地，或者思考过程根本不流式返回，就没有可测量的时间窗。看板宁可留空，也不把思考耗时算成输出速度。
- 思考是静默等待且与正文共享输出预算。`mimo-v2.6-flash-free` 实测静默 60–70 秒，期间计费 3024 个 reasoning token 但不发帧。心跳只能维持连接，不能解决超时；遇到这种情况请提高单次输出上限，或换用标注 `reasoning: false` 的模型。
- 自动恢复有次数、时间和上下文上限，它基于检查点重新发起请求，不保证成功，也不能保留上游没发出的内部状态。
- 能力标注只写探测能证明的部分，拿不到证据的不写。
- 源码是明文的 JavaScript。作为本地插件只能如此，能读到这个目录的人就能读到网关逻辑，混淆解决不了这个问题。
- 应用内升级的信任根是插件里 pin 的 Ed25519 公钥。带签名的清单才能装，镜像被投毒只会升级失败；持有发布私钥的人等同于能推仓库的人。

## 开发

要求 Node `^22.19.0 || >=24.0.0`，无安装步骤、无依赖。

```bash
npm test                             # 全部离线套件 + 清单一致性
node scripts/client-lint.mjs         # 浏览器半身：文案键、样式键、bundle 可执行
node scripts/offline-test.mjs        # 离线端到端
node scripts/host-selftest.mjs       # 真实出网，会消耗免费额度
node scripts/build-manifest.mjs      # 重新生成发布清单（需要发布私钥签名）
npm run typecheck                    # 严格检查 adapter/ 接缝，需要 typescript
```

发布清单必须用发布私钥签名（`--key` 或 `OFM_MANIFEST_KEY`），未签名的清单会被构建器拒绝。私钥不进仓库、不进任何分发物。

各版本的验证记录在 [docs/releases/](docs/releases/) 和 [docs/verification/](docs/verification/)。`scripts/probes/` 下的脚本是当初的取证记录，会直连上游，不属于测试套件。

## EAC 渠道（桌面端专属）

桌面端会多出一条协付渠道，模型名带 `EAC` 前缀。它只在宿主识别通过后出现：DSHEAC AIO（Tauri 壳）要求内核路径、内嵌 node、web-desktop profile 三个信号同时命中；DeepSeek Harness 桌面端和 DSH Tauri 认内核给出的 `desktop` / `tauri` profile。命令行参数不算数。

渠道凭据以 AES-256-GCM 密文存放，解密密钥由分散在两个文件里的三片掩码在解锁时派生，明文只在构造请求的那一帧存在，不落盘、不进日志。此外还需要 GitHub 授权：登录并 star 本仓库后，网关才签发对话令牌，默认每 12 小时复查一次 star。

`worker/` 里是一个可选的 Cloudflare Worker 网关，签名密钥泄露时在网关侧轮换即可全体吊销。部署见 [worker/README.md](worker/README.md)。

## 上游是哪些源

全部直连，没有号池，没有中转：

| 用途 | 目标 | 凭据 |
| --- | --- | --- |
| 免费车道推理与清单 | `https://opencode.ai/inference/v1/*` | `Bearer public`，这条车道本身就是公开免密额度 |
| Kilo 免费池 | `https://api.kilo.ai/api/gateway/*` | 无需账号、Key 或登录态 |
| 公告与升级清单 | 本仓库 `feed/*.json`，raw.githubusercontent.com 优先，jsDelivr 兜底 | 无 |
| 出口地区判定 | api.ipify.org / ipinfo.io / ipapi.co，只读取公网 IP 与国家码 | 无 |

你的 prompt、工具结果和图像会作为正常推理请求发给所选模型的上游。除此之外插件不上传任何东西：用量、设置、Key 都只在 `DSH_HOME/our-free-model/`。

免密不等于没人管：免费车道通过 `x-opencode-*` 指纹识别客户端、按会话限额，会因地区返回 403、因超量返回 429。Kilo 免费池的模型卡写明 prompt 可能被上游记录并用于改进服务，不要发送敏感内容。

## 免责声明

- 本插件是客户端，不是模型服务方。响应由上游生成，插件不托管、不改写、不过滤。
- 免费额度由上游单方面提供，随时可能限流、收费或下线。不要用它发送密码、密钥、身份信息或商业机密；敏感场景请用自己的付费 API。
- 使用各渠道即表示你同意对应上游的条款，违规导致的限流或封禁由使用者承担。
- EAC 渠道是协付性质，凭据和网关由维护者部署，仅限授权用户，请勿转售或共享。
- 本项目与任何模型提供方没有隶属或背书关系，厂名与商标归各自所有者。

## 安全与隐私

设置、用量、聚合渠道的 Key 都写在 `DSH_HOME/our-free-model/` 下的 0600 文件里。插件接口只回显 `hasKey` 和 `…abcd` 指纹。

转发监听只绑回环，改成可路由地址会被 `POST /settings` 直接拒绝。局域网访问是单独开的门：中继绑可路由地址，每个请求都要局域网 Key，连 `/health` 也不例外，并且只放行前面列出的五条 `/v1/*` 路径。

插件路由带请求信任围栏。挂载了 connection 服务的 composition（dsh web、桌面端）与内核 `/api` 同级，需要应用自己的 cookie 或 token；没有 connection 服务的极简 composition 退回 loopback + 同源检查，这种情况下本机其它进程可以拿到转发 Key，请按这个信任级别使用。

公告 HTML 在客户端按白名单渲染，`scripts/sanitize-test.mjs` 用 XSS 语料验证过。升级链路是 Ed25519 签名 → 清单校验 → 逐文件 SHA-256 → staging 回读 → 安装后回读，任一步失败都恢复备份。`feedUrl` 只能改公告源，不能改升级源。

卸载只需要移除 bundle 条目，插件不留补丁；数据目录是纯 JSON，删掉即可。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## Star 趋势

<a href="https://www.star-history.com/?type=date&amp;repos=Ebony-Vinyl%2Fdsh-our-free-model">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Ebony-Vinyl/dsh-our-free-model&amp;type=Date&amp;theme=dark" />
    <img alt="dsh-our-free-model 的 GitHub Star 增长趋势" src="https://api.star-history.com/svg?repos=Ebony-Vinyl/dsh-our-free-model&amp;type=Date" />
  </picture>
</a>
