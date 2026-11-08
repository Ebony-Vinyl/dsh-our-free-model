# Claude TUI 卡 45 秒的修复:引擎跟上新版 Claude Code 的引导屏

Status: 修复交付。引擎 pin `6a900e0d048e592cbc9120dd2c3f515aab9ef04a`(2026-10-31)
→ `eef99e4bbebaf363840847dce4a33ee72eb37945`(2026-11-08),六个契约套件全绿;
TUI 模式在新装环境(全新引导状态)连续 3 次完整跑通一轮对话。附带修掉了一个
与本次改动无关但挡路的发布套件竞态,以及升级路径上的一个体验坑。

## 问题与根因

用户侧现象(QQ 反馈,2026-11-07):Claude 订阅走 magpie 引擎时,交互(TUI)模式
起不来,每次拖满 45 秒后回退 `-p`;多次失败后连退避都进去了,"claude 的 tui 模式
用不了,只能用 p"。

本机复现(用 vendored 引擎 + 全新 claude 配置目录 + `MAGPIE_CLAUDE_TUI_TRUST=1`,
Claude Code 2.1.319):

```text
claude-tui: Claude Code showed no prompt in 45s: Security notes: 1. Claude can
make mistakes. … 2. Due to prompt injection risks, only use it with code you
trust … Press Enter to continue…; this run is -p
```

根因:新版 Claude Code 的首次运行引导多了一屏"安全须知,按回车继续",之后还有
一屏"终端设置,Esc 跳过"。引擎的 `claudetui.ready()`(旧 pin)只认识信任文件夹、
登录、Chrome 提示和旧的主题选择屏:新屏幕没人替它按 Enter,Claude Code 等按键,
magpie 等提示符,两边互等到 `ReadyWait`(45 秒)上限,`MarkBroken` 退避后回退
`-p`。引擎侧 CPU 累计约 1 秒——它没在算,它在等。

上游已修:yetone/magpie 的 claudetui 在 #4817 一线加上了
`Security notes:.*Press Enter to continue`(回车)与
`terminal setup?.*Esc to skip`(Esc),配 `onboardTries` 防住同一屏反复重绘的死
循环,并处理了 `--dangerously-skip-permissions` 的 Bypass 声明(#5042);此后又有
四个 claudetui 修复(Chrome 提示停留后再拒、空屏错误、`/usage` 只走 -p 以免打开
空闲账号的 5 小时窗口、回放历史的图片命名)。所以正确的修法不是给旧引擎打补丁,
而是把 pin 挪过去——`node scripts/update-magpie-engine.mjs <sha>` 一次完成:
移 pin、重建、重打包、跑六个守护套件,失败自动回滚。

## 引擎更新 6a900e0d → eef99e4

- 新二进制 sha256 `02876489caff4aaac2a50356cabff3fe708f17d07af052f6fd7b8433a4ba7446`
  (64.8 MB → 72.7 MB,上游 8 天 +12%)。gzip 载荷 27.2 MB → 30.0 MB。
- 守护套件里需要答案的上游变化:内置预设 +3(longcat、volcengine-decision、
  voyage,均不在排除名单),`magpie-plugin-test.mjs` 的期望 59 → 62、地区总数
  64 → 63(腾讯把企业版并入 Plan,lkeap 域名整体迁到 tokenhub.tencentmaas.com);
  新预设加入 must-include 清单防回归。

## 附带修复

1. **升级路径上的退避标记**(src/magpie-engine.js):引擎失败 N 次后会在自己的
   LOCALAPPDATA 里写 `claude-tui-broken`,此后最长 24 小时直接走 -p 不再尝试
   TUI。旧引擎留下的标记对新引擎(带了修复)毫无意义,不清掉的话用户升级完还
   得等退避期。现在包装层在引擎 revision 变化时忘记这份标记;同一 revision
   自己的标记照旧保留(退避仍然保护每次启动不被 45 秒拖死)。
   回归测试在 `magpie-engine-test.mjs`(fixture 引擎:升级清标记、同版本保留)。
2. **80 文件上限**(scripts/build-legacy-payload.mjs):引擎变大后 gzip -9 溢出
   到第 8 个分片,整个清单 81 个文件,超过旧升级器(1.3.1/2.5.9)硬编码的
   80 文件上限——现场所有旧版用户升级会直接拒绝。此时改用 zopfli(@gfx/zopfli,
   devDependency)重压:仍是标准 gzip 流,任何 gunzip 都能解(校验本来就是按
   roundtrip 验的,不认压缩器);28,678,010 字节回到 7×4 MiB 预算内,清单回到
   80 个文件。zopfli 压 70+ MB 约需几分钟,只在溢出时发生。
3. **发布套件的 keep-alive 竞态**(scripts/legacy-upgrade-test.mjs、
   scripts/release-e2e.mjs,与本改动无关):夹具服务器用 Node 默认 5 秒
   keep-alive 超时;一轮 28 MB 下载之后的检查若耗时超过它,池化连接被服务端
   关闭,下一个请求 ECONNRESET,负控制死在"fetch failed"而非预期的拒绝理由。
   本机(较慢的文件断言)稳定复现,夹具服务器改为 600 秒 keep-alive 后两个
   套件全绿。HEAD 上同样复现,确认不是本次改动引入。

## 验证

- 端到端(真机,vendored 新引擎):全新 claude 配置目录(引导未做)+ mock
  Anthropic API,`claude-tui-helper` 连跑 3 次,3/3 通过——每次都是 TUI 模式
  (shim 发出 system/init),消息粘入、Enter 发送、transcript 回读、流式回出
  "ok",stderr 无回退字样。
- 契约:magpie-engine(含新的退避标记测试)、engine-transport、magpie-models、
  magpie-policy(16)、magpie-plugin(8 组,真引擎)、engine-payload(7/7)全绿。
- 发布:manifest 2.8.2、80 文件、34,036,022 字节、签名有效;legacy-upgrade 8/8
  (两个真历史升级器接受当前清单、完成真实下载安装、篡改分片被拒、升级产物凭
  分片还原引擎并启动);release-e2e 全绿。
- 全量 `npm test`(test-all):115/115 套件通过。

## 给用户的两个说明

- 本机(开发机)开着卡巴斯基时,新引擎二进制会被它拦下读不了/执行不了——这是
  杀软对未签名新 PE 的启发式,与ofm 无关。用户机器上如遇到引擎无法启动,把
  引擎 exe 加白即可。
- 截图里 `gemini-3.8-flash: 403 · Antigravity: Verify your account to continue`
  不是 bug:Google 要求该账号先完成验证,引擎只是如实转述并给出验证链接
  (上游 Verification() 提取 google.rpc.Help 链接并附指引)。在浏览器里登录该
  Google 账号、打开链接完成验证后重试即可。
