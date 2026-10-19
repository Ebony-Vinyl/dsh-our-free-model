/**
 * Batas ukuran body permintaan ke upstream jalur gratis.
 *
 * Upstream menjawab `400 ModelProtocolUnsupported` untuk body di atas sekitar
 * 700 KB. Diukur 2026-10-19 lewat jalur yang sama, model yang sama, dan
 * riwayat yang sama: 699.974 byte lolos, 765.000 byte ditolak. Pemicunya
 * **ukuran body**, bukan jumlah tool (227 tool tetap lolos saat skemanya
 * diringkas) dan bukan isi pesan.
 *
 * Zed mendeklarasikan setiap tool MCP yang dikenal, jadi sesi dengan 227 tool
 * sudah mengirim ~950 KB sebelum percakapan tumbuh. Modul ini menurunkan body
 * ke bawah anggaran byte **tanpa membuang tool**: deskripsi dipotong lebih
 * dulu, lalu hanya skema yang masih kebesaran yang dibatasi kedalamannya.
 * Membuang tool adalah upaya terakhir dan selalu dilaporkan lewat `warn`.
 *
 * @module src/request-budget.js
 */

/** 640 KiB — margin aman di bawah 699.974 byte yang terbukti lolos. */
export const DEFAULT_REQUEST_BUDGET_BYTES = 655360

/** Deskripsi tool tingkat atas; sisanya jarang dibaca model. */
const MAX_TOOL_DESCRIPTION = 200
/** Deskripsi properti di dalam skema parameter. */
const MAX_PARAMETER_DESCRIPTION = 160
/**
 * Tangga batas per tool. Setiap batas diterapkan ke seluruh tool, lalu body
 * diukur ulang; tangga berhenti pada batas pertama yang membuat body muat.
 * 20 KB → 16 KB → … → 2 KB.
 */
const TOOL_CAP_LADDER = [20000, 16000, 12000, 8000, 5000, 3000, 2000]
/** Kedalaman terdalam yang masih dipertahankan saat skema diringkas. */
const MIN_DEPTH = 2
/** Kedalaman awal; sebagian besar skema MCP tidak lebih dalam dari ini. */
const MAX_DEPTH = 6

/** Kunci skema yang dipertahankan saat meringkas; sisanya dibuang. */
const SCHEMA_KEYS = [
  'type', 'format', 'enum', 'const', 'required', 'additionalProperties',
  'items', 'properties', 'anyOf', 'oneOf', 'allOf', 'not',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
  'minProperties', 'maxProperties', 'multipleOf',
]

/** Byte yang benar-benar dikirim, bukan satuan UTF-16 dari `.length`. */
export function payloadBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * Locate the schema holder for every tool spelling this gateway accepts:
 * `{type:'function', function:{…}}` (chat), `{type:'function', name, …}` (flat),
 * and `{name, input_schema}` (messages).
 */
function schemaSlot(tool) {
  if (tool !== null && typeof tool === 'object' && tool.function !== null && typeof tool.function === 'object') {
    return { holder: tool.function, key: 'parameters' }
  }
  if (tool !== null && typeof tool === 'object' && tool.input_schema !== undefined) {
    return { holder: tool, key: 'input_schema' }
  }
  return { holder: tool, key: 'parameters' }
}

