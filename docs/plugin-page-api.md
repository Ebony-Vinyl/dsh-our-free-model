# 页面插件 API

页面插件是一个静态 HTML 包，运行在控制台的沙箱 iframe 中。它不能访问父页面、Cookie、localStorage 或网络；所有宿主能力都通过 `window.ofm` 桥。

## 1. 包结构

```text
my-page/
  ofm-plugin.json
  ui/
    index.html
    app.js
    style.css
```

清单：

```json
{
  "schemaVersion": 2,
  "id": "example.page",
  "version": "1.0.0",
  "apiVersion": "^2",
  "kind": "page",
  "name": "示例页面",
  "permissions": { "network": [], "secrets": [], "storage": true },
  "files": ["ui/index.html", "ui/app.js", "ui/style.css"],
  "contributes": {
    "pages": [{
      "id": "home",
      "title": "示例页面",
      "entry": "ui/index.html",
      "group": "工具",
      "order": 100,
      "icon": "sparkles"
    }]
  }
}
```

## 2. HTML 规则

- 不允许内联 `<script>`；脚本必须是清单声明的外部 `.js` 文件。
- 不允许外部 `src` / `href` / CSS `url(http…)`；只能引用包内相对路径或 `data:`。
- 不允许 `<iframe>`、`<object>`、`<embed>`、`<form>`、`<base>`、`meta refresh`、内联事件属性与 `javascript:` URL。
- 页面不需要、也不能自己引入桥脚本：宿主在返回 HTML 时把 `__bridge.js` 注入到 `</head>` 之前。

## 3. 宿主桥

页面加载后自动获得 `window.ofm`：

```js
const info = await ofm.plugin.info()
// { id, name, version, pageId }

const config = await ofm.config.get()
// 清单 config 的默认值 + 用户保存值；不含密钥

await ofm.storage.set('visits', 1)
const visits = await ofm.storage.get('visits')
await ofm.storage.delete('visits')
// 仅在 permissions.storage === true 时可用

const response = await ofm.http.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: { authorization: 'Bearer …' },
})
// { status, ok, headers, text }
// 只允许 permissions.network 中的精确 origin；GET/POST；响应文本最多 1 MiB

ofm.notify('已保存')
ofm.resize(520)
ofm.onTheme(({ theme, tokens }) => {
  // theme: 'light' | 'dark'
  // tokens: { '--ofm-bg', '--ofm-panel', '--ofm-text', '--ofm-muted', '--ofm-accent', '--ofm-border', '--ofm-radius' }
})
```

- 所有调用 20 秒超时；失败以 rejected Promise 返回。
- `ofm.http.fetch` 的请求由宿主发出，页面本身没有网络能力。
- 页面可以用 `ofm.resize(height)` 告诉父级 iframe 的目标高度（320–2400 px）。
- 主题切换时父级会主动推送一次 `theme` 消息；页面也可以用 `ofm.onTheme` 订阅。

## 4. 主题

页面应使用宿主推送的 CSS 变量，而不是写死颜色：

```css
body {
  margin: 0;
  background: var(--ofm-bg);
  color: var(--ofm-text);
  font-family: system-ui, sans-serif;
}
```

明暗切换由父级下发；页面不需要自己维护主题状态。

## 5. 安全边界

- iframe 只带 `sandbox="allow-scripts"`：来源不透明，无法访问父文档或同源存储。
- 页面响应带 `default-src 'none'` 的 CSP；脚本只能来自宿主服务 origin，连接被禁止。
- 资产 URL 带每次启动随机生成的 capability token，只能读取清单声明的文件。
- 安装前对 HTML、JS、CSS 分别做静态扫描；外部资源、内联脚本、`fetch`、`eval`、`localStorage`、`parent.document` 等都会被拒绝。
- 页面桥的宿主端需要管理会话；iframe 永远看不到会话 Cookie、管理密钥或插件密钥明文。

## 6. 最小示例

`ui/index.html`

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <h1 id="title">示例页面</h1>
  <button id="save">保存</button>
  <script src="./app.js"></script>
</body>
</html>
```

`ui/app.js`

```js
const title = document.getElementById('title')
const config = await ofm.config.get()
title.textContent = config.title || '示例页面'
document.getElementById('save').addEventListener('click', async () => {
  await ofm.storage.set('savedAt', Date.now())
  ofm.notify('已保存')
})
ofm.resize(document.body.scrollHeight)
```

注意：`app.js` 以普通脚本加载时不能使用顶层 `await`；上面只是示意，实际请包在 `async` 函数或事件回调里。
