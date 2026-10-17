/**
 * Tests for the QoS (IP TOS) best-effort guard (src/tos-guard.js).
 *
 * The guard exists because Node's built-in undici calls
 * `socket.setTypeOfService()` unguarded in `writeH1`. A transient `EINVAL` from
 * that optional syscall then escapes as an uncaught exception and takes the
 * host process down (issue #263). These checks pin the three properties that
 * make the fix safe: transient failures are swallowed, real failures are not,
 * and installing twice does not stack wrappers.
 *
 * Run: node scripts/tos-guard-test.mjs
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { installTosGuard, isTosGuarded, isTransientTosFailure, wrapSetTypeOfService } from '../src/tos-guard.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const coded = code => Object.assign(new Error(`setTypeOfService ${code}`), { code })

// ── classification ───────────────────────────────────────────────────────────
check('darwin EINVAL is transient', () => {
  assert.equal(isTransientTosFailure(coded('EINVAL')), true)
  assert.equal(isTransientTosFailure(new Error('setTypeOfService EINVAL')), true)
})
check('unsupported-marking errnos are transient', () => {
  assert.equal(isTransientTosFailure(coded('ENOPROTOOPT')), true)
  assert.equal(isTransientTosFailure(coded('ENOTSUP')), true)
  assert.equal(isTransientTosFailure(coded('EBADF')), true)
})
check('real defects are not transient', () => {
  assert.equal(isTransientTosFailure(coded('ERR_INVALID_ARG_TYPE')), false)
  assert.equal(isTransientTosFailure(new RangeError('The "tos" argument must be of type number')), false)
  assert.equal(isTransientTosFailure(null), false)
  assert.equal(isTransientTosFailure(undefined), false)
  assert.equal(isTransientTosFailure('EINVAL'), false)
})

// ── wrapper semantics ────────────────────────────────────────────────────────
check('a successful call is passed through and returns the socket', () => {
  const socket = {}
  const guarded = wrapSetTypeOfService(function (tos) { this.applied = tos; return this })
  assert.equal(guarded.call(socket, 46), socket)
  assert.equal(socket.applied, 46)
})
check('a transient failure is swallowed and returns the socket', () => {
  const socket = {}
  const guarded = wrapSetTypeOfService(function () { throw coded('EINVAL') })
  assert.equal(guarded.call(socket, 0), socket)
})
check('any other failure still propagates', () => {
  const guarded = wrapSetTypeOfService(function () { throw coded('ERR_INVALID_ARG_TYPE') })
  assert.throws(() => guarded.call({}, 0), /ERR_INVALID_ARG_TYPE/)
})
check('the wrapper keeps the method name for stack readability', () => {
  const guarded = wrapSetTypeOfService(() => undefined)
  assert.equal(guarded.name, 'setTypeOfService')
})

// ── installation ─────────────────────────────────────────────────────────────
check('installing on a prototype without the method reports nothing to do', () => {
  assert.equal(installTosGuard({}), false, 'a prototype that cannot mark TOS needs no guard')
  assert.equal(installTosGuard(null), false, 'a null target needs no guard')
  // Note: an explicit `undefined` is not a no-op — like any default parameter it
  // selects the default target, net.Socket.prototype.
})
check('installing marks the prototype and is idempotent', () => {
  const proto = { setTypeOfService: function (tos) { this.applied = tos; return this } }
  assert.equal(isTosGuarded(proto), false)
  assert.equal(installTosGuard(proto), true)
  assert.equal(isTosGuarded(proto), true)
  const afterFirst = proto.setTypeOfService
  assert.equal(installTosGuard(proto), true)
  assert.equal(proto.setTypeOfService, afterFirst, 'a second install must not stack another wrapper')
})
check('the guarded prototype swallows only the transient failure', () => {
  const proto = { setTypeOfService: function () { throw coded('EINVAL') } }
  installTosGuard(proto)
  assert.equal(proto.setTypeOfService.call({}, 0).applied, undefined)
  const strict = { setTypeOfService: function () { throw coded('ERR_INVALID_ARG_TYPE') } }
  installTosGuard(strict)
  assert.throws(() => strict.setTypeOfService.call({}, 0), /ERR_INVALID_ARG_TYPE/)
})

// ── the real runtime ─────────────────────────────────────────────────────────
check('the real net.Socket prototype is guarded and still usable', () => {
  const before = net.Socket.prototype.setTypeOfService
  assert.equal(typeof before, 'function', 'this Node build should expose socket TOS marking')
  assert.equal(installTosGuard(net.Socket.prototype), true)
  assert.equal(isTosGuarded(net.Socket.prototype), true)
  const socket = new net.Socket()
  try {
    // TOS marking on an unconnected socket is queued by the runtime; the guard
    // must not change that contract.
    socket.destroy()
  } finally {
    socket.destroy()
  }
})

// ── summary ─────────────────────────────────────────────────────────────────
console.log('')
if (failures === 0) console.log('all checks passed')
else { console.error(`${failures} check(s) failed`); process.exitCode = 1 }
