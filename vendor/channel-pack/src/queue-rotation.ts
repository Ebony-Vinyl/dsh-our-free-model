import { AsyncLocalStorage } from 'node:async_hooks'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AccountPool } from './account-pool.js'
import { pickSlot, type IdentitySlot } from './opencode-auth.js'
import { ModelQueuedError, QUEUE_MAX_ATTEMPTS, QUEUE_MAX_DELAY_MS } from './model-queue.js'
import { reportLedgerAccount } from './token-ledger.js'

interface QueueOptions {
  accountPool?: AccountPool
  resolveCredential?: (model?: string) => Promise<unknown>
  refresh?: (accountId?: string, reason?: 'auth') => Promise<unknown>
  currentAccountId?: () => string | undefined
  nextAccount?: (model: string, tried: ReadonlySet<string>) => Promise<{ accountId: string; credential: unknown } | undefined>
  identitySlots?: (model?: string) => Promise<readonly IdentitySlot[]>
}

type Account = NonNullable<Awaited<ReturnType<AccountPool['getAvailableAccount']>>>
interface QueueRequest {
  owner: QueueOptions
  provider: string
  model: string
  tried: Set<string>
  credentialRefreshes: Set<string | undefined>
  authRefreshes: Set<string | undefined>
  account?: Account
  slot?: IdentitySlot
}

const requests = new AsyncLocalStorage<QueueRequest>()

