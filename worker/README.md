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

- `CONCURRENCY_PER_IP=20` —— 单 IP 并发上限（只对对话转发计数，超限 429）；
- `RATE_LIMIT_PER_MINUTE=60` / `RATE_LIMIT_PER_DAY=1000` —— 单 IP 频率与日额度；
- `ADMIN_TOKEN=<随机串>` —— 管理看板令牌。设置后浏览器打开 `https://<网关域名>/eac/stats?t=<ADMIN_TOKEN>`：请求热力图（星期×小时）、72 小时请求曲线、按 IP 与按模型的 Token 消耗扇形图、每 IP 明细表（请求数、频率、Token、拒绝数、并发峰值）。看板 30 秒自动刷新，统计数据落盘 `stats.json`（重启不丢），IP 以盐值哈希存储、非可逆。

**SSE 预冲刷**（`SSE_PRELUDE_SECONDS=15`，0 关闭）默认开启：对话回合验签一通过就回 200 + `text/event-stream` 头 + `: keepalive` 注释帧，上游出 token 后再灌真实帧。这是给 Cloudflare（~100 秒源站超时，免费版不可调）和 nginx（默认 60 秒读超时）准备的——推理型模型首 token 经常要 30~140 秒，不预冲刷就会被中间层掐成 504/524 的 HTML 错误页。预冲刷之后才到的上游拒绝（如中继 5xx）以流内 `data: {"error":…}` 帧送达，插件按错误信封同款分类；网关日志与看板仍记录真实上游状态码。

New API 面板本身不按 IP 记账，这些视图由网关提供。Cloudflare 部署（方式一）无进程内状态，此三层仅自建形态可用。

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
2. **上传文件**：宝塔 → 文件 → 新建目录 `/www/eac-gateway/`，把本目录的 **两个文件** 上传进去：`worker.js` 和 `gateway-node.mjs`（必须同目录）。
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
