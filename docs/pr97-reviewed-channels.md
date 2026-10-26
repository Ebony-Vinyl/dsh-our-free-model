# PR #97 审查修复决策

## 已确认范围

- 移除“白嫖模型接入”的 OpenCode 账号卡，避免调用不适用的浏览器账号创建 RPC。
- OFM 挂载渠道包时关闭其 OpenCode provider、自动建槽和专用 RPC；保留已有账号及凭据。
- OFM 原有匿名免费模型继续走 `src/adapter.js` 和 `src/upstream.js`。
- 渠道网关中继与渠道包使用同一 home 解析顺序。
- 升级备份、安装清扫及恢复包含发布的渠道包运行文件。
- 成功刷新得到空 Kilo 免费池时清除目录和持久缓存；刷新失败时保留原缓存。
- 修改保留在独立分支；经用户授权，将修复版安装到本机 Desktop 进行真实冒烟测试。

## 假设与维护边界

保持现有用户规模、请求并发及其他渠道行为。关闭 OpenCode 账号接入不增加网络请求，不迁移、删除或输出凭据。回滚必须恢复 pack 与 WASM 的原始字节。开发源码和仓库脚手架继续受保护。发布签名仍由维护者完成。

## 决策

1. 采用追加的可选挂载配置关闭 OpenCode，省略配置时保留上游行为；只隐藏卡片不足以阻止自动建槽，删除已有数据不符合用户要求。
2. 中继每次读取 `profileContext`，按 `DSH_CHANNEL_PACK_STATE_DIR`、`profileContext.home`、`DSH_HOME`、默认 home 的顺序解析；不改变 OFM 自身数据位置。
3. 精确纳入当前发布的四个 vendor 文件，避免取消整棵 vendor 目录的脚手架保护。
4. 直接从受版本管理的 TypeScript 源码打包，避免依赖未入库的旧 lib；记录本地适配差异并验证生成包。
5. Kilo 合法清单是当前完整免费池的权威，包括 `data: []` 和全收费列表。网络、HTTP、JSON 或清单结构失败不代表空池，保留旧缓存；沿用现有持久化与目录刷新机制，不新增请求、账号或数据迁移。

## 验证结果

- 上一轮 `npm run test:contributor`：26/26 套件通过。
- `node scripts/channel-pack-test.mjs`：实际生成包挂载 13 个账号 provider，OpenCode 未注册/预热，历史账号保留，创建 RPC 拒绝；实际接入页渲染 13 张卡；OFM 匿名模型能列出并从本地 HTTP 流式返回。
- `node scripts/chan-relay-test.mjs`：25 项通过，包括不同 home 的密钥隔离、环境覆盖与鉴权围栏。
- `node scripts/updater-test.mjs`：通过，包括 pack/WASM 原始字节恢复、1.x 升级失败清理新 vendor 文件及开发源码保留。
- `tsc --noEmit -p tsconfig.json`：通过；仓库现有配置仅检查 adapter 接缝，不代表整个 vendored TypeScript 已完成类型检查。
- `node --check index.js`、`node --check client.js`、`node --check vendor/channel-pack/pack.js` 和 `git diff --check`：通过。
- 已从真实源码重新构建 pack，构建依赖位于隔离临时目录，仓库内的临时依赖已清理。

### 本次 Kilo 空池修复

- 修改前，新回归实际失败：全收费清单刷新后，发现目录、设置目录、模型选择器都仍保留两个旧模型，磁盘缓存未清除。
- 修改后 `node scripts/kilo-test.mjs`：57 项通过，覆盖全收费列表、显式空列表、缓存落盘、过期模型本地拒绝、免费池恢复、六类刷新失败及实际重新挂载后的空缓存。
- `node scripts/picker-test.mjs`：通过，验证共享目录刷新下的原免费模型选择与鉴权行为。
- `node scripts/channel-pack-test.mjs`：通过，确认 OpenCode 账号渠道停用、历史账号保留及原匿名模型流式回复。
- `node --check index.js`、`node --check scripts/kilo-test.mjs`、`git diff --check`：通过。
- 提交前再次执行 `npm run test:contributor`：26/26 套件通过；再次执行 adapter 范围 `tsc --noEmit -p tsconfig.json`、三个运行入口语法检查及 `git diff --check`，均通过。

### Desktop 真实冒烟（2026-10-06）

- 安装来源为 `fix/pr97-reviewed-channels` 工作区的当前修改，基于 `699e5163683570f9c41077981d1ee17b1bfe038c`。先备份当前插件，再复制声明的运行文件；安装后及热重载后均核对 39 个文件 SHA-256，零差异。
- 安装位置为 `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model`，使用真实目录及既有注册；通过设置页热重载，不重启 Desktop。
- 实际接入页显示 13 个账号渠道，未显示 OpenCode 卡片。原匿名免费模型和 Kilo 模型仍出现在设置页及对话模型选择器。
- Desktop 设置页真实“测一次”：MiMo V2.6 Flash 成功，耗时 3342 ms；Kilo Ling 3.1 Flash 成功，耗时 2112 ms。两项均有本机统计中的成功终态。
- Desktop 独立 MiMo V2.6 Flash 对话回复 `OK`，界面显示已完成，用时 30 秒。提示要求不调用工具、不读写文件。
- Desktop 另一独立 Kilo Ling 3.1 Flash 对话（High）回复 `OK`，界面显示已完成，用时 30 秒；使用同一最小提示。
- 已运行的渠道网关 `/v1/models` 返回 HTTP 200。用安装版中继代码及当前 home 的网关凭据，建立临时回环中继查询同一网关，返回 HTTP 200、39 个模型；测试后关闭临时中继，未开启持久 LAN 转发。
- 本机备份、安装摘要及截图保存在 `~/.dsh/plugin-dev-artifacts/ofm-pr97-reviewed-20261006-203907/`，不提交这些本机资产。

未测试十三个渠道逐一登录、正式签名升级或真实上游空池。空池及刷新失败语义由上述本地回归覆盖。修复作为独立 PR 提交到 #97 的功能分支；修改后的发布文件需要维护者重新签署清单，再验证 #97 合入 main 的发布就绪状态。本分支没有 AOCI 资产，当前 MCP 绑定原 91db 工作区，不能据其状态声称本分支索引已对齐。
