/**
 * 国内渠道在 fake-ip 透明代理下的真实 IP 直连。
 *
 * ## 为什么需要它
 *
 * 代理以 fake-ip 模式接管 DNS 时（TUN + `198.18.0.0/15`），所有域名都被解析成
 * 伪地址，代理再按**域名规则**选出口。国内渠道域名（`copilot.tencent.com` 等）
 * 因此被送往海外节点；而这些服务对来源做地域校验，在 TLS 握手阶段就重置连接。
 *
 * 实测（同机、同出口，只改解析结果）：
 * - fake-ip：`schannel: failed to receive handshake`，TLS 不建立；
 * - 真实国内 IP：`HTTP 200`，`auth/state` 正常返回。
 *
 * 现象与内容无关（空 body 也失败），所以**不能**靠重试或改请求头绕过。
 *
 * ## 做法
 *
 * 先用 **DoH 取真实 IP**（`223.5.5.5` 是 IP 字面量，fake-ip 模式下仍可直连、
 * 不经本地 DNS 劫持），再**连该 IP**（`servername`/`Host` 仍是原域名），让
 * TUN 栈看到 CN 目的地址从而命中 `GEOIP,CN,DIRECT`。
 *
 * ## 边界
 *
 * 只对**国内域名**生效，且只在调用方**没有**指定代理时才接管：
 * - 海外渠道（`www.workbuddy.ai` 等）走原有路径，行为零变化 —— 它们的出口地域
 *   校验方向相反，强制直连反而会失败；
 * - 调用方显式给了 `dispatcher`（插件出口代理等）时一律让路，不越过用户选择；
 * - `OFM_DOMESTIC_DIRECT=0` 可整体关闭，退回纯 `fetchImpl` 语义。
 *
 * 后两条是刻意设计的：本模块只处理「fake-ip 把国内流量误送海外」这一种情形，
 * 不改变任何既有的代理优先级。
 */
import { lookup as defaultLookup } from 'node:dns'
import { Agent, fetch as undiciFetch } from 'undici'

/**
 * 需要真实 IP 直连的国内渠道域名后缀。
 *
 * 收录标准：中国大陆服务商、且已被证实对海外出口做来源校验。
 * **不含** `workbuddy.ai` —— 它是国际站点，海外出口是正常且首选路径。
 */
const DOMESTIC_HOST =
  /(^|\.)(tencent\.com|codebuddy\.cn|qoder\.com\.cn|trae\.cn|trae\.com\.cn|huaweicloud\.com|sensenova\.cn|bigmodel\.cn|volces\.com|stepfun\.com|modelbest\.cn)$/i

/** DoH 单次超时；失败一律回退系统 DNS，不改变原有失败语义。 */
const DOH_TIMEOUT_MS = 8_000

/** AliDNS 的 JSON 接口。用 IP 字面量，避免 fake-ip 模式下再次被劫持。 */
const DOH_ENDPOINT = 'https://223.5.5.5/resolve'

export function isDomesticHost(hostname: string): boolean {
  return DOMESTIC_HOST.test(hostname)
}

/** 域名是否属于「需要真实 IP 直连」的国内渠道。非法 URL 返回 false，交给原路径报错。 */
export function isDomesticUrl(input: string | URL): boolean {
  try {
    return isDomesticHost(new URL(String(input)).hostname)
  } catch {
    return false
  }
}

/** 开关：默认开启；`0` / `off` / `false` 关闭。 */
export function domesticDirectEnabled(): boolean {
  const flag = (process.env.OFM_DOMESTIC_DIRECT ?? '').trim().toLowerCase()
  return !(flag === '0' || flag === 'off' || flag === 'false')
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
 * 回退是刻意保留的 —— DoH 不可用（离线、被拦截）时应退化为原有行为，
 * 而不是让渠道整体不可用。
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
      // Node 22+ 的 verbatim 要求返回地址数组；老式回调要 (err, address, family)。
      if (opts.all === true || opts.verbatim === true) done(null, [{ address, family: 4 }])
      else done(null, address, 4)
    })
    .catch(fallback)
}

let agent: Agent | undefined

/**
 * 国内直连用的 dispatcher（进程内复用，保持连接池）。
 *
 * ⚠️ 必须配 undici 的 `fetch` 使用，**不能**喂给 `globalThis.fetch`：宿主可能没
 * 安装 undici 的全局实现（本仓库的 `install()` 并未被调用），此时
 * `globalThis.fetch` 是 Node 内置实现，与这里创建的 `Agent` 属不同实例，
 * 跨实例传 `dispatcher` 不可靠。
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
 * 判断这次请求是否该走国内直连。
 *
 * 条件全部成立才接管：国内域名 + 未显式指定 dispatcher + 开关打开。
 */
export function shouldUseDomesticDirect(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): boolean {
  if ((init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher !== undefined) return false
  if (!domesticDirectEnabled()) return false
  return isDomesticUrl(input instanceof Request ? input.url : String(input))
}

/**
 * 用真实 IP 直连发出请求。
 *
 * `undiciFetch` 与 `domesticDispatcher()` 配对使用（见 `domesticDispatcher` 的说明）。
 */
export function domesticDirectFetch(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): Promise<Response> {
  return undiciFetch(input as never, {
    ...init,
    dispatcher: domesticDispatcher(),
  } as never) as unknown as Promise<Response>
}
