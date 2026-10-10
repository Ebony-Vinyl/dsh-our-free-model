/** 渠道请求的代理选择；只传逐请求 dispatcher，不修改宿主全局 fetch。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { Dispatcher1Wrapper, type Dispatcher } from 'undici'
import { normalizeProxy } from './opencode.js'
import { createProxyDispatcher } from './opencode-proxy.js'

export interface ChannelOutlet {
  active: () => boolean
  fetch: typeof fetch
}

interface WindowsProxy {
  server: string
  bypass: string
}

/** 解析手动系统代理；不执行 PAC 脚本，也不读取其它注册表配置。 */
export function parseWindowsProxy(output: string): WindowsProxy | undefined {
  const value = (name: string) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, 'mi').exec(output)?.[1]?.trim() ?? ''
  if (Number(value('ProxyEnable')) !== 1 || value('ProxyServer') === '') return undefined
  return { server: value('ProxyServer'), bypass: value('ProxyOverride') }
}

async function readWindowsProxy(): Promise<string> {
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  try {
    const { stdout } = await promisify(execFile)(executable, [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024, encoding: 'utf8' })
    return stdout
  } catch {
    // 注册表键缺失是正常的无代理配置，不把启动失败传播给其它渠道。
    return ''
  }
}

function loopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/** NO_PROXY 支持域名后缀、通配符、可选端口；系统例外另支持 <local>。 */
export function channelProxyBypassed(target: URL, patterns: string, windows = false): boolean {
  const hostname = target.hostname.toLowerCase()
  const port = target.port || (target.protocol === 'https:' ? '443' : '80')
  return patterns.split(/[;,\s]+/).filter(Boolean).some(raw => {
    let pattern = raw.toLowerCase()
    if (pattern === '*') return true
    if (windows && pattern === '<local>') return !hostname.includes('.') && !hostname.includes(':')
    const withPort = /^(.*):(\d+)$/.exec(pattern)
    if (withPort) {
      if (withPort[2] !== port) return false
      pattern = withPort[1]!
    }
    if (pattern.includes('*')) {
      const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      return new RegExp(`^${escaped}$`, 'i').test(hostname)
    }
    const domain = pattern.replace(/^\./, '')
    return hostname === domain || (!windows && hostname.endsWith(`.${domain}`))
  })
}

function windowsProxyFor(target: URL, config: WindowsProxy): string | undefined {
  if (channelProxyBypassed(target, config.bypass, true)) return undefined
  if (!config.server.includes('=')) return config.server
  const entries = new Map(config.server.split(';').map(row => {
    const at = row.indexOf('=')
    return [row.slice(0, at).trim().toLowerCase(), row.slice(at + 1).trim()]
  }))
  const selected = entries.get(target.protocol.slice(0, -1))
  if (selected) return selected
  const socks = entries.get('socks')
  return socks ? `socks5://${socks.replace(/^socks5h?:\/\//, '')}` : undefined
}

/** 只显示路由类型和错误码，避免将代理密码、OAuth code 或令牌写进日志。 */
export class ChannelNetworkError extends Error {
  override name = 'ChannelNetworkError'
}

function networkFailure(error: unknown, route: string): Error {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return error
  const codes = new Set<string>()
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const record = current as { code?: unknown; cause?: unknown }
    if (typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(record.code)) codes.add(record.code)
    current = record.cause
  }
  return new ChannelNetworkError(`渠道网络请求失败（${route}${codes.size ? `；${[...codes].join('、')}` : ''}）：请检查代理连通性后重试`, { cause: error })
}

export interface ChannelFetchOptions {
  outlet?: ChannelOutlet
  /** 以下依赖可注入，用于离线验证，不读取测试机的真实代理配置。 */
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  readSystemProxy?: () => Promise<string>
  fetchImpl?: typeof fetch
  dispatcherFor?: typeof createProxyDispatcher
}

