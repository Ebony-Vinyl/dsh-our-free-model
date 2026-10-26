/**
 * 内部载体的**载体页小服务**：只监听 `127.0.0.1` 的独立端口，唯一职责是提供那张页面。
 *
 * ## ★ 为什么载体页不能挂在插件自己的路由上（C1/C2，本轮最致命的一条）
 * 初版把页面挂在 `/api/channel-pack/captcha-carrier`，理由是「与 GUI 同源，`<webview>` 才导航得过来」。
 * 真机证据（DSH Desktop 0.2.0-rc.2，`resources/app.asar/lib/main.js`）把这个前提整个推翻了：
 *
 * | 判据（asar 原文） | 行为 |
 * |---|---|
 * | `allowedNavigation(v)` = `["http:","https:"].includes(protocol) && !username && !password && !isApplicationHost(url)` | 命中应用自身 host ⇒ **导航被 `preventDefault`** |
 * | `isApplicationHost(u)` = `u.port === host.port && (u.hostname === host.hostname \|\| 回环)` | **端口相同** + 主机相同或回环 |
 * | `configureSession().onBeforeRequest`：`isApplicationHost(url) ⇒ callback({cancel: true})` | 请求**根本发不出去** |
 * | `acquire()`：`partition = \`dsh-sidebar-browser-${randomUUID()}\`` | **无 `persist:`** ⇒ 内存 session，拿不到 Host 存在 `defaultSession` 里的会话 cookie |
 *
 * ⇒ 桌面版 GUI 的真实 origin 是自定义 scheme `dsh-app://app/`，而插件 API 走
 * `forwardWebRequest(request, hostUrl, hostCookie)` 转发到 `http://127.0.0.1:<host 端口>`。
 * 载体页挂在那个端口上 ⇒ 每轮都在 `allowedNavigation` 的**第一个判断**退出，guest 都不建，
 * 收益恒为 0（且失败被 `preventDefault` 吞掉，日志一切正常）。
 *
 * ## ✅ 为什么「换个端口」就能过
 * `isApplicationHost` 要求「**端口相同** 且 主机相同/回环」⇒ **换端口即不在判定内**，
 * guest 可导航、可加载。独立小服务不是「变通」，而是当前唯一能过那三道判定的形态。
 *
 * ## 安全边界（到此为止，不要再加东西）
 * - **只监听回环**：`127.0.0.1`，不绑所有网卡（局域网里的别的机器够不着）；
 * - **只有一条路由**：`GET /carrier`（其余 404，该路径上的非 GET 405），**只回静态 HTML**；
 * - **无账号数据**：页面里的 `region` / `prefix` / `sceneId` 是阿里云 SDK 的**公开**初始化参数
 *   （本来就要发给阿里云），JWT / token / cookie 一个都没有（`buildCarrierPageHtml` 的契约）；
 * - **因此不需要鉴权**：加了反而致命 —— guest 那个 partition 没有会话 cookie，
 *   一旦要 cookie 就是 401 ⇒ 又回到「代码全对但一次都没产」。页面里没有秘密可保护。
 *
 * ## 端口怎么挑
 * 照 `src/zcode-captcha.ts` 的 `pickFreePort` / `isPortFree`（调试端口）那套写法：
 * 先用 `net.createServer` **真的占一下**候选端口确认空闲，再交给 HTTP 监听器；
 * 探测与真正绑定之间仍有理论竞态，所以 `tryListen` 失败（`EADDRINUSE`）会**换下一个候选**
 * 而不是就此放弃。**端口绝不用 0**：`0` 只是「让系统挑一个」的请求，
 * 拿到真实端口前拼不出任何可导航的 URL。
 *
 * ## 生命周期
 * 随 `ZcodeAuth` 起停（`src/zcode-auth.ts` 的 `carrierPageUrl()` 懒起 / `stop()` 关）。
 * 懒起的理由：**web 版根本不会有人来问地址**（`dshDesktop.browser` 拿不到 ⇒ 贡献循环
 * 整体 return，一个 RPC 都不发）—— 那就别给 web 版开一个监听端口。
 */
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'

/** 页面路由（唯一一条）。client 拿到的地址就是 `http://127.0.0.1:<port>/carrier`。 */
export const CARRIER_PAGE_ROUTE = '/carrier'

/**
 * 候选端口的范围（随机取一个再验空闲）。
 *
 * ⚠ 与 DSH 自己的端口天然错开：宿主那个是 `DesktopHostProcess` 自己挑的动态端口
 *   （`hostUrl()`，见 asar `main.js`），我们这里固定在 1xxxx 段，两者撞上的概率极低；
 *   真撞上也只是**这一轮候选**失败，`tryListen` 会换下一个（见文件头「端口怎么挑」）。
 */
const PORT_RANGE_MIN = 19_100
const PORT_RANGE_MAX = 19_599

export interface CarrierPageServerOptions {
  /**
   * 渲染载体页（通常是 `buildCarrierPageHtml(await zcode.fetchCaptchaConfig())`）。
   *
   * 抛错 ⇒ 回 500（见 handler），**不许**把监听器带崩。
   */
  renderPage: () => Promise<string> | string
  /** 候选端口生成（注入只为让单测能制造「端口被占用」那一支）。 */
  pickCandidate?: () => number
  /** 最多试几个候选端口（默认 8）。全被占 ⇒ 返回 `null`（RPC 据此回 `url: null`）。 */
  attempts?: number
  log?: (message: string) => void
}

