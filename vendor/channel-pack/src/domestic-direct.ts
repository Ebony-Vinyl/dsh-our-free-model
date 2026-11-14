/**
 * 国内渠道在透明代理（fake-ip TUN）下的直连绕行。
 *
 * 问题：代理以 fake-ip 模式接管 DNS 时，国内渠道域名（`copilot.tencent.com`
 * 等）会被解析到 `198.18.0.0/15` 的伪地址，代理再按其**域名规则**把请求送往
 * 海外节点；国内服务（腾讯/阿里/华为等）拒绝海外来源，在 TLS 握手阶段就重置
 * 连接 —— 表现为 `ECONNRESET` / `fetch failed`，且**与内容无关**（空 body 也失败）。
 *
 * 实测（同一机器、同一出口、仅改解析结果）：
 *   - 走 fake-ip：`schannel: failed to receive handshake`，TLS 不建立；
 *   - 直连真实国内 IP：`HTTP 200`，`auth/state` 正常返回 `authUrl`。
 *
 * 因此：先用 **DoH 解析真实 IP**（`223.5.5.5` 是 IP 字面量，fake-ip 模式下
 * 仍可直连，不经过本地 DNS 劫持），再**直连该 IP**（`servername`/`Host` 仍是
 * 原域名），让 TUN 栈看到 CN 目的地址从而命中 `GEOIP,CN,DIRECT`。
 *
 * 只对国内域名生效；海外渠道（`www.workbuddy.ai` 等）继续走调用方原有路径，
 * 行为完全不变 —— 这类服务的出口地域校验与国内相反，强制直连反而会失败。
 */
import { lookup as defaultLookup } from 'node:dns'
import { Agent, fetch as undiciFetch } from 'undici'

/**
 * 需要真实 IP 直连的国内渠道域名后缀。
 *
 * 收录标准：中国大陆服务商、且已被证实对海外出口做来源校验。不含
 * `workbuddy.ai` —— 它是国际站点，海外出口是正常且首选路径。
 */
const DOMESTIC_HOST = /(^|\.)(tencent\.com|codebuddy\.cn|qoder\.com\.cn|trae\.cn|trae\.com\.cn|huaweicloud\.com|sensenova\.cn|bigmodel\.cn|volces\.com|stepfun\.com|modelbest\.cn)$/i

/** DoH 解析单次超时；解析失败一律回退系统 DNS，不改变失败语义。 */
const DOH_TIMEOUT_MS = 8_000

/** AliDNS 的 JSON 接口。用 IP 字面量，避免 fake-ip 模式下再次被劫持。 */
const DOH_ENDPOINT = 'https://223.5.5.5/resolve'

export function isDomesticHost(hostname: string): boolean {
  return DOMESTIC_HOST.test(hostname)
}

export function isDomesticUrl(input: string | URL): boolean {
  try {
    return isDomesticHost(new URL(String(input)).hostname)
  } catch {
    // 非法 URL 交给原路径去报错，这里不吞掉详情。
    return false
  }
}

/** DoH 查询 A 记录；无 A 记录或网络失败时抛出，由调用方回退。 */
async function resolveOverDoh(hostname: string): Promise<string> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=A`
  const response = await undiciFetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`DoH responded ${response.status}`)
  const payload = (await response.json()) as { Answer?: Array<{ type?: number; data?: string }> }
  const address = (payload.Answer ?? []).find(row => row.type === 1)?.data
  if (address === undefined || address === '') throw new Error(`DoH returned no A record for ${hostname}`)
  return address
}

/**
 * 国内域名的 lookup：先 DoH，失败回退系统解析器。
 *
 * 回退是刻意保留的 —— DoH 不可用时（离线、被防火墙拦截）应退化为原有行为，
 * 而不是让渠道完全不可用。
 */
function domesticLookup(
  hostname: string,
  options: { all?: boolean; verbatim?: boolean } | ((...args: never[]) => void),
  callback?: (...args: never[]) => void,
): void {
  const done = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void
  const opts = (typeof options === 'function' ? {} : options) as { all?: boolean; verbatim?: boolean }
  const fallback = () => defaultLookup(hostname, opts as never, done as never)
  if (!isDomesticHost(hostname)) {
    fallback()
    return
  }
  resolveOverDoh(hostname)
    .then((address) => {
      // Node 22+ 的 verbatim 模式要求返回地址数组；老式回调要 (err, addr, family)。
      if (opts.all === true || opts.verbatim === true) done(null, [{ address, family: 4 }])
      else done(null, address, 4)
    })
    .catch(fallback)
}

let agent: Agent | undefined

/**
 * 国内直连用的 dispatcher（进程内复用，保持连接池）。
 *
 * 用 undici 的 `fetch` + `Agent` 配对，而**不是** `globalThis.fetch`：宿主可能
 * 尚未安装 undici 的全局实现（本仓库的 `install()` 并未被调用），此时
 * `globalThis.fetch` 是 Node 内置实现，与这里创建的 `Agent` 属不同实例，
 * 跨实例传入 `dispatcher` 不可靠。
 */
export function domesticDispatcher(): Agent {
  agent ??= new Agent({ connect: { lookup: domesticLookup as never } })
  return agent
}

/** 测试与关停用：释放连接池。 */
export async function closeDomesticDispatcher(): Promise<void> {
  const current = agent
  agent = undefined
  await current?.close()
}

/**
 * 国内域名 → 真实 IP 直连；其余域名 → 原样交给 `fallback`。
 *
 * `fallback` 由调用方注入（宿主 fetch 或 `createChannelFetch` 的 `fetchImpl`），
 * 保持“非国内流量行为零变化”。
 */
/**
 * 国内直连是否启用（默认启用，可用环境变量关闭）。
 *
 * 关闭开关的存在意义：出网走 `globalThis.fetch` 是本插件的既有契约 —— 宿主可能
 * 在那个位置装审计/限流/录制的实现，离线测试也靠替换它来断言"不会真的发请求"。
 * 国内直连必须**绕开 DNS 劫持**，因此无法经由被替换的 fetch 完成；把开关留给
 * 这类环境，让它们可以退回纯 fetch 语义。
 */
function domesticDirectEnabled(): boolean {
  const flag = (process.env.OFM_DOMESTIC_DIRECT ?? '').trim().toLowerCase()
  return !(flag === '0' || flag === 'off' || flag === 'false')
}

export function createDomesticFetch(fallback?: typeof fetch): typeof fetch {
  // 调用方显式给的 fallback 永远优先。
  if (fallback !== undefined) return fallback

  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const explicit = (init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher
    const domestic = explicit === undefined
      && domesticDirectEnabled()
      && isDomesticUrl(input instanceof Request ? input.url : String(input))
    // 非国内域名 / 已指定 dispatcher / 直连被关闭 → 完全走全局 fetch，
    // 与既有行为逐字节一致，宿主与测试的替换都能正常生效。
    if (!domestic) return globalThis.fetch(input, init)
    return undiciFetch(input as never, { ...init, dispatcher: domesticDispatcher() } as never) as unknown as Promise<Response>
  }) as typeof fetch
}
