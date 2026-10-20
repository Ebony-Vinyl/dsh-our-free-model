# 2026-10-20 免费车道「全被拒还照拨」修复验证

分支 `fix/free-lane-refusal`，基线 `v2.5.6`（本机原运行的 2.5.3 落后三个发布：2.5.4 / 2.5.5 / 2.5.6）。

## 1. 现象

设置页 → Our Free Model → 免费模型：10 个免费模型里 9 个「暂不可用」、1 个「地区受限」，可用度 0%，鱼缸 0 水位。此时点任何模型发请求，仍然会照常向上游拨号，一轮 10 个模型全部拨完才返回失败。

## 2. 根因（数据面实测）

`~/.dsh/our-free-model/availability.json` 中 9 条 detail 全是上游原话：

```
OpenCode's free models aren't available from your current network because we've
detected abusive traffic from this IP address. This isn't related to your account.
If you're on a VPN or proxy, turn it ...
```

`beam-free` 是 `region-blocked`（`This model is not available in your country`）。出口 IP 与 `api.ipify.org` 实测一致（50.7.250.107，Bettbox/Meta Tunnel 虚拟网卡）。

也就是说：**探测早就拿到了确定的拒绝结论，但调用路径完全没用它**。`src/adapter.js` 的 `runStream` / `runCombo` 无条件向上游拨号，把「已知必失败」的模型挨个送一遍，用户看到的是 4 分钟 TTFT 然后失败（`stats.json`：10-19 `deepseek-ai/deepseek-v4.1-flash` 10 次调用 9 次失败，ttftMs 242082）。

附带两个小问题：
- `availability.json` 里 `space-bunny-free` 是 13 小时前的幽灵条目（已不在上游 `catalog.json` 的 entries 里），重新探测刷不到它，一直留着旧结论。
- `computeMembership` 的 `refusedAll → usable = catalog` 是 fail-open：全被拒也照常投放，界面上无法区分「能用」与「被拒但仍列出」。

## 3. 改动

新增 `src/verdict.js`（四类拒绝的唯一判定口）：

| 导出 | 作用 |
| --- | --- |
| `classifyDetail(detail)` | 上游原话 → `abusive-ip` / `region-blocked` / `throttled` / `model-gone` / `unknown` |
| `isFresh(verdict, now, interval)` | 结论有效期 = 2×探测间隔（缺省 15 分钟 → 30 分钟），`at<=0` 视为不新鲜 |
| `refusalFor(id, results, ctx)` | 新鲜且 `unavailable`/`region-blocked` → `{code:'LANE_REFUSED'|'REGION_BLOCKED', status, message}`；`throttled` 一律 `null`（它是暂时的，必须真拨） |
| `laneView(entries, results, ctx)` | 给 UI 的车道视图：`state`（ok/partial/refused）、`counts`、`reason`、`exitIp`、`refusedStreak`、`stale` |

`src/adapter.js`：`runStream` 在选模型之后、拨号之前判定，命中即 `recordTurn({attempts:0})` 并直接 `finish`；`runCombo` 先用 `refusalOf` 过滤出 `dialable`，全被拒则用第一条的 refusal 结束，一次都不拨。

`src/core/runtime.js`：
- `availability.refusedStreak`：一轮被拒是天气，两轮才是状态。`computeMembership` 在 `streak >= 2` 时不再投放被拒行（`settings.keepRefusedModels` 可强制保留）。region-blocked 行不受影响——它仍按 `exposeRegionModels` 留在 region 路由。
- `pruneAvailability()`：以 catalog 为准清掉幽灵结论，`refreshCatalogOnce` 后调用。
- `state()` 暴露 `availability` 快照，`laneView` 进 membership。

`index.js` / `src/store.js` / `src/failure.js`：`/summary` 增加 `lane` 字段；`keepRefusedModels` 进设置白名单与 `publicSettings`；`LANE_REFUSED → 503`、`REGION_BLOCKED → 403`。

`client.js`：免费页在「刷新/重探」下方新增红色诊断块（拒绝标题 + 上游原话 + 可操作提示 + 连续轮数 + 过期提示 + 「重新探测这个出口」「打开出口设置」两个按钮），设置页新增「被拒时保留模型列表」开关。

## 4. 验证（本轮实测）

| 项 | 结果 |
| --- | --- |
| `node scripts/verdict-test.mjs` | 28/28 —— 五种真实 detail 文本、有效期边界（29 分钟内 / 31 分钟外）、`refusalFor` 六种、`laneView` 六项、`computeMembership` 五项 |
| `node scripts/refusal-fast-fail-test.mjs` | 5/5 —— 单模型拒绝时 `attempts === 0`（用 `OUR_FREE_MODEL_BASE=http://127.0.0.1:9` 动态 import 保证离线）、全链拒绝、非首链被拒不连累、region→`REGION_BLOCKED`、throttled 仍拨 |
| `node scripts/test-all.mjs` | **72/76**，失败 4 个全是签名门禁（见第 5 节）；`picker` / `client-lint` 全绿（691 copy keys、181 style rules） |
| `OFM_PREVIEW_REFUSED=1 node scripts/ui-preview.mjs` | 31 张截图，无空白页/溢出；日志 `refused lane: fast-failed with LANE_REFUSED and no upstream dial (0 requests)`；`summary lane: state=refused counts={...abusiveIp:3...}` |
| `node scripts/ui-preview.mjs`（默认全部可用） | 31 张截图，`summary lane: state=ok`，交互回环（RTK 开关）正常 |

`scripts/ui-preview.mjs` 为此新增了两个可选的回归出口：`OFM_PREVIEW_REFUSED=1` 让 free lane stub 返回上游拒绝原文（否则 fixture 永远全可用，走不到诊断块），并在该模式下断言「必须 fast-fail 且 0 次上游拨号」「`/summary.lane.state === 'refused'`」。

## 5. 发布门禁（本地不通过是预期的）

`manifest` / `release` / `standalone-package` / `catalog` 四个套件要求 `feed/manifest.json` 与 `catalog/integrity.json` 用发布私钥重签：`build-manifest` 直接拒写（`refusing to write an unsigned manifest — pass --key <pem-path> or set OFM_MANIFEST_KEY`）。私钥只在 GitHub secrets（`.github/workflows/release-sign.yml`），本机没有，README 也明确换钥等于换信任根。

`build-manifest --check` 的漂移列表恰好只有本次改动的六个文件，没有意外漂移：

```
client.js: size 501326 in the manifest, 506434 on disk
index.js: size 114714 in the manifest, 115117 on disk
src/adapter.js: size 41255 in the manifest, 43298 on disk
src/core/runtime.js: size 16790 in the manifest, 21579 on disk
src/failure.js: size 2222 in the manifest, 2263 on disk
src/store.js: size 24277 in the manifest, 24622 on disk
not covered: src/verdict.js
```

合并后由 CI 的 `release-sign` 重签即可。

## 6. 部署与回滚

已把 `index.js`、`client.js`、`src/**`、`adapter/**`、`locale/**`、`vendor/channel-pack/**`、`package.json`、`README.md` 覆盖到
`C:\Users\26777\.dsh\profiles\desktop\node_modules\dsh-our-free-model\`（`package.json` 2.5.6）。

宿主当前进程里跑的还是 2.5.3 的模块实例，重启一次即生效；重启前插件页会显示一次版本不一致提示（`versionMismatch`，设计如此）。

回滚：`git checkout v2.5.3` 后重跑同一份覆盖命令，或直接删掉 profile 里的 `dsh-our-free-model` 让插件市场重装。
