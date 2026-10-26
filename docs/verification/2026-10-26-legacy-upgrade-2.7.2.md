# 2.7.2 插件升级验证

范围：仅插件端。桌面和独立产品版本未修改，不构建或发布桌面安装包。

## 实际结果

- `node scripts/test-all.mjs --mode contributor`：98/98 套件通过，退出码 0。
- `node scripts/test-all.mjs --mode release`：5/5 套件通过，退出码 0；包含真实生产签名检查。
- `node scripts/legacy-upgrade-test.mjs`：8/8 通过，原版 1.3.1、2.5.9 升级器完成真实 79 文件的下载与安装。
- `node scripts/legacy-upgrade-test.mjs --production`：在生产签名清单下重复通过；未修改历史升级器源码、公钥或大小限制。
- `node scripts/engine-payload-test.mjs`：7/7 通过，覆盖并发还原、坏缓存恢复、坏分片、缺片、非法路径、输出限制、摘要及生成代码行为。
- `node scripts/build-legacy-payload.mjs --check`：通过，打包代码与源码一致、已发布分片摘要及还原后的引擎一致。
- `npm run typecheck`、`node scripts/catalog-test.mjs --contributor` 和 `git diff --check`：通过。

第一轮完整检查发现安装文档仍指向 2.7.1、共享源码包缺少新模块。两处均已修复；最终完整检查为上述 98/98，不将第一轮失败计作通过。

## 历史版本与产物

历史升级器夹具与对应 Git 对象逐字节核对，真实旧安装包从历史发布提交归档提取。旧版的 80 文件和 4 MiB 限制均保持不变。负向夹具仍能重现并拒绝 93 文件与超大文件。

验证了升级后插件入口加载、用户数据保留、激活失败恢复原文件、篡改真实分片时拒绝安装，以及新升级器重新检查同一签名版本时无需重复升级。Windows 上从真实升级目录中的分片还原引擎，启动并访问了认证管理接口，结束后关闭测试进程。

生产签名来自主线 `prepare-release` 工作流运行 `40269127939`，签名候选为 `ac5364b890adc90dbc8f1c3e9c372d0b4c8a37c4`。收据、补丁摘要及所有 79 项运行时内容均已核对；之后的提交仅修复构建检查和文档，运行时字节不变。签名私钥始终保留在 GitHub Actions 中。

本地升级回归使用回环 HTTP 服务，未调用真实模型上游。公开下载地址、发布 tarball 与校验记录的验证结果随 Release 产物记录提供；本说明不将尚未完成的公开下载检查算作通过。
