/**
 * The plugin kernel: manifest, scans, built-in descriptors, the page bridge
 * and the bundled marketplace shelf — one module, on purpose.
 *
 * The release manifest must stay inside the legacy upgrader's 80-file budget,
 * so everything the kernel needs ships in this single file. The sections are
 * ordered: manifest, static scans, built-in data and descriptors, the bundled
 * registry snapshot, and the page bridge.
 *
 * @module src/plugins.js
 */

import fs from 'node:fs'
import { compareVersions, parseVersion } from './semver.js'



/** The plugin API this host implements. Manifests may ask for a compatible range. */
export const PLUGIN_API_VERSION = '2.0.0'

export const PLUGIN_KINDS = new Set(['channel', 'enhancement', 'page', 'bundle'])

/** Icons a page contribution may name. The console maps each to a lucide icon. */
export const PAGE_ICONS = new Set([
  'puzzle', 'sparkles', 'chart', 'tool', 'image', 'globe',
  'terminal', 'book', 'palette', 'activity', 'boxes', 'route',
])

/** Capabilities a plugin may require. They are host features, not other plugins. */
export const PLUGIN_CAPABILITIES = new Set([
  'ui', 'channels', 'enhancements', 'providers', 'clients', 'formats',
  'network', 'storage', 'secrets', 'http',
])

const MANIFEST_ID_RE = /^[a-z][a-z0-9-]{1,47}$/
const PAGE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const NETWORK_ORIGIN_RE = /^https?:\/\//
const COVER_NAME_RE = /^[\w.-]+\.(?:png|jpe?g|webp|svg)$/i

const FILE_EXTENSIONS = new Set([
  '.mjs', '.js', '.css', '.html', '.svg', '.png', '.jpg', '.jpeg',
  '.webp', '.gif', '.woff2', '.json', '.txt',
])
const MAX_FILES = 64
const MAX_PAGE_FILES = 32
const MAX_FILE_PATH = 200
const MAX_PAGES = 8

/**
 * A relative package path: no absolute root, no drive letter, no backslash, no
 * `..` segment, no empty segment, and a short allowlisted extension. This is
 * the only path grammar the installer will copy or serve.
 */
export function safePluginPath(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > MAX_FILE_PATH || text.startsWith('/') || text.includes('\\')) return null
  if (text.includes('\0') || text.split('/').some(part => part === '' || part === '.' || part === '..')) return null
  if (!/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(text)) return null
  const dot = text.lastIndexOf('.')
  if (dot <= 0 || !FILE_EXTENSIONS.has(text.slice(dot).toLowerCase())) return null
  return text
}

function safeUrl(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.href : ''
  } catch { return '' }
}

function normalizePermissions(raw) {
  const permissions = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const network = (Array.isArray(permissions.network) ? permissions.network : [])
    .map(origin => String(origin ?? '').trim().replace(/\/+$/, ''))
    .filter(origin => NETWORK_ORIGIN_RE.test(origin) && origin.length <= 128)
    .slice(0, 8)
  const secrets = (Array.isArray(permissions.secrets) ? permissions.secrets : [])
    .map(key => String(key ?? '').trim())
    .filter(key => /^[\w-]{1,64}$/.test(key))
    .slice(0, 8)
  return { network, secrets, storage: permissions.storage === true }
}

function normalizeHooks(raw) {
  const allowed = new Set(['onRequest', 'onModels', 'onUsage'])
  const hooks = (Array.isArray(raw) ? raw : []).filter(hook => allowed.has(hook))
  return hooks.length > 0 ? hooks : ['onRequest']
}

function normalizeConfig(raw) {
  const rows = Array.isArray(raw) ? raw : []
  const out = []
  for (const row of rows.slice(0, 12)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const key = typeof row.key === 'string' && /^[\w-]{1,64}$/.test(row.key) ? row.key : ''
    if (key === '' || ['__proto__', 'prototype', 'constructor'].includes(key)) continue
    const type = ['text', 'password', 'toggle', 'number', 'select'].includes(row.type) ? row.type : 'text'
    out.push({
      key,
      type,
      label: typeof row.label === 'string' ? row.label.slice(0, 80) : key,
      description: typeof row.description === 'string' ? row.description.slice(0, 200) : '',
      default: row.default,
      ...(type === 'select' && Array.isArray(row.options) ? { options: row.options.slice(0, 16).map(String) } : {}),
    })
  }
  return out
}

function normalizeFiles(raw) {
  const rows = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const row of rows.slice(0, MAX_FILES)) {
    const file = safePluginPath(row)
    if (file === null || seen.has(file)) continue
    seen.add(file)
    out.push(file)
  }
  return out
}

function normalizePages(raw, { files }) {
  const rows = Array.isArray(raw) ? raw : []
  const pages = []
  const seen = new Set()
  for (const row of rows.slice(0, MAX_PAGES)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const id = typeof row.id === 'string' && PAGE_ID_RE.test(row.id) ? row.id : ''
    if (id === '' || seen.has(id)) continue
    const entry = safePluginPath(row.entry)
    if (entry === null || !entry.toLowerCase().endsWith('.html')) throw new Error(`page "${id}" must name a relative .html entry`)
    if (files.length > 0 && !files.includes(entry)) throw new Error(`page "${id}" entry "${entry}" is not in the manifest files list`)
    const order = Number.isInteger(row.order) ? Math.max(-1000, Math.min(1000, row.order)) : 100
    const icon = typeof row.icon === 'string' && PAGE_ICONS.has(row.icon) ? row.icon : 'puzzle'
    const group = typeof row.group === 'string' && row.group.trim() !== '' ? row.group.trim().slice(0, 40) : '插件'
    pages.push({
      id,
      title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim().slice(0, 60) : id,
      description: typeof row.description === 'string' ? row.description.slice(0, 200) : '',
      entry,
      slot: 'sidebar',
      group,
      order,
      icon,
    })
    seen.add(id)
  }
  return pages
}

