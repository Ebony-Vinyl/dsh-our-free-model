import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, readFileSync, createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile, rename, link, unlink, realpath } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loopbackFetch } from './loopback-fetch.js'
import { hasEnginePayload, materializeEngine } from './engine-payload.js'
import {
  POLICY_REFUSED, assertEngineMutation, deniedLookup, filterEngineJSON, policyMutation, policyResponse,
} from './magpie-policy.js'

const vendor = fileURLToPath(new URL('../vendor/magpie/', import.meta.url))
function readBrandIcon() {
  try {
    return `data:image/svg+xml;base64,${readFileSync(new URL('../icon.svg', import.meta.url)).toString('base64')}`
  } catch {
    return ''
  }
}
const brandIcon = readBrandIcon()
export const MAGPIE_UI_PREFIX = '/api/our-free-model/engine/ui/'
const PREFIX_HINT = '__ofm_ui_prefix'
const INTERNAL_KEY_ID = 'our-free-model-engine'
const INTERNAL_KEY_REASON = 'This gateway key is managed by the application and cannot be changed here.'
const MAX_ACTIVE = 128
const MAX_HTML = 4 * 1024 * 1024
const MAX_KEY_BODY = 64 * 1024
const START_TIMEOUT = 45_000
const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])
const credentialHeaders = new Set([
  'authorization', 'cookie', 'cookie2', 'host', 'forwarded',
  'x-api-key', 'x-goog-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
])

function engineError(message, statusCode = 503) {
  return Object.assign(new Error(message), { statusCode })
}

function localPath(value) {
  if (typeof value !== 'string') throw engineError('Invalid engine path', 400)
  let decoded = value.split('?')[0]
  for (let i = 0; i < 4; i++) {
    let next
    try { next = decodeURIComponent(decoded) } catch { throw engineError('Invalid engine path', 400) }
    if (/[\u0000-\u0020\u007f\\#]/.test(next) || !next.startsWith('/') ||
      next.startsWith('//') || next.split('/').some(part => part === '.' || part === '..')) {
      throw engineError('Invalid engine path', 400)
    }
    if (next === decoded) break
    decoded = next
    if (i === 3) throw engineError('Invalid engine path', 400)
  }
  if (value.includes('#') || /[\r\n\0]/.test(value)) throw engineError('Invalid engine path', 400)
  const url = new URL(value, 'http://127.0.0.1')
  // Authentication belongs to the owner, never a browser-supplied query key.
  url.searchParams.delete('k')
  url.searchParams.delete(PREFIX_HINT)
  return url.pathname + url.search
}

function validatePrefix(value, mount = MAGPIE_UI_PREFIX) {
  if (typeof value !== 'string' || !value.endsWith(mount) ||
    !/^\/[A-Za-z0-9/._~%-]+$/.test(value) || localPath(value) !== value) {
    throw engineError('Invalid engine UI prefix', 400)
  }
  return value
}

function visiblePrefix(req, options) {
  const raw = String(req.url || '/')
  const pathname = raw.split('?')[0]
  const mount = options?.mount ?? MAGPIE_UI_PREFIX
  const marker = mount.slice(0, -1)
  const index = pathname.indexOf(marker)
  const derived = index >= 0 && ['', '/'].includes(pathname[index + marker.length] || '')
    ? pathname.slice(0, index) + mount : mount
  // A stripped outer mount cannot be inferred from headers. The browser bridge
  // carries its visible path as a validated path-only hint, removed upstream.
  const hint = new URL(raw, 'http://127.0.0.1').searchParams.get(PREFIX_HINT)
  return validatePrefix(options?.prefix ?? hint ?? derived, mount)
}

function routePath(destination) {
  return decodeURIComponent(destination.split('?')[0])
}

function callerKeysRoute(pathname) {
  return /^\/api\/caller-keys(?:\/[^/]+)?\/?$/.test(pathname)
}

function callerKeysMutation(method, pathname) {
  return method !== 'GET' && method !== 'HEAD' && callerKeysRoute(pathname)
}

function callerKeysListing(method, pathname) {
  return /^\/api\/caller-keys\/?$/.test(pathname) || callerKeysMutation(method, pathname)
}

function protectInternalKey(body) {
  let input
  try { input = JSON.parse(body.toString('utf8')) } catch { throw engineError('Invalid gateway key request', 400) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw engineError('Invalid gateway key request', 400)
  // Go's JSON decoder accepts case-insensitive field names too.
  if (Object.entries(input).some(([name, value]) => name.toLowerCase() === 'key' && value === INTERNAL_KEY_ID)) {
    throw engineError(INTERNAL_KEY_REASON, 409)
  }
}

function publicKeyListing(body) {
  const value = JSON.parse(body.toString('utf8'))
  if (Array.isArray(value?.keys)) value.keys = value.keys.filter(row => row?.id !== INTERNAL_KEY_ID)
  return Buffer.from(JSON.stringify(value))
}

async function readBounded(body, limit, signal) {
  const reader = body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const chunks = []
    let size = 0
    while (true) {
      if (signal?.aborted) throw engineError('Engine request aborted')
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > limit) throw engineError('Engine response exceeds limit', 413)
      chunks.push(Buffer.from(next.value))
    }
    return Buffer.concat(chunks)
  } catch (error) { cancel(); throw error } finally { signal?.removeEventListener('abort', cancel) }
}

function readKeyBody(req, signal) {
  return readRequestBody(req, MAX_KEY_BODY, signal)
}

function readRequestBody(req, limit, signal) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', data)
      req.off('end', end)
      req.off('error', failed)
      req.off('aborted', failed)
      signal.removeEventListener('abort', aborted)
    }
    const rejectBody = error => { cleanup(); req.pause(); reject(error) }
    const data = chunk => {
      size += chunk.length
      if (size > limit) rejectBody(engineError('Engine request body exceeds limit', 413))
      else chunks.push(chunk)
    }
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)) }
    const failed = () => rejectBody(engineError('Engine request interrupted', 400))
    const aborted = () => rejectBody(engineError('Engine request aborted'))
    const timer = setTimeout(() => rejectBody(engineError('Engine request timed out', 408)), 30_000)
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    req.on('data', data)
    req.once('end', end)
    req.once('error', failed)
    req.once('aborted', failed)
  })
}

