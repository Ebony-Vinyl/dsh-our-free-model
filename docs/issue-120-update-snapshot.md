# issue #120：升级分发缓存与固定提交取件

## 目标与边界

修复清单与文件经可变分支取件时可能来自不同提交的问题，并处理当前 CDN 对
`vendor/channel-pack/NOTICE.md` 的重定向。保持现有公钥、清单字段、签名算法、
文件大小和 SHA-256 校验；保留旧安装在暂存失败时不变的行为。

复用现有镜像和原子升级流程，无新运行依赖。假设发布频率低，每次检查及应用允许
一次 GitHub API 分支解析；解析和清单读取在每个源的 15 秒预算内完成。
GitHub API 不可达或限流时拒绝可变分支下载，并显示失败；不增加用户 Token 要求。

## 核实结果（2026-10-07）

- main `fbc3b9b55686fe169bd1fd26bb9211b9d3008d9e` 的 40 个清单项与 Git
  发布字节和 SHA-256 全部一致；最新重签提交是 `967a596`。
- CDN 最初返回 05:14 的旧清单与四个旧代码文件，Git/raw 返回 07:34 的新清单。
  分钟级 `?ofm=` 不改变这个差异。issue 所述四文件未重签不能据此视为当前 main 的事实。
- 整树及逐路径 purge 返回 finished。一条网络路径随后确认当前清单和全部 40 个文件
  与 Git 相符，但本机 Node 的旧升级器仍复现
  `package.json: size 2354 != manifest 2328; vendor/channel-pack/NOTICE.md: fetch failed`。
- 补刷 package/NOTICE 后，Node 取得正确的 2328 字节 package，但 NOTICE 仍返回
  301，指向 raw；固定 SHA 也会收到该跳转。raw 的该文件在本次 Node 请求中超时。
- 同一固定 SHA 的 gcore NOTICE 返回 200、3542 字节。
- 新升级器实际通过 CDN 下载 2.0.0 全部 40 文件、4008049 字节，完成验签、摘要校验及回读。
  该验证在临时目录完成，没有替换 Desktop 安装或部署新版本。

## 决策记录

| 决策 | 考虑的方案 | 原因 |
| --- | --- | --- |
| 先解析 SHA，再下载清单和文件 | 只加查询参数；只 purge | 实测查询参数无效，purge 无法消除各路径与访问边缘的差异 |
| 使用 GitHub 官方 commits API | jsDelivr 分支解析接口 | 两个实测 jsDelivr 解析接口均返回 version=null，不能提供完整 SHA |
| 不改变签名字段 | 新增必签 revision 字段 | 保持现有清单及旧客户端验签格式兼容 |
| 同次检查跨镜像复用 SHA，apply 重新解析 | 每个镜像独立解析；复用旧检查结果 | 避免切换镜像或下载途中分支移动带来的版本混用 |
| 固定 SHA 文件在连接、重定向、404/429/5xx 时回退至 gcore | 跟随任意 Location；移除 NOTICE 校验 | 同一 SHA/path 可取到合法文件；每份字节仍需符合签名清单 |
| 对大小、哈希及鉴权拒绝不回退 | 任意错误都换镜像 | 保持已有完整性失败和授权拒绝的语义 |

## 验证与交接

`npm run test:contributor` 覆盖版本解析、签名、固定提交、镜像切换、解析拒绝/超时、
apply 重新解析、gcore 回退、坏文件拒绝、安装与回滚。`node --check src/updater.js`、
`node --check scripts/live-audit.mjs` 和 `git diff --check` 已通过。
类型检查使用相邻主工作区已安装的 TypeScript 5.9.3 执行
`tsc --noEmit -p tsconfig.json`，范围仅 adapter。

真实验证命令：

```bash
node scripts/live-audit.mjs --source https://cdn.jsdelivr.net/gh/Ebony-Vinyl/dsh-our-free-model@main/feed/manifest.json
```

