/**
 * Qoder 设备码登录流程（PKCE + 轮询）。
 *
 * ## 与其它 provider 的差异
 *
 * ## 两步式的必要性
 *
 * 浏览器只在用户点击后的短暂窗口（transient activation，约 5 秒）内允许
 * `window.open`。若把「生成 URL → 打开 → 等授权」做成一次阻塞调用，
 * 调用方拿到 URL 时手势已过期，弹窗被拦截（返回 null），前端兜底若执行
 * `window.location.href = loginUrl` 会把**整个设置页**导航走（真实缺陷）。
 * 故提供 {@link startQoderLoginFlow} 立即返回 URL，由前端先开窗再等结果。
 *
 * 协议依据：`docs/superpowers/specs/2026-09-19-qoder-provider-design.md` §2.3。
 */

import {
  QODER_LOGIN_TIMEOUT_MS,
  QODER_POLL_INTERVAL_MS,
  QODER_POLL_MAX_FAILURES,
  buildQoderAuthUrl,
  buildQoderCredential,
  buildQoderPollUrl,
  createQoderDeviceSession,
  isQoderRefreshable,
  parseQoderTokenPayload,
  qoderCredentialExpiresAtMs,
  type QoderCredential,
  type QoderDeviceSession,
  type QoderTokenPayload,
} from './qoder.js'
import type { QoderProduct } from './qoder-product.js'

/** 在浏览器中打开 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>

/** 一次登录流程的结果。 */
export interface QoderLoginFlowResult {
  /** 已序列化的 `QoderCredential` JSON 字符串（直接存入 ctx.credentials）。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
  /** 本次登录使用的设备标识（需随凭据持久化）。 */
  machineId: string
}

/** `startQoderLoginFlow` 接受的选项。 */
export interface QoderLoginFlowOptions {
  /** 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 打开登录 URL 的方式；默认用平台打开器。 */
  openBrowser?: OpenBrowser
  /** 登录等待总超时（毫秒）；默认 5 分钟。 */
  timeoutMs?: number
  /** 轮询间隔（毫秒）；默认 1000。 */
  pollIntervalMs?: number
  /** 外部取消信号。 */
  signal?: AbortSignal
  /** 产品配置。 */
  product: QoderProduct
}

/** 睡眠（可被 signal 中断）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('登录已取消'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('登录已取消'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 本函数自身抛出的确定性错误前缀（用于与网络错误区分）。 */
const SERVER_ERROR_PREFIX = '登录服务返回异常'

/**
 * 是否已取消。
 *
 * 抽成函数而非内联 `signal?.aborted === true`：TS 的控制流分析会把
 * 「循环开头检查过、为假才进入 try」这一事实带进 catch 块，从而认定
 * catch 里的同一个比较**恒为假**（报 TS2367 no overlap）。
 * 但运行时 signal 完全可能在 `await` 期间被 abort —— 用函数调用切断
 * 这条收窄路径，既让类型检查通过，也保留了「await 后重新确认」的正确语义。
 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/**
 * 轮询直到拿到 token。
 *
 * **404 表示「用户尚未完成授权」，必须继续轮询**（源码
 * `if (404 === A.status) { await sleep(...); continue }`）。
 * 实测依据：`openapi.qoder.sh/api/v1/deviceToken/poll` 返回 404
 * `{"errorCode":"NotFound"}`，而任意不存在的路径返回 401
 * —— 说明该端点存在且被网关豁免认证，404 是业务层的「会话未就绪」。
 *
 * 网络失败容忍 {@link QODER_POLL_MAX_FAILURES} 次连续失败；
 * 其它非 2xx（如 5xx）立即抛错 —— 那是服务端异常，不是「等用户」。
 */
