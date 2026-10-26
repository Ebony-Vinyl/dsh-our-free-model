/**
 * Gemini `thoughtSignature` 的**本地缓存**。
 *
 * ## 为什么必须有它
 *
 * 带思考的 flash 模型在返回 `functionCall` 时会附带 `thoughtSignature`，
 * 下一轮请求理应把它**原样带回** —— 丢了推理链会断（模型重复思考、工具调用
 * 质量下降）。
 *
 * ⚠️ 但 DSH 的思考块是 `ReasoningBlock{type:'reasoning';text}`，**不携带签名**
 * （`@deepseek-ai/dsh-llm` 0.1.7+ 的 `ContentBlockMap` 里根本没有
 * `thinking` / `redacted_thinking` 这两个 type）。签名无处安放 ⇒ 只能自己落盘。
 *
 * 于是：响应里第一次见到签名时按「工具名 + 规范化参数」记下来，
 * 后续请求按同一个键回填。
 *
 * ## ⚠️ 实测修正（原版 2026-10-02 记录，逐字照抄）
 *
 * 低档 + 不带 `tool_choice` 时**没有签名也能成功**（全新进程、无缓存，直接发带
 * `tool_result` 的请求，上游回 200 正常出字）。所以「否则上游以 400 拒绝」
 * 这个说法过于绝对 —— 它更像某些档位/场景下的行为。缓存仍值得留：
 * 签名是推理链连续性的保障，缺了不一定报错，但可能**悄悄降质**。
 *
 * ## 只存 functionCall 上的签名
 *
 * 原版 `proxy.CollectSignatures` 的口径：Gemini 校验的只有 `functionCall` 上
 * 那一个，纯文本 part 的签名回传时会被忽略，存了是噪音。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveChannelPackHome } from './channel-pack-store.js'

/**
 * 落盘文件名（与 `state.json` **同目录**）。
 *
 * ⚠️ 独立文件而**不是**塞进 `state.json`：后者是**整体替换**语义，且是 dsh home
 * 级、同机多 profile 共享 —— 旧代码/另一个工作区触发任意一次全量写入就会把
 * 不认识的键抹掉（`src/permanent-lock-store.ts:1-33` 记录的同类事故）。
 */
export const GEMINI_SIG_FILE = 'gemini-sigs.json'

/**
 * 缓存条数上限。签名串平均 300~800 字节，2000 条约 1MB 量级，
 * 足够覆盖一个工作日的会话。
 */
export const GEMINI_SIG_MAX_ENTRIES = 2_000

/**
 * 算键时只取正文前 512 字符。
 *
 * ⚠️ 刻意的：思考模型的签名绑定的是「**前缀内容**」，而长回答的尾部每次都不一样，
 * 用全文当键会让命中率接近 0。
 */
const SIG_KEY_BODY_LIMIT = 512

/** 缓存里的一条：签名本体 + 写入时刻（秒）+ 工具名（供 `byTool` 重建）。 */
interface SigEntry {
  sig: string
  at: number
  /**
   * 工具名。
   *
   * ⚠️ 必须持久化：缓存键是 `sha256("tool:" + name + "\0" + args)[:16]`，**不可逆**，
   * 不存名字就没法在载入时重建 {@link GeminiSigStore.latestForTool} 的索引。
   * 旧版本写的条目没有这个字段 —— 它们仍能按精确键命中，只是不进索引（可接受降级）。
   */
  name?: string
}

/**
 * 由「角色/工具名 + 正文」算稳定键。
 *
 * ⚠️ 键 = `sha256(role + '\0' + body)[:8]` 的十六进制（16 字符），
 * 与原版 `SigKey` 逐字一致 —— 换算法会让**已有缓存全部失配**（表现为每轮都
 * 去签重试）。
 */