日志中的实际清单 URL 为 `@fbc3b9b55686fe169bd1fd26bb9211b9d3008d9e`，
40/40 文件通过。原版脚本的同一命令仍失败，不能用新脚本成功宣称旧客户端已自动修复。

本地源码已变，现有签名尚未覆盖本修复。发布检查中 manifest、release 因摘要漂移失败，
catalog 在未提交状态通过；提交修复后再次执行 `npm run test:release`，
manifest、release、catalog 三项均失败，catalog 原因是内容提交改变而 revision 尚未刷新。
发布前由持钥维护者重签并更新目录 revision，保留普通 merge
所需的内容提交身份；不用占位签名，不替换公钥。

旧客户端需要先成功升级或手动安装修复后的正式版本才能获得新逻辑；如果其网络仍将
NOTICE 跳转到不可达 raw，仅刷新缓存不能保证过渡成功。本次已完成下述 macOS Desktop 宿主冒烟；
没有执行 Windows UI 升级，也没有发布本修复。


## macOS Desktop 实机冒烟（2026-10-07）

- 实际应用：`/Applications/DeepSeek Harness.app`，Desktop profile 内的插件安装副本。
- 原安装为 2.0.0 开发版（包含 EAC 本机 Exo 功能）；先完整备份插件及升级状态。
  本次为 **2.0.0 → 2.0.0 同版本重新安装**，不是 1.4.5 → 2.0.0 或 Windows 实测。
- 新升级器由实际 Desktop Node 宿主加载。采用临时本地文件触发探针调用真实
  `PluginUpdater.apply()`，并将 `selfReload()` 作为激活回调；没有开放匿名接口，
  没有读取或改变宿主鉴权，也没有用替身服务、替换签名公钥或伪造版本。
  同版本页面没有升级按钮，因此本次没有覆盖用户点击“立即升级”的 UI 操作链。
- 首轮下载 38/40 后失败：`client.js` 与 `adapter/dsh-llm.d.ts` 的连接失败。
  暂存目录清理，未进入安装，没有版本不一致或恢复待办。该失败记录完整保留。
- 重试通过，耗时约 23.7 秒；实际清单源固定为
  `https://cdn.jsdelivr.net/gh/Ebony-Vinyl/dsh-our-free-model@fbc3b9b55686fe169bd1fd26bb9211b9d3008d9e/feed/manifest.json`。
  raw 清单连接超时后使用同 SHA 的 CDN；NOTICE 等主 CDN 连接失败后使用固定镜像。
- 宿主完成 40 文件、4008049 字节下载、验签、暂存、备份、安装及热重载。
  激活返回 `ok:true`、`version:2.0.0`、`fibers:1`；generation 1→2。
  事务为 `complete`，`activated:true`，没有错误、版本不一致或恢复待办。
  随后独立逐文件核对已安装字节：大小与 SHA-256 **40/40** 符合正式签名清单。
- 最后恢复测试前的开发插件及升级状态，仅保留本次 `src/updater.js`。
  42 个原文件中其余 41 个摘要不变，无额外文件。恢复副本再次在真实宿主热重载成功，
  generation 1→2、1 个 fiber；恢复后的旧开发入口没有导出运行版本，故不把其空版本
  返回值作为严格版本激活证明。Desktop 插件页显示 v2.0.0、**共 1 个 · 1 运行中**。
- 测试探针在重载前自移除，最终磁盘与运行实例使用干净入口。文件自动热重载设置
  仍为测试前的关闭状态；没有操作用户账号、聊天或密钥数据。

本机证据与原安装备份保留在仓库外，不提交本机路径、用户截图或原始运行数据。
主要证据为 `attempt1-host-result.json`、`host-result.json`、`host-activation.json`、
`installed-verification.json`、`restoration-runtime.json`、`final-verification.json` 和
`desktop-restored.png`。首次失败及成功重试均记录，不将真实网络可用性解释为永久保证。
本机当前保留修复后的开发升级器，尚不属于已签名发布版本。
