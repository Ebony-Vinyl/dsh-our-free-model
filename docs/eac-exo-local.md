# EAC 本机 Exo 接入

## 已确认的范围

- EAC 渠道中的模型 ID 和显示名称均为 `EAC-claude opus 5.5`。
- 这是 OFM 的自定义模型标识，实际请求模型仍为 `exo-free`；首个 `msg_` 只作为筛选依据，不证明具体 Claude 型号。
- 正常 OFM 使用流程复用已有 GitHub 登录、Star 和服务端用户凭证。
- 每次生成前请求现有 EAC `/auth/status`，成功确认后才从本机请求上游。
- 服务器只参与授权检查，不承载提示词、工具历史或生成响应。
- 首个 `resp_` 响应取消并换请求 ID，最多四次尝试，固定同一会话；已放行的响应不自动重发或续写。

## 假设与边界

授权服务使用现有 Star 缓存和复查周期。移除 Star 生效时间由服务器的 `STAR_RECHECK_HOURS` 决定，并非每次生成都调用 GitHub 实时复查。授权超时、不可达、返回格式异常时拒绝生成，不使用页面的离线授权提示放行。

使用已有每用户凭证文件和现有密封服务地址。无需新签名密钥、短期租约、系统凭据库或代码加密。代码可被修改，匿名上游不识别 EAC 授权；该方案不承诺阻止自行调用上游。

网络请求分布在各安装实例所在的机器，共用公网出口的用户仍可能共享限额。遵守上游的 HTTP 拒绝和限流；不通过更换会话、账号或出口规避。上游对工具和客户端的检查仍适用，不能保证任何独立客户端均获准使用。

模型能力使用保守的 Exo 基线，不根据自定义名称推导 Opus 容量或视觉能力。Exo 免费通道的服务方可能收集请求用于改进模型，应沿用项目的第三方服务隐私说明。

## 决策记录

1. **授权复用现有 EAC**：用户接受现有授权力度。放弃增加独立租约协议和部署要求，减少两端配置成本。
2. **分开渠道与传输**：`channel: eac` 用于分组，`transport: exo-local` 用于本机路由，避免误把别名发送给 EAC 中转。
3. **真实清单决定入口**：仅在免费模型清单存在 `exo-free` 且宿主可打开 EAC worker 密封时提供入口。成功空清单移除入口，网络失败可沿用清单缓存。
4. **明确自定义名称**：保留用户指定 ID，在模型详情说明实际来源和型号未核验。
5. **有限筛选**：最多四次，仅在未放行内容且发现 `resp_` 时重试。未知 ID、非流式结果、超时和筛选耗尽均报错。

## 数据流

`EAC 模型选择 → 宿主密封检查 → 读取本机用户凭证 → 服务端 /auth/status → 本机 exo-free → 首 ID 筛选 → OFM 流解析`

用户凭证只发给 EAC 授权服务器，上游只收到匿名通道需要的请求头。响应筛选前的数据有大小和时间限制；取消时关闭上游请求。工具声明和历史沿用 OFM 现有 Chat 投影与名称回译。

## 验证与交付

离线验证覆盖未登录、未 Star、授权故障、凭证隔离、Claude 候选放行、GPT 候选取消重试、重试上限、非法响应、取消和工具流。真实上游成功和具体模型身份应单独记录，离线替身不能证明这两项。

安装、服务器部署和提交 PR 属于后续交付步骤。本次设计不要求修改服务器现有配置；已有服务端必须已完成 GitHub OAuth 和 Star 授权配置。

### 2026-10-07 验证记录

- `node scripts/test-all.mjs --mode contributor --only exo`：2/2 套件通过，流与授权测试 44/44，目录生命周期测试 20/20。
- `npm run test:contributor`：30/30 套件通过。
- `git diff --check`：通过。
- 本机新 `postExoStreamed` 对真实上游发出小请求，收到 `msg_` 响应、4 个数据事件，正文为 `OK`。没有执行模型工具。本次仅验证生成传输，不验证线上 EAC 授权。
- 并行只读审查未发现可操作问题。
- 未核验具体上游型号、真实 GPT 候选重试分布或真实 GitHub 授权端到端流程；未安装到 Desktop、部署服务器或创建 PR。

### 2026-10-07 Desktop 安装后的追加定位

上述一次成功属于传输测试，不能作为安装后的持续可用证明。之后已安装到本机 Desktop 并热重载，实际 EAC GitHub/Star 授权核验通过，但生成失败。

