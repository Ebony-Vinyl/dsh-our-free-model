# 发布钥匙台账（2026-10-20）

本文记录本机持有的**清单签名钥匙**：它签什么、在哪里、怎么用、怎么轮换、坏了怎么回滚。
上游 `feed/manifest.json` 的原始签名私钥只在 GitHub Actions secrets 里（`RELEASE_MANIFEST_PRIVATE_KEY`），
本机从来没有过；因此插件升级到自己修过的版本时，签名门禁必须有一个本机信任根。

## 1. 现状：双钥匙信任窗口

`src/updater.js` 里 pin 了两把公钥，验签时**逐个尝试，任一通过即接受**：

| 常量 | 公钥（SPKI base64） | 谁签的 |
|------|--------------------|--------|
| `UPSTREAM_MANIFEST_PUBLIC_KEY` | `MCowBQYDK2VwAyEAeLdSVwYFyazc2PIBC0oLsvo4LghGEQz9iXIl3CqRuXI=` | 上游 GitHub Actions（v2.5.6 及以前的所有发布） |
| `LOCAL_MANIFEST_PUBLIC_KEY` | `MCowBQYDK2VwAyEA/QccXrWO8e07drlv1foso/MuNF/ZmNew3WD7Tt01rsk=` | 本机 `ofm-release-key.pem` |

`PINNED_MANIFEST_PUBLIC_KEYS = [UPSTREAM, LOCAL]` 是该窗口的唯一真源；`downloadManifest()`、
`PluginUpdater`、`scripts/build-manifest.mjs`、`scripts/prepare-release.mjs` 的默认验证键都指向它。
`PINNED_MANIFEST_PUBLIC_KEY`（单数）仍保留为上游键，供只会传单个键的老调用方使用。

键集**永远来自源码**，绝不从清单里读 —— 清单自带 `signature`，但签名所用公钥只能来自 pin，
否则任何人都能自签一份清单并附上自己的公钥。

## 2. 钥匙文件

- 路径：`C:\Users\26777\.dsh\keys\ofm-release-key.pem`
- 类型：Ed25519，PKCS#8 私钥，119 字节，无口令
- 公钥指纹（SPKI DER 的 SHA-256）：`a119f951b67bd4ba722affb8b0908b2e476f4c23e3c95606fba8bd7e2a7e5c77`
- ACL：`icacls` 已 `/inheritance:r`，只剩 `MRSUN\26777:(R,W)` —— 其他账户、Administrators 组之外的默认继承都被切断

私钥只用于**本机自我发布**（把修好的版本推给同一台机器上的插件升级路径）。
丢了不影响已安装插件运行，只是不能再自签新版本；此时要么重新生成一对新钥匙并改 pin，要么改回只信上游键。

## 3. 签名与验证

```powershell
# 签名（会同时重写 feed/manifest.json 与 catalog/integrity.json）
$env:OFM_MANIFEST_KEY = "$env:USERPROFILE\.dsh\keys\ofm-release-key.pem"
node scripts/build-manifest.mjs

# 把 catalog 里的 revision 指到当前 HEAD
node scripts/refresh-revision.mjs

# 只校验，不写入
node scripts/build-manifest.mjs --check
```

`build-manifest.mjs` 拒绝在无钥匙时写入（`refusing to write an unsigned manifest`），
这是故意的：仓库里不留未签名清单。

## 4. 轮换

1. 新钥匙：`node -e "..."` 生成 Ed25519 私钥 → 存到 `~/.dsh/keys/ofm-release-key-<date>.pem`，收紧 ACL。
2. 导出 SPKI base64 与指纹，登记到上表。
3. 改 `src/updater.js` 的 `LOCAL_MANIFEST_PUBLIC_KEY`（或把新键加进 `PINNED_MANIFEST_PUBLIC_KEYS` 做三键过渡窗口）。
4. 重签清单 + `refresh-revision`，跑全量套件，部署 `src/updater.js`。
5. 过渡窗口结束后删掉旧键 —— 保留旧键等于长期接受旧钥匙签的任何清单。

## 5. 老用户 / 上游 CI 的边界

- **上游 CI 仍然只认上游私钥**：本地这把钥匙在服务器上没有对应公钥，所以本机签的清单推给 GitHub
  只会让 CI 的 `release-sign` 任务按自己的钥匙重签（这是期望行为：上游发布继续用上游钥匙）。
- **只装过旧版（≤2.5.6 官方包）的机器**只认上游键，遇到本机签的清单会判签名不符；
  它们需要一次手动重装（或升级到带双键的版本）才能进入这个信任窗口。
- 只有经本机双键版本安装/更新的插件，才同时接受两个来源。

## 6. 回滚

- 撤掉双键：`PINNED_MANIFEST_PUBLIC_KEYS = [UPSTREAM_MANIFEST_PUBLIC_KEY]`，重签（需上游钥匙，没有就保持双键）。
- 撤掉内容改动：`git revert` 本次提交并重新部署，插件仍按旧逻辑运行；`~/.dsh/our-free-model/*.json` 里的
  `refusedStreak` 字段对旧代码是未知键，读取时被忽略，不需要清理。
- 钥匙泄漏：立即删掉 `LOCAL_MANIFEST_PUBLIC_KEY` 并重新部署 —— 这会让所有本地签名的清单一律验签失败，
  但已安装的插件不受影响（签名只在安装/升级时校验）。