function normalizeStringList(raw, { pattern, max }) {
  const rows = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const value = typeof row === 'string' ? row.trim() : ''
    if (value === '' || value.length > 64 || !pattern.test(value) || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function normalizeApiVersion(raw) {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string' || raw.length > 32) throw new Error('manifest apiVersion must be a short string')
  const value = raw.trim()
  if (!/^(?:\^|~)?\d+(?:\.\d+){0,2}(?:\.x)?$|^\*\*$|^\*$|^>=\s*\d+(?:\.\d+){0,2}(?:\s+<\s*\d+(?:\.\d+){0,2})?$/.test(value)) {
    throw new Error(`manifest apiVersion "${value}" is not a supported range`)
  }
  return value
}

/**
 * Does `range` accept `host`? Only the compact forms authors actually write:
 * `^2`, `^2.0.0`, `~2.1`, `2.x`, `2`, `>=2 <3`, `*`.
 */
export function satisfiesApiVersion(range, host = PLUGIN_API_VERSION) {
  if (typeof range !== 'string' || range.trim() === '' || range.trim() === '*') return true
  const hostVersion = parseVersion(host)
  if (hostVersion === null) return false
  const value = range.trim()
  const major = hostVersion.major
  if (value === '**') return true
  const caret = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value)
  if (caret !== null) {
    const atMajor = Number(caret[1])
    if (atMajor !== major) return false
    if (caret[2] === undefined) return true
    const atMinor = Number(caret[2])
    if (hostVersion.minor !== atMinor) return hostVersion.minor > atMinor
    if (caret[3] === undefined) return true
    return compareVersions(host, `${atMajor}.${atMinor}.${Number(caret[3])}`) >= 0
  }
  const tilde = /^~(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value)
  if (tilde !== null) {
    if (Number(tilde[1]) !== major) return false
    if (tilde[2] === undefined) return true
    if (Number(tilde[2]) !== hostVersion.minor) return false
    if (tilde[3] === undefined) return true
    return compareVersions(host, `${tilde[1]}.${tilde[2]}.${Number(tilde[3])}`) >= 0
  }
  const xRange = /^(\d+)(?:\.(\d+))?\.x$/.exec(value)
  if (xRange !== null) {
    if (Number(xRange[1]) !== major) return false
    return xRange[2] === undefined || Number(xRange[2]) === hostVersion.minor
  }
  const bare = /^(\d+)$/.exec(value)
  if (bare !== null) return Number(bare[1]) === major
  const bounded = /^>=\s*(\d+(?:\.\d+){0,2})(?:\s+<\s*(\d+(?:\.\d+){0,2}))?$/.exec(value)
  if (bounded !== null) {
    if (compareVersions(host, bounded[1]) < 0) return false
    return bounded[2] === undefined || compareVersions(host, bounded[2]) < 0
  }
  return false
}

/** One manifest, v1 or v2, normalized. Throws with a human-readable reason. */
export function parsePluginManifest(raw, { source = 'registry' } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest must be a JSON object')
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1 && raw.schemaVersion !== 2) {
    throw new Error('manifest schemaVersion must be 1 or 2')
  }
  const schemaVersion = raw.schemaVersion === 2 ? 2 : 1
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!MANIFEST_ID_RE.test(id)) throw new Error(`manifest id "${id}" must match /^[a-z][a-z0-9-]{1,47}$/`)
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  if (!SEMVER_RE.test(version)) throw new Error(`manifest version "${version}" is not semver`)

  const contributes = raw.contributes !== null && typeof raw.contributes === 'object' && !Array.isArray(raw.contributes)
    ? raw.contributes : {}
  const rawChannels = contributes.channels !== undefined ? contributes.channels : (Array.isArray(raw.models) ? [{ models: raw.models }] : [])
  const channelRows = Array.isArray(rawChannels) ? rawChannels : []
  const channelModels = channelRows.flatMap(row => Array.isArray(row?.models) ? row.models : []).slice(0, 256)
  const enhancementHooks = contributes.enhancements !== undefined
    ? normalizeHooks(contributes.enhancements?.hooks)
    : normalizeHooks(raw.hooks)
  const files = normalizeFiles(raw.files)
  const pages = normalizePages(contributes.pages !== undefined ? contributes.pages : raw.pages, { files })

  const kind = (() => {
    if (PLUGIN_KINDS.has(raw.kind)) return raw.kind
    if (raw.type === 'channel' || raw.type === 'enhancement') return raw.type
    if (raw.type === 'page') return 'page'
    const hasChannels = channelRows.length > 0 || channelModels.length > 0
    const hasEnhancements = contributes.enhancements !== undefined
      || (Array.isArray(raw.hooks) && raw.hooks.length > 0)
    const hasPages = pages.length > 0
    if (hasChannels && (hasEnhancements || hasPages)) return 'bundle'
    if (hasChannels) return 'channel'
    if (hasEnhancements) return 'enhancement'
    if (hasPages) return 'page'
    return 'bundle'
  })()
  const hasChannels = channelRows.length > 0 || channelModels.length > 0 || kind === 'channel'
  const hasEnhancements = contributes.enhancements !== undefined || (schemaVersion === 1 && raw.type === 'enhancement') || kind === 'enhancement'
  const kinds = []
  if (hasChannels) kinds.push('channel')
  if (hasEnhancements) kinds.push('enhancement')
  if (pages.length > 0) kinds.push('page')
  if (kinds.length === 0) kinds.push(kind === 'page' ? 'page' : 'bundle')

  // A page-only package has no code entry; a channel/enhancement package must
  // name one. `main` stays optional in the manifest when the registry supplies
  // its own file list, but a code contribution without `main` can never load.
  // A registry entry inlines the manifest and uses `main` for the signed file
  // object (`{path, url, size, sha256}`); a package's own `ofm-plugin.json`
  // uses a string. Accept both without making the registry carry a second name.
  const rawMain = typeof raw.main === 'string'
    ? raw.main.trim()
    : (raw.main !== null && typeof raw.main === 'object' && !Array.isArray(raw.main)
      ? String(raw.main.path ?? '').trim()
      : '')
  if (rawMain !== '' && (safePluginPath(rawMain) === null || !rawMain.toLowerCase().endsWith('.mjs'))) {
    throw new Error('manifest main must be a relative .mjs file name')
  }
  const needsMain = hasChannels || hasEnhancements
  const main = rawMain !== '' ? rawMain : (needsMain ? 'main.mjs' : '')
  if (main !== '' && files.length > 0 && !files.includes(main)) throw new Error(`manifest main "${main}" is not in the files list`)

  const apiVersion = schemaVersion === 2 ? normalizeApiVersion(raw.apiVersion) : ''
  const apiCompatible = apiVersion === '' || satisfiesApiVersion(apiVersion)

  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 64) : id
  const cover = typeof raw.cover === 'string' && COVER_NAME_RE.test(raw.cover) && !raw.cover.includes('..') ? raw.cover : undefined
  const permissions = normalizePermissions(raw.permissions)
  const minHost = typeof raw.minHost === 'string' && SEMVER_RE.test(raw.minHost.trim()) ? raw.minHost.trim() : '0.0.0'
  // Keep unknown capabilities on purpose: a manifest that requires something
  // this host does not provide must mount as `pending`, not silently pretend
  // the requirement was satisfied.
  const requires = normalizeStringList(raw.requires, { pattern: /^[a-z][a-z0-9-]{0,31}$/, max: 16 })
  const provides = normalizeStringList(raw.provides, { pattern: /^[a-z][a-z0-9-]{0,31}(?::[a-z0-9][a-z0-9-]{0,31})?$/, max: 16 })

  return {
    schemaVersion,
    id,
    version,
    kind,
    kinds,
    // Legacy consumers read `type`; keep it faithful to their two-value world.
    type: hasChannels ? 'channel' : hasEnhancements ? 'enhancement' : 'page',
    name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 400) : '',
    author: typeof raw.author === 'string' ? raw.author.slice(0, 80) : '',
    license: typeof raw.license === 'string' ? raw.license.slice(0, 40) : '',
    homepage: safeUrl(raw.homepage),
    repository: safeUrl(raw.repository),
    icon: typeof raw.icon === 'string' ? raw.icon.slice(0, 200) : '',
    minHost,
    apiVersion,
    apiCompatible,
    main,
    permissions,
    requires,
    provides,
    replaces: typeof raw.replaces === 'string' ? raw.replaces : undefined,
    ...(cover !== undefined ? { cover } : {}),
    ...(hasEnhancements ? { hooks: enhancementHooks } : {}),
    ...(hasChannels && channelModels.length > 0 ? { models: channelModels } : {}),
    files,
    pages,
    config: normalizeConfig(raw.config),
    // Built-ins set this; a registry manifest cannot make itself uninstallable.
    essential: source === 'builtin' && raw.essential === true,
    ...(source === 'builtin' ? { builtin: true } : {}),
  }
}

