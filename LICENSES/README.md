# 第三方许可证全文

根目录 `LICENSE` 只覆盖 OFM 自己写的代码（MIT）。下列第三方组件的许可证全文放在本目录，
供任何接收者随分发一并取得。来源清单本身见根 README 的「致谢」。

| 组件 | 上游 | 许可证 | 本仓库中的落点 | 全文 |
| --- | --- | --- | --- | --- |
| free-claude-code | https://github.com/Alishahryar1/free-claude-code | AGPL-3.0-only | 历史供应商目录与本地应答来源（`docs/provider-compatibility.md`） | `AGPL-3.0-only.txt` |
| opencode2api | https://github.com/jasonxu114514/opencode2api | GPL-3.0 | 历史免费车道请求整形来源（`src/o2a/SYNC.md`） | `GPL-3.0.txt` |
| rtk | https://github.com/rtk-ai/rtk | CLI Apache-2.0 / engine BUSL-1.1 | 工具输出压缩的历史参考（`docs/verification/2026-11-18-independent-core.md`） | `Apache-2.0.txt` |
| models.dev | https://github.com/anomalyco/models.dev | MIT | 模型窗口、输出上限与思考档位数据 | 见根 `LICENSE` 内附版权与全文 |
| dsh-providers-hub | https://github.com/iJetLi/dsh-providers-hub | MIT | `vendor/channel-pack/` | `vendor/channel-pack/LICENSE` |
| 9router / trae-mate / dsh-cline-pass | 见根 README「致谢」 | MIT | 目录与流程参考 | 以各上游 `LICENSE` 为准 |

## 对应源码的获取方式（AGPL-3.0 §13 / GPL-3.0 §6）

本插件包含以 AGPL-3.0-only 与 GPL-3.0 许可的历史来源组件。**任何通过网络使用本插件的用户，
都可以通过下列任一方式取得这些组件对应源码的完整副本，无需额外付费，也无需提供凭据：**

1. 上游公开仓库：`https://github.com/Alishahryar1/free-claude-code`（AGPL-3.0-only）、
   `https://github.com/jasonxu114514/opencode2api`（GPL-3.0）；
2. 本仓库 Git 历史中对应版本的完整源码树（历史提交未重写，`git log` 可追溯）；
3. 在本仓库开 issue 索取，维护者提供打包副本。

本仓库对相关模块的改写记录见 `docs/provider-compatibility.md`、`src/o2a/SYNC.md` 与
`docs/verification/2026-11-18-independent-core.md`。这些记录说明改动范围，不改变上游许可证的适用；
改写是否使某段代码不再构成演绎作品，属于权利人的主张，不由本仓库或任何第三方单方认定。

## 已分发版本

v2.8.5 及更早的 release 产物中包含了上述来源的代码。这些版本的接收者同样适用上面的许可证与
源码获取方式；本目录的加入不撤回、也不替代这些历史版本上的义务。
