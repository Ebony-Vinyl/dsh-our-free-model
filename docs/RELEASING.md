# 发布与公告（仓库主人）

这份文档面向维护者，不属于发布内容：`package.json` 的 `files` 不含 `docs/`，所以它
不会被安装到用户机器上，也不出现在 [`README.md`](../README.md) 里——README 只讲使用者
需要知道的事。

一切通过插件仓库根目录下的 `feed/` 目录完成，**推送即发布**。

普通贡献者与维护者的检查分工、受保护的签名补丁准备流程见
[`contributor-ci-signing.md`](contributor-ci-signing.md)。贡献者运行
`npm run test:contributor`；main 合并前必须通过 `release-readiness`，
默认 `npm test` 仍包含完整发布校验。不要让贡献者持有发布私钥。

## 推送公告

编辑 [`feed/announcements.json`](../feed/announcements.json)，往 `announcements`
数组加一条：

```json
{
  "id": "2026-10-01-something",        // 全局唯一，出现过的 id 不会重复提醒
  "title": "一句话标题",
  "level": "info",                     // info | update | warn | urgent
  "pinned": false,                     // 可选，置顶
  "createdAt": "2026-10-01T00:00:00Z",
  "expiresAt": "2026-10-15T00:00:00Z", // 可选，过期自动消失
  "link": { "url": "https://…", "label": "查看详情" },  // 可选
  "html": "<p>正文，<strong>支持受限白名单的 HTML</strong></p>"
}
```

`urgent` 会触发全屏弹窗。正文 HTML 由客户端白名单渲染器解析——脚本、事件属性、
`javascript:` URL、iframe 等一律被丢弃（测试见 `scripts/sanitize-test.mjs`），
所以仓库被篡改也不会变成代码执行。

## 发布新版本

改完代码后——

```bash
# 1. 修改 package.json 的 version、两份 README 的本地 tarball 安装版本号
#    （catalog 套件校验文件名版本）与 feed/announcements.json（版本说明）
# 2. 重新生成清单（把每个发布文件的字节数与 SHA-256 写进 feed/manifest.json；
#    同一份文件清单也会写进 catalog/integrity.json，供生态目录审计用）
node scripts/build-manifest.mjs --key /安全目录/既有发布私钥.pem
# 3. 确认清单与实物一致（不一致就非零退出；已接进 npm test）
node scripts/build-manifest.mjs --check
# 4. 提交并推送（目录记录 revision 的两步提交见下一节），再打 tag 并创建 Release
git tag -a v1.2.3 -m "…" && git push origin v1.2.3
gh release create v1.2.3 --title "…" --notes-file …
# 5. purge CDN 缓存——整棵 @main，不只是 feed 那两个文件（原因见下一节）
curl "https://purge.jsdelivr.net/gh/Ebony-Vinyl/dsh-our-free-model@main"
# 6. 以「已安装用户」的身份复核发布产物：下载清单、逐文件校验字节数与 SHA-256、再回读
node scripts/live-audit.mjs          # 打印 OK 才算发出去；FAIL 就按它给的提示处置
```

第 2 步不是可选项：清单是发布者对每个文件的**字节数与 SHA-256 的承诺**，改了发布文
件却没重跑，客户端就会下到新文件、拿旧哈希去校验，校验机制会（正确地）拒绝安装——于
是这一版的一键升级对所有旧版本用户都失败。`--check` 就是让这种事在提交前失败。

`--key` 与 `OFM_MANIFEST_KEY` 都接收私钥**文件路径**；没有既有私钥时拒绝写入，
不得提交占位签名或替换公钥。受保护工作流的 `RELEASE_MANIFEST_PRIVATE_KEY`
则是 PEM **内容**，由可信 main 的 `prepare-release.mjs` 使用，两者不要混用。

摘要按 **LF 归一化后的字节**计算，不是工作区字节：`.gitattributes` 是
`* text=auto eol=lf`，用户下载到的是 blob，而编辑器可以把工作区改成 CRLF 且
`git status` 依然干净。`scripts/release-e2e.mjs` 会把全部发布文件改写成 CRLF 再跑一次
`--check`，旧算法在这一步直接失败。