/** Backwards-compatible name for the v1 entry point. */
export const parseExtensionManifest = parsePluginManifest

export function manifestHasChannel(manifest) {
  return Array.isArray(manifest?.kinds) ? manifest.kinds.includes('channel') : manifest?.type === 'channel'
}

export function manifestHasEnhancement(manifest) {
  return Array.isArray(manifest?.kinds) ? manifest.kinds.includes('enhancement') : manifest?.type === 'enhancement'
}

export function manifestHasPage(manifest) {
  return Array.isArray(manifest?.pages) && manifest.pages.length > 0
}

const MAX_SOURCE_BYTES = 256 * 1024
const MAX_PAGE_BYTES = 2 * 1024 * 1024

/** APIs a code plugin must never name. */
const BANNED_SOURCE_PATTERNS = [
  /\brequire\s*\(/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bglobal\s*\./,
  /\bFunction\s*\(/,
  /\beval\s*\(/,
  /\bWebAssembly\b/,
  /\bimportScripts\b/,
  /\bchild_process\b/,
  /\bworker_threads\b/,
  /\bnode\s*:\s*(?:fs|path|os|net|tls|dns|http|https|child_process|worker_threads|module|vm|inspector)\b/,
  /\bimport\s*\(/,
]

/** APIs a page plugin must never name: the bridge is its only way out. */
const BANNED_PAGE_SCRIPT_PATTERNS = [
  /\brequire\s*\(/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bFunction\s*\(/,
  /\beval\s*\(/,
  /\bWebAssembly\b/,
  /\bimportScripts\b/,
  /\bimport\s*\(/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bsendBeacon\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bdocument\s*\.\s*cookie\b/,
  /\bwindow\s*\.\s*open\b/,
  /\bparent\s*\.\s*document\b/,
  /\btop\s*\.\s*(?:location|document|window)\b/,
  /\bjavascript\s*:/i,
]

/**
 * Static scan of one code plugin's source, before it ever executes.
 */
export function scanExtensionSource(source, { manifest } = {}) {
  const violations = []
  const text = String(source ?? '')
  if (text.length > MAX_SOURCE_BYTES) violations.push(`source is ${text.length} bytes; the limit is ${MAX_SOURCE_BYTES}`)
  if (text.trim() === '') violations.push('source is empty')
  // Import specifiers live inside strings, so they are read from the raw
  // source; the API tripwire runs over the stripped text so a quoted manual
  // ("never call process") is prose, not a violation.
  const imports = text.matchAll(/\bimport\b[^'";]*['"]([^'"]+)['"]/g)
  for (const match of imports) {
    if (match[1] !== 'ofm:sdk') violations.push(`import of "${match[1]}" — only "ofm:sdk" is available`)
  }
  const withoutStringsAndComments = stripStringsAndComments(text)
  for (const pattern of BANNED_SOURCE_PATTERNS) {
    if (pattern.test(withoutStringsAndComments)) violations.push(`source names a forbidden API: ${pattern}`)
  }
  const lines = text.split('\n')
  const longLines = lines.filter(line => line.length > 500).length
  if (longLines > 2) violations.push(`${longLines} lines exceed 500 characters — bundles and minified output are not reviewable`)
  if (manifest !== undefined && manifest !== null && typeof manifest === 'object') {
    // The manifest is already validated; keeping the parameter documents the
    // contract and leaves room for per-manifest rules without a signature change.
  }
  return { ok: violations.length === 0, violations }
}

/**
 * One page asset. HTML, JS and CSS get their own scans; images, fonts and JSON
 * are display/data only and pass as long as the path was declared.
 */
export function scanPageAsset({ path, text } = {}) {
  const source = String(text ?? '')
  const name = String(path ?? '').toLowerCase()
  if (source.length > MAX_PAGE_BYTES) return { ok: false, violations: [`${path} is ${source.length} bytes; the limit is ${MAX_PAGE_BYTES}`] }
  if (name.endsWith('.html')) return scanPageHtml(source)
  if (name.endsWith('.js') || name.endsWith('.mjs')) return scanPageScript(source)
  if (name.endsWith('.css')) return scanPageStyle(source)
  return { ok: true, violations: [] }
}

export function scanPageHtml(source) {
  const violations = []
  const text = String(source ?? '')
  if (text.trim() === '') violations.push('page HTML is empty')
  const lower = text.toLowerCase()

  // Inline scripts are refused: every script is a declared file with a digest,
  // and the host injects the one bridge script itself.
  const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  for (const match of scripts) {
    const attrs = match[1]
    if (!/\bsrc\s*=/i.test(attrs)) violations.push('inline <script> is not allowed; put the code in a declared .js file')
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? ''
    if (src !== '' && !isRelativeAsset(src)) violations.push(`script src "${src}" must be a relative package path`)
  }
  if (/<script\b(?![^>]*\bsrc\s*=)/i.test(text) && scripts.length === 0) {
    violations.push('unterminated or inline <script> is not allowed')
  }
  for (const tag of ['iframe', 'object', 'embed', 'form', 'base']) {
    if (new RegExp(`<\\s*${tag}\\b`, 'i').test(text)) violations.push(`<${tag}> is not allowed in a page plugin`)
  }
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(text)) violations.push('meta refresh is not allowed')
  if (/\son[a-z]+\s*=/i.test(text)) violations.push('inline event handlers are not allowed')
  const refs = [...text.matchAll(/\b(?:src|href|poster|data)\s*=\s*["']([^"']*)["']/gi)]
  for (const [, value] of refs) {
    if (value === '' || value.startsWith('#') || value.startsWith('data:') || value.startsWith('blob:')) continue
    if (!isRelativeAsset(value)) violations.push(`asset reference "${value}" must be a relative package path`)
  }
  if (/javascript\s*:/i.test(lower)) violations.push('javascript: URLs are not allowed')
  if (/@import\b/i.test(text)) violations.push('@import is not allowed in page HTML')
  return { ok: violations.length === 0, violations }
}

export function scanPageScript(source) {
  const violations = []
  const text = String(source ?? '')
  if (text.trim() === '') violations.push('page script is empty')
  const visible = stripStringsAndComments(text)
  for (const pattern of BANNED_PAGE_SCRIPT_PATTERNS) {
    if (pattern.test(visible)) violations.push(`page script names a forbidden API: ${pattern}`)
  }
  const longLines = text.split('\n').filter(line => line.length > 500).length
  if (longLines > 2) violations.push(`${longLines} lines exceed 500 characters — bundles and minified output are not reviewable`)
  return { ok: violations.length === 0, violations }
}

export function scanPageStyle(source) {
  const violations = []
  const text = String(source ?? '')
  if (text.trim() === '') violations.push('page style is empty')
  if (/@import\b/i.test(text)) violations.push('@import is not allowed in page CSS')
  if (/\bexpression\s*\(/i.test(text)) violations.push('CSS expression() is not allowed')
  for (const match of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
    const value = match[1].trim()
    if (value === '' || value.startsWith('data:') || value.startsWith('#')) continue
    if (!isRelativeAsset(value)) violations.push(`CSS url("${value}") must be a relative package path or data: URL`)
  }
  return { ok: violations.length === 0, violations }
}

function isRelativeAsset(value) {
  const text = String(value ?? '').trim()
  if (text === '') return true
  if (text.startsWith('//') || text.startsWith('/') || text.includes('\\')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return false
  if (text.split('/').some(part => part === '..')) return false
  return true
}

/** Blank comments and string bodies so pattern scans read code, not prose. */
export function stripStringsAndComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const end = stringEnd(source, index, char)
      if (end !== -1) {
        out += char + char
        index = end + 1
        continue
      }
    }
    out += char
    index += 1
  }
  return out
}

/**
 * The index of the quote closing the string opened at `start`, or -1 when this
 * quote does not open one. A single- or double-quoted literal cannot span a raw
 * newline, so a lone quote is a character inside something else — a regular
 * expression such as `/['"]/`, for one.
 */
function stringEnd(source, start, quote) {
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') { index += 2; continue }
    if (char === quote) return index
    if (char === '\n' && quote !== '`') return -1
    index += 1
  }
  return -1
}

export const CHANNEL_PACK_CHANNELS = [
  { id: 'lobsterai', providerId: 'llm-lobsterai', name: 'LobsterAI' },
  { id: 'qoder', providerId: 'llm-qoder', name: 'Qoder' },
  { id: 'qodercn', providerId: 'llm-qodercn', name: 'Qoder CN' },
  { id: 'trae', providerId: 'llm-trae', name: 'TRAE' },
  { id: 'cline', providerId: 'llm-cline', name: 'Cline' },
  { id: 'loomy', providerId: 'llm-loomy', name: 'Loomy' },
  { id: 'raccoon', providerId: 'llm-raccoon', name: 'Raccoon' },
  { id: 'minimax', providerId: 'llm-minimax', name: 'MiniMax' },
  { id: 'zcode', providerId: 'llm-zcode', name: 'ZCode' },
  { id: 'gemini', providerId: 'llm-gemini', name: 'Gemini' },
]

export const CHANNEL_PACK_DISABLED = [
  { id: 'opencode', providerId: 'opencode', name: 'OpenCode', reason: 'disabled in this build' },
]

export const WORKBENCH_CLIENTS = [
  { id: 'codex', name: 'Codex CLI', kind: 'cli', command: 'codex' },
  { id: 'claude', name: 'Claude Code', kind: 'cli', command: 'claude' },
  { id: 'gemini', name: 'Gemini CLI', kind: 'cli', command: 'gemini' },
  { id: 'codex-desktop', name: 'Codex Desktop', kind: 'desktop', command: 'Codex' },
  { id: 'cc-switch', name: 'CC Switch', kind: 'desktop', command: 'cc-switch', nativeOnly: true },
  { id: 'codex-plus-plus', name: 'Codex++', kind: 'desktop', command: 'codex-plus-plus', nativeOnly: true },
]

export const LIBRARY_FORMATS = {
  codex: { context: 'AGENTS.md', skills: 'skills', codex: true },
  'codex-desktop': { context: 'AGENTS.md', skills: 'skills', codex: true },
  claude: { context: 'CLAUDE.md', skills: 'skills', agents: 'agents', config: '.claude.json' },
  gemini: { context: '.gemini/GEMINI.md', skills: '.gemini/skills', agents: '.gemini/agents', config: '.gemini/settings.json' },
}



/** A compact projection of the aggregate provider registry: the plugin center
 *  does not need every model row, only the provider identity and size. */
let cached = null

export function providerContributions() {
  if (cached !== null) return cached
  try {
    const rows = JSON.parse(fs.readFileSync(new URL('./providers/registry.json', import.meta.url), 'utf8'))
    cached = (Array.isArray(rows) ? rows : []).map(row => ({
      id: String(row.id ?? ''),
      name: typeof row.name === 'string' ? row.name : String(row.id ?? ''),
      baseUrl: typeof row.baseUrl === 'string' ? row.baseUrl : '',
      format: typeof row.format === 'string' ? row.format : '',
      category: typeof row.category === 'string' ? row.category : '',
      modelCount: Array.isArray(row.models) ? row.models.length : 0,
    })).filter(row => row.id !== '')
  } catch {
    cached = []
  }
  return cached
}



export function builtinDescriptors() {
  const providers = providerContributions()
  return [
    {
      manifest: {
        id: 'core-channel-pack',
        name: '内置账号渠道',
        description: '随应用发布的十个账号渠道：登录、账号池、每日额度与本地网关。',
        icon: 'network',
        provides: ['channels'],
      },
      contributions: {
        channels: CHANNEL_PACK_CHANNELS,
        disabled: CHANNEL_PACK_DISABLED,
      },
    },
    {
      manifest: {
        id: 'core-aggregate-providers',
        name: '聚合渠道目录',
        description: '用户自带 API Key 的提供商目录与连线格式。',
        icon: 'boxes',
        provides: ['providers'],
      },
      contributions: { providers },
    },
    {
      manifest: {
        id: 'core-workbench-clients',
        name: '客户端启动器',
        description: '识别本机的 CLI 与桌面客户端，并为每次启动写入独立配置。',
        icon: 'terminal',
        provides: ['clients'],
      },
      contributions: { clients: WORKBENCH_CLIENTS },
    },
    {
      manifest: {
        id: 'core-library-formats',
        name: '资源库格式',
        description: '把资源库条目物化为各客户端的上下文、技能与 MCP 配置。',
        icon: 'book',
        provides: ['formats'],
      },
      contributions: {
        formats: Object.entries(LIBRARY_FORMATS).map(([id, format]) => ({ id, ...format })),
      },
    },
    {
      manifest: {
        id: 'core-model-workspace',
        name: '模型工作台',
        description: '内置的本地模型工作台页面与模型目录同步。',
        icon: 'panels',
        provides: ['ui'],
      },
      contributions: {},
    },
  ]
}


/** The marketplace snapshot shipped with the build; see readBundledRegistry. */
export const REGISTRY_FALLBACK = {
  "schemaVersion": 1,
  "generatedAt": "2026-11-07T09:25:39.628Z",
  "plugins": [
  {
    "schemaVersion": 1,
    "id": "anthropic-compatible",
    "version": "1.0.0",
    "type": "channel",
    "name": "Anthropic-Compatible",
    "main": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/anthropic-compatible/main.mjs",
      "size": 2309,
      "sha256": "138a77b64a4b5b64cfb38b3acbe1004cdab7b855ac66176791d51313ef35c3ad"
    },
    "description": "Point the harness at any Anthropic-compatible /v1/messages server — Anthropic itself, a gateway, or a loopback proxy. Speaks the messages wire.",
    "author": "OFM Extensions maintainers",
    "license": "MIT",
    "homepage": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "repository": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "icon": "",
    "minHost": "2.8.1",
    "permissions": {
      "network": [
        "https://api.anthropic.com",
        "http://127.0.0.1:8080",
        "http://127.0.0.1:8000",
        "http://localhost:8080"
      ],
      "secrets": [
        "apiKey"
      ],
      "storage": false
    },
    "cover": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/anthropic-compatible/cover.svg",
      "size": 838,
      "sha256": "7f3943f8aab12d08798c95db2d5a5b49c81e8d79340dc8e66e6e99167542227a"
    },
    "models": [
      {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5",
        "contextWindow": 200000,
        "maxOutput": 64000,
        "vision": true,
        "reasoning": true,
        "wire": "messages"
      },
      {
        "id": "claude-opus-4-1",
        "name": "Claude Opus 4.1",
        "contextWindow": 200000,
        "maxOutput": 32000,
        "vision": true,
        "reasoning": true,
        "wire": "messages"
      },
      {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5",
        "contextWindow": 200000,
        "maxOutput": 64000,
        "vision": true,
        "reasoning": false,
        "wire": "messages"
      }
    ],
    "config": [
      {
        "key": "baseUrl",
        "type": "text",
        "label": "Base URL",
        "description": "The server root — /v1/messages is appended, e.g. https://api.anthropic.com. Its origin must be one this package's permissions declare.",
        "default": "https://api.anthropic.com"
      }
    ],
    "summary": "Turns any Anthropic-compatible /v1/messages server into an OFM channel: base URL plus API key, speaking the messages wire.",
    "tags": [
      "anthropic",
      "claude",
      "messages",
      "self-hosted"
    ],
    "publishedAt": "2026-11-07T00:00:00.000Z",
    "changelog": [
      "1.0.0 — initial release: Anthropic-compatible /v1/messages channel with a canonical Claude model shelf"
    ]
  },
  {
    "schemaVersion": 1,
    "id": "kilo-free",
    "version": "1.0.0",
    "type": "channel",
    "name": "Kilo Free",
    "main": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/kilo-free/main.mjs",
      "size": 4390,
      "sha256": "954d775191d3407092eeb842e0023c4a8da7295e0efca95c232a06447bdbad13"
    },
    "description": "The Kilo gateway's free tier as a keyless channel. Takes the built-in Kilo lane over; no API key required.",
    "author": "OFM Extensions maintainers",
    "license": "MIT",
    "homepage": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "repository": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "icon": "",
    "minHost": "2.8.1",
    "permissions": {
      "network": [
        "https://ai-gateway.kilo.ai",
        "https://api.kilo.ai"
      ],
      "secrets": [],
      "storage": false
    },
    "replaces": "kilo",
    "cover": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/kilo-free/cover.svg",
      "size": 838,
      "sha256": "917288a7a7edf17fab751fe57bb3aee63178dd498c5506e68fdc97b8f5c62181"
    },
    "models": [
      {
        "id": "kilo-auto/free",
        "name": "Kilo Auto",
        "contextWindow": 256000,
        "maxOutput": 32768,
        "vision": false,
        "reasoning": false,
        "wire": "chat"
      },
      {
        "id": "nvidia/nemotron-3.5-super-vl:free",
        "name": "Nemotron 3.5 Super VL",
        "contextWindow": 262144,
        "maxOutput": 32768,
        "vision": true,
        "reasoning": false,
        "wire": "chat"
      },
      {
        "id": "reflection/beam-free",
        "name": "Beam",
        "contextWindow": 131072,
        "maxOutput": 16384,
        "vision": false,
        "reasoning": true,
        "wire": "chat"
      },
      {
        "id": "stealth/glyph-cluster",
        "name": "Glyph Cluster",
        "contextWindow": 200000,
        "maxOutput": 32768,
        "vision": false,
        "reasoning": true,
        "wire": "chat"
      },
      {
        "id": "stealth/crouton-alpha",
        "name": "Crouton Alpha",
        "contextWindow": 200000,
        "maxOutput": 32768,
        "vision": false,
        "reasoning": false,
        "wire": "chat"
      },
      {
        "id": "dots-studio/dots-3-note-preview:free",
        "name": "Dots 3 Note Preview",
        "contextWindow": 131072,
        "maxOutput": 16384,
        "vision": false,
        "reasoning": false,
        "wire": "chat"
      },
      {
        "id": "nvidia/nemotron-3.5-lightning:free",
        "name": "Nemotron 3.5 Lightning",
        "contextWindow": 262144,
        "maxOutput": 16384,
        "vision": false,
        "reasoning": false,
        "wire": "chat"
      },
      {
        "id": "cohere/north-mini-code:free",
        "name": "North Mini Code",
        "contextWindow": 256000,
        "maxOutput": 32768,
        "vision": false,
        "reasoning": false,
        "wire": "chat"
      },
      {
        "id": "nvidia/nemotron-3-ultra-550b-a55b:free",
        "name": "Nemotron 3 Ultra 550B",
        "contextWindow": 262144,
        "maxOutput": 32768,
        "vision": false,
        "reasoning": true,
        "wire": "chat"
      },
      {
        "id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        "name": "Nemotron 3 Nano Omni 30B",
        "contextWindow": 262144,
        "maxOutput": 32768,
        "vision": true,
        "reasoning": true,
        "wire": "chat"
      },
      {
        "id": "openrouter/free",
        "name": "OpenRouter Free",
        "contextWindow": 131072,
        "maxOutput": 16384,
        "vision": false,
        "reasoning": false,
        "wire": "chat"
      }
    ],
    "config": [],
    "summary": "The Kilo gateway's free model tier as a keyless channel — takes the built-in Kilo lane over with no API key required.",
    "tags": [
      "free",
      "gateway",
      "kilo",
      "no-key"
    ],
    "publishedAt": "2026-11-07T00:00:00.000Z",
    "changelog": [
      "1.0.0 — initial release: keyless Kilo gateway free tier, takes over the built-in kilo lane"
    ]
  },
  {
    "schemaVersion": 1,
    "id": "model-filter",
    "version": "1.0.0",
    "type": "enhancement",
    "name": "Model Filter",
    "main": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/model-filter/main.mjs",
      "size": 1577,
      "sha256": "530ae8873b73252599e7e7e76082917aa239f5f1af644d921d7d38820e264479"
    },
    "description": "Hides catalog models whose id or name contains one of your comma-separated substrings. Reserved for the lane's model listing; request bodies pass through.",
    "author": "OFM Extensions maintainers",
    "license": "MIT",
    "homepage": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "repository": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "icon": "",
    "minHost": "2.8.1",
    "permissions": {
      "network": [],
      "secrets": [],
      "storage": false
    },
    "cover": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/model-filter/cover.svg",
      "size": 838,
      "sha256": "eda4a836f67fb8ce4e38e01fba4965df14455328c491b3002a7184555ad2b118"
    },
    "hooks": [
      "onRequest",
      "onModels"
    ],
    "config": [
      {
        "key": "hide",
        "type": "text",
        "label": "Hide models matching",
        "description": "Comma-separated substrings, matched case-insensitively against each model's id and name. Empty shows everything.",
        "default": ""
      }
    ],
    "summary": "Filters catalog rows whose id or name contains one of your comma-separated substrings; outgoing bodies pass through untouched.",
    "tags": [
      "catalog",
      "filter",
      "models"
    ],
    "publishedAt": "2026-11-07T00:00:00.000Z",
    "changelog": [
      "1.0.0 — initial release: catalog filtering by comma-separated substrings"
    ]
  },
  {
    "schemaVersion": 1,
    "id": "openai-compatible",
    "version": "1.0.0",
    "type": "channel",
    "name": "OpenAI-Compatible",
    "main": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/openai-compatible/main.mjs",
      "size": 2374,
      "sha256": "b194b9ef5c44903db5d4aa1a5739101673ad882bc3a12cfc4b10aac70da7d233"
    },
    "description": "Point the harness at any OpenAI-compatible /chat/completions server — OpenAI itself, Ollama, LM Studio, llama.cpp, vLLM, or a loopback proxy.",
    "author": "OFM Extensions maintainers",
    "license": "MIT",
    "homepage": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "repository": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "icon": "",
    "minHost": "2.8.1",
    "permissions": {
      "network": [
        "https://api.openai.com",
        "http://127.0.0.1:11434",
        "http://127.0.0.1:1234",
        "http://127.0.0.1:8080",
        "http://127.0.0.1:8000",
        "http://[::1]:11434"
      ],
      "secrets": [
        "apiKey"
      ],
      "storage": false
    },
    "cover": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/openai-compatible/cover.svg",
      "size": 838,
      "sha256": "3aefa41e87f9f946956ac3a0173f3d76f4171bb499f1ff23a4391d2603c9c6d2"
    },
    "models": [
      {
        "id": "gpt-4o",
        "name": "GPT-4o",
        "contextWindow": 128000,
        "maxOutput": 16384,
        "vision": true,
        "reasoning": false,
        "wire": "chat"
      },
      {
        "id": "gpt-4o-mini",
        "name": "GPT-4o mini",
        "contextWindow": 128000,
        "maxOutput": 16384,
        "vision": true,
        "reasoning": false,
        "wire": "chat"
      },
      {
        "id": "gpt-4.1",
        "name": "GPT-4.1",
        "contextWindow": 128000,
        "maxOutput": 32768,
        "vision": true,
        "reasoning": false,
        "wire": "chat"
      },
      {
        "id": "deepseek-chat",
        "name": "DeepSeek Chat",
        "contextWindow": 131072,
        "maxOutput": 8192,
        "vision": false,
        "reasoning": false,
        "wire": "chat"
      }
    ],
    "config": [
      {
        "key": "baseUrl",
        "type": "text",
        "label": "Base URL",
        "description": "The server root, e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1. Its origin must be one this package's permissions declare.",
        "default": "https://api.openai.com/v1"
      }
    ],
    "summary": "Turns any OpenAI-compatible server into an OFM channel: set the base URL, optionally store an API key, and chat over the chat wire.",
    "tags": [
      "chat",
      "compatible",
      "openai",
      "self-hosted"
    ],
    "publishedAt": "2026-11-07T00:00:00.000Z",
    "changelog": [
      "1.0.0 — initial release: OpenAI-compatible /chat/completions channel with a canonical model shelf"
    ]
  },
  {
    "schemaVersion": 1,
    "id": "param-override",
    "version": "1.0.0",
    "type": "enhancement",
    "name": "Param Override",
    "main": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/param-override/main.mjs",
      "size": 1544,
      "sha256": "3ee28eda4fbc30d517d9b97ebd4c86fc4c8c809f83b2b80170cec07a5c97c86d"
    },
    "description": "Caps max_tokens (and max_completion_tokens) on every outgoing body and can drop temperature — for gateways that reject large or hot requests.",
    "author": "OFM Extensions maintainers",
    "license": "MIT",
    "homepage": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "repository": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "icon": "",
    "minHost": "2.8.1",
    "permissions": {
      "network": [],
      "secrets": [],
      "storage": false
    },
    "cover": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/param-override/cover.svg",
      "size": 838,
      "sha256": "441c4cc182acfa8fbbc4b5870a62dff6cd7cbd70e2a8ed753a9e8ae88f05f9ec"
    },
    "hooks": [
      "onRequest"
    ],
    "config": [
      {
        "key": "maxTokens",
        "type": "number",
        "label": "max_tokens cap",
        "description": "Outgoing max_tokens / max_completion_tokens above this cap are lowered to it. Values the gateway already accepts are left alone.",
        "default": 8192
      },
      {
        "key": "dropTemperature",
        "type": "toggle",
        "label": "Drop temperature",
        "description": "Remove the temperature field from every outgoing body. For servers that reject sampling options.",
        "default": false
      }
    ],
    "summary": "Caps outgoing max_tokens and optionally strips temperature from every body — fail-open when disabled.",
    "tags": [
      "body",
      "parameters",
      "rewrite"
    ],
    "publishedAt": "2026-11-07T00:00:00.000Z",
    "changelog": [
      "1.0.0 — initial release: max_tokens cap with optional temperature drop"
    ]
  },
  {
    "schemaVersion": 1,
    "id": "system-prompt",
    "version": "1.0.0",
    "type": "enhancement",
    "name": "System Prompt",
    "main": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/system-prompt/main.mjs",
      "size": 2589,
      "sha256": "c11337c14c8077fcf23e4bf83af1d94774a88b3f6a95424709404d93d3fb79e8"
    },
    "description": "Prepends one system prompt to every outgoing turn — merged into the chat system message, the Claude system string, or the responses instructions field, per wire.",
    "author": "OFM Extensions maintainers",
    "license": "MIT",
    "homepage": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "repository": "https://github.com/Ebony-Vinyl/ofm-extensions",
    "icon": "",
    "minHost": "2.8.1",
    "permissions": {
      "network": [],
      "secrets": [],
      "storage": false
    },
    "cover": {
      "url": "https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/system-prompt/cover.svg",
      "size": 838,
      "sha256": "65ab2c703a0c5ab203464a7e77261af6cbef4412086425fd9bf11f54773b22e1"
    },
    "hooks": [
      "onRequest"
    ],
    "config": [
      {
        "key": "prompt",
        "type": "text",
        "label": "System prompt",
        "description": "Prepended to every outgoing turn. Empty disables the enhancement. Merged with any system prompt the lane itself sets.",
        "default": ""
      }
    ],
    "summary": "Prepends one configurable system prompt to every outgoing turn, across the chat, messages and responses wires.",
    "tags": [
      "prompt",
      "rewrite",
      "system"
    ],
    "publishedAt": "2026-11-07T00:00:00.000Z",
    "changelog": [
      "1.0.0 — initial release: one system prompt prepended across the chat, messages and responses wires"
    ]
  }
]
}

