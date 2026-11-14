# OFM 反馈服务

插件内「反馈与许愿」的接收端。零依赖 Node，一个 JSON 文件存数据。

## 为什么独立部署

反馈与推理网关没有任何共享状态：网关崩了反馈照收，反馈服务发版也不该重启
网关。所以它是独立进程、独立端口，由反向代理挂在同一个域名下的 `/feedback/*`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，`configured` 表示 GitHub 登录是否可用 |
| POST | `/api/auth/start` | 发起 GitHub device flow，返回 `userCode` 与验证地址 |
| POST | `/api/auth/poll` | 轮询授权结果；成功后发放本服务令牌（一次性） |
| POST | `/api/feedback` | 提交反馈，需要 `Authorization: Bearer <令牌>` |

## 部署

```bash
GITHUB_CLIENT_ID=<oauth app client id> \
FEEDBACK_DATA_DIR=/var/lib/ofm-feedback \
PORT=4319 node server.mjs
```

`GITHUB_CLIENT_ID` 对应的 OAuth App 必须在 GitHub 后台勾选
**Enable Device Flow**，否则 `start` 会返回 `device_flow_disabled`。
本服务不需要 `GITHUB_CLIENT_SECRET` —— device flow 的公共客户端模式不校验它。

数据按 UTC 日期分目录：`$FEEDBACK_DATA_DIR/2026-11-14/<id>.json`。
备份就是 `cp -r`。文件权限 0600，目录 0700。

## 隐私

落盘内容只有：GitHub 数字 id、login、反馈类型、标题、正文、客户端版本与平台。
**不存任何令牌** —— GitHub 的 access token 用完即弃，本服务令牌只存在内存里，
服务重启后全部失效（用户重新登录即可）。
