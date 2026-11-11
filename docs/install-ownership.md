# 安装归属契约（Install ownership）

> 这份文档回答一个问题：**这份安装的字节归谁管？** 应用内升级只允许改「归它管」的字节；其余情况必须拒绝，并指向正确的更新者。
>
> 背景：#335（Windows 上应用内升级与 pnpm 抢写同一目录）、#802（用户看到拒绝却不知道下一步）、#343 复审要求「先明确安装归属契约，再实现检测」。

## 三种安装形态

| 形态 | 谁拥有字节 | 应用内升级 | 怎么更新 |
|---|---|---|---|
| 应用内插件管理器（`dsh plugin add` / 桌面端插件管理器） | 宿主 | ✅ 允许 | 设置页「立即升级」 |
| profile `dependencies` 里的 `file:` / tarball URL / registry 版本 | pnpm | ❌ 拒绝（409） | `pnpm update dsh-our-free-model`，或把 `distribution` 设为 `managed` |
| profile `dependencies` 里的相对 `link:` | pnpm 只拥有接合点，不拥有字节 | ✅ 允许 | 设置页「立即升级」（插件树在 profile 内的真实目录） |

## 检测规则（`isPackageManagerOwned`）

只有两条**文件系统本地**的信号会把安装判为「包管理器拥有」：

1. profile 的 `pnpm-lock.yaml` **根 importer**（`.`）以本包为键，且 `specifier` 不是 `link:`；
2. `node_modules/.modules.yaml` 的 `hoistedLocations` 列出本包（`link:` 依赖不会出现在其中）。

布局覆盖：hoisted、scoped（`@scope/name`）、isolated（`node_modules/.pnpm/<name>@<ver>/node_modules/<name>`）。**workspace 子包的 importer 不算归属**，**`link:` 与「profile 未声明该依赖」也不算**。

## 被拒绝时

拒绝是 409，且发生在任何写入之前（不拉清单、不 staging、不动字节）。错误信息会给出可执行路径：

- 由 pnpm 统一更新：`pnpm update dsh-our-free-model`；
- 或把 bundle config / `settings.json` 的 `distribution` 设为 `managed`：应用内升级、公告 feed 与热重载停用，模型功能保留；
- 或改成相对 `link:` 依赖（插件树放在 profile 内的真实目录），应用内升级恢复可用。

## 已知限制

- 锁文件只解析 lockfileVersion 9 的 importer 拼写；v6 的内联 `specifiers:` 不匹配。
- isolated linker 下 profile 根按路径中最外层的 `node_modules` 定位（对应回归测试覆盖）。
