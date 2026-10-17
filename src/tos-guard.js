/**
 * QoS (IP TOS) best-effort guard.
 *
 * Node's built-in undici (`node:internal/deps/undici`) writes every HTTP/1.1
 * request through `writeH1`, which marks the socket's Quality of Service:
 *
 *     if (socket.setTypeOfService) socket.setTypeOfService(request.typeOfService)
 *
 * Two properties of that call site make it able to kill the process:
 *
 * 1. `typeOfService` defaults to `0`, so the call happens on **every** request,
 *    not only when a caller asked for a DSCP value;
 * 2. it is **not** wrapped in a `try`/`catch` in that copy — while upstream
 *    undici (the npm package, 8.x) guards the same call and documents why:
 *    "QoS marking is best-effort. setTypeOfService() can throw synchronously on
 *    some platforms depending on socket state, but that must not abort the
 *    request."
 *
 * On macOS the underlying `setsockopt` returns `EINVAL` for some socket states
 * (observable on TLS sockets over a proxy CONNECT tunnel, re-established or
 * half-torn-down sockets). Because the call is unguarded there, a transient
 * QoS failure becomes an uncaught exception inside the host process: in DSH on
 * Electron this surfaces as a repeating "A JavaScript error occurred in the main
 * process / Uncaught Exception: Error: setTypeOfService EINVAL" dialog and makes
 * the application unusable.
 *
 * This module restores the upstream behaviour for whichever process loads the
 * plugin: the QoS marking stays best-effort, and a failure of that optional
 * syscall never aborts a request. It wraps only the transient socket-state
 * errnos and rethrows everything else, so genuine programming errors keep
 * surfacing.
 *
 * @module src/tos-guard.js
 */
import net from 'node:net'

/** Marks a guarded method without colliding with anything the runtime owns. */
const GUARD = Symbol.for('dsh-our-free-model.tos-guard')

/**
 * Errnos that mean "this socket cannot carry a TOS mark right now".
 *
 * `EINVAL` is the one observed on darwin; the others are the same class of
 * state-dependent refusal (`ENOPROTOOPT`/`ENOTSUP` where marking is unsupported,
 * `EBADF` when the socket closed under us). Anything else is a real defect and
 * must not be swallowed.
 */
const TRANSIENT_CODES = new Set(['EINVAL', 'ENOPROTOOPT', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF'])

/**
 * Whether a failure from `setTypeOfService` is the optional-marking kind.
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} `true` when the failure is transient and may be ignored.
 */
export function isTransientTosFailure(error) {
  if (error === null || typeof error !== 'object') return false
  const code = /** @type {{ code?: unknown, errno?: unknown, message?: unknown }} */ (error).code
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true
  // Some libuv paths report only via the message ("setTypeOfService EINVAL").
  const message = /** @type {{ message?: unknown }} */ (error).message
  return typeof message === 'string' && /\b(EINVAL|ENOPROTOOPT|ENOTSUP|EOPNOTSUPP|EBADF)\b/.test(message)
}

/**
 * Build the guarded replacement for one `setTypeOfService` implementation.
 *
 * Exported so the behaviour is testable without a live socket: the tests wrap
 * stubs that throw on demand and assert what is swallowed and what is not.
 *
 * @param {(this: unknown, tos: number) => unknown} original - the implementation
 *   being made best-effort (normally `net.Socket.prototype.setTypeOfService`).
 * @returns {(this: unknown, tos: number) => unknown} the guarded implementation.
 */
export function wrapSetTypeOfService(original) {
  const guarded = function (tos) {
    try {
      return original.call(this, tos)
    } catch (error) {
      if (isTransientTosFailure(error)) return this
      throw error
    }
  }
  Object.defineProperty(guarded, 'name', { value: 'setTypeOfService', configurable: true })
  return guarded
}

/**
 * Install the guard on a socket prototype. Idempotent: a second call on an
 * already-guarded prototype leaves the wrapper in place and returns `true`.
 *
 * @param {object} [target] - the prototype to guard; defaults to
 *   `net.Socket.prototype`, the only one the runtime's HTTP client marks.
 * @returns {boolean} `true` when a guard is in place, `false` when this runtime
 *   exposes no `setTypeOfService` at all (nothing to do).
 */
export function installTosGuard(target = net.Socket?.prototype) {
  if (target === null || target === undefined) return false
  const current = target.setTypeOfService
  if (typeof current !== 'function') return false
  if (current[GUARD] === true) return true
  const guarded = wrapSetTypeOfService(current)
  Object.defineProperty(guarded, GUARD, { value: true, configurable: true })
  target.setTypeOfService = guarded
  return true
}

/** Whether a prototype already carries this guard. */
export function isTosGuarded(target = net.Socket?.prototype) {
  return typeof target?.setTypeOfService === 'function' && target.setTypeOfService[GUARD] === true
}