/** 一次挂载一个实例：插件出口 > 环境代理 > Windows 手动代理 > 直连。 */
export function createChannelFetch(options: ChannelFetchOptions = {}): { fetch: typeof fetch; close: () => Promise<void> } {
  const dispatchers = new Map<string, Dispatcher>()
  let system: Promise<WindowsProxy | undefined> | undefined
  let systemAt = 0
  let closed = false
  const fetchImpl: typeof fetch = (input, init) => (options.fetchImpl ?? globalThis.fetch)(input, init)
  const fetcher: typeof fetch = async (input, init) => {
    if (closed) throw new Error('渠道出网服务已停止')
    const target = new URL(input instanceof Request ? input.url : String(input))
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    signal?.throwIfAborted()
    let route = '直连'
    try {
      // 本机请求不自动加代理；保留调用方明确指定的 dispatcher。
      if ((init as RequestInit & { dispatcher?: unknown })?.dispatcher !== undefined) {
        route = '调用方指定代理'
        return await fetchImpl(input, init)
      }
      if (loopback(target.hostname)) {
        return await fetchImpl(input, init)
      }
      if (options.outlet?.active()) {
        route = '插件出口代理'
        // relay 不允许自动跳转绕过选定出口。
        return await options.outlet.fetch(input, { ...init, redirect: 'error' })
      }
      const env = options.environment ?? process.env
      const envValue = (name: string) => env[name.toLowerCase()] ?? env[name]
      const proxy = (target.protocol === 'https:' ? envValue('HTTPS_PROXY') : envValue('HTTP_PROXY')) || envValue('ALL_PROXY')
      let address: string | undefined
      if (proxy) {
        route = '环境代理'
        if (!channelProxyBypassed(target, envValue('NO_PROXY') ?? '')) address = proxy
      } else if ((options.platform ?? process.platform) === 'win32') {
        if (!system || Date.now() - systemAt >= 30_000) {
          systemAt = Date.now()
          system = (options.readSystemProxy ?? readWindowsProxy)().then(parseWindowsProxy)
        }
        const config = await system
        signal?.throwIfAborted()
        if (closed) throw new Error('渠道出网服务已停止')
        if (config) { address = windowsProxyFor(target, config); route = 'Windows 系统代理' }
      }
      if (!address) {
        if (route !== '直连') route = '直连，代理例外或当前协议无代理'
        return await fetchImpl(input, init)
      }
      // 环境代理允许省略 HTTP(S) 的默认端口；账号表单的解析器要求显式端口。
      const proxyUrl = new URL(address.includes('://') ? address : `http://${address}`)
      const authority = `${proxyUrl.hostname}:${proxyUrl.port || (proxyUrl.protocol === 'https:' ? '443' : proxyUrl.protocol.startsWith('socks') ? '1080' : '80')}`
      const auth = proxyUrl.username ? `${proxyUrl.username}${proxyUrl.password ? `:${proxyUrl.password}` : ''}@` : ''
      const parsed = normalizeProxy(`${proxyUrl.protocol}//${auth}${authority}`)
      if (!parsed.ok) throw new Error('代理地址无效')
      let dispatcher = dispatchers.get(parsed.proxy.url)
      if (!dispatcher) {
        // undici 8 的 handler 契约与 Node 22/24 内置 fetch 不同，使用官方兼容桥。
        dispatcher = options.dispatcherFor ? options.dispatcherFor(parsed.proxy) : new Dispatcher1Wrapper(createProxyDispatcher(parsed.proxy))
        dispatchers.set(parsed.proxy.url, dispatcher)
      }
      return await fetchImpl(input, { ...init, dispatcher } as RequestInit)
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw networkFailure(error, route)
    }
  }
  return {
    fetch: fetcher,
    async close() {
      closed = true
      const all = [...dispatchers.values()]
      dispatchers.clear()
      await Promise.allSettled(all.map(dispatcher => dispatcher.destroy()))
    },
  }
}
