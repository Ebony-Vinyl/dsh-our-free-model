# 插件平台

桌面端与独立本地服务共用一套插件内核：渠道、增强、页面和内置能力都通过同一份清单注册、同一个市场分发、同一套权限与生命周期运行。DSH 插件宿主复用同一内核，渲染渠道与增强贡献；页面贡献由桌面控制台渲染。

## 1. 插件种类

| 类型 | 作用 | 运行方式 |
| --- | --- | --- |
| `channel` | 声明模型并把一轮请求转成上游调用 | Worker + `vm` 沙箱 |
| `enhancement` | 改写请求体、过滤模型清单、观察用量 | Worker + `vm` 沙箱 |
| `page` | 在控制台侧边栏贡献一个页面 | `sandbox="allow-scripts"` iframe |
| `bundle` | 同时贡献上表中的多项 | 按贡献分别运行 |

内置能力（账号渠道包、聚合渠道目录、客户端启动器、资源库格式、模型工作台）以 `essential: true` 的 built-in 描述符注册。它们出现在插件中心，但不可卸载、不可停用；实现仍在内核代码里，后续可以逐个迁出为独立包，而不改变契约。

## 2. 清单

包根目录必须有 `ofm-plugin.json`。`schemaVersion: 1` 的旧清单继续可用；`schemaVersion: 2` 增加页面、文件列表、宿主能力依赖与 API 版本范围。

```json
{
  "schemaVersion": 2,
  "id": "example.dashboard",
  "version": "1.0.0",
  "apiVersion": "^2",
  "kind": "bundle",
  "name": "示例面板",
  "description": "一个渠道 + 一个页面",
  "author": "Example",
  "license": "MIT",
  "main": "index.mjs",
  "permissions": {
    "network": ["https://api.example.com"],
    "secrets": ["apiKey"],
    "storage": true
  },
  "requires": ["channels"],
  "provides": ["channel:example"],
  "config": [
    { "key": "region", "type": "text", "label": "区域", "default": "us" }
  ],
  "files": ["index.mjs", "ui/index.html", "ui/app.js", "ui/style.css"],
  "contributes": {
    "channels": [{ "models": [{ "id": "example-1", "contextWindow": 131072 }] }],
    "pages": [{
      "id": "dashboard",
      "title": "示例面板",
      "entry": "ui/index.html",
      "group": "工具",
      "order": 100,
      "icon": "sparkles"
    }]
  }
}
```

字段约束：

- `id`：`/^[a-z][a-z0-9-]{1,47}$/`。模型 id 在目录中统一加 `ext:<plugin>/` 前缀，第三方不会意外覆盖内置模型。
- `version`：语义化版本；`minHost` 可声明宿主最低版本。
- `apiVersion`：`^2`、`~2.1`、`2.x`、`>=2 <3` 或 `*`。不兼容的条目仍会显示在市场中，但安装按钮会禁用。
- `files`：包内全部文件的相对路径；禁止绝对路径、反斜杠、`..` 段与未允许的扩展名。本地开发包必须列出全部文件。
- `permissions.network`：最多 8 个精确 origin；运行时的出站请求、页面桥的 `http.fetch` 都只允许这些 origin。
- `permissions.secrets`：最多 8 个密钥名；密钥只进不出，API 只返回 `hasValue` 与 `…last4` 指纹。
- `permissions.storage`：允许插件读写自己的键值空间。
- `requires`：宿主能力名（`ui`、`channels`、`enhancements`、`providers`、`clients`、`formats`、`network`、`storage`、`secrets`、`http`）。缺失能力时插件进入 `pending`，不会崩溃，也不会隐藏原因。
- `config`：最多 12 项，类型为 `text` / `password` / `toggle` / `number` / `select`。控制台按字段描述渲染表单，插件代码无需自带设置 UI。
- `contributes.pages`：最多 8 项；`entry` 必须是 `files` 中声明的 `.html`。

## 3. 市场与安装

市场索引是签名的 `registry.json`：维护者用 Ed25519 对规范化 JSON 签名，客户端从多个镜像读取 `registry.json` 与 `registry.sig`，用构建中固定的公钥验签。索引中的每个文件都带 `size` 与 `sha256`。

安装流程：

1. 解析并校验清单；校验 `minHost` 与 `apiVersion`。
2. 逐个下载清单声明的文件，校验字节数与 SHA-256。
3. 运行静态扫描（代码与页面分别有规则）。
4. 写入 `extensions/packages/<id>/<version>/`，权限 0600。
5. 记录 `installed.json`、追加 `audit.jsonl`，重新挂载贡献。