已安装的插件会按 `updateCheckHours`（默认 6 小时）自动发现新版本并推送通知；
用户确认后下载、校验、备份、替换、热重载全部在应用内完成。清单会校验每个文件的
SHA-256，并在安装前重新拉取一次，避免用陈旧清单校验新文件。

## main 上的发布一致性是强制的（ruleset）

**推送即发布**意味着「改了发布文件却没重签清单」不是普通的 CI 红灯，而是让所有旧
版本用户的一键升级当场失败（1.4.5 事故、2026-10-06 main 上 1.4.6 的漂移都是这一类）。
仓库因此给 main 配了 ruleset：`offline` 与 `release-readiness` 两个检查是必需的，且
改动必须走 PR——清单与实物不一致的树在 merge 前就会被挡下，而不是发布后让用户撞墙。

这带来两条纪律：

- 改了 `package.json` 的 `files` 清单里的任何文件，同一 PR 里必须带上重签后的
  `feed/manifest.json` 与 `catalog/integrity.json`（`node scripts/build-manifest.mjs`
  用发布私钥跑一遍即可），否则 `release-readiness` 会红、merge 被拒。
- ruleset 本身在仓库 Settings → Rules → Rulesets 调整。紧急情况可以临时改成
  inactive，但事后必须恢复；绕过它的每一次 merge 都要让全量校验立刻补跑。

## 目录记录与 revision 约定

`catalog/dsh-plugin.json`（`source.revision`）与 `catalog/provenance.json`
（`subject.sourceRevision`）记录**最近一次触及发布内容的 commit**——`package.json`
加上 `files` 清单，正是 `catalog/integrity.json` 逐字节描述的那份文件集合。
`scripts/catalog-test.mjs` 按此校验，比较对象刻意不是 HEAD：记录无法内含引入它自己
的那个 commit 的哈希，拿 HEAD 比对会让目录套件在记录真正提交的那一刻变红，事后单改
revision 再提交，HEAD 又前移——逻辑上无解。改比"最近一次触及发布内容的 commit"既
真实（单独提交目录记录不改变任何发布字节）又可满足（刷新 revision 的 commit 只碰
`catalog/`，它要匹配的指针不会因此移动）。

所以内容改动按两步提交：

1. **内容 commit**：代码、清单、目录记录一起进；
2. **刷新 commit**：紧接着单独一个 commit，只把上述两处 revision 改成第 1 步的
   哈希——不得顺带改动任何发布文件，否则校验会继续红。

只有触及发布内容的 commit 才移动这个指针：改 `docs/`、`scripts/`、`catalog/`
本身都不需要刷新。发布 tag 打在第 2 步之后（发布物不含 `catalog/`，两步的制品字节
相同，但 HEAD 处于全绿状态）。

## 固定提交取件与旧客户端过渡（issue #120）

新版升级器将默认更新 URL 用于发现版本；实际下载前依次通过 GitHub 官方
commits API、git upload-pack refs 和 commits Atom feed 解析完整 40 位 commit SHA，
再从 `raw.githubusercontent.com/<repo>/<sha>/feed/manifest.json` 或
`cdn.jsdelivr.net/gh/<repo>@<sha>/feed/manifest.json` 下载签名清单。
清单的相对 `base` 从这个固定 URL 解析，全部文件因此来自同一提交。
raw 取件失败转 CDN 时复用本次已解析的 SHA；点击升级会重新解析，防止使用数小时前的结果。

现有公钥、清单字段和签名格式保持兼容；解析接口仅提供下载位置，不授权代码。
清单验签、文件大小与 SHA-256、暂存回读及回滚照常执行。解析失败、限流或超时会报错，
不退回可变分支取件。每个镜像的一次解析及清单读取共用 15 秒预算；单个解析端点最多
占用 3 秒，API 限流时仍可尝试 refs 和 Atom。固定 SHA 的 `--source` 和本地测试源无需解析。

固定 SHA 的主 jsDelivr 文件取件遇到连接失败、重定向、404、429 或 5xx 时，
可切换至 `gcore.jsdelivr.net` 的同一 SHA 和路径，两次取件共用单次超时预算。
不跟随响应给出的任意 `Location`，不对 401/403 做镜像回退，也不对大小或摘要错误回退。
每份下载字节仍须符合签名清单；固定提交以外的源不启用此文件回退。

