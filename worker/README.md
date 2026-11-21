# EAC 网关（Cloudflare Worker）部署与轮换

Worker 是协付渠道的**唯一持密方**：插件里密封的只是本网关的地址和一个签名密钥，中继（relay）的真实 key 只存在 Worker 的环境变量里。插件被逆向得到的只是一个可以随时吊销的间接入口。

```
插件（签名请求，无密钥） → Worker（验签/白名单/限速，注入真 key） → 中继
```

## 签名契约（worker.js 实现并锁定）

```
x-ofm-timestamp: <unix 毫秒>
x-ofm-signature: hex(HMAC-SHA256(secret, "<ts>\n<METHOD>\n<path>\n<hex(sha256(body))>"))
```

- 时间戳偏离超过 `CLOCK_SKEW_SECONDS`（默认 600s）即拒绝（防重放）；
- 签名恒时比较，`SIGNING_SECRETS` 里任意一个匹配即放行（轮换期间新旧并存）；
- 仅放行 `GET /v1/models` 与 `POST /v1/chat/completions`，其余 404；
- `MODELS` 白名单之外的模型 403；请求体超过 `MAX_BODY_BYTES` 413；
- 可选 `RATE_LIMITER` 绑定按 IP 限速。

## 管理看板与限流（自建网关专属）

自建部署（方式零）的网关自带三层自防滥用，全部在 `.env` 配置：

- `CONCURRENCY_PER_IP=5` —— 单 IP 并发上限（只对对话转发计数，超限 429）。默认 5：一条 LLM 流会占住一个上游连接几十秒到几分钟，免费中继撑不住大户并发冲顶，20 的旧默认让单 IP 就能打满上游连接池、拖垮整机（连面板都登不进去的现场就是它）；
- `RATE_LIMIT_PER_MINUTE=60` / `RATE_LIMIT_PER_DAY=1000` —— 单 IP 频率与日额度；
- `POOL_PRESSURE_BUSY=30` / `POOL_PRESSURE_OVER=80` —— 全局进行中并发的负载判定阈值（0 关闭）：快照据此向插件设置页的号池面板报告「繁忙/过载」，事件循环平均延迟 ≥100ms/≥300ms 也会强制升级判定。按你服务器的实际承压调；
- `ADMIN_TOKEN=<随机串>` —— 管理看板令牌。设置后浏览器打开 `https://<网关域名>/eac/stats?t=<ADMIN_TOKEN>`：请求热力图（星期×小时）、72 小时请求曲线、按 IP 与按模型的 Token 消耗扇形图、每 IP 明细表（请求数、频率、Token、拒绝数、并发峰值）。看板 30 秒自动刷新，统计数据落盘 `stats.json`（重启不丢），IP 以盐值哈希存储、非可逆。

**SSE 预冲刷**（`SSE_PRELUDE_SECONDS=15`，0 关闭）默认开启：对话回合验签一通过就回 200 + `text/event-stream` 头 + `: keepalive` 注释帧，上游出 token 后再灌真实帧。这是给 Cloudflare（~100 秒源站超时，免费版不可调）和 nginx（默认 60 秒读超时）准备的——推理型模型首 token 经常要 30~140 秒，不预冲刷就会被中间层掐成 504/524 的 HTML 错误页。预冲刷之后才到的上游拒绝（如中继 5xx）以流内 `data: {"error":…}` 帧送达，插件按错误信封同款分类；网关日志与看板仍记录真实上游状态码。

New API 面板本身不按 IP 记账，这些视图由网关提供。Cloudflare 部署（方式一）无进程内状态，此三层仅自建形态可用。

## 授权闸门已移除

这里原本有一道 GitHub 授权闸门：登录并发 star 才发令牌，`POST /v1/chat/completions` 没令牌就 401。它连同 `auth-github.mjs` 一起删了。

原因是这道门没解决它想解决的问题。它把使用权和 star 绑在一起，公告里写的是「每 1 个 Star，号池 +1.5」，可号池本身只是拿 star 数乘出来的一个数字（见 `poolSnapshot`），不是真加出来的账号。门立着，数字涨着，能用的还是那几个排队的模型。

去掉之后：

- `POST /v1/chat/completions` 只看签名，不再要 `x-ofm-user`；
- `/auth/*` 路由、`REQUIRE_STAR_REPO`、`REQUIRE_USER_TOKEN`、`STAR_RECHECK_HOURS`、`USER_STORE_KEY`、`users.json` 全部不再需要；
- `/pool` 的容量只认 `POOL_SIZE`，没配就如实报 unavailable，不再拿 star 数乘 1.5 编一个；
- 按 IP 的限流、并发、看板统计原样保留。

想按人限流的，自己在网关外面套一层，比让所有人为了一个 star 去授权要干净。


## ⚠️ 只能单实例运行（cluster / instances>1 会直接坏）

网关是**单进程有状态**服务：签发的用户令牌索引、按 IP/按账号的限流与并发计数、
看板统计，全部活在进程内存里；用户表与待领取的登录链接落在 `users.json`
（0600，待领令牌同样加密落盘——重启不再吞掉一个已完成等待领取的登录）。
若以 **PM2 cluster 模式或多实例**（`instances: 2`）拉起，连接被轮询分发到多个
各自持有一份内存的进程，症状是：

