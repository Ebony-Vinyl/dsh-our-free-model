/**
 * PR #483 的签名传输隔离：默认使用包内 undici，不读取 globalThis.fetch。
 * 出口选择仍复用 channel-fetch（插件出口 > 环境代理 > Windows 手动代理）。
 * direct 只表示不经过全局 fetch，并不表示忽略用户代理。
 */
import { Agent, fetch as undiciFetch } from 'undici'
import { createChannelFetch, type ChannelFetchOptions, type ChannelOutlet } from './channel-fetch.js'

/** 插件出口需将提供的底层发送函数用于本机 relay，避免重新进入全局 fetch。 */
export interface SignedChannelOutlet extends ChannelOutlet {
  fetchSigned?: (input: Parameters<typeof fetch>[0], init: RequestInit | undefined, send: typeof fetch) => Promise<Response>
}

export type DirectFetchOptions = Omit<ChannelFetchOptions, 'outlet'> & { outlet?: SignedChannelOutlet }

/** 沿用 PR #483 的离线测试入口；生产代码不写入它，显式 fetchImpl 始终优先。 */
export const directLane: { fetch: typeof fetch | null } = { fetch: null }

export function createDirectFetch(options: DirectFetchOptions = {}): { fetch: typeof fetch; close: () => Promise<void> } {
  // 独立 Agent 同时避免其它插件修改 undici 的全局 dispatcher；仅销毁自己拥有的资源。
  const agent = new Agent()
  const lifetime = new AbortController()
  let closing: Promise<void> | undefined
  const send: typeof fetch = async (input, init) => {
    const injected = options.fetchImpl ?? directLane.fetch
    if (injected) return injected(input, init)
    const dispatcher = (init as RequestInit & { dispatcher?: unknown })?.dispatcher ?? agent
    let target: string | URL = input as string | URL
    let requestInit = init
    // Node 内置 Request 与包内 undici 的 Request 品牌不同，不能只做类型强转。
    if (input instanceof Request) {
      const request = new Request(input, init)
      target = request.url
      requestInit = {
        method: request.method, headers: request.headers, body: request.body,
        signal: request.signal, redirect: request.redirect, credentials: request.credentials,
        cache: request.cache, integrity: request.integrity, keepalive: request.keepalive,
        mode: request.mode, referrer: request.referrer, referrerPolicy: request.referrerPolicy,
        ...(request.body ? { duplex: 'half' } : {}),
      } as RequestInit
    }
    return undiciFetch(target, { ...requestInit, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
  }
  const outlet = options.outlet
  const network = createChannelFetch({
    ...options,
    fetchImpl: send,
    outlet: outlet && {
      active: () => outlet.active(),
      fetch: (input, init) => {
        if (!outlet.fetchSigned) {
          throw new Error('所选插件出口尚未接入签名传输，请升级出口适配；请求未绕过该出口')
        }
        return outlet.fetchSigned(input, init, send)
      },
    },
  })
  return {
    fetch: async (input, init) => {
      lifetime.signal.throwIfAborted()
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      combined.throwIfAborted()
      return network.fetch(input, { ...init, signal: combined })
    },
    close() {
      if (!closing) {
        lifetime.abort(new DOMException('CodeArts 签名传输已停止', 'AbortError'))
        closing = Promise.allSettled([network.close(), agent.destroy()]).then(() => {})
      }
      return closing
    },
  }
}

// credits RPC 的既有调用没有 fetch 参数；绑定默认传输使其与聊天共享所选出口。
// 每次挂载有独立所有权，旧挂载延迟卸载不能摘掉新挂载的传输。
const mounted = new Set<{ fetch: typeof fetch }>()
export function attachDirectFetch(fetcher: typeof fetch): () => void {
  const binding = { fetch: fetcher }
  mounted.add(binding)
  return () => { mounted.delete(binding) }
}
let fallback: ReturnType<typeof createDirectFetch> | undefined
export const directFetch: typeof fetch = (input, init) => {
  const injected = directLane.fetch ?? [...mounted].at(-1)?.fetch
  if (injected) return injected(input, init)
  fallback ??= createDirectFetch()
  return fallback.fetch(input, init)
}

/** 仅关闭无宿主挂载时惰性创建的传输；宿主实例由各自的 close 管理。 */
export async function closeDirectFetch(): Promise<void> {
  const previous = fallback
  fallback = undefined
  await previous?.close()
}