已安装 1.x/旧 2.0 客户端仍使用 `@main` 取件，不能靠新客户端代码修复它们的当前升级。
发布时仍需整树 purge，并针对失败路径逐个 purge；用旧升级器跑完整取件校验，
确认过渡升级可用后，用户才能获得新的固定提交流程。`live-audit.mjs` 默认核验新版路径，
现在会显示实际 snapshot URL；旧路径应使用旧安装或旧提交中的该脚本单独核验。

签名清单仍须与其所在发布提交的全部文件一致。固定 SHA 解决 CDN 分支缓存和下载过程中
分支移动的问题，不能修复未重签的代码变更；持钥维护者仍须按上述发布步骤生成签名及目录记录。
不得放宽 vendor 文件校验；当前 2.0.0 清单只包含四个 vendor 发布文件，并非其全部开发源码。

## 关于源顺序与网络现实

发现源的顺序是 `raw.githubusercontent(main) → jsDelivr(@main) → gcore jsDelivr(@main) → gh-proxy(main)`。
新版升级器先固定提交再取件，全部失败时报错并保留现有安装；公告仍使用原有缓存回退。
以 `src/feed.js` 与 `src/updater.js` 的 `DEFAULT_*_SOURCES` 数组及下载实现为准。

raw 排在前面是因为它**权威、不缓存**：推上去立刻能读到。但它在部分网络（实测本机 CN
出口 + Watt Toolkit 类加速工具）根本走不通——`git push` 正常，而 raw 对新文件返回假
404，或干脆 TLS 失败（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）。这些网络上 jsDelivr 是唯一
的源，所以下一条很要紧。

**jsDelivr 的新鲜度没有 cache-buster 那么可靠**（2026-09-26 实测）。请求确实自动带上
分钟级 `?ofm=` 参数，但 jsDelivr 把 `@main` 这类**分支引用**的"分支 → commit"解析放在
单独一层缓存里，查询串不进这一层。实测：推送 v1.2.2 之后，jsDelivr 仍返回 v1.2.1 的清单
（连 `README.md` 的字节数都是上一版的）和 v1.2.1 的公告；显式 purge 之后两者立刻变成
v1.2.2。

后果要具体说：在 raw 走不通、只能靠 jsDelivr 的网络上，旧版本用户拿到的是**过期清单**，
于是「检查更新」回答"已是最新"，一键升级根本不会出现，新公告也收不到。这与 issue #1 是
同一类失败，只是往下一层。新仓库的首次收录也有延迟（创建 Release 会触发它）。

所以发布流程的最后一步是 purge；不做就要等 CDN 自己重解析，通常数小时：

```bash
curl "https://purge.jsdelivr.net/gh/<仓库>@main"
```

**要 purge 的是整棵 `@main`，不能只 purge `feed/*.json`。** v1.3.1（2026-09-27）就是反面
教材：只 purged 那两个 feed 文件之后，`…@main/feed/manifest.json` 立刻变成 1.3.1，而同一
CDN 上 `…@main/index.js` 仍返回 v1.3.0 的 56 999 字节——清单声明的却是 60 224。这比完全
不 purge 更糟：完全不 purge 时用户拿到旧清单配旧文件，自洽，只是「检查更新」答「已是最
新」；而新清单配旧文件会让 `stageRelease` 在按清单校验时失败（安全失败——拒绝安装、保留
旧版本，但这一版对该网络的用户就是发不上去）。同一次实测里 `…@v1.3.1/index.js` 与
`…@<commit sha>/index.js` 都返回正确的 60 224，可见 jsDelivr 缓存的是 `@main` 这个**分支
名到 commit 的解析**，文件层跟着它一起旧；而且 purge 返回 `"status":"finished"` 之后文件
层仍滞后了数分钟。