更新是同一流程的版本替换；重装会先停掉旧 Worker。卸载删除整个包目录、配置、密钥与该插件的本地存储。市场不可达时使用 6 小时缓存；没有缓存时使用构建内置的官方货架快照。宿主还会以同样的节奏后台定时刷新索引，上游发新版不需要用户打开市场就会出现在「已安装」页。

市场条目可选携带 `changelog`（≤ 8 条、newest-first 的发布说明），详情弹层按「更新内容」渲染；详情弹层同时提供指向签名源文件的「查看源码」直达链接。

插件中心支持**导出/导入清单**：导出为 JSON（每个已装插件的 id、版本、启停与配置；**密钥永不导出**），导入按清单逐个从签名市场重装并恢复配置与启停，单个失败不影响其余 —— 用于跨机器迁移。

## 4. 生命周期

- `ready`：已加载，贡献生效。
- `pending`：`requires` 未满足；页面不展示，渠道不参与目录。
- `failed`：加载或完整性校验失败；只影响该插件，其他插件继续运行。
- `disabled`：用户停用；Worker 停止，贡献撤下。
- `stopped`：启用但尚未启动（例如启动失败后）。

配置或密钥保存会重启该插件的 Worker（配置在加载时读取）。插件包目录、配置、密钥的变化由 2 秒轮询发现并触发重新挂载；测试可通过不启动监视器保持确定性。

## 5. 安全边界

- **签名与摘要**是信任根；静态扫描是安装前的绊线，不是沙箱的替代。
- **代码插件**运行在 `worker_threads` + `vm.SourceTextModule` 中，唯一 import 是 `ofm:sdk`；没有 `require`、`process`、文件系统或自有套接字。出站 HTTP、密钥、存储与日志都经 JSON 桥。
- **页面插件**运行在 `sandbox="allow-scripts"` 的 iframe 中，来源不透明：不能访问父页面 DOM、Cookie 或 localStorage。页面只能通过宿主注入的 `window.ofm` 桥调用白名单方法；网络请求由宿主按 `permissions.network` 代发。
- 页面资产使用每次启动随机生成的 capability token，只能读取清单声明的文件；响应带严格 CSP、`nosniff` 与 `no-store`。
- 安装、启停、配置、密钥与卸载都记录在 `extensions/audit.jsonl`。

## 6. 开发者模式

默认关闭。开启后，插件中心接受本地目录安装：

- 目录必须包含 `ofm-plugin.json`，且 `files` 列出全部文件。
- 文件必须是普通文件（拒绝符号链接），逐个扫描、计算摘要后复制。
- 记录标记为 `source: "local"`、`verified: false`，界面显示“未验证 / 开发者包”。
- 运行沙箱与权限模型与市场包完全一致。

开发者模式只是一条安装通道，不会放宽运行时的权限检查。

## 7. 管理 API

所有路由在 `/api/management` 下，`/plugins` 为当前接口，`/extensions` 为兼容别名：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /plugins` | 已安装、built-in、市场索引、页面、审计与开发者开关 |
| `GET /plugins/pages` | 当前可渲染的页面贡献 |
| `GET /plugins/audit` | 最近 100 条操作 |
| `GET /plugins/cover?id=` | 签名封面图 |
| `POST /plugins/registry/refresh` | 强制刷新市场 |
| `POST /plugins/install` | 从签名市场安装/更新 |
| `POST /plugins/install-local` | 本地开发者包安装（需开发者模式与显式确认） |
| `POST /plugins/uninstall` | 卸载（内置插件拒绝） |
| `POST /plugins/toggle` | 启用/停用 |
| `POST /plugins/config` | 保存配置 |
| `POST /plugins/secret` | 保存密钥 |
| `POST /plugins/self-test` | 运行插件自检 |
| `POST /plugins/page-rpc` | 页面桥的宿主端，需管理会话 |
| `GET /plugins/assets/<token>/<path>` | 页面资产；token 即能力，免会话 |

## 8. 发布

1. 在 `ofm-extensions` 仓库新增包目录，放入 `ofm-plugin.json`、代码与页面文件。
2. CI 校验 JSON Schema、路径、摘要、静态扫描与清单一致性。
3. 运行 `build-registry.mjs` 生成确定性索引，再用维护者私钥签名。
4. 提交 PR；合并后市场自动可见。

签名私钥永远不进入本仓库或包目录。客户端固定的公钥在 `src/extensions.js`；替换公钥必须与发布流程同步，否则所有安装都会被拒绝。