- `/eac/auth/status` 的 `authorized` 在 true/false 之间来回跳——用户明明登录成功；
- 新登录的令牌时灵时不灵；限流与并发上限实际翻倍；看板数字对不上。

**正确姿势**（`pm2_configs/eac-gateway.config.js` 的出厂值即是）：
`exec_mode: "fork"`、`instances: "1"`，并且 **`watch: false`**——网关每 30 秒把
`stats.json` 写进自己的目录，开着 watch 等于让它不停重启自己。

单进程足够：一条 SSE 流只是几个空闲 socket，几千并发也在一个事件循环的能力内。
要提容量，调 `POOL_SIZE` / `RATE_LIMIT_*` / `CONCURRENCY_PER_IP`，不要加实例；
将来若真要多进程，必须先把用户表与限流状态挪进共享存储，而不是改 PM2 配置了事。

> 2026-10-06 实测教训（两次事故，同一类根因）：
>
> 1. 该项目曾被以 cluster×2 + watch:true 拉起，用户登录成功但状态在
>    「已授权/未授权」间跳变（两个进程的用户表各自独立，令牌只发到了其中一个）。
>    改回 fork×1 后立即恢复。
> 2. 同类配置在另一台守护进程里复活过一次：这台服务器上 **root 与 www 各有一个
>    PM2 守护进程**（各带开机自启 systemd 单元），宝塔面板按项目的运行用户
>    （www）管理其一，root shell 里的 `pm2` 命令操作的是另一个——两边各挂一份
>    应用就会抢 17788 端口，输家进入 EADDRINUSE 重启循环；watch:true 再叠加
>    `stats.json` 周期写入，变成不停重启的风暴。重启瞬间 nginx 报
>    `connection refused` / `prematurely closed`，Cloudflare 回 520，赶上登录
>    轮询就是「授权成功但应用一直未同步」。**处置：确认两个守护进程里谁持有
>    该应用，把另一个清空并 `pm2 save`；面板项目设置（watch/cluster）是会被
>    面板重新生成的源头，只改 `pm2_configs` 文件会在下次面板重启时被还原。**

## 部署

三种方式任选其一（Cloudflare 与自建二选一即可，核心验签逻辑是同一份 `worker.js`）。

**复用中继已有的域名？可以。** 两条路：

- **子域名（零代码改动）**：DNS 加一条 `eac.你的域名` → 同一台服务器，网关按下面步骤部署，客户端密封地址用 `https://eac.你的域名/v1`。
- **同域子路径（少一条 DNS）**：网关的 `.env`（或 Worker vars）里设 `MOUNT_PREFIX=/eac`，在**中继现有站点**的 Nginx 配置里加一段原样透传的反代（**不要**剥前缀）。**读超时必须显式加长**——nginx 默认 `proxy_read_timeout 60s`，而推理型模型首字节经常超过 60 秒，漏了就是一道 504 墙：
  ```nginx
  location /eac/ {
      proxy_pass http://127.0.0.1:17788;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_buffering off;
      proxy_cache off;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_connect_timeout 60s;
      proxy_send_timeout 600s;
      proxy_read_timeout 600s;
  }
  ```
  客户端密封地址用 `https://你的域名/eac/v1`（签名覆盖含前缀的完整路径，网关原样收到后自行剥前缀路由）。若网关与中继同机，`UPSTREAM_URL` 可直接写中继的回环地址（`http://127.0.0.1:<中继端口>`，网关允许回环 http）。

### 方式零：宝塔面板自建 Node 网关

前提：服务器装了宝塔面板（Linux 版），有一个能解析到这台服务器的域名（比如在 DNS 服务商给 `eac.你的域名` 加一条 A 记录指向服务器 IP）。

1. **装 Node**：宝塔 → 软件商店 → 搜索「Node.js版本管理器」→ 安装，再在其中安装 Node 20 或 22（LTS）。
2. **上传文件**：宝塔 → 文件 → 新建目录 `/www/eac-gateway/`，把本目录的 **两个文件** 上传进去：`worker.js`、`gateway-node.mjs`（必须同目录）。
3. **写配置**：在 `/www/eac-gateway/` 新建文件 `.env`，内容（三个真实值取自 `D:\our free model\eac-channel.private.json`：`base`→UPSTREAM_URL、`apiKey`→UPSTREAM_API_KEY、`signingSecret`→SIGNING_SECRETS）：
   ```ini
   UPSTREAM_URL=https://<中继地址>/v1（必须以 /v1 结尾——网关按它拼 /models 与 /chat/completions）
   UPSTREAM_API_KEY=粘贴私有 JSON 的 apiKey（不要把任何真实 key 写进本仓库的任何文件）
   SIGNING_SECRETS=这里粘贴 signingSecret（43 位左右的一串）
   MODELS=deepseek-ai/deepseek-v4.1-flash,moonshotai/kimi-k2.6,moonshotai/kimi-k3,openai/gpt-oss-20b,z-ai/glm-5.3,z-ai/glm-5.3-flash
   HOST=127.0.0.1
   PORT=17788
   RATE_LIMIT_PER_MINUTE=60
   ```
   把 `.env` 权限改成 600（右键 → 权限），不要让其它用户可读。
