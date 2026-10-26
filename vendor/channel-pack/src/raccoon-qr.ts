/**
 * 二维码生成（零依赖，供本地登录页使用）。
 *
 * ## 为什么要自己实现
 *
 * 仓库**没有任何 QR 依赖**（已核实 `node_modules` 与 DSH 的 `node_modules`）。
 * 客户端用的是 `qrcode.react`（内部 `qrcode-generator`），但那不能直接复用：
 * 我们的登录页是宿主侧渲染的 HTML，而 `qrcode.react` 是 React 组件。
 *
 * ## 为什么放在宿主侧而不是浏览器端
 *
 * 二维码内容（`https://…/login/mp?code=<32位hex>&appname=…`）由**宿主侧**
 * 在登录会话开始时生成，之后**不再变化** —— 页面只需把它画出来。
 * 故宿主侧直接产出 SVG 字符串内联进 HTML 即可，浏览器端**不需要**任何 QR 逻辑。
 * 这消除了「两份实现漂移」的风险（计划里曾考虑宿主 + 浏览器两份实现 + parity 测试）。
 *
 * ## 实现范围（刻意最小）
 *
 * - **byte 模式**（UTF-8 字节）
 * - **纠错等级 M**
 * - **版本 1–10**（内容上限 213 字节，够编码约 145 字节的登录 URL）
 *
 * 不做数字/字母数字模式、不做更高纠错等级、不做版本 11+ —— 本插件的用途是
 * 编码一个固定形态的短 URL。超出容量时**抛错**（由调用方缩短内容），
 * 而不是静默产出扫不出来的坏码。
 *
 * 算法依据 ISO/IEC 18004。结构与 Nayuki 的参考实现一致（MIT），
 * 但按本项目的注释与命名习惯重写。
 */

/** 生成结果。 */
export interface QrMatrix {
  /** 边长（模块数）。 */
  size: number
  /** `modules[row][col]`，`true` 表示深色模块。 */
  modules: boolean[][]
}

/** 各版本（1–10）纠错等级 M 的**数据码字**总数。 */
const DATA_CODEWORDS: readonly number[] = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216]

/** 纠错块结构。 */
interface EcBlocks {
  /** 每块的纠错码字数。 */
  ecPerBlock: number
  /** `[块数, 每块数据码字数]` 的列表。 */
  groups: readonly (readonly [number, number])[]
}

/** 各版本（1–10）纠错等级 M 的块结构。 */
const EC_BLOCKS_M: readonly (EcBlocks | undefined)[] = [
  undefined,
  { ecPerBlock: 10, groups: [[1, 16]] },
  { ecPerBlock: 16, groups: [[1, 28]] },
  { ecPerBlock: 26, groups: [[1, 44]] },
  { ecPerBlock: 18, groups: [[2, 32]] },
  { ecPerBlock: 24, groups: [[2, 43]] },
  { ecPerBlock: 16, groups: [[4, 27]] },
  { ecPerBlock: 18, groups: [[4, 31]] },
  { ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  { ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  { ecPerBlock: 26, groups: [[4, 43], [1, 44]] },
]

// ── GF(256) 运算（本原多项式 0x11D） ──────────────────────────────

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)

{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if ((x & 0x100) !== 0) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0
}

/** GF(256) 乘法。 */
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0
}

/** 多项式乘法（最高次在前）。 */
function polyMul(a: readonly number[], b: readonly number[]): number[] {
  const result = new Array<number>(a.length + b.length - 1).fill(0)
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gfMul(a[i] ?? 0, b[j] ?? 0)
    }
  }
  return result
}

/** 生成 `degree` 次 Reed-Solomon 生成多项式（最高次在前）。 */
function rsGeneratorPoly(degree: number): number[] {
  let poly: number[] = [1]
  for (let i = 0; i < degree; i++) {
    poly = polyMul(poly, [1, GF_EXP[i] ?? 0])
  }
  return poly
}

/** 计算 Reed-Solomon 纠错码字（综合除法取余）。 */
function rsEncode(data: readonly number[], ecCount: number): number[] {
  const gen = rsGeneratorPoly(ecCount)
  const buf = [...data, ...new Array<number>(ecCount).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i] ?? 0
    if (coef === 0) continue
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] ^= gfMul(gen[j] ?? 0, coef)
    }
  }
  return buf.slice(data.length)
}

// ── 数据编码 ──────────────────────────────────────────────────────

