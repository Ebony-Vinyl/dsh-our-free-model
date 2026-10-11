# Our Free Model 独立服务部署指南

独立服务可以以三种形态运行：桌面安装版、命令行裸服务、服务器容器部署。
三种形态共用同一套服务代码与数据格式，本指南覆盖后两种的服务器化用法。

## 服务器模式是什么

设置环境变量 `OFM_SERVER_MODE=1` 后，服务从「本机工具」切换为「网络服务」：

| 行为 | 默认（桌面/本机） | 服务器模式 |
| --- | --- | --- |
| 监听地址 | 仅回环（127.0.0.1 / ::1 / localhost） | 任意地址（`--host 0.0.0.0`） |
| `/v1/*` 推理接口 | Bearer API Key | Bearer API Key（不变） |
| `/health` | 完整产品信息 | 仅 `{ok:true}`（不披露版本） |
| 管理页 | 仅本机同源 | 远程可访问（Origin 校验放宽到 http/https） |
| 本机取令牌终端 | 支持 | 禁用（改用登录链接或 API Key 登录） |

未开启 `OFM_SERVER_MODE` 时，`--host 0.0.0.0` 会被直接拒绝，
桌面形态的安全语义没有任何变化。

## 方式一：Docker（推荐）

```bash
docker build -t our-free-model .
docker run -d \
  --name our-free-model \
  -p 18900:18900 \
  -v ofm-data:/data \
  our-free-model
```

或使用 compose：

```bash
docker compose up -d
```

首次启动后查看日志取得一次性管理链接：

```bash
docker logs our-free-model
# Our Free Model 独立本地服务
# 管理页面（10 分钟内一次性登录）：http://127.0.0.1:18900/#login=<token>
```

从外部访问时把主机名换成服务器地址：`http://<服务器IP>:18900/#login=<token>`。
链接过期或已兑换后，可用数据目录里的 API Key 登录：

```bash
docker exec our-free-model cat /data/settings.json
```

- 数据（凭据、统计、密钥）都在 `ofm-data` 卷的 `/data` 下，升级镜像不丢数据。
- `OFM_PROBE=true` 可开启启动时的自动模型探测（会产生上游请求）。
- 生产建议：在容器前面放一层 HTTPS 反向代理（Caddy/Nginx/Traefik），
  只暴露 443，并把 `/health` 之外的路径置于你的认证之后——服务的密钥
  是唯一门票，越少人拿到越好。

## 方式二：裸 Node 进程

需要 Node.js ≥ 22.19：

```bash
OFM_SERVER_MODE=1 node packages/standalone/cli.mjs --host 0.0.0.0 --port 18900
```

数据目录默认 `~/.our-free-model`，可用 `OFM_HOME=/var/lib/ofm` 或
`--data-dir /var/lib/ofm` 指定。systemd 示例：

```ini
[Unit]
Description=Our Free Model standalone service
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/our-free-model/packages/standalone/cli.mjs --host 0.0.0.0 --port 18900
Environment=OFM_SERVER_MODE=1
Environment=OFM_HOME=/var/lib/our-free-model
Restart=on-failure
User=ofm

[Install]
WantedBy=multi-user.target
```

## 客户端接入

任何 OpenAI 兼容客户端：

```yaml
base_url: http://<服务器IP>:18900/v1
api_key: <你的 forwardKey>
```

Anthropic 兼容客户端：`http://<服务器IP>:18900` 同样提供 `/v1/messages`
与 `/v1/messages/count_tokens`。

## 安全须知

- API Key 是全部推理接口与管理接口的唯一凭证，泄露即等于把你的免费
  额度送出去；在设置页轮换密钥后旧 Key 立即失效。
- 免费车道来自上游公共网关，请遵守其服务条款；Kilo 免费池的提示词
  可能被上游记录，不要把敏感内容发往任何免费车道。
- 服务器模式不做用户隔离：所有持 Key 的调用方共享同一批渠道账号与
  积分。多用户场景请自行在上游加网关（如 one-api）分发子 Key。
