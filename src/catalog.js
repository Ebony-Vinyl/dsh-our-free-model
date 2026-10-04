/**
 * Model catalog for the free lane.
 *
 * Two sources, deliberately layered so no single one can break the plugin:
 *
 * 1. the upstream listing itself (`/zen/v1/models`) — the authoritative set of
 *    ids the gateway will currently name;
 * 2. a vetted local capability table (context window / vision / reasoning),
 *    because the upstream listing discloses an id and nothing else.
 *
 * @module src/catalog.js
 */

import { baseModelId, isResponsesModel } from './upstream.js'

/** Ids that are free-tier without carrying the `-free` suffix. */
const ALWAYS_FREE = new Set(['union-alpha', 'space-bunny-free'])

/**
 * Local capability baseline. `contextWindow`/`maxOutput` are the provider's
 * published capacities; `vision` is what this lane actually accepted under a
 * direct image-input probe, not what a model card claims.
 */
export const CAPABILITIES = [
  { match: /^mimo.*v2\.6/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072, canDisableThinking: false },
  { match: /^mimo.*v2\.5/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072, canDisableThinking: false },
  { match: /^mimo/, vision: true, reasoning: true, contextWindow: 262144, maxOutput: 131072 },
  { match: /^muse.?spark/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
  { match: /^nemotron/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 32768 },
  { match: /^ling/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 32768 },
  { match: /^space.?bunny/, vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 },
  { match: /^union/, vision: true, reasoning: false, contextWindow: 262144, maxOutput: 131072 },
  { match: /^deepseek/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 64000 },
  { match: /^jev/, vision: false, reasoning: false, contextWindow: 32768, maxOutput: 4096 },
]

/** Human-facing display names, so a raw upstream id never reaches the picker. */
const DISPLAY_NAMES = {
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash',
  'mimo-v2.5-free': 'MiMo V2.5',
  'muse-spark-1.3-contributor-free': 'Muse Spark 1.3',
  'muse-spark-1.2-contributor-free': 'Muse Spark 1.2',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning',
  'ling-3.0-flash-fin-free': 'Ling 3.0 Flash Fin',
  'space-bunny-free': 'Space Bunny',
  'union-alpha': 'Union Alpha',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash',
  'jev-1.13-free': 'Jev 1.13',
}

/** Ids whose regional availability is known to be egress-dependent. */
const REGION_SENSITIVE = [/^muse.?spark/]

/**
 * Is this id on the免密 lane? The gateway's listing mixes paid and free ids;
 * only these answer without a per-user key.
 */
export function isFreeLane(modelId) {
  const base = baseModelId(modelId)
  if (ALWAYS_FREE.has(base)) return true
  return /(?:^|[-_])free(?:$|[-_.])/.test(base)
}

/** Look up the baseline capacities for one model id. */
export function capabilitiesFor(modelId) {
  const base = baseModelId(modelId)
  for (const entry of CAPABILITIES) if (entry.match.test(base)) return entry
  return { vision: false, reasoning: true, contextWindow: 131072, maxOutput: 32768 }
}

export function isRegionSensitive(modelId) {
  const base = baseModelId(modelId)
  return REGION_SENSITIVE.some(pattern => pattern.test(base))
}

/** Title-case a bare upstream id into something a picker can show. */
export function displayModelName(modelId) {
  const base = baseModelId(modelId)
  const known = DISPLAY_NAMES[base]
  if (known !== undefined) return known
  const words = base
    .replace(/[-_.]+/g, ' ')
    .replace(/(\d)\s+/g, '$1 ')
    .trim()
    .split(' ')
    .map(word => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
  return words
}

/**
 * Merge the upstream listing with the local capability table.
 *
 * @param {string[]} ids - raw upstream model ids
 * @returns {Array<object>} catalog entries in listing order
 */
export function buildCatalog(ids) {
  const seen = new Set()
  const entries = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (id === '' || !isFreeLane(id)) continue
    const base = baseModelId(id)
    if (seen.has(base)) continue
    seen.add(base)
    const caps = capabilitiesFor(base)
    entries.push({
      id: base,
      name: displayModelName(base),
      wire: isResponsesModel(base) ? 'responses' : 'chat',
      vision: caps.vision === true,
      reasoning: caps.reasoning !== false,
      contextWindow: number(caps.contextWindow) ?? 131072,
      maxOutput: number(caps.maxOutput) ?? 32768,
      canDisableThinking: caps.canDisableThinking !== false,
      regionSensitive: isRegionSensitive(base),
    })
  }
  return entries
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/** Parse the gateway's `{"data":[{"id":…}]}` listing. */
export function parseListing(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : []
  return rows.map(row => (typeof row === 'string' ? row : row?.id)).filter(id => typeof id === 'string' && id !== '')
}

// ── the co-paid lane ──────────────────────────────────────────────────────────
//
// A second producer whose ids are namespaced upstream ids (`org/model`) and
// whose entries carry `channel: 'eac'` end to end: the adapter routes them to
// their own wire, the probe skips them, and the pages show the channel tag.
// Display names are the model's own name under the channel tag — the org
// prefix is routing detail, never a name the picker shows.

export const EAC_CHANNEL = 'eac'
export const EAC_TAG = 'EAC'

const EAC_DISPLAY_NAMES = {
  'deepseek-ai/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'moonshotai/kimi-k2.6': 'Kimi K2.6',
  'moonshotai/kimi-k3': 'Kimi K3',
  'openai/gpt-oss-20b': 'GPT-OSS 20B',
  'z-ai/glm-5.3': 'GLM 5.3',
  'z-ai/glm-5.3-flash': 'GLM 5.3 Flash',
}

/**
 * Capacities per model: published specs cross-checked against this lane where
 * the relay allowed a probe (2026-10-03), and the thinking-level menu copied
 * from ZCode's built-in provider config (`config/provider/zcode-builtin.json`,
 * the `modelRules`/`modelApiRules`/`providerSiteRules` buckets) — the same
 * per-model declaration shape that product ships: a list of levels plus a
 * JSON merge patch the level maps onto the request body. `vision` records what
 * the relay actually accepted under a direct image-input probe — DeepSeek V4.1
 * Flash and GLM 5.3 Flash answered a 1×1 image with its colour; the Kimi
 * models carry native vision encoders per their model cards but the relay's
 * kimi routes were down during the probe, so their flag follows the published
 * spec. These numbers bound the client-side truncation estimates and the sent
 * max_tokens; the relay enforces its own ceilings on the wire.
 *
 * `efforts`/`effortDefault`/`effortPatch` mirror ZCode's declaration for the
 * model families it names; `effortPatch` uses `$effort` as the selected
 * level's placeholder, and `effortOffPatch` (when present) replaces the patch
 * for the off level. Models ZCode does not declare (kimi-k2.6, gpt-oss-20b)
 * fall back to the family-standard `reasoning_effort` field.
 */
const EAC_CAPABILITIES = [
  {
    match: /^deepseek-ai\/deepseek-v4/,
    vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 384000,
    efforts: ['disabled', 'low', 'high', 'max'], effortDefault: 'high',
    effortPatch: { reasoning_effort: '$effort' },
    effortOffPatch: { reasoning: { enabled: false } },
  },
  {
    match: /^moonshotai\/kimi-k3/,
    vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072,
    efforts: ['low', 'high', 'max'], effortDefault: 'high',
    effortPatch: { reasoning_effort: '$effort' },
  },
  {
    match: /^moonshotai\/kimi/,
    vision: true, reasoning: true, contextWindow: 262144, maxOutput: 98304,
    efforts: ['low', 'high', 'max'], effortDefault: 'high',
    effortPatch: { reasoning_effort: '$effort' },
  },
  {
    match: /^z-ai\/glm-5\.3-flash/,
    vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072,
    efforts: ['low', 'high', 'max'], effortDefault: 'high',
    effortPatch: { thinking: { type: 'enabled' }, output_config: { effort: '$effort' } },
  },
  {
    match: /^z-ai\/glm-5/,
    vision: false, reasoning: true, contextWindow: 1048576, maxOutput: 131072,
    efforts: ['low', 'high', 'max'], effortDefault: 'high',
    effortPatch: { thinking: { type: 'enabled' }, output_config: { effort: '$effort' } },
  },
  {
    match: /^openai\/gpt-oss/,
    vision: false, reasoning: true, contextWindow: 131072, maxOutput: 32768,
    efforts: ['low', 'medium', 'high'], effortDefault: 'medium',
    effortPatch: { reasoning_effort: '$effort' },
  },
]

/** `org/model` → the model's own name under the channel tag. */
export function eacDisplayName(modelId) {
  const base = String(modelId ?? '').trim()
  const bare = base.includes('/') ? base.slice(base.indexOf('/') + 1) : base
  const known = EAC_DISPLAY_NAMES[base]
  const pretty = known ?? bare
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(' ')
    .map(word => (/^\d/.test(word) ? word : word.toUpperCase() === word ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
  return `${EAC_TAG} ${pretty}`
}

function eacCapabilitiesFor(modelId) {
  for (const entry of EAC_CAPABILITIES) if (entry.match.test(modelId)) return entry
  return { vision: false, reasoning: true, contextWindow: 131072, maxOutput: 32768 }
}

/**
 * Build the co-paid lane's catalog rows from its raw listing ids.
 *
 * Every row is one chat-wire model that always thinks (the relay streams
 * reasoning whether or not the caller asks for it) and never sees images.
 */
export function buildEacCatalog(ids) {
  const seen = new Set()
  const entries = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const caps = eacCapabilitiesFor(id)
    entries.push({
      id,
      name: eacDisplayName(id),
      channel: EAC_CHANNEL,
      wire: 'chat',
      vision: caps.vision === true,
      reasoning: caps.reasoning !== false,
      contextWindow: number(caps.contextWindow) ?? 131072,
      maxOutput: number(caps.maxOutput) ?? 32768,
      canDisableThinking: Array.isArray(caps.efforts) ? caps.efforts.includes('disabled') : false,
      regionSensitive: false,
      // The model's declared thinking menu, copied from ZCode's built-in config.
      ...Array.isArray(caps.efforts) ? { efforts: [...caps.efforts], effortDefault: caps.effortDefault } : {},
      ...caps.effortPatch === undefined ? {} : { effortPatch: caps.effortPatch },
      ...caps.effortOffPatch === undefined ? {} : { effortOffPatch: caps.effortOffPatch },
    })
  }
  return entries
}

/** Is this catalog row from the co-paid lane? */
export function isEacEntry(entry) {
  return entry?.channel === EAC_CHANNEL
}