export async function pollQoderDeviceToken(
  session: QoderDeviceSession,
  options: QoderLoginFlowOptions,
): Promise<QoderTokenPayload> {
  const fetcher = options.fetcher ?? fetch
  const pollUrl = buildQoderPollUrl(session, options.product)
  const interval = options.pollIntervalMs ?? QODER_POLL_INTERVAL_MS
  const deadline = Date.now() + (options.timeoutMs ?? QODER_LOGIN_TIMEOUT_MS)
  let failures = 0

  while (Date.now() < deadline) {
    if (isAborted(options.signal)) throw new Error('登录已取消')
    try {
      const response = await fetcher(pollUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      failures = 0
      if (response.status === 404) {
        await sleep(interval, options.signal)
        continue
      }
      if (!response.ok) {
        throw new Error(`${SERVER_ERROR_PREFIX}（HTTP ${response.status}）`)
      }
      const payload = parseQoderTokenPayload(await response.json() as unknown)
      if (payload.accessToken.length > 0) return payload
      // 2xx 但尚无 token：同样继续轮询
      await sleep(interval, options.signal)
    } catch (error) {
      if (isAborted(options.signal)) throw new Error('登录已取消')
      // 「登录服务返回异常」是本函数自己抛的确定性错误，直接冒泡
      if (error instanceof Error && error.message.startsWith(SERVER_ERROR_PREFIX)) throw error
      failures += 1
      if (failures >= QODER_POLL_MAX_FAILURES) {
        throw new Error(
          `无法连接 Qoder 登录服务（连续 ${failures} 次失败）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
      await sleep(interval, options.signal)
    }
  }
  throw new Error('登录等待已超时，请重新发起登录')
}

/** 把凭据包成一次登录流程的结果。 */
function toLoginFlowResult(
  credential: QoderCredential,
  loginUrl: string,
  machineId: string,
): QoderLoginFlowResult {
  return {
    access: JSON.stringify(credential),
    // 与其它 provider 一致：无法解析过期时间时报 0，而不是抛错 ——
    // 凭据本身可用（只是有效期未知），不该因展示层缺失而登录失败。
    expires: qoderCredentialExpiresAtMs(credential) ?? 0,
    loginUrl,
    refreshable: isQoderRefreshable(credential),
    machineId,
  }
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const { openBrowser } = await import('./open-browser.js')
  openBrowser(url)
}

/** 已启动但尚未完成的登录流程（两步式登录用）。 */
export interface StartedQoderLoginFlow {
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 用户完成授权（或超时/失败）后落定的结果。 */
  result: Promise<QoderLoginFlowResult>
  /** 取消登录（中止轮询）；**幂等**。 */
  close: () => Promise<void>
}

/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * 设备码流程天然是「先拿 URL → 打开 → 后台轮询」，故无需起服务器，
 * 也没有端口可泄漏。`close()` 通过 abort 取消轮询。
 */
export async function startQoderLoginFlow(
  options: QoderLoginFlowOptions,
): Promise<StartedQoderLoginFlow> {
  const session = createQoderDeviceSession()
  const loginUrl = buildQoderAuthUrl(session, options.product)
  const controller = new AbortController()
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, options.signal])

  const result = (async (): Promise<QoderLoginFlowResult> => {
    const payload = await pollQoderDeviceToken(session, { ...options, signal })
    if (payload.accessToken.length === 0) {
      throw new Error('登录响应缺少访问令牌')
    }
    const credential = buildQoderCredential(payload, { machineId: session.machineId })
    return toLoginFlowResult(credential, loginUrl, session.machineId)
  })()
  // 这个 Promise 是手工创建的、要过一会儿才交给调用方消费，
  // 期间可能已被 reject（如轮询立刻失败）。先挂空处理器避免
  // Node 报「未处理的拒绝」，不影响后续消费者拿到同一拒绝原因。
  result.catch(() => {})

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    controller.abort()
  }

  return { loginUrl, result, close }
}

/**
 * 运行完整登录流程：打开授权页 → 轮询 → 返回凭据。
 *
 * 阻塞语义：等用户完成授权后才返回。需要「立即拿到 URL」的场景
 * （Channel Pack 两步式登录）请用 {@link startQoderLoginFlow}。
 */
export async function runQoderLoginFlow(
  options: QoderLoginFlowOptions,
): Promise<QoderLoginFlowResult> {
  const open: OpenBrowser = options.openBrowser ?? defaultOpenBrowser
  const started = await startQoderLoginFlow(options)
  try {
    await open(started.loginUrl)
    return await started.result
  } finally {
    await started.close()
  }
}
