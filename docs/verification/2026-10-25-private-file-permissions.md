# 私有文件 Windows 权限验证

## 实现

Node 在 Windows 上忽略 `mode` 的权限位，README 承诺的 0600 落盘即失效。新增 `src/private-file.js`：Windows 上以 `icacls /inheritance:r /grant:r` 去除继承 ACE、仅保留当前用户（账户名取 `process.env.USERNAME`，经 UTF-16 API 读取，避免 `whoami` 的 OEM 代码页把非 ASCII 机器名解码成乱码）；其他平台保持 chmod。icacls 失败即抛错、放弃写入——达不到承诺的文件不落盘。

接入点为全部手写源码中带 0600/0600 语义承诺的凭据与私有数据写入：`src/eac-user.js`、`src/egress.js`、`src/picks.js`、`src/store.js`（含损坏备份）、`src/updater.js`、`src/magpie-engine.js`（两处）、`packages/standalone/channels/credentials.mjs`、`packages/standalone/workbench.mjs`（privateWrite）、`packages/standalone/client-terminal.mjs`（privateFile）；`src/subscriptions.js` 的本地实现改为复用共享模块并顺带修复 whoami 编码缺陷。`mode: 0o600` 全部保留；workbench 的 `chmodSync` 保留为测试注入缝隙。

独立服务打包清单（`scripts/pack-standalone.mjs`）登记 `private-file`；新增 `private-file` 回归套件接入统一 runner，断言 icacls 实际 ACL（ASCII ACE 标记跨区域设置稳定）与 POSIX 权限位，并端到端验证 JsonStore 与 eac-user 的写入回读。

## 已执行

- `node scripts/test-all.mjs --mode contributor --only private-file`：4/4 通过（Windows 本机，真实 icacls ACL 断言）。
- `subscriptions` 套件：38/38 通过。此前本机仅 1/38，全部报 `Cannot read private subscription storage`；根因即 whoami OEM 编码，随本次共享模块修复一同治愈。
- `updater`、`picks`、`magpie-engine`、`chan-relay`、`forward`、`workbench`、`workbench-library`、`workbench-management`、`client-terminal`、`standalone-package`、`gemini-gateway` 套件：通过。
- `node scripts/standalone-channels-test.mjs`：14/14 通过（credentials 仓库直测）。
- `npm run test:contributor`：94/94 套件通过（期间一次 `forward` 偶发失败，单跑与复跑均通过，判定为并发抖动，与本次改动无关）。
- `node --check` 全部改动源文件、`git diff --check`：通过。

## 边界

- 覆盖范围为手写源码中的文件级 0600 写入；`service.mjs` 的 lock 文件与 `error.json`（均无敏感内容）、各处 0700 目录 mkdir 未接入，目录级限制仍只存在于 subscriptions 自身目录。
- 未在 POSIX 平台实机运行（新套件的 POSIX 分支断言权限位，逻辑与原 chmod 一致）；CI Linux 会覆盖。
- 未做真实 DSH 宿主热重载验收、未跑 `test:release`（签名清单对齐属正式发布流程，本分支不触碰）、桌面安装包未重建。
- Microsoft 账户/域账户下裸用户名的 icacls 解析未逐一实测；本机（本地账户、非 ASCII 机器名）验证通过。
