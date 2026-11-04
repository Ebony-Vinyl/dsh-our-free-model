# #738 修复验证：icacls 授权对象改用当前用户 SID

## 缺陷

`restrictPermissions()` 在 Windows 上执行

```
icacls <file> /inheritance:r /grant:r "<USERNAME>:F"
```

`<USERNAME>` 是裸账户名。当计算机名与登录账户名只差大小写时（Windows 允许、
个人机常见），`icacls` 在账户数据库与计算机账户之间解析这个名字，**计算机账户
胜出**。写入的 ACE 因此指向 `S-1-5-21-<machine>`——一个没有任何用户令牌携带的
SID；而同一次调用里的 `/inheritance:r` 已经先删掉了继承 ACE。文件于是只剩一条
谁都匹配不上的 ACE：随后的 `fs.renameSync` 必然 `EPERM`，文件连同已写入的内容
一起变成不可读、不可写、不可删。

`restrictPermissions()` 服务于全部「临时文件 + rename」的私有落盘路径
（`eac-user.js`、`store.js` 两处、`updater.js`、`picks.js`、`egress.js`、
`magpie-engine.js` 两处、`subscriptions.js` 三处、`packages/standalone` 三处），
所以这台机器上登录令牌、`settings.json`、`catalog.json`、`upgrade-state.json`
全部只在内存里，升级流程也卡在状态落盘。

## 方案

`src/open-external.js` 新增 `currentUserGrantee()`：

1. `whoami /user /fo csv /nh` 取当前令牌的 SID，加 `*` 前缀交给 `icacls`
   （`*` 明确告诉 icacls 这是 SID，不要做名字解析）。
2. `whoami` 缺失或失败时回退到 `USERDOMAIN\USERNAME` 全限定名；仍比裸名严格，
   因为它点名了账户域，不再把二选一留给 icacls。
3. 结果按进程记忆化：令牌的 SID 在进程生命周期内不变，而这些存储定时 flush。

保留 PR #637 的原始动机：`whoami` 的**账户名**输出走 OEM 代码页，非 ASCII 机器名
会被 UTF-8 解码毁掉。SID 是纯 ASCII、不含可本地化文本，这条顾虑对 SID 不适用。
`restrictPermissions()` 的语义、抛错/放弃写入的行为、POSIX 分支与全部调用点均未改动。

## 已执行

本机环境：Windows 10.0.26300.9818 / Node v24.15.0，`COMPUTERNAME=COLOR`、
`USERNAME=color`、`USERDOMAIN=COLOR`（即触发条件成立）。

- **修复前**：`node scripts/private-file-permissions-test.mjs` → `5 private-file
  check(s) failed`，首个失败为
  `the DACL does not name S-1-5-21-...-1001: <file> COLOR\:(F)`，`renameSync` 复现
  `EPERM`。同一份代码模拟 `USERNAME=COMPUTERNAME` 独立复现 `RESULT: REPRODUCED — EPERM`。
- **修复后**：`5/5 private-file checks passed`；同一复现脚本输出
  `RESULT: still accessible`。
- 断言口径从「acl 文本含 `(F)` 且不含 `(I)`」加强为「DACL 的 SDDL 里必须出现**当前
  令牌的 SID**」（`icacls /save` 产物恒以 SID 形式记录），这才约束住本缺陷；旧的
  `(F)` 断言在坏 ACE 上同样成立，捕不到它。
- 新增端到端用例：在 `USERNAME`/`USERDOMAIN` 与 `COMPUTERNAME` 相同的前提下，走完
  「写 tmp → restrictPermissions → rename 覆盖正式文件 → 回读」整条私有落盘路径。
- `node scripts/test-all.mjs --mode contributor`：**103/108**。失败 5 项经 `git stash`
  对标为既有失败，与本改动无关：`legacy-upgrade`（浅克隆缺 `f14d261` 对象，
  CI `fetch-depth: 0` 不触发）、`magpie-engine`（4 项 reviewer 回归，基线同样失败）、
  `magpie-policy`、`standalone-management`（`registry.npmjs.org` 不可达 + 残留
  `EPERM` 临时目录，基线同样失败）、`forward`（并发抖动，单跑 2/2 通过）。
- 直接受影响的套件全部通过：`private-file` 5/5、`open-external`、`updater`、
  `subscriptions` 38/38。
- `node --check`、`git diff --check`：通过。

## 边界

- 未覆盖域账户与 Microsoft 账户实机（本机为本地账户）；回退分支只保证不比原实现弱，
  未在无 `whoami` 的环境实测。
- 未在 POSIX 实机运行；该分支代码未改动，CI Linux 覆盖。
- 已存在但**未被本改动修复**的坏 ACE 文件不会自愈：`restrictPermissions()` 只处理
  新写入的临时文件。历史残留仍需 `icacls <path> /reset` 手工恢复（已验证可恢复且
  内容不丢）。
- 未跑 `test:release`（签名清单对齐属正式发布流程，本分支不触碰）。
