/**
 * 每账号代理 → undici Dispatcher。
 *
 * ## 两条实现路线（设计文档 §3）
 *
 * - **HTTP(S)**：undici 的 `ProxyAgent`。⚠️ 必须传
 *   `clientFactory` + `pipelining: 0` —— 默认的 keep-alive 连接池会被
 *   Clash 类代理静默关闭空闲 CONNECT 隧道，导致请求挂死
 *   （opencode2dsh / dsh-llm-proxy 都实测踩过，数据 2/10 → 10/10）。
 * - **SOCKS5**：Node 生态**没有**可用的纯 JS 栈（npm 的 `socks-proxy-agent`
 *   是给 node:http 的 Agent，不是 undici Dispatcher），故自实现最小
 *   CONNECT 隧道：RFC 1928 握手 + RFC 1929 认证 + CONNECT，
 *   **不**自写加密协议栈（设计文档 §8 明确排除）。
 *
 * ## 作用域：仅本 provider
 *
 * 只在 `fetch(url, { dispatcher })` 里逐请求传入，**不动全局 dispatcher**
 * （opencode2dsh 的 R1 教训：两个插件抢全局槽位会互相短路整个路由层）。
 *
 * ## ⚠️ 依赖说明
 *
 * 本模块是**全仓库唯一**新增的 npm 依赖（undici）。原本的设计要求「零新依赖」，
 * 但 per-request 代理的 `ProxyAgent` / 可插 connector 的 `Agent` 都住在 undici
 * 里，而它既不在本仓库依赖中、也无法从 Node 内部路径 require 到
 * （`node:undici` 不存在、`globalThis.ProxyAgent` 未定义、
 * `--use-env-proxy` 是**进程全局**的，给不了「每账号不同出口」）。
 * 用户已确认接受这一处破例。
 */

import { Agent, Pool, ProxyAgent } from 'undici'
import type { Dispatcher } from 'undici'
import { connect as netConnect, type Socket } from 'node:net'
import { URL } from 'node:url'
import type { NormalizedProxy } from './opencode.js'

/** LRU 上限：连接是惰性建立的，缓存过多实例只是占内存。 */
const PROXY_CACHE_LIMIT = 16

const cache = new Map<string, Dispatcher>()

/** 取（或建）该代理地址的 Dispatcher。 */
export function buildProxyDispatcher(proxy: NormalizedProxy): Dispatcher {
  const existing = cache.get(proxy.url)
  if (existing !== undefined) return existing
  const created = createProxyDispatcher(proxy)
  // 触碰即移到末尾，实现 LRU 的淘汰顺序
  cache.delete(proxy.url)
  cache.set(proxy.url, created)
  while (cache.size > PROXY_CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    const victim = cache.get(oldest.value)
    cache.delete(oldest.value)
    if (victim !== undefined) {
      // 淘汰路径不 await（失败只落在实例内部，不该拖慢请求路径）；
      // 插件 dispose 时 closeAllProxyDispatchers 会兜底等待。
      void Promise.resolve(victim.close?.()).catch(() => {})
    }
  }
  return created
}

/** 创建独立生命周期的代理，供渠道共享出网层管理，不占每账号代理缓存。 */
export function createProxyDispatcher(proxy: NormalizedProxy): Dispatcher {
  return proxy.kind === 'http' ? buildHttpDispatcher(proxy.url) : buildSocksDispatcher(proxy)
}

/** 当前缓存的代理实例数（诊断用）。 */
export function proxyCacheSize(): number {
  return cache.size
}

/** 关闭并清空全部缓存实例（插件 dispose 路径）。 */
export async function closeAllProxyDispatchers(): Promise<void> {
  const all = [...cache.values()]
  cache.clear()
  await Promise.allSettled(all.map(async (d) => {
    try {
      await d.close()
    } catch {
      // 已被对端断开的实例 close() 会抛；这在 dispose 路径无关紧要
    }
  }))
}

/** HTTP(S) 代理：ProxyAgent + 禁用代理侧 keep-alive 复用。 */
function buildHttpDispatcher(url: string): Dispatcher {
  return new ProxyAgent({
    uri: url,
    // ⚠️ `pipelining: 0` 是必需的（见模块头）；`clientFactory` 由 undici 在
    // 每次建连时调用，用它把默认 Pool 换成禁用复用的 Pool。
    clientFactory: (origin: string, opts: object) => new Pool(origin, { ...(opts as object), pipelining: 0 } as never),
  } as never)
}