function safeHeaders(input) {
  const headers = Object.create(null)
  const entries = input instanceof Headers ? [...input] : Object.entries(input || {})
  const connection = entries.find(([name]) => name.toLowerCase() === 'connection')?.[1]
  const blocked = new Set(String(connection || '').toLowerCase().split(',').map(s => s.trim()))
  for (const [name, value] of entries) {
    const lower = name.toLowerCase()
    if (!hopHeaders.has(lower) && !credentialHeaders.has(lower) && !blocked.has(lower) &&
      !lower.startsWith('x-forwarded-') && !lower.startsWith('proxy-') &&
      !lower.startsWith('sec-websocket-')) headers[lower] = value
  }
  return headers
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function bindLease(port = 0) {
  const server = net.createServer(socket => socket.destroy())
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve)
    })
    server.unref()
    return server
  } catch (error) { server.close(); throw error }
}

async function closeLease(server) {
  await new Promise(resolve => server.close(resolve))
}

// The durable file names an OS-held TCP lease, not a permanent exclusive file.
// Every contender binds the same port before changing it. The OS releases the
// lease on a parent crash; a reused PID never grants ownership of a live lease.
async function ownerLease(home) {
  const file = path.join(home, 'owner.lock')
  for (let attempt = 0; attempt < 3; attempt++) {
    const saved = await jsonFile(file, null)
    if (saved) {
      if (saved.version !== 1 || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535) {
        throw engineError('Engine owner lock has an unsupported format')
      }
      let lease
      try { lease = await bindLease(saved.port) } catch {
        throw engineError('Magpie data directory already has an owner or its lease port is occupied')
      }
      try {
        await writeJSON(file, { version: 1, port: saved.port, pid: process.pid, token: randomBytes(16).toString('hex') })
        return lease
      } catch (error) { await closeLease(lease); throw error }
    }
    const lease = await bindLease()
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(temp, JSON.stringify({
        version: 1, port: lease.address().port, pid: process.pid, token: randomBytes(16).toString('hex'),
      }), { mode: 0o600, flag: 'wx' })
      // Atomic publication never overwrites another owner's lease record.
      await link(temp, file)
      return lease
    } catch (error) {
      await closeLease(lease)
      if (error.code !== 'EEXIST') throw error
    } finally { await unlink(temp).catch(() => {}) }
  }
  throw engineError('Magpie data directory ownership changed during startup')
}

async function jsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw engineError('Engine settings could not be read')
  }
}

async function writeJSON(file, value) {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } finally { await unlink(temp).catch(() => {}) }
}

// Executed before upstream scripts. Relative assets use <base>; dynamically
// assigned root URLs (including plugin frames and downloads) keep the prefix.
function browserBridge(prefix, mount = MAGPIE_UI_PREFIX) {
  return `(() => {
const configuredPrefix = ${JSON.stringify(prefix)};
const route = ${JSON.stringify(mount)};
const current = new URL(location.href);
const index = current.pathname.indexOf(route.slice(0, -1));
const prefix = index >= 0 && ["", "/"].includes(current.pathname[index + route.length - 1] || "")
  ? current.pathname.slice(0, index) + route : configuredPrefix;
const base = document.querySelector("base");
if (base) base.href = prefix;
const rewrite = value => {
  if (typeof value !== "string" && !(value instanceof URL)) return value;
  const text = String(value);
  if (/^(#|data:|blob:|mailto:|javascript:)/i.test(text)) return value;
  let url; try { url = new URL(text, location.href); } catch { return value; }
  if (url.origin !== location.origin) return value;
  if (!url.pathname.startsWith(prefix)) {
    const root = url.pathname.startsWith(configuredPrefix) ? configuredPrefix
      : url.pathname.startsWith(route) ? route : "/";
    url.pathname = prefix + url.pathname.slice(root.length);
  }
  if (prefix !== configuredPrefix) url.searchParams.set(${JSON.stringify(PREFIX_HINT)}, prefix);
  return url.pathname + url.search + url.hash;
};
const fetch = window.fetch;
window.fetch = function(input, init) {
  const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (input instanceof Request) {
    const url = rewrite(input.url);
    if (url !== input.url) input = new Request(new URL(url, location.href), input);
  } else input = rewrite(input);
  return fetch.call(this, input, init).then(response => {
    if (response.ok && /^(POST|PUT|PATCH|DELETE)$/.test(method) && window.parent !== window) {
      window.parent.postMessage({type: "ofm:engine-changed"}, location.origin);
    }
    return response;
  });
};
for (const name of ["EventSource", "WebSocket"]) {
  const Original = window[name]; if (!Original) continue;
  window[name] = new Proxy(Original, {construct(Target, args) {
    args[0] = rewrite(args[0]); return Reflect.construct(Target, args);
  }});
}
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...args) { return open.call(this, method, rewrite(url), ...args); };
for (const [Type, prop] of [[HTMLIFrameElement,"src"],[HTMLImageElement,"src"],[HTMLScriptElement,"src"],
  [HTMLLinkElement,"href"],[HTMLAnchorElement,"href"],[HTMLFormElement,"action"],[HTMLSourceElement,"src"],
  [HTMLMediaElement,"src"],[HTMLVideoElement,"poster"],[HTMLObjectElement,"data"]]) {
  const descriptor = Object.getOwnPropertyDescriptor(Type.prototype, prop);
  if (descriptor?.set) Object.defineProperty(Type.prototype, prop, {...descriptor, set(value) { descriptor.set.call(this, rewrite(value)); }});
}
const setAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function(name, value) {
  return setAttribute.call(this, name, /^(src|href|action|poster|data)$/i.test(name) ? rewrite(value) : value);
};
const openWindow = window.open;
window.open = function(url, ...args) { return openWindow.call(this, rewrite(url), ...args); };
for (const name of ["pushState","replaceState"]) {
  const original = history[name];
  history[name] = function(state, title, url) { return original.call(this, state, title, url == null ? url : rewrite(url)); };
}
})();`
}