4. **建 Node 项目**：宝塔 → 网站 → Node 项目 → 添加 Node 项目：
   - 项目目录：`/www/eac-gateway`
   - 启动方式/运行脚本：`node gateway-node.mjs`（启动文件选 `gateway-node.mjs`）
   - 端口：`17788`
   - 运行用户随意（www 即可），提交并启动。日志里应出现 `eac gateway listening on 127.0.0.1:17788 → …`。
   - 旧版面板没有 Node 项目功能：用 PM2 管理器添加同目录 `gateway-node.mjs` 即可，效果一样。
5. **域名 + 证书**：宝塔 → 网站 → 添加站点（域名填第 0 步那个，PHP 版本选纯静态）→ 站点设置 → 反向代理 → 添加反向代理，目标 URL `http://127.0.0.1:17788`，发送域名 `$host`；再到 SSL → Let's Encrypt 申请证书 → 开启「强制 HTTPS」。
6. **安全**：确认宝塔安全组/防火墙**没有**放行 17788（网关只监听本机回环，外网只走 Nginx 的 443）。
7. **自检**：在你自己电脑上（本仓库目录）跑：
   ```
   node worker\verify-deployment.mjs https://eac.你的域名/v1 "D:\our free model\eac-channel.private.json"
   ```
   三行全 ok 即部署成功。服务器时间要准（签名有 ±10 分钟防重放窗口，宝塔机器一般 NTP 已同步；若 401 且本地同配置正常，先查服务器时间）。
8. **上线切换**：自检通过后，把 `https://eac.你的域名/v1` 填进私有 JSON 的 `workerBase` → 重跑 `node scripts/eac-vault-mint.mjs "D:\our free model\eac-channel.private.json"` → 走发布流程 → 最后在中继侧轮换旧 key。

### 方式一：Cloudflare 面板粘贴（无需服务器）

1. Cloudflare Dashboard → Workers & Pages → **Create** → Create Worker，名字随意（如 `ofm-eac-gateway`），Deploy 后 **Edit code**，把本目录 `worker.js` 全文粘进去，Deploy。
2. Worker → **Settings → Variables and Secrets**，添加：
   - Secret `UPSTREAM_URL` = 中继地址（形如 `https://<relay-host>/v1`，取私有凭据文件里的 `base`）
   - Secret `UPSTREAM_API_KEY` = 中继 key（`sk-…`，取 `D:\our free model\eac-channel.private.json` 的 `apiKey`）
   - Secret `SIGNING_SECRETS` = 签名密钥（取同一文件的 `signingSecret`）
   - Variable `MODELS` = 六个模型 id 的逗号列表（见 `wrangler.toml`）
3. （可选）Settings → Bindings → **Rate Limit** 绑定，名字必须叫 `RATE_LIMITER`（如 30 次/60 秒）。

### 方式二：wrangler

```bash
npm i -g wrangler && wrangler login
cd worker
npx wrangler secret put UPSTREAM_URL
npx wrangler secret put UPSTREAM_API_KEY
npx wrangler secret put SIGNING_SECRETS
npx wrangler deploy        # 如需限速，先取消 wrangler.toml 里 bindings 的注释
```

`wrangler tail` 可看实时日志（每请求一行：path/status/耗时，无 body、无 key、无签名）。

## 上线切换（把真 key 从插件里拿掉）

1. 部署完成后，把 Worker 地址（`https://<name>.<subdomain>.workers.dev/v1`，**必须以 `/v1` 结尾**）填进 `D:\our free model\eac-channel.private.json` 的 `workerBase`。
2. 重铸密封件：`node scripts/eac-vault-mint.mjs "D:\our free model\eac-channel.private.json"`（此时起 seal 只含 Worker 地址 + 签名密钥）。
3. 按发布 runbook 出版（版本号、公告、清单重签、双提交）。发布完成后在**中继侧轮换旧 key**——旧版插件自然失效，Worker 用新 key 不受影响。

## 轮换预案

- **签名密钥泄露**（表现：陌生来源的合法签名请求）：`SIGNING_SECRETS` 改为 `"新密钥"`（或 `"新密钥,旧密钥"` 保兼容）→ deploy → 出新版插件；确认旧流量归零后移除旧密钥再 deploy。整个过程秒级生效，中继 key 不用动。
- **中继 key 泄露**：在中继侧轮换 → 更新 Worker 的 `UPSTREAM_API_KEY` → deploy。客户端零改动。
- 两个都泄露：上面两条各做一遍，顺序不限。

## 本地验证

离线套件直接驱动本仓库的 `worker.js`（同一份代码，无逻辑漂移）：`node scripts/test-all.mjs --only vault`，覆盖验签通过/时间戳过期/坏签名/未知路径/白名单外模型/超限 body/流式转发全链路。