export function pageBridgeSource() {
  return `(() => {
  const pending = new Map()
  let sequence = 0
  const themeHandlers = new Set()
  const reply = (event) => {
    const data = event && event.data
    if (!data || typeof data !== 'object' || data.__ofm !== 1) return
    if (data.type === 'rpc-reply') {
      const entry = pending.get(data.id)
      if (entry === undefined) return
      clearTimeout(entry.timer)
      pending.delete(data.id)
      if (data.ok) entry.resolve(data.result)
      else entry.reject(new Error(String(data.error || 'host call failed')))
      return
    }
    if (data.type === 'theme') {
      const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : {}
      for (const key of Object.keys(tokens)) {
        if (/^--[\\w-]+$/.test(key) && typeof tokens[key] === 'string') {
          document.documentElement.style.setProperty(key, tokens[key])
        }
      }
      document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light'
      for (const handler of themeHandlers) {
        try { handler(data) } catch {}
      }
    }
  }
  window.addEventListener('message', reply)
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('host call timed out'))
    }, 20000)
    pending.set(id, { resolve, reject, timer })
    parent.postMessage({ __ofm: 1, type: 'rpc', id, method, params }, '*')
  })
  const storage = {
    get: key => call('storage.get', { key: String(key) }),
    set: (key, value) => call('storage.set', { key: String(key), value }),
    delete: key => call('storage.delete', { key: String(key) }),
  }
  window.ofm = {
    plugin: { info: () => call('plugin.info', {}) },
    config: { get: () => call('config.get', {}) },
    storage,
    http: {
      fetch: (url, init) => call('http.fetch', {
        url: String(url),
        method: init && init.method ? String(init.method) : 'GET',
        headers: init && init.headers ? init.headers : {},
        body: init ? init.body : undefined,
      }),
    },
    notify: message => parent.postMessage({ __ofm: 1, type: 'notify', message: String(message).slice(0, 200) }, '*'),
    resize: height => parent.postMessage({ __ofm: 1, type: 'resize', height: Number(height) || 0 }, '*'),
    onTheme: handler => {
      if (typeof handler !== 'function') return () => {}
      themeHandlers.add(handler)
      return () => themeHandlers.delete(handler)
    },
    ready: Promise.resolve(),
  }
  parent.postMessage({ __ofm: 1, type: 'ready' }, '*')
})()
`
}

