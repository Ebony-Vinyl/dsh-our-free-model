/**
 * The first-run announcement must never be painted — or silently completed —
 * while the shell is hiding `#root`.
 *
 * The desktop shell mounts its own onboarding surface over the application and,
 * for as long as it is up, sets `#root { opacity: 0 }` *and* `#root.inert`. A
 * slot step stays inside `#root`, so while that is true the plugin's dialog is
 * invisible and unclickable — and the ack fallback used to expire anyway, mark
 * the step complete, and swallow the announcement for good. These checks pin
 * both halves: what counts as "the host is hidden", and that the ack fallback
 * does not run while it is.
 *
 * Run: node scripts/announcement-visibility-test.mjs
 */
import fs from 'node:fs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'fail'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// ── timers are recorded, never fired: the suite must not hang on a live timer ─
const timers = []
const intervals = []
const cleared = []
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
globalThis.clearTimeout = id => { cleared.push(id) }
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length }
globalThis.clearInterval = id => { cleared.push(id) }

/** A never-settling fetch: `/announcement` staying unresolved is the case that matters. */
globalThis.fetch = () => new Promise(() => {})
globalThis.MutationObserver = class { observe() {} disconnect() {} }

// ── shell stand-ins ──────────────────────────────────────────────────────────
let computedOpacity = ''
const root = { inert: false, style: { opacity: '' }, isConnected: true, ownerDocument: undefined }
const surface = { dataset: { desktopOnboardingSurface: '' } }
const shell = { surfaceVisible: false }

const document = {
  baseURI: 'http://127.0.0.1/',
  getElementById: id => (id === 'root' ? root : null),
  querySelector: selector => (selector === '[data-desktop-onboarding-surface]' && shell.surfaceVisible ? surface : null),
  createElement: () => ({ setAttribute() {}, style: {}, remove() {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => true,
}
root.ownerDocument = { defaultView: { getComputedStyle: () => ({ opacity: computedOpacity, visibility: 'visible', display: 'block' }) } }

globalThis.window = { __ModuleLoader__: { load: record => { globalThis.__registered = record } } }
globalThis.document = document
const navigator = { language: 'zh-CN' }

new Function('window', 'document', 'navigator', source)(globalThis.window, globalThis.document, navigator)

const effects = []
const portals = []
const stubReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: fn => { effects.push(fn) },
  useLayoutEffect: fn => { effects.push(fn) },
  useMemo: factory => factory(),
  useRef: () => ({ current: null }),
  useCallback: fn => fn,
}
const stubReactDom = {
  createPortal: (node, target) => { portals.push({ node, target }); return { portal: true, node, target } },
}

const exports = globalThis.__registered.factory(name => {
  if (name === 'react') return stubReact
  if (name === 'react-dom') return stubReactDom
  throw new Error(`the browser half asked for an unexpected module "${name}"`)
})
const test = exports.__test ?? {}

/** Run every effect the stub collected, so a component's timers become observable. */
function settle() {
  const pending = effects.splice(0, effects.length)
  for (const effect of pending) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  }
}
const ackTimers = () => timers.filter(timer => timer.ms === 3000).length
const view = root.ownerDocument
const reset = () => {
  timers.length = 0
  intervals.length = 0
  cleared.length = 0
  computedOpacity = ''
  root.inert = false
  root.style.opacity = ''
  root.ownerDocument = view
  root.isConnected = true
  shell.surfaceVisible = false
}

// ── what counts as "hidden" ──────────────────────────────────────────────────
check('the bundle exposes the host-visibility seam', typeof test.hostShown, 'function')

reset()
check('a visible shell root is shown', test.hostShown?.(), true)

reset()
root.inert = true
check('an inert root is hidden (the shell owns the pointer)', test.hostShown?.(), false)

reset()
root.style.opacity = '0'
check('an inline opacity:0 root is hidden', test.hostShown?.(), false)

reset()
computedOpacity = '0'
check('a computed opacity:0 root is hidden', test.hostShown?.(), false)

reset()
shell.surfaceVisible = true
check('the desktop onboarding surface hides the root', test.hostShown?.(), false)

reset()
root.ownerDocument = undefined
check('a root with no view falls back to its inline state', test.hostShown?.(), true)
root.inert = true
check('and still reports hidden when that inline state says so', test.hostShown?.(), false)

// ── the ack fallback must not run behind a hidden root ───────────────────────
reset()
root.inert = true
effects.length = 0
test.AnnouncementGate?.({ t: key => key, complete: () => {}, openSection: () => {}, explicit: false })
settle()
check('no acknowledgement timer is armed while the host is hidden', ackTimers(), 0)

reset()
effects.length = 0
test.AnnouncementGate?.({ t: key => key, complete: () => {}, openSection: () => {}, explicit: false })
settle()
check('the acknowledgement timer is armed once the host is shown', ackTimers(), 1)

// ── the dialog leaves `#root` so a hidden root cannot swallow it ─────────────
reset()
portals.length = 0
const rendered = test.Announcement?.({
  t: key => key, complete: () => {}, openSection: () => {}, page: 0, setPage: () => {}, summary: {}, acknowledged: false,
})
check('the announcement renders through a portal', rendered?.portal, true)
check('and that portal targets the document body', portals[0]?.target === globalThis.document.body, true)

console.log(`\nannouncement-visibility: ${failures === 0 ? 'OK' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
