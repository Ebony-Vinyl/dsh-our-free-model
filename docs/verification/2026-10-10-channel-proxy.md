# Issue #196：Gemini 与 Cline 渠道代理修复

## 基线与复现

基线为主线 `84ab66398c3b8b6aeb7595a8b7ce38a7a5bc9cbf`。问题是浏览器通过系统代理完成 Google 授权后，渠道包仍以 Node 全局 fetch 直连令牌端点；原来的插件出口只覆盖匿名渠道，未传给 GeminiAuth。

使用 `scripts/channel-network-test.mjs --pack .verify/issue196-before-pack.mjs --oauth-only` 加载基线发布包，在本机接收真实 OAuth 回调。请求替身要求换令牌请求携带 dispatcher，未携带时抛出 `UND_ERR_CONNECT_TIMEOUT`。基线结果为 `done: true, success: false, error: fetch failed`，与问题报告的失败路径一致。这是隔离复现，没有操作真实 Google 账号或模拟真实网络地理限制。

## 修复设计与范围

采用每次挂载独立的渠道出网封装，不修改全局 fetch 或全局 Dispatcher。路由优先级为插件正在运行的出口、环境代理、Windows 手动系统代理、直连；插件将出口能力显式传入渠道包，独立服务使用相同生成业务包的环境和系统代理能力。

Gemini 的登录、续期、userinfo、项目探测和推理全部注入同一封装；Cline 的登录、续期、模型目录及推理同样接入。其它渠道业务保持原实现，不宣称本次已统一全部十三条渠道的网络调用。

环境代理支持 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 及小写形式，遵守 NO_PROXY；Windows 读取 ProxyEnable、ProxyServer 和 ProxyOverride，支持按协议配置、通配符和 <local>，最多缓存 30 秒。回环请求不自动加代理，不执行 PAC。使用既有 HTTP(S)/SOCKS5 代理构造器，并以 undici 官方 Dispatcher1Wrapper 兼容 Node 22/24 内置 fetch 的 handler 契约。代理实例随挂载释放，不改动每账号代理缓存。

错误文案只显示路由类型和底层错误码，不拼接代理 URL、密码或 OAuth code。网络错误保留原 cause；TLS 的 CERT_HAS_EXPIRED 不再被 Gemini 的 expired 文案判据误认成 refresh_token 失效。不会在代理失败后自动直连。

## 实际验证

- `node scripts/channel-network-test.mjs`：6/6 项通过，包含系统代理解析、例外、代理优先级、参数传递、缓存、取消、错误码与脱敏、代理释放及真实本机 HTTP 代理转发。
- 同一专项测试分别加载实际插件包与独立服务生成业务包，真实监听本机 OAuth 回调、调用实际 RPC 和凭据服务；令牌、身份、续期、项目探测及 Gemini 推理请求替身均要求携带代理。Cline 设备码授权和续期也验证了代理注入。
- TLS 过期错误的回归检查确认凭据不被删除、不被误判为 refresh_token 过期。
- `node scripts/test-all.mjs --mode contributor`：34/34 套件通过。
- `node scripts/channel-pack-test.mjs`：通过，既有十三渠道、登录失败轮询、余额、图片预算和匿名模型请求检查保持通过。
- `npm run typecheck`、`npm run typecheck:standalone`：通过；这两个现有配置检查各自声明的范围，不代表整个 vendor TypeScript 源码已通过类型检查。
- `node scripts/build-channel-pack.mjs`、`node scripts/build-standalone-channels.mjs`：成功；`node scripts/build-standalone-channels.mjs --check`：通过。
- `node --check scripts/channel-network-test.mjs`、`node --check index.js`、`git diff --check`：通过。
- `node scripts/test-all.mjs --mode release`：0/3 套件通过；manifest、release、catalog 均因 `index.js` 与渠道包产物的大小或摘要与现有清单不符而失败。保留现有清单及签名，待维护者在发布前更新并重新签名。

## 未验证与发布边界

没有使用真实 Google 或 Cline 账号手工走完授权，未验证 Google 对 OAuth client 的其它限制。网络替身验证代理选择和授权状态机，本机 HTTP 代理验证实际 socket 转发；不等于已验证所有第三方代理软件、真实 Google HTTPS 端点或 PAC。回调未到达造成的授权超时不属于此修复已经解决的网络路径。

无应用 UI 变更。没有发布 release、改动信任公钥或生成签名；发布前维护者需更新清单、catalog revision 和签名。升级无需迁移数据，回退本次提交并重建渠道产物即可。