2026-10-05 的 1.4.5 重签复核又量到一个更坏的分裂态：整树 purge 之后（`finished`，CF/FY
两个 provider 均报 true），`…@main/feed/manifest.json` 与 `client.js`、`package.json`、
`src/feed.js`、`src/updater.js` 四个文件仍是旧提交的字节，其余文件却是新的——正是「新清单
配旧文件」会拦下升级的那半边；随后**按文件路径逐个 purge**（`…@main/<path>`），清单与四
个文件立刻转新，升级路当场全绿。所以整树 purge 是第一步而不是保证：purge 完必须跑
`live-audit.mjs`，它失败时会指名道姓列出坏在哪些文件上，对每个路径再 purge 一次再复跑。
`live-audit.mjs` 现在把「可达源全部通过、其余源不可达」报成成功（raw 在 CN 网络本来就不
通），只有真的坏发布才返回非零。

所以第 6 步是：以已安装用户的身份把整条升级路跑一遍，而不是 curl 一下清单看版本号。
`scripts/live-audit.mjs` 调的就是插件自己的 `downloadManifest` → `stageRelease` →
`verifyStaged`，它打印 OK 等价于旧版本用户点「一键升级」会成功。清单的 `base` 是 `"../"`、
相对清单自身 URL 解析，因此对不可变 ref 跑它（`--source …/@v1.3.1/feed/manifest.json`）
验的是发布物本身，而默认三个源验的是用户实际会走的那条路。

`feedUrl` 仅覆写公告源（含 `{repo}` 占位符），不改变升级源或签名信任根。
本地升级测试由测试程序注入 `defaultSources`；发布复核使用 `live-audit.mjs --source`。

---

# Releasing and announcements (repository owner)

This document is for maintainers and is not part of the release: `package.json`'s
`files` does not include `docs/`, so it never reaches an installed copy and never
appears in [`README_EN.md`](../README_EN.md). Everything lives in the repository's
`feed/` directory — **pushing is publishing**.

See [`contributor-ci-signing.md`](contributor-ci-signing.md) for contributor
checks and protected signature preparation. Contributors run
`npm run test:contributor`; maintainers must pass `release-readiness` before
merging into main. The default `npm test` still checks the complete release.

## Push an announcement

Edit [`feed/announcements.json`](../feed/announcements.json) and add one entry:

```json
{
  "id": "2026-10-01-something",        // unique; a seen id never re-alerts
  "title": "One-line title",
  "level": "info",                     // info | update | warn | urgent
  "pinned": false,                     // optional
  "createdAt": "2026-10-01T00:00:00Z",
  "expiresAt": "2026-10-15T00:00:00Z", // optional
  "link": { "url": "https://…", "label": "Read more" },
  "html": "<p>Body with <strong>allowlisted HTML</strong></p>"
}
```

`urgent` opens a full-screen modal. Bodies are rendered by a client-side allowlist
parser — scripts, event handlers, `javascript:` URLs, iframes and friends are all
dropped (see `scripts/sanitize-test.mjs`), so a compromised repository does not
become code execution.

## Release a new version

```bash
# 1. bump `version` in package.json, and the release note in feed/announcements.json
# 2. regenerate the manifest (size + SHA-256 of every published file; the same
#    list is written to catalog/integrity.json for ecosystem catalog audits)
node scripts/build-manifest.mjs --key /secure/path/to/existing-release-key.pem
# 3. confirm the manifest matches the tree (non-zero exit otherwise; part of npm test)
node scripts/build-manifest.mjs --check
# 4. commit and push (see the two-step catalog revision convention below), then
#    tag and create the release
git tag -a v1.2.3 -m "…" && git push origin v1.2.3
gh release create v1.2.3 --title "…" --notes-file …
# 5. purge the CDN — the whole @main tree, not only the two feed files (see below)
curl "https://purge.jsdelivr.net/gh/Ebony-Vinyl/dsh-our-free-model@main"
# 6. re-verify as an installed user would: download the manifest, check every file's
#    byte count and SHA-256, then read the staged copy back
node scripts/live-audit.mjs          # publishing is done when this prints OK
```

Step 2 is not optional. The manifest is the publisher's promise about every file's
byte count and SHA-256: edit a published file and skip the rebuild, and a client
downloads the *new* file while verifying it against the *old* hash — verification
then correctly refuses to install, and the one-click upgrade is broken for every
user on an older version. `--check` is what makes that fail before a commit
instead of in the field.

`--key` and `OFM_MANIFEST_KEY` accept a private-key **file path**. No key means
no manifest write; do not add a placeholder signature or replace the public
key. The protected workflow's `RELEASE_MANIFEST_PRIVATE_KEY` instead contains
the existing key's **PEM text**, used only by the trusted main signer.