// Presentation only: the bundled assets, settings and sandbox pages stay intact.
const engineAppearanceCSS = `
:root[data-ofm-engine] :is(.top,.side-top) > .brand,
:root[data-ofm-engine] #agents :is(.ag-menu,.import) > .ic[data-icon="magpie"],
:root[data-ofm-engine] #addSheet .tile > .ic[data-icon="magpie"],
:root[data-ofm-engine] #addSheet .tiles > [data-ofm-promotion],
:root[data-ofm-engine] #about :is(.discord,.github),
:root[data-ofm-engine] #nav button[data-view="plugins"] > span,
:root[data-ofm-engine] #view-plugins :is(.pm-intro,.pm-sechead),
:root[data-ofm-engine] #addProvider.has-new::after { display:none!important }
:root[data-ofm-engine] #view-plugins > .ofm-plugin-source {
  flex:none; margin:0 2px 10px; padding:7px 10px; border:1px solid var(--line-2);
  border-radius:8px; background:var(--card-2); color:var(--fg-2);
  font-size:11.5px; line-height:1.5; text-wrap:pretty;
}
:root[data-ofm-engine] #nav button[data-view="plugins"] > .nav-ic { display:block!important; flex:none }
:root[data-ofm-engine] body:not(.side-nav) #nav button[data-view="plugins"] { display:inline-flex; align-items:center; justify-content:center; min-width:32px }
:root[data-ofm-engine] #view-routing .rt-flier { display:none!important }
:root[data-ofm-engine] #view-routing .rt-hub > .ofm-brand-icon { border-radius:6px; object-fit:cover; }
:root[data-ofm-engine] #view-routing .rt-hub > b { white-space:normal; overflow:visible; overflow-wrap:anywhere; line-height:1.35; }
:root[data-ofm-engine] .side-top:has(> .brand:only-child) { height:10px!important; min-height:0!important }
:root[data-ofm-engine] :is(.top,.sidebar,.view,.row,.editor,.sheet,.dialog,.pop,.seg,button,input,textarea,select) { letter-spacing:0 }
:root[data-ofm-engine] :is(.row,.editor,.sheet,.dialog,.pop) { border-radius:8px }
:root[data-ofm-engine] :is(button,input,textarea,select) { font-family:var(--ui-font,var(--font)); }
/* Floating page tools measure this anchor, even with external controls. */
:root[data-ofm-external-controls] .top > .actions {
  position:absolute; right:0; top:0; display:flex!important;
  width:0; height:0; min-height:0!important; overflow:hidden;
  visibility:hidden; pointer-events:none;
}
:root[data-ofm-external-controls] #side #prefs { display:none!important }
:root[data-ofm-external-controls] body:not(.side-nav) > .top {
  display:block!important; height:auto!important; min-height:0!important;
  padding:0 0 8px!important; margin:0 12px 8px;
  border-bottom:1px solid var(--line-2);
}
:root[data-ofm-external-controls] body:not(.side-nav) #nav {
  position:relative!important; inset:auto!important; transform:none!important;
  display:flex!important; flex-wrap:wrap; flex-basis:auto!important; gap:2px;
  width:100%; max-width:100%; min-width:0; padding:0; overflow:visible!important;
}
:root[data-ofm-external-controls] body:not(.side-nav) #nav > .thumb { display:none }
:root[data-ofm-external-controls] body:not(.side-nav) #nav button {
  height:32px!important; padding:0 10px!important; font-size:12px!important;
}
:root[data-ofm-external-controls] body:not(.side-nav) #nav button.on { background:var(--pill); color:var(--fg); }
:root[data-ofm-engine] #view-providers .after-list.away { display:none!important }
:root[data-ofm-engine] #providerDiscovery {
  flex:none; gap:8px 12px; margin:0 0 12px; padding:10px 12px; border-radius:8px;
}
:root[data-ofm-engine] #providerDiscovery .who { flex:1 1 160px; gap:2px; }
:root[data-ofm-engine] #providerDiscovery .actions { min-height:0; gap:8px; }
:root[data-ofm-engine] #providerDiscovery button.text { height:32px; min-height:32px; }
:root[data-ofm-engine] #addSheet { padding-top:0; }
:root[data-ofm-engine] #addSheet > .row-head { height:auto; min-height:32px; gap:8px; }
:root[data-ofm-engine] #addSheet .find { height:32px; }
:root[data-ofm-engine] #addSheet .kind { padding-top:16px; }
:root[data-ofm-engine-theme] {
  --ofm-bg:#f4f4f6; --ofm-card:#fff; --ofm-fg:#1c1c21; --ofm-quiet:#63636b;
  --ofm-muted:#85858d; --ofm-line:#e3e3e8; --ofm-accent:#4f46e5;
  --bg:var(--dsw-alias-bg-layer-1,var(--ofm-bg))!important;
  --card:var(--dsw-alias-bg-layer-3,var(--ofm-card))!important;
  --card-2:var(--dsw-alias-bg-layer-2,var(--ofm-bg))!important;
  --pill:var(--dsw-alias-bg-layer-2,var(--ofm-bg))!important;
  --pill-hover:color-mix(in srgb,var(--fg) 7%,var(--card))!important;
  --seg-track:var(--pill)!important; --seg-thumb:var(--card)!important;
  --line:var(--dsw-alias-border-l2,var(--ofm-line))!important;
  --line-2:var(--dsw-alias-border-l1,var(--ofm-line))!important;
  --fg:var(--dsw-alias-label-primary,var(--ofm-fg))!important;
  --fg-2:var(--dsw-alias-label-secondary,var(--ofm-quiet))!important;
  --ctl-fg:var(--fg-2)!important;
  --muted:var(--dsw-alias-label-tertiary,var(--ofm-muted))!important;
  --faint:var(--muted)!important;
  --accent:var(--dsw-alias-state-business-primary,var(--ofm-accent))!important;
  --accent-fg:var(--dsw-alias-label-on-accent,#fff)!important;
  --accent-soft:color-mix(in srgb,var(--accent) 12%,var(--card))!important;
  --sel:var(--accent-soft)!important;
  --green:var(--dsw-alias-state-success-primary,#189a58)!important;
  --red:var(--dsw-alias-state-error-primary,#d64545)!important;
  --amber:var(--dsw-alias-state-warning-primary,#b45309)!important;
  --green-soft:color-mix(in srgb,var(--green) 12%,var(--card))!important;
  --red-soft:color-mix(in srgb,var(--red) 12%,var(--card))!important;
  --amber-soft:color-mix(in srgb,var(--amber) 12%,var(--card))!important;
  --drift:var(--red)!important; --drift-soft:var(--red-soft)!important;
  --pop-bg:var(--card)!important;
  --font:var(--ofm-font,system-ui,sans-serif)!important;
  --ui-font:var(--ofm-font,system-ui,sans-serif)!important;
  color-scheme:var(--ofm-color-scheme)!important;
}
:root[data-ofm-engine-theme="dark"] {
  --ofm-bg:#18181b; --ofm-card:#27272a; --ofm-fg:#f4f4f5; --ofm-quiet:#d4d4d8;
  --ofm-muted:#a1a1aa; --ofm-line:#3f3f46; --ofm-accent:#a5b4fc;
}
`

