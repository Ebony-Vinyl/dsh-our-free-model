# Our Free Model 独立本地服务 — 中文使用指南

本指南面向 `packages/standalone` 独立服务：**不需要安装 DSH**。服务启动后提供 OpenAI 兼容接口和本机网页管理台。

> 详细参数与实现说明见 [独立服务完整说明](../packages/standalone/README.md)。本指南只覆盖从零到可用的最短路径。

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | `^22.19.0` 或 `>=24.0.0`；用 `node -v` 检查。低于 22.19 会启动失败 |
| npm | Node 自带即可（验证过 npm 10） |
| 系统 | Windows / macOS / Linux |
| 端口 | 默认本机 `18900`（管理 + 推理）；可选 LAN 中继 `18901`；插件转发默认 `18899`，独立服务不占用 |
| 磁盘 | 数据目录默认 `~/.our-free-model`，建议预留 1 GB 以上 |
| 网络 | 匿名免费渠道需要能访问上游；Gemini / Cline 等账号渠道读取 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` |

源码必须来自完整仓库：单独复制 `packages/standalone` 目录无法运行（它依赖 `src/`、`vendor/`、`catalog/` 等）。

```bash
git clone https://github.com/xuanyangzhenren/dsh-our-free-model.git
cd dsh-our-free-model
node -v
```

## 2. 配置方法

配置分四层，优先级从高到低：

1. **CLI 参数**：`--port`、`--data-dir`、`--lan`、`--no-lan`、`--lan-port`、`--no-refresh`、`--probe`
2. **环境变量**：`OFM_HOME`、代理变量（见 `packages/standalone/.env.example`）
3. **数据目录 `settings.json`**：端口、API Key、LAN 开关、模型与渠道设置（首次启动自动生成）
4. **网页管理台**：大部分日常设置在此修改并持久化

### 2.1 零配置启动

不做任何配置即可运行：数据目录 `~/.our-free-model`，端口 `18900`，LAN 关闭。

### 2.2 用 .env 文件配置（可选）

```bash
cp packages/standalone/.env.example packages/standalone/.env
# 编辑 .env：设置 OFM_HOME / 代理；不用的项保持注释
npm --prefix packages/standalone run start:env
```

Node **不会自动加载 `.env`**；必须走 `start:env` 脚本（内部使用 `node --env-file=.env`）。`.env` 已在 `.gitignore` 中忽略，不要提交。

### 2.3 用命令行参数配置

```bash
npm run start:standalone -- --port 18900 --data-dir F:/ofm-data
```

`OFM_HOME` 与 `--data-dir` 作用相同，后者优先。**不要**把独立服务的 `OFM_HOME` 指向插件目录 `~/.dsh/our-free-model`。

`--probe` 已停用（保留兼容），自动探测不会发请求；页面手动探测仍可用。

## 3. 启动步骤

```bash
# 仓库根目录
npm run start:standalone
```

终端会打印：

- 一次性管理链接（10 分钟内有效，只能兑换一次）
- 实际 API 地址（端口被占用时可能不是 18900）
- API Key 文件位置（不直接打印密钥）

浏览器打开管理链接 → 进入管理台。若链接过期或已使用，读取 `settings.json` 的 `forwardKey` 作为密钥登录。

健康检查：`curl http://127.0.0.1:18900/health`（不含凭据）。

停止服务：在终端按 `Ctrl+C`；正常退出会释放端口并清除 `service.lock`。

## 4. 基本使用流程

1. **确认模型**：管理台 →「模型清单」→ 刷新；可搜索、筛选、单模型测试。
2. **配置账号渠道**（可选）：「免费账号渠道」→ 对应供应商登录；也可导入插件账号备份（备份含明文凭据）。EAC 渠道在「EAC 协付渠道」自行授权。
3. **复制接入信息**：「API 接入」→ 查看 base URL 与 API Key（首次需主动点击显示）。
4. **在客户端接入**：选择 OpenAI 兼容协议，Base URL 填 `http://127.0.0.1:18900/v1`，API Key 填 `forwardKey`。

```bash
curl http://127.0.0.1:18900/v1/chat/completions \
  -H "Authorization: Bearer <你的 API Key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<模型清单中的 ID>","messages":[{"role":"user","content":"你好"}]}'
```

也支持 `GET /v1/models`、`POST /v1/responses`（含流式）。

5. **局域网使用（可选）**：默认关闭。开启后使用**独立的 LAN Key**，与本机 API Key 不同：

```bash
npm run start:standalone -- --lan --lan-port 18901
```

LAN Key 在管理接口 `GET /api/management/lan/key` 查看，需要时调用 `/api/management/lan/key/rotate` 轮换。管理页仍只监听回环地址，不能从 LAN 打开。

## 5. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `node: bad option: --env-file` | Node 版本过低；升级到 22.19+ 或 24+，改用 `npm run start:standalone` |
| 启动报 `engines` 不满足 | 同上；`.nvmrc` 可执行 `nvm use` 切到 Node 22 |
| `EADDRINUSE` / 端口不是 18900 | 端口被占用；用 `--port <其他端口>`，以终端打印的实际地址为准 |
| `EEXIST`：数据目录已有服务或锁归属无法确认 | 确认旧进程已停止，再删除数据目录中的 `service.lock`；Windows/Linux 会自动回收已确认退出的陈旧锁 |
| 管理链接打不开 / 提示已使用 | 链接 10 分钟且一次性；用 `settings.json` 的 `forwardKey` 登录 |
| 推理返回 401 | 推理接口只接受 `Authorization: Bearer <API Key>`；管理 Cookie 不能用于推理；轮换密钥后旧 Key 立即失效 |
| 模型列表为空 / 上游不可达 | 首次启动异步刷新，稍候；上游不可达时保留缓存；`--no-refresh` 会跳过启动刷新但可手动刷新 |
| Gemini / Cline 登录成功但后台报错 | 后台连接需代理；设置 `HTTPS_PROXY` 等环境变量，Windows 无环境代理时读取用户手动系统代理；PAC 不支持 |
| 页面显示 `networkMode: fixture` | 正在使用本机替身测试进程；不能登录真实账号，需按正式命令重启 |
| LAN 客户端连不上 | 确认 `--lan` 已保存、`running:true`、端口未被占用；使用 LAN Key 而非本机 Key；防火墙放行 |
| 想从局域网打开管理页 | 不支持；管理接口与页面强制回环，无 `--host` / `OFM_ALLOW_NON_LOOPBACK` 选项 |
| 账号/配置串到插件 | 独立服务不读取 `DSH_HOME`；确认 `OFM_HOME` 与插件目录不同 |

## 6. 验证

```bash
npm run test:standalone
npm run test:management
npm run test:standalone-channels
npm run test:contributor
```

专项测试使用本机替身，不访问真实上游；测试账号与额度不可当真实数据使用。

## 7. 安全提示

- `settings.json` 含 `forwardKey` 与 `standaloneLanKey`；`channel-credentials.json`、`eac-user.json` 含凭据，勿外传。
- 备份账号会包含明文凭据，妥善保存。
- 不要提交 `.env`；LAN 仅对可信客户端开放，必要时用防火墙限制来源。
- Kilo 免费池的提示词可能被上游记录，勿发送敏感内容。