Digests are computed over **LF-normalised** bytes, not working-tree bytes:
`.gitattributes` says `* text=auto eol=lf`, so users download the blob while an
editor can leave the tree CRLF with `git status` clean. `scripts/release-e2e.mjs`
rewrites every published file to CRLF and re-runs `--check`; the old builder fails
there.

Installed plugins discover the new release automatically (every
`updateCheckHours`, 6 by default) and notify the user; the upgrade itself runs
in-app, and the manifest is re-fetched right before installing so a document
fetched hours earlier cannot be used to vouch for bytes that changed since.

## Release consistency on main is enforced (ruleset)

**Pushing is publishing**, so "edited a released file but skipped the manifest
rebuild" is not an ordinary red CI run — it breaks the one-click upgrade for
every user on an older version at once (the 1.4.5 incident, and the 1.4.6 drift
on main measured 2026-10-06, were exactly this). A ruleset therefore guards
main: `offline` and `release-readiness` are required checks and changes must
arrive as pull requests, so a tree whose manifest does not describe its files
is stopped at merge time instead of failing in the field.

Two disciplines follow:

- Any change to a file in `package.json`'s `files` list must carry the re-signed
  `feed/manifest.json` and `catalog/integrity.json` in the same PR (run
  `node scripts/build-manifest.mjs` with the release key); otherwise
  `release-readiness` goes red and the merge is refused.
- The ruleset lives in Settings → Rules → Rulesets. In an emergency it can be
  flipped to inactive, but it must be restored afterwards, and every merge that
  bypassed it owes an immediate full verification run.

## Catalog records and the revision convention

`catalog/dsh-plugin.json` (`source.revision`) and `catalog/provenance.json`
(`subject.sourceRevision`) record the **most recent commit that touched the
release content** — `package.json` plus the `files` list, exactly the set
`catalog/integrity.json` describes byte by byte. `scripts/catalog-test.mjs`
checks it against that, deliberately not against HEAD: a record cannot contain
the hash of the commit that introduces it, so a revision compared against HEAD
turns red the moment the records are actually committed, and re-pointing it in
a follow-up commit moves HEAD again — logically unsatisfiable. "Last commit
that touched the release content" is both truthful (committing the records
alone changes no published byte) and satisfiable (the refresh commit touches
only `catalog/`, so the pointer it must match does not move under it).

Content changes therefore go in as two commits:

1. **The content commit**: code, manifest and catalog records together;
2. **The refresh commit**: immediately after, a commit that only rewrites the
   two revision fields to the first commit's hash — it must not touch any
   published file, or the check stays red.

Only commits that touch the release content move the pointer: `docs/`,
`scripts/` and `catalog/` changes need no refresh. Tag the release after step 2
(the published artifact excludes `catalog/`, so both commits produce identical
artifact bytes — but HEAD sits at all-green there).

## Immutable downloads and migration from old clients (issue #120)

The updater resolves each official discovery ref through GitHub's commits API,
git upload-pack refs, then the commits Atom feed
before downloading its signed manifest. It returns the SHA-based manifest URL;
all file URLs resolve relative to that snapshot. A raw-to-CDN fallback reuses
the same SHA within a check. Apply performs a fresh check. The resolver only
selects a location: the existing Ed25519 signature and every file's size/hash
remain mandatory. The manifest format and pinned public key do not change.

Resolution and manifest reading share a 15-second budget per source. Each resolver
has at most three seconds, so an API rate limit or timeout can fall back to refs
and Atom. If all resolvers fail, the update fails without using mutable refs.
Explicit full-SHA URLs and custom/local test sources need no resolver.

Installed old clients still fetch mutable refs. Purge the current publication
and verify all files with an old updater before relying on that migration.
The new live audit reports and uses the resolved URL; it does not prove the
old path works. Immutable downloads do not fix unsigned source changes:
maintainers must still re-sign and align the catalog before publishing. Vendor
runtime files retain full integrity checks.

Fixed-SHA CDN files may use the gcore edge at the same SHA/path after transport,
redirect, 404, 429 or 5xx failures. Both requests share the attempt's deadline;
arbitrary redirects, authorization refusals, size errors and hash errors do
not trigger this fallback. Mutable and custom file sources are not remapped.