export function geminiSigKey(role: string, text: string): string {
  const body = text.length > SIG_KEY_BODY_LIMIT ? text.slice(0, SIG_KEY_BODY_LIMIT) : text
  return createHash('sha256').update(`${role}\u0000${body}`, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 工具调用的签名键。
 *
 * ⚠️ `argsJson` **必须**与回填侧用**同一个规范化**（`canonicalArgs`，
 * 即按键名升序的 JSON）—— 两侧不一致会让查表**永远命中不了**，
 * 症状是「每轮都去签重试」而不报任何错。
 */
export function geminiToolSigKey(name: string, argsJson: string): string {
  return geminiSigKey(`tool:${name}`, argsJson)
}

/** 去掉签名首尾空白（上游对首尾换行敏感，原版 `TrimPrefix`）。 */
export function trimGeminiSignature(signature: string): string {
  return signature.trim()
}

/** 读取结果：坏文件按「空缓存」处理，不算失败。 */
export interface GeminiSigRead {
  entries: Map<string, SigEntry>
}

/**
 * 签名缓存（进程内 map + 落盘）。
 *
 * `path === undefined` 时退化为**仅内存**（无法定位 dsh home 时的显式降级，
 * 与 `permanent-lock-store.ts` 的 `MemoryLockStore` 同策）。
 */
export class GeminiSigStore {
  private readonly entries: Map<string, SigEntry>
  private dirty = false

  constructor(
    private readonly path: string | undefined,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {
    this.entries = this.load()
  }

  /** 当前条目数（诊断用）。 */
  get size(): number {
    return this.entries.size
  }

  /** 按工具名 + 规范化参数查签名。 */
  get(name: string, argsJson: string): string | undefined {
    const entry = this.entries.get(geminiToolSigKey(name, argsJson))
    if (entry === undefined || entry.sig === '') return undefined
    return entry.sig
  }

  /**
   * 按**工具名**取最近一次签名（精确键 miss 时的兜底）。
   *
   * ## 为什么需要它
   *
   * 精确键 = `sha256("tool:"+name+"\0"+args)[:16]`，**参数逐字相同**才命中。
   * 但长任务里参数漂移是**必然事件**：绝对路径变了、时间戳变了、上游对参数做过
   * 一次归一化、或用户改了同一个文件的行号。一旦漂移就 miss，只能走去签重试
   * —— 而那条路会把**整条思考链丢掉**（模型重复思考、工具调用质量下降）。
   *
   * 兜底取值在语义上成立：签名绑定的是「模型对这次工具调用的推理」，同一个工具
   * 名 + 近似参数下，最近一次签名是**最好可得**的近似，比没有强得多。
   * 这正是 `cmdc-pak` 的 `Service.lookup` 做法（精确键 → 按工具名取最近）。
   *
   * ⚠️ 「最近」用**写入顺序**判定（Map 保插入序，同键 `set` 会覆盖并挪到末尾），
   * **不**用 `at` 时间戳 —— 后者是**秒级**精度，同一秒内的两次写入无法区分，
   * 会让兜底取到较早那个（实测踩过）。
   *
   * ⚠️ 返回 `undefined` 而不是抛错：拿不到签名就让上层走去签重试，那是既有路径。
   */
  latestForTool(name: string): string | undefined {
    let best: string | undefined
    for (const entry of this.entries.values()) {
      if (entry.name === name && entry.sig !== '') best = entry.sig
    }
    return best
  }

  /**
   * 记一个签名。
   *
   * ⚠️ 空键/空签名一律丢弃（原版同口径）：上游偶尔下发空串占位，
   * 存进去会让回填侧以为「有签名」而发一个空字段。
   */
  put(name: string, argsJson: string, signature: string): void {
    const sig = trimGeminiSignature(signature)
    if (sig === '') return
    const key = geminiToolSigKey(name, argsJson)
    if (key === '') return
    this.entries.set(key, { sig, at: Math.floor(Date.now() / 1000), name })
    if (this.entries.size > GEMINI_SIG_MAX_ENTRIES) this.evict()
    this.dirty = true
  }

  /**
   * 淘汰最旧的一半。
   *
   * 原版用部分选择排序（冒泡一半）只为「少留一点空间」，不做精确 LRU；
   * 这里直接全排序取后一半 —— **结果等价**（删掉最旧的一半），可读性更好。
   */
  private evict(): void {
    const all = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)
    const half = Math.floor(all.length / 2)
    for (let i = 0; i < half; i++) {
      const key = all[i]?.[0]
      if (key !== undefined) this.entries.delete(key)
    }
  }

  /**
   * 写回磁盘（原子写：tmp + rename）。
   *
   * ⚠️ 纯缓存，**任何失败都只记日志**：写不进去只是命中率低一点，
   * 不该让推理请求失败。
   */
  async flush(): Promise<void> {
    if (this.path === undefined || !this.dirty) return
    this.dirty = false
    const payload = JSON.stringify(
      Object.fromEntries(
        [...this.entries.entries()].map(([key, entry]) => [
          key,
          // `name` 缺席时不写这个键（旧条目/未知来源），保持载荷紧凑。
          entry.name === undefined
            ? { sig: entry.sig, at: entry.at }
            : { sig: entry.sig, at: entry.at, name: entry.name },
        ]),
      ),
      null,
      2,
    )
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, payload, 'utf-8')
      renameSync(tmp, this.path)
    } catch (error) {
      this.logger?.warn(`[gemini] 签名缓存写入失败（不影响推理）: ${String(error)}`)
    }
  }

  /** 载入；文件不存在/损坏都按空缓存处理（**不抛错**）。 */
  private load(): Map<string, SigEntry> {
    const out = new Map<string, SigEntry>()
    if (this.path === undefined) return out
    try {
      if (!existsSync(this.path)) return out
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue
        const record = value as Record<string, unknown>
        const sig = typeof record.sig === 'string' ? record.sig : ''
        if (sig === '') continue
        const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0
        // ⚠️ 旧版本写的条目**没有** `name`（那时还没这个字段）—— 它们照常按精确键
        // 命中，只是不进 `latestForTool` 索引。这是可接受的降级：新写入的条目
        // 会补上，索引随使用自然补齐。
        const name = typeof record.name === 'string' && record.name !== '' ? record.name : undefined
        out.set(key, name === undefined ? { sig, at } : { sig, at, name })
      }
    } catch (error) {
      // 坏文件直接丢弃：这是纯缓存，没有它只是命中率低一点。
      this.logger?.warn(`[gemini] 签名缓存文件损坏，已重置: ${String(error)}`)
      return new Map()
    }
    return out
  }
}

/**
 * 按 dsh home 创建签名缓存（落 `$DSH_HOME/channel-pack/gemini-sigs.json`）。
 *
 * home 的解析与账号池**同一个函数**（`resolveChannelPackHome`），保证与 `state.json`、
 * `permanent-locks.json` 永远落在同一目录。
 */
export function createGeminiSigStore(ctx: Context): GeminiSigStore {
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[gemini] 无法定位 DSH home，签名缓存仅存在于内存中（命中率会在重启后归零）')
    return new GeminiSigStore(undefined, ctx.logger)
  }
  return new GeminiSigStore(join(home, 'channel-pack', GEMINI_SIG_FILE), ctx.logger)
}