/** 试占一个端口判断是否空闲（能绑上就算空闲）。⚠ 只绑回环。 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer()
    const settle = (value: boolean): void => { resolve(value) }
    probe.once('error', () => { settle(false) })
    probe.once('listening', () => { probe.close(() => { settle(true) }) })
    try {
      probe.listen(port, '127.0.0.1')
    } catch {
      settle(false)
    }
  })
}

export class CarrierPageServer {
  private readonly renderPage: () => Promise<string> | string
  private readonly pickCandidate: () => number
  private readonly attempts: number
  private readonly log: ((message: string) => void) | undefined
  private server: Server | undefined
  private boundPort: number | null = null
  /** 并发去重：两个 RPC 同时问地址时只起一个监听器。 */
  private starting: Promise<void> | undefined

  constructor(options: CarrierPageServerOptions) {
    this.renderPage = options.renderPage
    this.pickCandidate = options.pickCandidate
      ?? (() => PORT_RANGE_MIN + Math.floor(Math.random() * (PORT_RANGE_MAX - PORT_RANGE_MIN + 1)))
    this.attempts = options.attempts ?? 8
    this.log = options.log
  }

  /** 当前地址（未启动 / 已停止 ⇒ `null`）。 */
  url(): string | null {
    if (this.boundPort === null) return null
    return `http://127.0.0.1:${String(this.boundPort)}${CARRIER_PAGE_ROUTE}`
  }

  /** 当前端口（未启动 / 已停止 ⇒ `null`）。 */
  port(): number | null {
    return this.boundPort
  }

  /**
   * 起服务并回地址；起不来回 `null`（**不抛** —— 载体页只是「没有 chromium 时的补充」，
   * 它起不来不该影响任何一条主路径）。
   */
  async start(): Promise<string | null> {
    if (this.boundPort !== null) return this.url()
    if (this.starting !== undefined) {
      await this.starting
      return this.url()
    }
    this.starting = this.listen()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
    return this.url()
  }

  /**
   * 关闭。⚠ `close` 的回调在**没有连接**时才会立刻到，所以必须真的回调一次
   * （不能 fire-and-forget：那会让「停掉后端口释放」不可验）。重复调用无害。
   */
  stop(): void {
    const server = this.server
    this.server = undefined
    this.boundPort = null
    if (server === undefined) return
    try {
      server.closeAllConnections?.()
      server.close()
    } catch (error) {
      // ⚠ 「端口已占用 / 未在运行」这类**幂等**异常直接忽略：停止路径不该因它而抛。
      this.log?.(`[channel-pack] zcode 载体页小服务关闭时忽略了一个异常：${
        error instanceof Error ? error.message : String(error)
      }`)
    }
  }

  /** 选端口 → 占一下 → 真监听。全部失败回 `false`（调用方据此换下一个候选）。 */
  private async listen(): Promise<void> {
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      const candidate = this.pickCandidate()
      // ⚠ 「避开 0」：`0` 是「让系统挑一个」的请求值，拿它拼 URL 之前什么地址都没有。
      if (!Number.isInteger(candidate) || candidate <= 0 || candidate > 65_535) continue
      if (!(await isPortFree(candidate))) continue
      const bound = await this.tryListen(candidate)
      if (!bound) continue
      this.boundPort = candidate
      this.log?.(`[channel-pack] zcode 载体页小服务已启动：${String(this.url())}（仅回环 / 仅一页静态 / 无凭据）`)
      return
    }
    this.log?.('[channel-pack] zcode 载体页小服务起不来（候选端口全被占）⇒ 内部载体本轮不可用')
  }

  /** 真绑一次端口。成功 ⇒ 记下 server 并回 true；`EADDRINUSE` 之类 ⇒ 回 false（换候选）。 */
  private tryListen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createHttpServer((request, response) => { this.handle(request, response) })
      const settle = (ok: boolean): void => { resolve(ok) }
      server.once('error', () => {
        try { server.close() } catch { /* 还没起来，close 可能抛 */ }
        settle(false)
      })
      server.once('listening', () => {
        this.server = server
        settle(true)
      })
      try {
        // ⚠ host 必须**显式**给 `127.0.0.1`：不写就是「所有网卡」，局域网里的别的机器能直接打开这页。
        server.listen(port, '127.0.0.1')
      } catch {
        settle(false)
      }
    })
  }

  /**
   * 唯一的 handler：只服务 `GET /carrier`，其余一律拒。
   *
   * ⚠ 判**路径**而不是「路径含 carrier」：`/api/channel-pack/captcha-carrier`（插件自己那条
   * 旧路由）在这个服务上必须 404，否则两处语义会悄悄合并成一条。
   */
  private handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void {
    const path = (request.url ?? '').split('?')[0]
    if (path !== CARRIER_PAGE_ROUTE) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
      response.end('method not allowed')
      return
    }
    void this.sendCarrierPage(response)
  }

  /** 现渲染那一页（配置跟着远端 60 秒 TTL 变，缓存这份只会拿旧 SceneId）。 */
  private async sendCarrierPage(response: import('node:http').ServerResponse): Promise<void> {
    let html: string
    try {
      html = await this.renderPage()
    } catch (error) {
      this.log?.(`[channel-pack] zcode 载体页渲染失败：${
        error instanceof Error ? error.message : String(error)
      }`)
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('carrier page render failed')
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(html)
  }
}