/** Deep-copy one schema node, keeping structure only up to `maxDepth`. */
function shrinkSchema(schema, depth, maxDepth) {
  if (schema === null || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(item => shrinkSchema(item, depth, maxDepth))

  const out = {}
  for (const key of SCHEMA_KEYS) {
    if (!Object.hasOwn(schema, key)) continue
    const value = schema[key]
    if (key === 'properties' && value !== null && typeof value === 'object') {
      out.properties = {}
      if (depth < maxDepth) {
        for (const [name, child] of Object.entries(value)) {
          out.properties[name] = shrinkSchema(child, depth + 1, maxDepth)
        }
      }
      continue
    }
    if (key === 'items' && depth >= maxDepth) {
      // Keep the item type so the model still knows the array's element kind.
      out.items = value !== null && typeof value === 'object' && !Array.isArray(value) && value.type !== undefined
        ? { type: value.type }
        : {}
      continue
    }
    if (key === 'additionalProperties' && value !== null && typeof value === 'object') {
      out.additionalProperties = shrinkSchema(value, depth + 1, maxDepth)
      continue
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.map(item => shrinkSchema(item, depth + 1, maxDepth))
      continue
    }
    if (key === 'not' && value !== null && typeof value === 'object') {
      out.not = shrinkSchema(value, depth + 1, maxDepth)
      continue
    }
    out[key] = value
  }
  if (typeof schema.description === 'string') out.description = schema.description.slice(0, MAX_PARAMETER_DESCRIPTION)
  return out
}

/**
 * Bring one payload under `budgetBytes` in place.
 *
 * @param {object} body - the exact JSON body about to be sent upstream
 * @param {{budgetBytes?: number}} [options]
 * @returns {{trimmed: boolean, before: number, after: number, budgetBytes: number,
 *   toolsShrunk: number, toolsDropped: number, fits: boolean}}
 */
export function applyRequestBudget(body, { budgetBytes = DEFAULT_REQUEST_BUDGET_BYTES } = {}) {
  const limit = Number.isFinite(budgetBytes) && budgetBytes > 0
    ? Math.floor(budgetBytes)
    : DEFAULT_REQUEST_BUDGET_BYTES
  const before = body === null || typeof body !== 'object' ? 0 : payloadBytes(body)
  const report = {
    trimmed: false, before, after: before, budgetBytes: limit,
    toolsShrunk: 0, toolsDropped: 0, fits: before <= limit,
  }
  if (before <= limit || body === null || typeof body !== 'object') return report

  // The adapter rebuilds a payload per attempt, but `payload.tools` may share
  // objects with the caller's request. Clone before mutating so a retry starts
  // from the caller's declaration, not from the previous trim.
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map(tool => JSON.parse(JSON.stringify(tool)))
  }
  const tools = Array.isArray(body.tools) ? body.tools : []

  // 1. Prose first — the cheapest thing to lose and the least structural.
  for (const tool of tools) {
    const slot = schemaSlot(tool)
    if (typeof slot.holder.description === 'string') {
      slot.holder.description = slot.holder.description.slice(0, MAX_TOOL_DESCRIPTION)
    }
  }
  let after = payloadBytes(body)
  if (after <= limit) {
    return { ...report, trimmed: true, after, fits: true }
  }

  // 2. Depth-limit only the schemas that are still oversized, escalating the
  //    per-tool cap until the whole body fits. Small tools stay untouched.
  const originals = new Map()
  for (const tool of tools) {
    const slot = schemaSlot(tool)
    originals.set(tool, slot.holder[slot.key])
  }
  for (const cap of TOOL_CAP_LADDER) {
    for (const tool of tools) {
      const slot = schemaSlot(tool)
      if (payloadBytes(slot.holder) <= cap) continue
      const original = originals.get(tool)
      if (original === undefined) continue
      for (let depth = MAX_DEPTH; depth >= MIN_DEPTH; depth -= 1) {
        slot.holder[slot.key] = shrinkSchema(original, 0, depth)
        if (payloadBytes(slot.holder) <= cap) break
      }
      report.toolsShrunk += 1
    }
    after = payloadBytes(body)
    if (after <= limit) {
      return { ...report, trimmed: true, after, fits: true }
    }
  }

  // 3. Last resort: the conversation itself is near the ceiling. Drop the
  //    largest schemas rather than send a body the upstream will reject.
  const ordered = tools
    .map(tool => ({ tool, bytes: payloadBytes(tool) }))
    .sort((left, right) => right.bytes - left.bytes)
  for (const { tool } of ordered) {
    const index = body.tools.indexOf(tool)
    if (index < 0) continue
    body.tools.splice(index, 1)
    report.toolsDropped += 1
    after = payloadBytes(body)
    if (after <= limit) break
  }

  return { ...report, trimmed: true, after, fits: after <= limit }
}
