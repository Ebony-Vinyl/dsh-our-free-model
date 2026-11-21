# 第三方来源对照

本文件把本仓库各模块与上游的对应关系逐条记下来，供许可证审查使用。判定分四档，判定本身只依据可复现的结构事实，不含法律结论：

- **独立**：与上游没有共同的实现细节，仅功能相同
- **参考重写**：读过上游源码后重写，结构或常量可能沿用
- **移植**：与上游逐函数对应，或常量表、标志字符串直接沿用
- **待确认**：来源不明，需要维护者补充

## 对照表

| 模块 | 上游来源 | 上游许可证 | 判定 | 可复核依据 |
| --- | --- | --- | --- | --- |
| `src/o2a/assets/ofm-agent-context.txt` | opencode2api | GPL-3.0 | 独立 | 929 B；与上游 `opencode_prompt_v2.txt`（8535 B）按句切分后交集 0 |
| `src/o2a/assets/ofm-tool-contracts.json` | opencode2api | GPL-3.0 | 独立 | 13 条 `description` 与上游逐字相同 0 条；工具名与 wire 字段属兼容要求，不计入 |
| `src/o2a/toolshape.js` | opencode2api `internal/gateway/toolshape.go` | GPL-3.0 | 移植 | 标识符交集 70；`renameAndCompleteTools`、`sanitizeToolHistory`、`chatMessageHasContent`、`convertLegacyFunctions`、`rewriteToolReferences` 同名；`chatMessageHasContent` 的三键数组与 `string`/`[]any`/`map`/`nil` 分支顺序一致 |
| `src/o2a/tool-renames.js` | opencode2api `internal/protocol/tools.go` | GPL-3.0 | 兼容 + 参考 | `clint_` 前缀是上游 free tier 的强制要求（见上游注释），属必须一致；`foldToolName` 等辅助函数同名 |
| `src/token-saver/rtk/constants.js` | rtk `src/cmds/system/constants.rs` | Apache-2.0 / BUSL-1.1 | 常量沿用 | `NOISE_DIRS` 25 项与 `LS_NOISE_DIRS` 同序，含 `env` 位于 `venv` 之后的位置与注释内容 |
| `src/token-saver/rtk/filters/*` | rtk（经 magpie-compress-core） | Apache-2.0 | 参考重写 | `gitDiff.js` 48 行 vs rtk `diff_cmd.rs` 7437 行，无 pairing cell、相似度重写等机制 |
| `src/local-optimize.js` | free-claude-code | AGPL-3.0-only | 独立 | fcc 全仓无 `command_injection_detected`、`<filepaths>`、`[SUGGESTION MODE:` 等标识 |
| `src/providers/registry.json` | free-claude-code `config/provider_catalog.py` | AGPL-3.0-only | 目录继承 | 本仓库 76 条与上游 61 条交集 60；`*_API_KEY` 环境变量约定一致 |
| `src/engine-parts/*.part` | 未提供 | 未知 | 待确认 | 7 个分片合计约 28 MB，由 `engine-payload.js` 解压为 `engine-runtime/<sha256>.exe` 执行；解压后为 PE 文件并含 `Go build ID`；本仓库内 `.go` 文件数为 0 |

## 这张表怎么用

1. 判为**移植**或**常量沿用**的条目，对应上游许可证仍然适用，`LICENSES/` 里必须有该许可证全文；
2. 判为**独立**的条目可以主张独立创作，但「独立」只针对列出的具体文件，不覆盖整个模块目录；
3. 判为**待确认**的条目需要在发布前补齐来源，否则无法判断该分发哪些条款。

## 仍需补充的三项

- `LICENSES/` 目录与许可证全文（本 PR 已包含）；
- `src/providers/registry.json` 的来源说明：当前 60 条与上游目录同源，`docs/` 里的「重建」表述与事实不符；
- `src/engine-parts/` 的来源与构建方式，或对应源码。

## 现成范例

`Ebony-Vinyl/ofm-extensions` 的 `companion/compression/NOTICE` 是同类记录的现成写法：点名上游仓库、给出参考 commit、附 Apache-2.0 与 MIT 全文、并直接写明「this is not a clean-room implementation」。本仓库可以直接照搬这个格式。