function engineAppearanceBridge() {
  const root = document.documentElement
  root.setAttribute('data-ofm-engine', '')
  let variables = new Set()
  let scheme
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent || event.origin !== location.origin) return
    const data = event.data
    if (data?.type === 'ofm:engine-action') {
      if (!root.hasAttribute('data-ofm-external-controls')) return
      const id = data.action === 'refresh' ? 'sync' : data.action === 'settings' ? 'prefs' : null
      const button = id && document.getElementById(id)
      if (button && !button.disabled) button.click()
      return
    }
    if (!data || data.type !== 'ofm:engine-theme' ||
      !['light', 'dark'].includes(data.colorScheme) ||
      !data.variables || typeof data.variables !== 'object' || Array.isArray(data.variables) ||
      typeof data.fontFamily !== 'string' || data.fontFamily.length > 1024 ||
      !CSS.supports('font-family', data.fontFamily)) return
    const entries = Object.entries(data.variables)
    if (entries.length > 256 || entries.some(([name, value]) =>
      !/^--dsw-alias-[a-z0-9-]{1,96}$/.test(name) || typeof value !== 'string' ||
      value.length > 2048 || !CSS.supports('color', value))) return
    const next = new Set(entries.map(([name]) => name))
    for (const name of variables) if (!next.has(name)) root.style.removeProperty(name)
    for (const [name, value] of entries) root.style.setProperty(name, value)
    variables = next
    root.style.setProperty('--ofm-font', data.fontFamily)
    root.style.setProperty('--ofm-color-scheme', data.colorScheme)
    scheme = data.colorScheme
    root.setAttribute('data-ofm-engine-theme', scheme)
    root.setAttribute('data-theme', scheme)
    root.toggleAttribute('data-ofm-external-controls', data.externalControls === true)
  })
  // Upstream refreshes its saved appearance. The embedding host owns this
  // document's presentation, without writing back to those saved preferences.
  new MutationObserver(() => {
    if (scheme && root.getAttribute('data-theme') !== scheme) root.setAttribute('data-theme', scheme)
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
}

function engineProductCopy(brandIcon) {
  if (typeof window.t !== 'function' || typeof I18N === 'undefined') return
  const translate = window.t
  // Snapshot core templates before plugins register their own words. Replace
  // product mentions before filling slots, never strings supplied by a user.
  const templates = new Set(Object.values(I18N).flatMap(strings => Object.keys(strings)))
  const brand = text => text.replace(
    /(^|[^a-z0-9_{}./:@-])magpie(?!:\/\/)(?=$|[^a-z0-9_{}./@-])/gi,
    (match, before, offset, full) => {
      const rest = full.slice(offset + match.length)
      // These are executable command names, not product copy.
      return /^\s+(?:web|quota|accounts|serve|version|update|status|models|doctor|help)\b/i.test(rest)
        ? match : before + 'Our Free Model'
    })
  window.t = function (source, values) {
    if (!templates.has(source) || !/magpie/i.test(source)) return translate(source, values)
    let text = brand(translate(source))
    if (values) for (const key in values) text = text.split('{' + key + '}').join(values[key])
    return text
  }
  // Cache the upstream English exactly as translateStatic does, so changing
  // language continues to use the original translation keys.
  for (const element of document.querySelectorAll('[data-t]')) {
    if (element.dataset.en === undefined) element.dataset.en = element.textContent
    if (templates.has(element.dataset.en)) element.textContent = window.t(element.dataset.en)
  }
  document.title = 'Our Free Model'
  document.querySelector('link[rel="icon"]')?.remove()
  const brandLabels = () => {
    const plugins = document.querySelector('#nav button[data-view="plugins"]')
    if (plugins) {
      const label = translate('Plugins')
      if (plugins.getAttribute('aria-label') !== label) plugins.setAttribute('aria-label', label)
      if (plugins.getAttribute('title') !== label) plugins.setAttribute('title', label)
    }
    for (const element of document.querySelectorAll('.top > .brand > span:not(.logo),.side-top > .brand > span:not(.logo)')) {
      if (element.textContent.trim() === 'magpie') element.textContent = 'Our Free Model'
    }
    for (const element of document.querySelectorAll('#agents button.field.import > .v')) {
      if (element.textContent === 'magpie') element.textContent = 'Our Free Model'
    }
    for (const element of document.querySelectorAll('#view-routing .rt-hub > b')) {
      if (element.textContent.trim() === 'magpie') element.textContent = 'Our Free Model'
    }
    for (const element of document.querySelectorAll('#view-routing .rt-hub > svg.rt-bird')) {
      const image = document.createElement('img')
      image.className = 'rt-bird ofm-brand-icon'
      image.src = brandIcon
      image.alt = ''
      image.width = image.height = 26
      element.replaceWith(image)
    }
    // Only the paid discovery section is hidden; an already configured partner
    // is still an ordinary, fully editable provider elsewhere in the UI.
    for (const heading of document.querySelectorAll('#addSheet .tiles > .kind')) {
      if (heading.querySelector('b')?.textContent !== translate('Partners')) continue
      heading.setAttribute('data-ofm-promotion', '')
      if (heading.nextElementSibling?.classList.contains('grid')) heading.nextElementSibling.setAttribute('data-ofm-promotion', '')
    }
    const add = document.querySelector('#addProvider.has-new')
    if (add?.hasAttribute('title')) add.removeAttribute('title')
    pluginSource()
  }
  // The plugin market is magpie's community's, not this product's: say whose it
  // is on every tab that offers third-party code. The built-in tab lists the
  // engine's own switches, so it carries no such notice. The page redraws its
  // children through replaceKeeping, so the note is put back when it goes.
  const pluginSource = () => {
    const view = document.querySelector('#view-plugins')
    if (!view) return
    const body = view.querySelector(':scope > .pm-body')
    const tabs = [...view.querySelectorAll('.lib-tabs .opt')]
    const active = tabs.findIndex(tab => tab.classList.contains('on'))
    const notice = view.querySelector(':scope > .ofm-plugin-source')
    if (!body || active === 0) { notice?.remove(); return }
    const zh = /^zh/i.test(typeof locale === 'string' ? locale : document.documentElement.lang || '')
    const text = zh
      ? '这里的插件来自 magpie 社区（github.com/magpie-community/plugins），由社区作者维护，与 Our Free Model 无关：我们不提供这些插件，也不对其行为负责。'
      : 'Plugins here come from the magpie community (github.com/magpie-community/plugins) and are maintained by their authors. They are not part of Our Free Model: we do not provide them and are not responsible for them.'
    if (notice) { if (notice.textContent !== text) notice.textContent = text; return }
    const note = document.createElement('p')
    note.className = 'ofm-plugin-source'
    note.setAttribute('role', 'note')
    note.textContent = text
    body.before(note)
  }
  const observer = new MutationObserver(brandLabels)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'title'] })
  brandLabels()
}