- 最初上游返回 HTTP 402；随后返回 HTTP 503，消息均为 `Error from provider (Console): Upstream request failed: Endpoint is unavailable.`，没有收到首个后端响应 ID。
- 对新保存的完整请求进行了两次字节完全一致的重放，均返回同一 HTTP 503。历史成功请求的随机 request ID 未保存，因此不能声称恢复了那次成功请求的全部字节。切换 `tool_choice`、原版 OpenCode 1.18.35、直连与已配置代理出口也未恢复生成。
- 2026-10-07 17:55（上海），原版 OpenCode 1.18.35 在独立临时目录中，以 `--pure`、`permission: { "*": "ask" }` 请求 `opencode/ling-3.1-flash-free`，约 5.9 秒返回 `OK.`，终态为 `stop`，退出码 0，没有调用工具。随后保留相同参数，仅将模型换为 `opencode/exo-free`，CLI 连续四次记录上述端点不可用错误；45 秒内没有正文，测试被终止。因此 `ask` 权限没有恢复 Exo，本次故障不能直接等同于通用客户端指纹拒绝。
- 9Router 0.5.95 的 Exo 请求 URL、请求体及公共头与 OFM 一致。2026-10-07 17:25:42（上海）实际运行它的发送器，关闭 HTTP 自动重试，单次请求仍返回同一 HTTP 503。

#### 已核实的上游边界

1. [官方 Exo 文档 PR #53622](https://github.com/anomalyco/opencode/pull/53622) 声明 `exo-free` 使用 `/zen/v1/chat/completions`，与当前实现一致。
2. [官方 handler 第 319–347 行](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/console/app/src/routes/zen/util/handler.ts#L319-L347) 给下一跳已有的 `error.message` 添加 provider 前缀，并保留其状态。因此本次内层错误来自 Zen 的 Console 下一跳，不能由它推断实际模型厂商、型号或具体停用原因。
3. [模型列表路由](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/console/app/src/routes/zen/v1/models.ts#L37-L41) 列出配置中的模型，不执行生成健康检查。Exo 仍出现在清单中不代表端点已恢复。
4. [provider 选择逻辑](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/console/app/src/routes/zen/util/handler.ts#L575-L670) 可依据 session、provider 池及其预算/容量状态选择路由；Exo 的实时配置未公开。不能假设仅更换 request ID 就会修复坏端点。

#### 本机处理与恢复条件

对 HTTP 402/503 中上述精确错误，使用独立且不可自动重试的 `EXO_UPSTREAM_UNAVAILABLE`，在提示中保留实际 HTTP 状态、原始错误，并说明尚未收到后端 ID。403、429及其他故障保持原有分类。

此修改改善故障识别，不承诺恢复生成。恢复需要 OpenCode/Console 运营方修复 Exo 的下一跳服务或路由配置；修改自有 EAC 授权服务器不能修复这个生成端点。端点恢复后，仍须验证 EAC 授权、真实正文、正常终帧和模型工具行为；具体 Claude 型号仍未核实。

本次追加验证：`node scripts/test-all.mjs --mode contributor --only exo` 两套通过，其中 Exo 49/49、目录生命周期 20/20；覆盖 402/503 的精确拒绝、403 分类隔离、其他 503、授权后的失败传递及单次失败记账。`node --check src/exo.js` 和 `git diff --check` 通过。新增诊断尚未重新安装及热重载到 Desktop；真实上游仍为 503，未验证恢复生成。

### PR 提交前验证

- `npm run test:contributor`：30/30 套件通过，其中 Exo 49/49、目录生命周期 20/20。
- 类型检查：该工作区未安装 `tsc`，直接运行 `npm run typecheck` 失败；随后使用相邻主工作区已有的 TypeScript 5.9.3 执行同一 `--noEmit -p tsconfig.json` 检查，通过。类型检查范围仍仅为 `adapter/`。
- `node --check src/exo.js`、`git diff --check`：通过。
- `npm run test:release`：0/3 套件通过，失败原因是已有签名清单和完整性记录尚未涵盖本次修改及新 `src/exo.js`，需要持钥维护者重新签名和更新目录 revision。
- 当前交付为待审查的测试接入；上游生成恢复、具体 Claude 型号、最终诊断版本的 Desktop 完整回合和真实工具调用均未验证通过。
