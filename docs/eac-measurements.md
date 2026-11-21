# EAC 渠道实测记录

请求时间：2026-11-18 23:40–23:55（北京时间）
记录时间：2026-11-19

## 为什么写这个

公告里说「每 1 个 Star，号池 +1.5」。我拿自己的号（已登录并 star）去试了一圈，想看看这个 star 到底换来了什么。

## 怎么测的

本机直连网关 `https://ourfreemodel.beichenapi.com/eac/v1`，完成 GitHub 授权后，对每个模型发一次 `POST /v1/chat/completions`（`stream: true`，`max_tokens` 160–260），记录首字时间（第一个正文帧）和总时长。每个模型 n=1。

## 结果

| 模型 | 结果 | 说明 |
| --- | --- | --- |
| `deepseek-ai/deepseek-v4.1-flash` | 不可用 | 网关返回 `end of life on 2026-11-16T08:00:00Z` |
| `opencode/deepseek-v4.1-flash-free` | 不可用 | `model_concurrency`，原文「Paid accounts are admitted first」 |
| `amd/DeepSeek-V4.1-Flash` | 无输出 | HTTP 200，0 字 |
| `openai/gpt-oss-20b` | 无输出 | HTTP 200，0 字 |
| `stepfun-ai/step-5-preview` | 超时 | 300 秒，0 字 |
| `z-ai/glm-5.3-flash` | 可用 | 首字 213,053 ms，160 tok，75.1 tok/s |
| `minimaxai/minimax-m3.1-flash` | 可用 | 首字 173,221 ms，160 tok，12.4 tok/s |

## 号池是怎么来的

`worker/gateway-node.mjs` 里的 `poolSnapshot`：

```js
const stars = await loadStars()
if (Number.isFinite(stars)) { pool = Math.round(stars * 1.5); poolSource = 'formula' }
```

`/pool` 返回的容量等于仓库 star 数 × 1.5，除非用环境变量 `POOL_SIZE` 直接指定。也就是说这个数字来自 GitHub 的 star 计数，不是实际开通的账号数。

## 自己怎么复现

1. 在桌面端插件里完成 EAC 授权（设置页 → EAC 渠道授权）；
2. 打开设置页「运行日志」，每个请求都记着结果、耗时、首字、速度；
3. 或者按上面同样的请求自己打一次，看返回什么。

## 这不是法律意见

只记录我这一晚测到的东西。渠道状态随时会变，上面的数字只代表那个时间点。