/** 选能容纳 `byteLength` 字节的最小版本；都装不下返回 undefined。 */
function pickVersion(byteLength: number): number | undefined {
  for (let version = 1; version <= 10; version++) {
    const capacityBits = (DATA_CODEWORDS[version] ?? 0) * 8
    // 模式指示符 4 位 + 字符计数（版本 1–9 是 8 位，10 起是 16 位）
    const overheadBits = 4 + (version <= 9 ? 8 : 16)
    if (overheadBits + byteLength * 8 <= capacityBits) return version
  }
  return undefined
}

/**
 * 把字节编码成**交织前**的完整码字序列（数据 + 纠错，按块交织）。
 */
function buildCodewords(bytes: readonly number[], version: number): number[] {
  const blocks = EC_BLOCKS_M[version]
  if (blocks === undefined) throw new Error(`raccoon: 不支持的二维码版本 ${version}`)

  const totalDataCodewords = DATA_CODEWORDS[version] ?? 0
  const capacityBits = totalDataCodewords * 8

  // 1) 位流：模式 + 计数 + 数据 + 终止符 + 补齐
  const bits: number[] = []
  const pushBits = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  pushBits(0b0100, 4) // byte 模式
  pushBits(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) pushBits(byte, 8)

  // 终止符最多 4 位（容量刚好时可以为 0 位）
  const terminator = Math.min(4, capacityBits - bits.length)
  pushBits(0, terminator)
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0)
  // 交替填充字节
  const PAD_BYTES = [0xec, 0x11] as const
  for (let i = 0; bits.length < capacityBits; i++) {
    pushBits(PAD_BYTES[i % 2] ?? 0, 8)
  }

  // 2) 位流 → 数据码字
  const dataCodewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0)
    dataCodewords.push(byte)
  }

  // 3) 切块 + 逐块算纠错
  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  let offset = 0
  for (const [count, dataPerBlock] of blocks.groups) {
    for (let b = 0; b < count; b++) {
      const block = dataCodewords.slice(offset, offset + dataPerBlock)
      offset += dataPerBlock
      dataBlocks.push(block)
      ecBlocks.push(rsEncode(block, blocks.ecPerBlock))
    }
  }

  // 4) 交织：先按序取各块的数据码字，再按序取各块的纠错码字
  const result: number[] = []
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i] ?? 0)
    }
  }
  for (let i = 0; i < blocks.ecPerBlock; i++) {
    for (const block of ecBlocks) {
      result.push(block[i] ?? 0)
    }
  }
  return result
}

// ── 矩阵构造 ──────────────────────────────────────────────────────

/** 对齐图案中心坐标（版本 1 无）。 */
function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return []
  const numAlign = Math.floor(version / 7) + 2
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos)
  }
  return result
}

/** 画 finder pattern（含分隔符，`x`/`y` 是中心）。 */
function drawFinderPattern(
  modules: boolean[][], isFunction: boolean[][], size: number, x: number, y: number,
): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const xx = x + dx
      const yy = y + dy
      if (xx < 0 || xx >= size || yy < 0 || yy >= size) continue
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      // dist 4 = 分隔符（浅色），2 = 内圈（浅色），其余深色
      const dark = dist !== 2 && dist !== 4
      modules[yy]![xx] = dark
      isFunction[yy]![xx] = true
    }
  }
}

/** 画 alignment pattern（`x`/`y` 是中心）。 */
function drawAlignmentPattern(
  modules: boolean[][], isFunction: boolean[][], x: number, y: number,
): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
      modules[y + dy]![x + dx] = dark
      isFunction[y + dy]![x + dx] = true
    }
  }
}

/** 画全部功能图案（timing / finder / alignment / 版本信息）。 */
function drawFunctionPatterns(
  modules: boolean[][], isFunction: boolean[][], size: number, version: number,
): void {
  // timing pattern
  for (let i = 0; i < size; i++) {
    const dark = i % 2 === 0
    modules[6]![i] = dark
    isFunction[6]![i] = true
    modules[i]![6] = dark
    isFunction[i]![6] = true
  }

  // 三个 finder（会覆盖部分 timing，符合规范）
  drawFinderPattern(modules, isFunction, size, 3, 3)
  drawFinderPattern(modules, isFunction, size, size - 4, 3)
  drawFinderPattern(modules, isFunction, size, 3, size - 4)

  // alignment
  const positions = alignmentPositions(version, size)
  const n = positions.length
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // 跳过三个 finder 角落
      const isCorner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)
      if (isCorner) continue
      drawAlignmentPattern(modules, isFunction, positions[i] ?? 0, positions[j] ?? 0)
    }
  }

  // 预留格式信息区（稍后写入真实值）
  drawFormatBits(modules, isFunction, size, 0)

  // 版本信息（版本 >= 7）
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    }
    const bits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      modules[b]![a] = dark
      isFunction[b]![a] = true
      modules[a]![b] = dark
      isFunction[a]![b] = true
    }
  }
}