function engineDisplayControls() {
  // The remote engine preset bypasses t(). Pass a display-only copy to its
  // renderer; its id, callbacks and the provider store remain upstream's.
  if (typeof window.tile !== 'function') return
  const tile = window.tile
  window.tile = function (preset) {
    return tile.call(this, preset?.id === 'remote-magpie' ? {
      ...preset,
      name: preset.name.replace(/magpie/gi, 'Our Free Model'),
      ...(preset.short ? { short: preset.short.replace(/magpie/gi, 'Our Free Model') } : {}),
    } : preset)
  }
}

function rewriteHTML(html, pathname, prefix, mount = MAGPIE_UI_PREFIX) {
  const plugin = pathname.startsWith('/_magpie/plugin/')
  const relativeRoot = plugin ? '../'.repeat(pathname.split('/').filter(Boolean).length - 1) : ''
  html = html.replace(/\b(src|href|action|poster)=(["'])\/(?!\/)(.*?)\2/gi,
    (_, name, quote, rest) => `${name}=${quote}${relativeRoot}${rest}${quote}`)
  // Plugin pages keep their own relative directory and cannot execute injected
  // inline code (CSP). Their bridge is served unchanged from their token folder.
  if (plugin) return html
  const main = pathname === '/' || pathname === '/index.html'
  const appearance = main
    ? `<style id="ofm-engine-appearance">${engineAppearanceCSS}</style><script>(${engineAppearanceBridge.toString()})();</script>` : ''
  if (main) {
    // Include the bundled pages' dictionaries, registered after core i18n.js.
    html = html.replace(/<script\b[^>]*\bsrc=(["'])(?:\.\/)?app\.js(?:\?[^"']*)?\1[^>]*>\s*<\/script>/i,
      match => `<script>(${engineProductCopy.toString()})(${JSON.stringify(brandIcon)});</script>${match}`)
    html = html.replace(/<script\b[^>]*\bsrc=(["'])(?:\.\/)?start\.js(?:\?[^"']*)?\1[^>]*>\s*<\/script>/i,
      match => `<script>(${engineDisplayControls.toString()})();</script>${match}`)
  }
  const injection = `<base href="${prefix}"><script>${browserBridge(prefix, mount)}</script>${appearance}`
  return /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, match => match + injection)
    : injection + html
}

function forbiddenFrame(headers, pathname) {
  return pathname.startsWith('/api/') && (headers.origin === 'null' ||
    ['iframe', 'frame', 'embed', 'object'].includes(headers['sec-fetch-dest']) ||
    (headers['sec-fetch-site'] === 'cross-site' && headers['sec-fetch-dest'] !== 'document'))
}

function protectUpdate(method, pathname) {
  if (method !== 'GET' && method !== 'HEAD' && /^\/api\/update(?:\/|$)/.test(pathname)) {
    throw engineError('Engine updates are managed by the application build', 409)
  }
}

/** A request body as the policy reads it; anything unreadable decides nothing. */
function parseBodyJSON(body) {
  if (body == null) return {}
  if (typeof body === 'object' && !Buffer.isBuffer(body) && !ArrayBuffer.isView(body)) return body
  try {
    const text = typeof body === 'string' ? body
      : Buffer.isBuffer(body) ? body.toString('utf8') : new TextDecoder().decode(body)
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

/**
 * Owns one private Magpie child. request() returns a Fetch Response; gateway()
 * is privileged adapter-only access. The caller admits trusted UI requests and
 * enforces its own origin policy before proxy(). close() is terminal.
 */
export function createMagpieEngine({ dataDir, logger, binary } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  let metadata = {}
  try { metadata = JSON.parse(readFileSync(path.join(vendor, 'engine.json'), 'utf8')) } catch {}
  const target = `${process.platform}-${process.arch}`
  const entry = metadata.binaries?.[target]
  let executable = binary ? path.resolve(binary) : path.join(vendor, 'bin', `magpie-${target}${process.platform === 'win32' ? '.exe' : ''}`)
  const home = path.join(dataDir, 'magpie')
  let state = 'stopped'
  let error = null
  let child = null
  let exited = null
  let starting = null
  let closing = null
  let lock = null
  let closed = false
  let webURL = ''
  let cookie = ''
  let gatewayURL = ''
  let gatewayKey = ''
  const lifetime = new AbortController()
  let runController = null
  let recovering = Promise.resolve()
  const active = new Set()
  const status = () => ({
    state, available: existsSync(executable) || (!binary && hasEnginePayload(fileURLToPath(new URL('../', import.meta.url)), entry)), version: metadata.version || null,
    revision: metadata.revision || null, error,
  })
  const note = () => {
    // Only fixed messages: upstream stdout and stderr include credentials.
    try { logger?.info?.('Magpie engine started') } catch {}
  }
  const assertOpen = () => {
    if (closed || lifetime.signal.aborted) throw engineError('Engine is closed')
  }
  const stopChild = async () => {
    const owned = child
    if (!owned) return
    if (owned.exitCode === null && owned.signalCode === null) {
      owned.kill()
      let timer
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2500) })])
      clearTimeout(timer)
      if (owned.exitCode === null && owned.signalCode === null) {
        owned.kill('SIGKILL')
        await exited
      }
    } else await exited
    if (child === owned) child = null
  }
  const releaseLock = async () => {
    if (!lock) return
    await closeLease(lock)
    lock = null
  }
  const boot = async () => {
    await recovering
    assertOpen()
    if (!binary && !existsSync(executable) && entry?.compressed) {
      executable = await materializeEngine({ pkgDir: fileURLToPath(new URL('../', import.meta.url)), dataDir, entry })
      assertOpen()
    }
    if (!existsSync(executable)) throw engineError('Magpie engine binary is unavailable')
    const beside = path.dirname(await realpath(executable))
    if (existsSync(path.join(beside, '.portable')) || existsSync(path.join(beside, 'data'))) {
      throw engineError('Engine portable data would override private configuration')
    }
    if (!binary) {
      if (!entry?.sha256) throw engineError('Magpie engine provenance is unavailable')
      const digest = createHash('sha256')
      for await (const chunk of createReadStream(executable)) digest.update(chunk)
      if (digest.digest('hex') !== entry.sha256) throw engineError('Magpie engine binary checksum mismatch')
    }
    await mkdir(home, { recursive: true, mode: 0o700 })
    assertOpen()
    lock = await ownerLease(home)
    const controller = new AbortController()
    runController = controller
    try {
      const dirs = Object.fromEntries(['config', 'cache', 'data', 'state'].map(name => [name, path.join(home, name)]))
      for (const dir of [...Object.values(dirs), path.join(dirs.config, 'magpie')]) {
        await mkdir(dir, { recursive: true, mode: 0o700 })
      }
      const config = path.join(dirs.config, 'magpie')
      const prefs = await jsonFile(path.join(config, 'settings.json'), { noAccountDiscovery: true, noStats: true, noUsageStats: true })
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw engineError('Invalid engine settings')
      let gatewayPort = prefs.port
      if (gatewayPort !== undefined && (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535)) {
        throw engineError('Saved engine gateway port is invalid')
      }
      if (gatewayPort !== undefined) {
        let reservation
        try { reservation = await bindLease(gatewayPort) } catch {
          throw engineError('Saved engine gateway port is occupied; close the conflicting listener before restarting')
        }
        await closeLease(reservation)
      } else gatewayPort = await freePort()
      let webPort = await freePort()
      while (webPort === gatewayPort) webPort = await freePort()
      const keys = await jsonFile(path.join(config, 'caller-keys.json'), [])
      if (!Array.isArray(keys)) throw engineError('Invalid engine key store')
      const ownedID = INTERNAL_KEY_ID
      const savedKey = keys.find(key => key?.id === ownedID)?.secret
      gatewayKey = typeof savedKey === 'string' && /^sk-magpie-key-[a-f0-9]{64}$/.test(savedKey)
        ? savedKey : `sk-magpie-key-${randomBytes(32).toString('hex')}`
      await writeJSON(path.join(config, 'caller-keys.json'), [
        ...keys.filter(key => key?.id !== ownedID),
        { id: ownedID, name: 'Our Free Model engine', secret: gatewayKey },
      ])
      await writeJSON(path.join(config, 'settings.json'), {
        ...prefs, port: gatewayPort, lan: false,
        noAutoUpdate: true, noAutoDownload: true, autoRestart: false,
      })
      const webKey = randomBytes(32).toString('hex')
      webURL = `http://127.0.0.1:${webPort}`
      gatewayURL = `http://127.0.0.1:${gatewayPort}`
      cookie = `magpie_web_${webPort}=${webKey}`
      const env = { ...process.env }
      // An inherited Magpie override must never redirect this owned instance.
      for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('MAGPIE_')) delete env[key]
      Object.assign(env, {
        XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache,
        XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state,
        MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`, MAGPIE_WEB_KEY: webKey,
        MAGPIE_NO_SHORTCUT: '1',
      })
      assertOpen()
      child = spawn(executable, ['web', '--addr', `127.0.0.1:${webPort}`, '--no-open'], {
        cwd: home, env, stdio: 'ignore', shell: false, windowsHide: true,
      })
      const owned = child
      let spawnFailed = false
      exited = new Promise(resolve => {
        child.once('error', () => { spawnFailed = true; resolve() })
        child.once('exit', resolve)
      })
      exited.then(() => {
        if (child !== owned) return
        controller.abort()
        if (!closed && state === 'ready') {
          state = 'error'
          error = 'Magpie engine exited'
          for (const cancel of active) cancel()
          // start() waits for this run's cleanup before acquiring a new lease.
          recovering = (async () => {
            await stopChild()
            await releaseLock()
            cookie = gatewayKey = gatewayURL = webURL = ''
            if (runController === controller) runController = null
          })().catch(() => { error = 'Magpie engine cleanup failed' })
        }
      })
      const deadline = Date.now() + START_TIMEOUT
      while (Date.now() < deadline) {
        assertOpen()
        if (spawnFailed || child.exitCode !== null || child.signalCode !== null) throw engineError('Magpie engine failed to start')
        try {
          // /api is not a route upstream; use its authenticated JSON /api/settings
          // rather than mistaking the static file server's 404 for readiness.
          const response = await loopbackFetch(`${webURL}/api/settings`, {
            headers: { cookie, accept: 'application/json' }, redirect: 'error',
            signal: AbortSignal.any([lifetime.signal, controller.signal, AbortSignal.timeout(1500)]),
          })
          const body = await response.json()
          if (response.ok && body && typeof body === 'object' && !Array.isArray(body)) {
            assertOpen()
            if (controller.signal.aborted || spawnFailed || owned.exitCode !== null || owned.signalCode !== null) {
              throw engineError('Magpie engine failed to start')
            }
            state = 'ready'
            note()
            return status()
          }
        } catch {}
        await new Promise(resolve => {
          const timer = setTimeout(done, 100)
          function done() { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve() }
          lifetime.signal.addEventListener('abort', done, { once: true })
        })
      }
      throw engineError('Magpie engine readiness timed out')
    } catch (failure) {
      controller.abort()
      await stopChild()
      await releaseLock()
      if (runController === controller) runController = null
      throw failure
    }
  }
  const start = () => {
    if (closed) return Promise.reject(engineError('Engine is closed'))
    if (state === 'ready') return Promise.resolve(status())
    if (starting) return starting
    state = 'starting'
    error = null
    starting = boot().catch(failure => {
      if (!closed) { state = 'error'; error = failure.statusCode ? failure.message : 'Magpie engine could not start' }
      throw engineError(error || 'Engine is closed')
    }).finally(() => { starting = null })
    return starting
  }
  const request = async (method, subpath, options = {}) => {
    const destination = localPath(subpath)
    const pathname = routePath(destination)
    const verb = String(method).toUpperCase()
    protectUpdate(verb, pathname)
    if (deniedLookup(pathname, new URL(destination, 'http://127.0.0.1').searchParams)) {
      throw engineError(POLICY_REFUSED, 403)
    }
    if (forbiddenFrame(options.headers || {}, pathname)) throw engineError('Framed engine API access is forbidden', 403)
    await start()
    assertOpen()
    if (active.size >= MAX_ACTIVE) throw engineError('Engine request limit reached', 503)
    const controller = new AbortController()
    const signal = AbortSignal.any([
      lifetime.signal, ...(runController ? [runController.signal] : []), controller.signal,
      ...(options.signal ? [options.signal] : []), AbortSignal.timeout(30_000),
    ])
    const finish = () => { active.delete(cancel); signal.removeEventListener('abort', finish) }
    const cancel = () => { controller.abort(); finish() }
    active.add(cancel)
    signal.addEventListener('abort', finish, { once: true })
    try {
      const headers = safeHeaders(options.headers)
      headers.cookie = cookie
      headers.origin = webURL
      headers.referer = `${webURL}/`
      let body = options.body
      if (body != null && typeof body === 'object' && !ArrayBuffer.isView(body) &&
        !(body instanceof ArrayBuffer) && !(body instanceof Blob) && !(body instanceof FormData) &&
        !(body instanceof URLSearchParams) && typeof body.pipe !== 'function' && typeof body.getReader !== 'function') {
        body = JSON.stringify(body)
        headers['content-type'] ??= 'application/json'
      }
      if (policyMutation(verb, pathname)) assertEngineMutation(verb, pathname, parseBodyJSON(body))
      if (callerKeysMutation(verb, pathname)) {
        const stream = new Response(body).body
        body = stream ? await readBounded(stream, MAX_KEY_BODY, signal) : Buffer.alloc(0)
        protectInternalKey(body)
        headers['content-length'] = String(body.length)
      }
      const response = await loopbackFetch(webURL + destination, {
        method: verb, headers, body, redirect: 'manual',
        ...(body && (typeof body.pipe === 'function' || typeof body.getReader === 'function') ? { duplex: 'half' } : {}),
        signal,
      })
      if (!response.body) { finish(); return response }
      if (response.ok && callerKeysListing(verb, pathname) && /json/i.test(response.headers.get('content-type') || '')) {
        const body = publicKeyListing(await readBounded(response.body, MAX_HTML, signal))
        const headers = new Headers(response.headers)
        for (const key of ['content-length', 'content-encoding', 'etag']) headers.delete(key)
        finish()
        return new Response(body, { status: response.status, statusText: response.statusText, headers })
      }
      if (response.ok && policyResponse(pathname) && /json/i.test(response.headers.get('content-type') || '')) {
        const raw = await readBounded(response.body, MAX_HTML, signal)
        let value
        try { value = JSON.parse(raw.toString('utf8')) } catch { finish(); return new Response(raw, { status: response.status, headers: response.headers }) }
        const filtered = Buffer.from(JSON.stringify(filterEngineJSON(pathname, value)))
        const headers = new Headers(response.headers)
        for (const key of ['content-length', 'content-encoding', 'etag']) headers.delete(key)
        finish()
        return new Response(filtered, { status: response.status, statusText: response.statusText, headers })
      }
      const reader = response.body.getReader()
      const bodyStream = new ReadableStream({
        async pull(stream) {
          try {
            const next = await reader.read()
            if (next.done) { stream.close(); finish() } else stream.enqueue(next.value)
          } catch { stream.error(engineError('Engine response interrupted')); finish() }
        },
        async cancel() { cancel(); await reader.cancel().catch(() => {}); finish() },
      })
      return new Response(bodyStream, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (failure) {
      finish()
      if (failure.statusCode === 409 && failure.message === INTERNAL_KEY_REASON) throw failure
      if (failure.statusCode === 403 && failure.message === POLICY_REFUSED) throw failure
      if (failure.statusCode === 400) throw engineError('Invalid gateway key request', 400)
      if (failure.statusCode === 413) throw engineError('Gateway key request exceeds limit', 413)
      if (options.signal?.aborted) throw new DOMException('Engine request aborted', 'AbortError')
      throw engineError('Engine request failed')
    }
  }
  const proxy = async (req, res, subpath = '/', options = {}) => {
    let destination
    let pathname
    let prefix
    let forwardedBody
    // The mount outlives the try block: the response handler rewrites HTML for
    // it long after the preflight checks have finished.
    const mount = options.mount ?? MAGPIE_UI_PREFIX
    try {
      if (typeof subpath !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(subpath)) throw engineError('Invalid engine path', 400)
      destination = localPath(subpath.startsWith('/') ? subpath : `/${subpath}`)
      pathname = routePath(destination)
      prefix = visiblePrefix(req, options)
      protectUpdate(req.method, pathname)
      if (deniedLookup(pathname, new URL(destination, 'http://127.0.0.1').searchParams)) {
        throw engineError(POLICY_REFUSED, 403)
      }
      if (forbiddenFrame(req.headers, pathname)) throw engineError('Framed engine API access is forbidden', 403)
      await start()
      assertOpen()
      if (req.aborted || res.destroyed) return
      if (active.size >= MAX_ACTIVE) throw engineError('Engine request limit reached')
      if (callerKeysMutation(req.method, pathname) || policyMutation(req.method, pathname)) {
        const controller = new AbortController()
        const cancel = () => controller.abort()
        active.add(cancel)
        try {
          forwardedBody = await readRequestBody(req, MAX_KEY_BODY, AbortSignal.any([
            lifetime.signal, runController.signal, controller.signal,
          ]))
          if (callerKeysMutation(req.method, pathname)) protectInternalKey(forwardedBody)
          else assertEngineMutation(req.method, pathname, parseBodyJSON(forwardedBody))
        } finally { active.delete(cancel) }
        assertOpen()
      }
    } catch (failure) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(failure.statusCode || 503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(failure.statusCode ? failure.message : 'Engine proxy failed', () => {
          if (failure.statusCode === 413 || failure.statusCode === 408) req.destroy()
        })
      }
      return
    }
    return new Promise(resolve => {
      const headers = safeHeaders(req.headers)
      headers.cookie = cookie
      headers.origin = webURL
      headers.referer = `${webURL}/`
      headers['accept-encoding'] = 'identity'
      if (forwardedBody) headers['content-length'] = String(forwardedBody.length)
      if (pathname === '/' || pathname === '/index.html') {
        delete headers['if-none-match']
        delete headers['if-modified-since']
        delete headers.range
      }
      const upstream = http.request(webURL + destination, { method: req.method, headers, agent: false })
      let incoming
      let done = false
      const finish = () => {
        if (done) return
        done = true
        active.delete(cancel)
        req.off('aborted', cancel)
        req.off('error', cancel)
        res.off('close', cancel)
        resolve()
      }
      const cancel = () => { upstream.destroy(); incoming?.destroy(); if (!res.destroyed) res.destroy(); finish() }
      active.add(cancel)
      req.once('aborted', cancel)
      req.once('error', cancel)
      res.once('close', cancel)
      upstream.setTimeout(30_000, () => upstream.destroy(engineError('Engine proxy timed out')))
      upstream.once('error', () => {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Engine proxy failed')
        } else if (!res.destroyed) res.destroy()
        finish()
      })
      upstream.once('response', async response => {
        incoming = response
        upstream.setTimeout(0)
        response.once('error', cancel)
        response.once('aborted', cancel)
        const outgoing = Object.create(null)
        const nominated = String(response.headers.connection || '').toLowerCase().split(',').map(s => s.trim())
        for (const [name, value] of Object.entries(response.headers)) {
          if (!hopHeaders.has(name) && !nominated.includes(name) &&
            !['set-cookie', 'set-cookie2', 'www-authenticate', 'access-control-allow-origin', 'access-control-allow-credentials'].includes(name)) {
            outgoing[name] = value
          }
        }
        try {
          if (outgoing.location) {
            const url = new URL(outgoing.location, webURL + destination)
            if (url.origin === webURL || String(outgoing.location).startsWith('/')) {
              const rewritten = localPath(url.pathname + url.search)
              outgoing.location = prefix + rewritten.slice(1) + url.hash
            }
          }
          if (pathname.startsWith('/_magpie/plugin/') && outgoing['content-security-policy']) {
            const host = String(req.headers.host || '')
            if (!/^[a-zA-Z0-9.[\]:-]+$/.test(host)) throw engineError('Invalid proxy host', 400)
            const source = new URL(webURL).host + '/_magpie/plugin/'
            outgoing['content-security-policy'] = outgoing['content-security-policy'].replaceAll(source, host + prefix + '_magpie/plugin/')
          }
          const html = /\btext\/html\b/i.test(outgoing['content-type'] || '') &&
            !/\battachment\b/i.test(outgoing['content-disposition'] || '') && req.method !== 'HEAD'
          const keys = callerKeysListing(req.method, pathname) && /json/i.test(outgoing['content-type'] || '') && req.method !== 'HEAD'
          const policy = !keys && req.method !== 'HEAD' && response.statusCode === 200 &&
            policyResponse(pathname) && /\bjson\b/i.test(outgoing['content-type'] || '')
          if ((html || keys || policy) && response.statusCode === 200) {
            const chunks = []
            let size = 0
            for await (const chunk of response) {
              size += chunk.length
              if (size > MAX_HTML) throw engineError('Engine response exceeds limit', 502)
              chunks.push(chunk)
            }
            const raw = Buffer.concat(chunks)
            let body
            if (keys) body = publicKeyListing(raw)
            else if (policy) {
              let value
              try { value = JSON.parse(raw.toString('utf8')) } catch { value = undefined }
              body = value === undefined ? raw : Buffer.from(JSON.stringify(filterEngineJSON(pathname, value)))
            } else body = Buffer.from(rewriteHTML(raw.toString('utf8'), pathname, prefix, mount))
            for (const key of ['content-length', 'content-encoding', 'etag', 'last-modified', 'accept-ranges', 'content-range']) delete outgoing[key]
            outgoing['content-length'] = body.length
            outgoing['cache-control'] = 'no-store'
            res.writeHead(response.statusCode, outgoing)
            res.end(body, finish)
          } else {
            res.writeHead(response.statusCode, outgoing)
            response.pipe(res)
            res.once('finish', finish)
          }
        } catch {
          response.destroy()
          if (!res.headersSent && !res.destroyed) { res.writeHead(502); res.end('Engine proxy failed') }
          else if (!res.destroyed) res.destroy()
          finish()
        }
      })
      if (forwardedBody) upstream.end(forwardedBody)
      else req.pipe(upstream)
    })
  }
  const close = () => {
    if (closing) return closing
    closed = true
    state = 'closing'
    lifetime.abort()
    runController?.abort()
    for (const cancel of active) cancel()
    closing = (async () => {
      if (starting) await starting.catch(() => {})
      await recovering
      await stopChild()
      await releaseLock()
      cookie = gatewayKey = gatewayURL = webURL = ''
      state = 'closed'
      return status()
    })()
    return closing
  }
  const gateway = () => {
    if (state !== 'ready' || closed) throw engineError('Magpie engine is not running')
    return { url: gatewayURL, key: gatewayKey }
  }
  return { start, status, close, request, proxy, gateway }
}