/** OpenCode 的槽在适配器内部选择，按实际发送的槽回报，不能猜账号池默认值。 */
export function reportQueueSlot(slot: IdentitySlot): void {
  const request = requests.getStore()
  if (request?.provider !== 'opencode') return
  request.slot = slot
  request.tried.add(slot.id)
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** 凭据覆盖只活在本次迭代的异步上下文，绝不改适配器的共享默认账号。 */
export function withQueueAccountRotation<O extends QueueOptions, A extends object>(
  provider: string,
  options: O,
  create: (options: O) => A,
  timing: { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): A {
  const now = timing.now ?? Date.now
  const sleep = timing.sleep ?? wait
  const active = () => {
    const request = requests.getStore()
    return request?.owner === options ? request : undefined
  }
  const remember = (request: QueueRequest, account: Account) => {
    request.account = account
    request.tried.add(account.entry.id)
    reportLedgerAccount(provider, account.entry.id)
  }
  const scoped: QueueOptions = { ...options }
  const pool = options.accountPool
  if (pool !== undefined) {
    scoped.accountPool = new Proxy(pool, {
      get(target, prop) {
        if (prop === 'getAvailableAccount') {
          return async (id: string, model: string, excluded?: ReadonlySet<string>) => {
            const request = active()
            const relevant = request !== undefined && id === provider && model === request.model
            const skipped = relevant ? new Set([...request.tried, ...excluded ?? []]) : excluded
            const account = await target.getAvailableAccount(id, model, skipped)
            if (account !== null && relevant) remember(request, account)
            return account
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    if (options.nextAccount !== undefined) {
      scoped.nextAccount = async (model, tried) => {
        const request = active()
        const relevant = request !== undefined && model === request.model
        const next = await options.nextAccount!(model, relevant ? new Set([...tried, ...request.tried]) : tried)
        if (next !== undefined && relevant) {
          const entry = pool.listAccountsByProvider(provider).find(account => account.id === next.accountId)
          if (entry !== undefined) remember(request, { entry, credential: next.credential as Account['credential'] })
        }
        return next
      }
    }
    if (options.resolveCredential !== undefined) {
      scoped.resolveCredential = async model => {
        const request = active()
        if (request?.account !== undefined) {
          const others = new Set(pool.listAccountsByProvider(provider).filter(account => account.id !== request.account!.entry.id).map(account => account.id))
          if (options.nextAccount !== undefined) {
            // 复用原选号策略验证当前账号；不能用 scoped.nextAccount，它会排除当前已试账号。
            const next = await options.nextAccount(request.model, others)
              ?? await options.nextAccount(request.model, request.tried)
            if (next === undefined) {
              throw new LlmError(`${provider}: 当前账号不可用或无法确认余额，且没有符合渠道策略的备用账号`, 'QUEUE')
            }
            const entry = pool.listAccountsByProvider(provider).find(account => account.id === next.accountId && account.enabled
              && !((account.modelRateLimits?.[request.model] ?? 0) > Date.now()))
            if (entry === undefined) throw new LlmError(`${provider}: 当前请求的账号已移除、停用或受限`, 'QUEUE')
            remember(request, { entry, credential: next.credential as Account['credential'] })
            return next.credential
          }
          const next = await pool.getAvailableAccount(provider, request.model, others)
            ?? await pool.getAvailableAccount(provider, request.model, request.tried)
          if (next === null) throw new LlmError(`${provider}: 当前账号不可用，且没有可用的备用账号`, 'QUEUE')
          remember(request, next)
          return next.credential
        }
        const credential = await options.resolveCredential!(model)
        if (request !== undefined && credential !== null && typeof credential === 'object') {
          const field = provider === 'zcode' ? 'zcode_jwt' : 'access_token'
          const token = (credential as Record<string, unknown>)[field]
          if (typeof token === 'string' && token.length > 0) {
            const id = await pool.findAccountIdByIdentityField(provider, field, token).catch(() => '')
            const entry = pool.listAccountsByProvider(provider).find(account => account.id === id && account.enabled)
            if (entry !== undefined) remember(request, { entry, credential: credential as Account['credential'] })
          }
        }
        return credential
      }
    }
    if (options.currentAccountId !== undefined) {
      scoped.currentAccountId = () => active()?.account?.entry.id ?? options.currentAccountId!()
    }
  }
  if (options.refresh !== undefined) {
    scoped.refresh = async (accountId, reason) => {
      const request = active()
      const id = accountId ?? request?.account?.entry.id
      if (request !== undefined) {
        // 初始凭据刷新和服务端认证续期各保留一次，预算跨排队重启并按账号隔离。
        const budget = reason === 'auth' ? request.authRefreshes : request.credentialRefreshes
        if (budget.has(id)) throw new LlmError(`${provider}: 当前账号已尝试${reason === 'auth' ? '认证续期' : '凭据刷新'}，停止重复刷新`, 'AUTH')
        budget.add(id)
      }
      return options.refresh!(id, reason)
    }
  }
  if (options.identitySlots !== undefined) {
    scoped.identitySlots = async () => {
      const request = active()
      const slots = await options.identitySlots!(request?.model)
      if (request?.slot === undefined) return slots
      const current = slots.find(slot => slot.id === request.slot!.id)
      return [...current === undefined ? [] : [current], ...slots.filter(slot => !request.tried.has(slot.id))]
    }
  }
  const adapter = create(scoped as O)

  const stream = async function* (input: unknown, open: () => AsyncIterable<unknown>): AsyncIterable<unknown> {
    const { model, signal } = input as { model: string; signal?: AbortSignal }
    const request: QueueRequest = { owner: options, provider, model, tried: new Set(), credentialRefreshes: new Set(), authRefreshes: new Set() }
    const deadline = now() + 30 * 60_000
    let attempts = 0, queued = 0, since: number | undefined
    let delivered = false
    for (;;) {
      signal?.throwIfAborted()
      if (now() >= deadline) throw new LlmError(`${provider}: 排队等待超时`, 'QUEUE')
      const iterator = open()[Symbol.asyncIterator]()
      try {
        for (;;) {
          const step = await requests.run(request, () => iterator.next())
          if (step.done) return
          delivered = true
          yield step.value
        }
      } catch (error) {
        if (!(error instanceof ModelQueuedError) || delivered) throw error
        signal?.throwIfAborted()
        if (++attempts > QUEUE_MAX_ATTEMPTS || now() >= deadline) {
          throw new LlmError(`${provider}: 排队重试次数或等待时间已用尽`, 'QUEUE')
        }
        queued += 1
        since ??= now()
        if (queued >= 3 || now() - since >= 20_000) {
          queued = 0
          since = now()
          if (scoped.nextAccount !== undefined) {
            // Loomy 的永久积分锁定等策略属于渠道选号入口，不能退回通用池绕过它。
            const next = await requests.run(request, () => scoped.nextAccount!(model, request.tried))
            if (next !== undefined) continue
          } else if (pool !== undefined) {
            const next = await pool.getAvailableAccount(provider, model, request.tried)
            if (next !== null) {
              remember(request, next)
              continue
            }
          } else if (options.identitySlots !== undefined && request.slot !== undefined) {
            const next = pickSlot(await options.identitySlots(model), model, request.tried)
            if (next !== undefined) {
              request.slot = next
              request.tried.add(next.id)
              continue
            }
          }
        }
        await sleep(Math.min(Math.max(100, error.retryAfterMs ?? 1_000), QUEUE_MAX_DELAY_MS, deadline - now()), signal)
      } finally {
        await requests.run(request, () => iterator.return?.())
      }
    }
  }

  return new Proxy(adapter, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (prop === 'stream' && typeof value === 'function') {
        return (input: unknown) => stream(input, () => value.call(target, input))
      }
      if (prop === 'prepareCall' && typeof value === 'function') {
        return async (...args: unknown[]) => {
          const call = await value.apply(target, args)
          return { ...call, stream: (input: unknown) => stream(input, () => call.stream(input)) }
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