/**
 * 写入格式信息（纠错等级 + 掩码号），两份拷贝。
 *
 * 纠错等级 M 的 `formatBits` 是 `0b00`。
 */
function drawFormatBits(
  modules: boolean[][], isFunction: boolean[][], size: number, mask: number,
): void {
  const data = (0b00 << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  }
  const bits = ((data << 10) | rem) ^ 0x5412

  const set = (x: number, y: number, dark: boolean): void => {
    modules[y]![x] = dark
    isFunction[y]![x] = true
  }
  const bit = (i: number): boolean => ((bits >> i) & 1) === 1

  // 第一份：第 8 列（行 0..5、7、8）+ 第 8 行（列 8、7、5..0）
  for (let i = 0; i <= 5; i++) set(8, i, bit(i))
  set(8, 7, bit(6))
  set(8, 8, bit(7))
  set(7, 8, bit(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))

  // 第二份：第 8 行右侧 8 列（bits 0..7）+ 第 8 列底部 **7 行**（bits 8..14）
  //
  // ⚠️ 底部 7 格是 **`size-7` 到 `size-1`**（版本 1 即 y=14..20），
  // 不是 `size-15+i`（那会写到 y=6..12，把 timing 行与数据格一起污染）。
  // `(8, size-8)` 是固定的深色模块，不承载格式位。
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) set(8, size - 7 + (i - 8), bit(i))

  // 固定的深色模块
  set(8, size - 8, true)
}

/** 按 zigzag 从右下向上填充数据位。 */
function drawCodewords(
  modules: boolean[][], isFunction: boolean[][], size: number, codewords: readonly number[],
): void {
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // 跳过 timing 列
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (isFunction[y]![x] !== true && i < codewords.length * 8) {
          const byte = codewords[i >>> 3] ?? 0
          modules[y]![x] = ((byte >> (7 - (i & 7))) & 1) === 1
          i++
        }
        // 剩余位（0–7 个）保持构造时的浅色，符合规范
      }
    }
  }
}

/** 应用掩码（XOR，自逆）。 */
function applyMask(
  modules: boolean[][], isFunction: boolean[][], size: number, mask: number,
): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y]![x] === true) continue
      let invert: boolean
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break
        case 1: invert = y % 2 === 0; break
        case 2: invert = x % 3 === 0; break
        case 3: invert = (x + y) % 3 === 0; break
        case 4: invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break
      }
      if (invert) modules[y]![x] = !modules[y]![x]
    }
  }
}

/**
 * 按规范的 4 条规则计算掩码惩罚分（越小越好）。
 *
 * - N1 = 3：同色连续 5 个以上，每多一个 +1
 * - N2 = 3：2×2 同色块
 * - N3 = 40：出现 finder-like 图案（`1011101` 前后带 4 个浅色）
 * - N4 = 10：深浅比例偏离 50%（每 5% 一档）
 */
function computePenalty(modules: boolean[][], size: number): number {
  const N1 = 3
  const N2 = 3
  const N3 = 40
  const N4 = 10
  let result = 0

  // 规则 1 + 3：逐行
  for (let y = 0; y < size; y++) {
    const row = modules[y]!
    result += penaltyForLine(row, size, N1, N3)
  }
  // 规则 1 + 3：逐列
  for (let x = 0; x < size; x++) {
    const col: boolean[] = []
    for (let y = 0; y < size; y++) col.push(modules[y]![x] === true)
    result += penaltyForLine(col, size, N1, N3)
  }

  // 规则 2：2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y]![x]
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) {
        result += N2
      }
    }
  }

  // 规则 4：深浅比例
  let dark = 0
  for (const row of modules) {
    for (const cell of row) if (cell) dark++
  }
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  result += Math.max(0, k) * N4

  return result
}