/**
 * SOCKS5 握手的**首帧**（可单测的纯函数）。
 *
 * - 无认证 → `[0x05, 0x01, 0x00]`（VER=5，NMETHODS=1，METHOD=NO AUTH）
 * - 有认证 → `[0x05, 0x02, 0x00, 0x02]`（NMETHODS=2，NO AUTH + USER/PASS）
 *
 * ⚠️ 凭据用 `decodeURIComponent` 解码：用户在 URL 里写 `%40` 表示 `@`。
 */
export function buildSocks5Handshake(proxy: Pick<NormalizedProxy, 'url'>): Uint8Array {
  const parsed = new URL(proxy.url)
  const wantsAuth = parsed.username.length > 0
  return wantsAuth
    ? new Uint8Array([0x05, 0x02, 0x00, 0x02])
    : new Uint8Array([0x05, 0x01, 0x00])
}

/** 走 SOCKS5 代理建立一条到 `host:port` 的 TCP 隧道。 */
async function openSocks5Tunnel(proxy: NormalizedProxy, host: string, port: number): Promise<Socket> {
  const parsed = new URL(proxy.url)
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = netConnect({ host: parsed.hostname, port: Number(parsed.port) })
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
  // ⚠️ 这里**不能**写 `const fail = (e) => reject(e)`：`reject` 只是上面那个
  // `new Promise` 执行器的作用域参数，在外层函数里已不存在（写出来会变成
  // ReferenceError，把「认证失败」变成「代码崩溃」——typecheck 抓到的真实 bug）。
  // 正确做法是直接 throw：本函数整体被 try/catch 包住，catch 负责 destroy socket。
  const fail = (error: Error): never => {
    throw error
  }
  const write = (bytes: Uint8Array): Promise<void> => new Promise((resolve, reject) => {
    socket.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve()))
  })

  /**
   * 带缓冲的定长读取器。
   *
   * ## ⚠️ 为什么必须跨调用保存余量（真实 bug，由 `opencode-proxy-live.spec.ts` 抓到）
   *
   * TCP **不保证**按我们的读请求切包：SOCKS5 服务端常把整个 10 字节 REPLY
   * 一次写完，而握手要分三次读（2 字节方法应答、4 字节前缀、6 字节地址端口）。
   * 若每次 `read(n)` 只取走 n 字节、**丢弃同 chunk 里的其余字节**，
   * 第二次 `read(6)` 就会永远等不到数据 —— 表现为握手卡死直到 undici 超时。
   *
   * ⇒ 余量必须留到下一次 `read` 里用。这也是本函数不用
   * `socket.once('data')` 逐次读取的根本原因。
   */
  let leftover: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let pending: { n: number; resolve: (value: Uint8Array) => void; reject: (err: Error) => void } | undefined

  const detach = (): void => {
    socket.off('data', onData)
    socket.off('error', onError)
    socket.off('close', onClose)
  }
  const fulfill = (): void => {
    if (pending === undefined || leftover.length < pending.n) return
    const n = pending.n
    const target = pending
    pending = undefined
    const value = new Uint8Array(leftover.subarray(0, n))
    leftover = leftover.subarray(n)
    detach()
    target.resolve(value)
  }
  const onData = (chunk: Buffer): void => {
    leftover = leftover.length === 0 ? chunk : Buffer.concat([leftover, chunk])
    fulfill()
  }
  const onError = (error: Error): void => {
    const target = pending
    pending = undefined
    detach()
    target?.reject(error)
  }
  // ⚠️ 对端在应答中途关闭时必须 reject：否则这个 Promise 永不 settle，
  // 请求会挂到 undici 自己的超时才结束，用户看到的是「转圈很久才失败」。
  const onClose = (): void => {
    const target = pending
    pending = undefined
    detach()
    target?.reject(new Error('SOCKS5 代理在握手完成前关闭了连接'))
  }

  const read = (n: number): Promise<Uint8Array> => new Promise((resolve, reject) => {
    if (n <= 0) {
      resolve(new Uint8Array(0))
      return
    }
    // 一次只允许一个在途请求：本模块的握手步骤是严格串行 await 的
    pending = { n, resolve, reject }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    fulfill()
  })

  try {
    await write(buildSocks5Handshake(proxy))
    const methodReply = await read(2)
    const method = methodReply[1]
    if (method === 0x02) {
      const user = Buffer.from(decodeURIComponent(parsed.username), 'utf8')
      const pass = Buffer.from(decodeURIComponent(parsed.password), 'utf8')
      // RFC 1929：VER=1 ULEN uname PLEN passwd
      await write(new Uint8Array([0x01, user.length, ...user, pass.length, ...pass]))
      const authReply = await read(2)
      if (authReply[1] !== 0x00) fail(new Error('SOCKS5 用户名/密码认证失败'))
    } else if (method !== 0x00) {
      fail(new Error(`SOCKS5 服务端要求未知认证方式 0x${(method ?? 0).toString(16)}`))
    }

    // CONNECT：VER CMD=0x01 RSV ATYP=0x03(域名) LEN host PORT
    // ⚠️ 端口必须转成**无符号 16 位**：`port >> 8` 在 >32767 时是负数，
    // 写进帧里会变成错误的字节（443/1080 之类常用值没事，但 40000+ 会坏）。
    const target = Buffer.from(host, 'utf8')
    await write(new Uint8Array([
      0x05, 0x01, 0x00, 0x03, target.length, ...target,
      (port >>> 8) & 0xff, port & 0xff,
    ]))
    // ⚠️⚠️ **必须读完整个应答，不能只读 4 字节前缀**（真实 bug，由
    // `opencode-proxy-live.spec.ts` 的真实联通测试抓到）：
    // RFC 1928 的 REPLY 里 BND.ADDR/BND.PORT 是**变长**的（ATYP 决定），
    // 只取前 4 字节会把剩余 6~18 字节留在 socket 缓冲里，随后被 undici
    // 当成 HTTP/TLS 数据读走 —— 表现为握手成功后紧跟一个莫名其妙的解析错误，
    // 或者响应流里凭空多出垃圾字节。
    const reply = await read(4)
    if (reply[1] !== 0x00) {
      fail(new Error(`SOCKS5 CONNECT 被拒绝（应答码 0x${(reply[1] ?? 0).toString(16)}）`))
    }
    const atyp = reply[3]
    if (atyp === 0x01) await read(4 + 2)
    else if (atyp === 0x04) await read(16 + 2)
    else if (atyp === 0x03) await read(1).then((lenByte) => read((lenByte[0] ?? 0) + 2))
    // 未知 ATYP：无法确定剩余长度，握手已成功但不能安全继续
    else fail(new Error(`SOCKS5 应答的地址类型 0x${(atyp ?? 0).toString(16)} 不受支持`))

    // ⚠️ **不要**在交出前 pause：undici 接管后不会 resume 一个已暂停的
    // socket（它假定 connector 交回的是流动的），实测会让请求挂到超时。
    // 握手期间的字节也不会丢 —— 我们的 `data` 监听在每次 read 结束时已摘除，
    // 剩余数据留在 Node 的流缓冲里，undici 挂上 reader 后照常读出。
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/**
 * SOCKS5 Dispatcher：把自定义 connector 交给 undici 的 `Agent`。
 *
 * 隧道 socket 交给 undici 后，它会继续在上面做 TLS 握手与 HTTP/1.x 收发。
 * ⚠️ 端口取不到时退回 443：目标是 https（Zen 端点）时 undici 不会给显式端口。
 */
function buildSocksDispatcher(proxy: NormalizedProxy): Dispatcher {
  return new Agent({
    connect: ((opts: { hostname?: string; host?: string; port?: number | string }, callback: (err: Error | null, socket?: unknown) => void) => {
      const host = String(opts.hostname ?? opts.host ?? '')
      const port = Number(opts.port ?? 443)
      if (host.length === 0) {
        callback(new Error('SOCKS5 代理：目标 host 为空'), undefined)
        return
      }
      openSocks5Tunnel(proxy, host, port)
        .then((socket) => { callback(null, socket) })
        .catch((error: Error) => { callback(error, undefined) })
    }) as never,
  } as never)
}
