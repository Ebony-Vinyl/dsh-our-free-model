# EAC 客户端密封迁移

现有客户端已支持带路径前缀的 worker 网关，不需要新增地址覆盖配置，也不修改宿主闸门、用户授权或 OAuth。迁移只替换 `src/vault-data.js` 和 `src/vault-anchor.js`。

## 私密输入

在仓库外的受控目录保存 UTF-8 JSON（支持 Windows BOM）：

```json
{
  "workerBase": "https://ourfreemodel.beichenapi.com/eac/v1",
  "signingSecret": "<从新服务器受控导出的真实签名密钥>"
}
```

占位内容不能用于实际迁移。密钥必须与服务器接受的签名密钥完全一致，至少 32 字符，不得带首尾空白或控制字符。工具不会替服务器生成或更换签名密钥。OAuth client secret 不是这个签名密钥。不需要上游 API key。

## 离线生成与审查

```powershell
node scripts/mint-eac-seal.mjs "D:\ofm-private\eac-new.json" "D:\ofm-private\seal-candidate"
node scripts/mint-eac-seal-test.mjs
```

输出目录的父目录必须已存在，输出目录本身必须不存在。工具拒绝本工作树内的私密输入，拒绝覆盖已有输出，不会自动安装或更改运行中的客户端。目录权限参数在 Windows 上不能代替 ACL；私密 JSON 应由受控导出过程放在已有访问限制的目录中。

工具随机生成三份 32 字节分片、掩码种子及 12 字节 IV，使用现有 HKDF 和 AES-256-GCM 格式，再通过运行时解密函数验证内存结果和磁盘文件。成功或失败均不打印配置值、文件路径或原始异常。JavaScript 字符串无法保证从内存清零；不要在共享环境中处理真实材料。

输出是 `vault-data.js`、`vault-anchor.js`。两份必须一起审查、一起替换到 `src/`。若生成失败，不能安装部分输出，应检查原因后使用另一个全新输出目录重试。密封是项目现有的可逆封装，不能代替服务器授权；不得公开私密输入，也不得把生成工具当成授权绕过方式。

## 验证与回滚

安装审查后的密封对后运行：

```powershell
node scripts/mint-eac-seal-test.mjs
node scripts/vault-test.mjs
node scripts/eac-auth-test.mjs
node scripts/eac-login-test.mjs
git diff --check
```

离线测试只证明格式和协议兼容；真实签名匹配、网关可用性与登录仍需授权联调。发布密封文件变更还需维护者执行仓库既有发布签名流程，不能自行伪造清单签名。

回滚必须同时恢复前一版本的两份密封文件。旧版本是否仍可访问取决于服务器是否保留旧网关和旧签名；客户端回滚不修改服务器。此流程不操作 OAuth 表单或 expiration 设置。