/** 单行/单列的规则 1 与规则 3 惩罚。 */
function penaltyForLine(
  line: readonly boolean[], size: number, N1: number, N3: number,
): number {
  let result = 0

  // 规则 1：连续同色
  let runLength = 1
  for (let i = 1; i < size; i++) {
    if (line[i] === line[i - 1]) {
      runLength++
    } else {
      if (runLength >= 5) result += N1 + (runLength - 5)
      runLength = 1
    }
  }
  if (runLength >= 5) result += N1 + (runLength - 5)

  // 规则 3：finder-like 图案（两个方向的 11 位窗口）
  const PATTERN_A = [true, false, true, true, true, false, true, false, false, false, false]
  const PATTERN_B = [false, false, false, false, true, false, true, true, true, false, true]
  for (let i = 0; i + 11 <= size; i++) {
    let matchA = true
    let matchB = true
    for (let j = 0; j < 11; j++) {
      if (line[i + j] !== PATTERN_A[j]) matchA = false
      if (line[i + j] !== PATTERN_B[j]) matchB = false
      if (!matchA && !matchB) break
    }
    if (matchA) result += N3
    if (matchB) result += N3
  }

  return result
}

/**
 * 生成 QR 模块矩阵。
 *
 * ⚠️ 只实现 byte 模式 + 纠错等级 M + 版本 1–10 —— 本插件的用途是编码一个
 * 约 145 字节的固定形态 URL。超出容量时**抛错**，由调用方缩短内容，
 * 而不是静默产出扫不出来的坏码。
 */
export function buildQrMatrix(
  text: string,
  options: { errorCorrection?: 'L' | 'M' | 'Q' | 'H'; mask?: number } = {},
): QrMatrix {
  const level = options.errorCorrection ?? 'M'
  if (level !== 'M') {
    throw new Error(`raccoon: 二维码目前只支持纠错等级 M（收到 ${level}）`)
  }
  const forcedMask = options.mask
  if (forcedMask !== undefined && (!Number.isInteger(forcedMask) || forcedMask < 0 || forcedMask > 7)) {
    throw new Error(`raccoon: 掩码必须是 0..7 的整数（收到 ${String(forcedMask)}）`)
  }

  const bytes = Array.from(new TextEncoder().encode(text))
  const version = pickVersion(bytes.length)
  if (version === undefined) {
    throw new Error(
      `raccoon: 二维码内容过长（${bytes.length} 字节，上限 213 字节），请缩短内容`,
    )
  }

  const size = version * 4 + 17
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))

  drawFunctionPatterns(modules, isFunction, size, version)
  drawCodewords(modules, isFunction, size, buildCodewords(bytes, version))

  // 选惩罚分最低的掩码。
  //
  // `options.mask` 用于**诊断与交叉验证**（与独立实现逐掩码对齐），
  // 生产路径不传，走自动评分。
  let bestMask = 0
  if (forcedMask !== undefined) {
    bestMask = forcedMask
  } else {
    let bestPenalty = Number.POSITIVE_INFINITY
    for (let mask = 0; mask < 8; mask++) {
      applyMask(modules, isFunction, size, mask)
      drawFormatBits(modules, isFunction, size, mask)
      const penalty = computePenalty(modules, size)
      if (penalty < bestPenalty) {
        bestPenalty = penalty
        bestMask = mask
      }
      applyMask(modules, isFunction, size, mask) // XOR 自逆，撤销
    }
  }
  applyMask(modules, isFunction, size, bestMask)
  drawFormatBits(modules, isFunction, size, bestMask)

  return { size, modules }
}

/**
 * 把矩阵渲染成内联 SVG 字符串。
 *
 * 用 SVG 而非 canvas：登录页直接把它插进 DOM 即可，无需任何 JS 绘图调用，
 * 且在任意缩放下都清晰（`shape-rendering: crispEdges` 保证模块边缘锐利）。
 */
export function renderQrSvg(
  text: string,
  options: { size?: number; margin?: number; dark?: string; light?: string } = {},
): string {
  const px = options.size ?? 158
  const margin = options.margin ?? 4
  const dark = options.dark ?? '#000000'
  const light = options.light ?? '#ffffff'

  const { size, modules } = buildQrMatrix(text)
  const dim = size + margin * 2

  const segments: string[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y]?.[x] === true) {
        segments.push(`M${x + margin},${y + margin}h1v1h-1z`)
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" `
    + `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${segments.join('')}" fill="${dark}"/>`
    + '</svg>'
}