## Source order and network reality

Discovery order is `raw.githubusercontent(main) → jsDelivr(@main) → gcore jsDelivr(@main) → gh-proxy(main)`.
The new updater pins a commit before downloading; on failure it reports the
error and retains the installation. Announcements retain their existing cache
fallback. Consult the source arrays and download implementation in `src/feed.js`
and `src/updater.js`.

raw leads because it is authoritative and uncached — push, and it is immediately
readable. But on some networks (measured: a CN egress with a Watt Toolkit-style
accelerator) raw does not work at all: `git push` succeeds while raw answers a
false 404 for a new file, or fails TLS outright
(`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). On those networks jsDelivr is the only
source, which makes the next part matter.

**jsDelivr's freshness is not as reliable as the cache-buster suggests** (measured
2026-09-26). Requests do carry a minute-resolution `?ofm=`, but jsDelivr caches
the *branch → commit* resolution for a branch ref like `@main` in a separate
layer that the query string does not reach. Measured: after pushing v1.2.2,
jsDelivr still served the v1.2.1 manifest (down to the previous `README.md` byte
count) and the v1.2.1 announcement; an explicit purge changed both to v1.2.2
immediately.

What that costs, concretely: on a network where raw is unreachable and jsDelivr is
all there is, an older user fetches the **stale manifest**, so "check for updates"
answers "already latest" — the one-click upgrade never even appears, and a new
announcement never arrives. That is the same class of failure issue #1 was about,
one layer down. A new repository's first index lags too (creating a Release
triggers it).

So the last step of a release is a purge; skip it and the CDN re-resolves on its
own in a matter of hours:

```bash
curl "https://purge.jsdelivr.net/gh/<repo>@main"
```

**Purge the whole `@main` tree — the two `feed/*.json` files are not enough.** The
counter-example is v1.3.1 itself (2026-09-27): after purging only those two,
`…@main/feed/manifest.json` turned into 1.3.1 at once while `…@main/index.js` on the
same CDN still answered v1.3.0's 56 999 bytes against a manifest declaring 60 224.
That is worse than not purging: unpurged, a user gets an old manifest with old files —
self-consistent, and *Check for updates* just says "already up to date" — while a new
manifest over old files makes `stageRelease` fail its digest check (it fails safe: the
install is refused and the previous version stays, but this release never reaches that
network). In the same measurement `…@v1.3.1/index.js` and the commit-sha ref both
returned the correct 60 224, so what jsDelivr caches is the `@main` branch-name →
commit resolution, and the file layer ages with it; a purge reporting
`"status":"finished"` still lagged by minutes.

The 1.4.5 re-sign audit on 2026-10-05 measured a worse split state: after the
whole-tree purge (`finished`, both CF and FY reported true),
`…@main/feed/manifest.json` and four files — `client.js`, `package.json`,
`src/feed.js`, `src/updater.js` — still served the previous commit's bytes while
the rest were fresh: exactly the new-manifest-over-old-files half that blocks an
upgrade. Purging **each named path** (`…@main/<path>`) turned the manifest and the
four files fresh at once, and the upgrade path went green on the spot. So the
tree purge is the first move, not the guarantee: run `live-audit.mjs` after it —
on failure it names the stale files, purge each of those paths, and re-run.
`live-audit.mjs` now reports success when every reachable source verifies and the
rest are unreachable (raw is simply down on CN networks); only a genuinely bad
publication returns non-zero.

Which is why step 6 walks the whole upgrade path as an installed user rather than
curling a manifest for its version string. `scripts/live-audit.mjs` calls the
plugin's own `downloadManifest` → `stageRelease` → `verifyStaged`, so its `OK` is
equivalent to an older install clicking *Upgrade* and succeeding. The manifest's
`base` is `"../"`, resolved against its own URL, so running the script against an
immutable ref (`--source …/@v1.3.1/feed/manifest.json`) verifies the release itself,
while the default sources verify the route a user actually takes.

`feedUrl` overrides only announcements (with a `{repo}` placeholder), never the
update source or signing trust root. Local updater tests inject `defaultSources`;
release audits use `live-audit.mjs --source`.
