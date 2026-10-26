/**
 * 「锁定永久积分」开关表的**独立**持久化文档。
 *
 * ## 为什么不与账号池同放一份 state.json（真实风险，用户 2026-09-29 定案）
 *
 * `$DSH_HOME/channel-pack/state.json` 是 **dsh home 级、全局共享**的：同机上多个
 * profile 用的是同一个 home，于是一台机器上的 `desktop` 与 `web` / `tui` /
 * `headless` 读到的是**同一份**账号池文档。
 *
 * 而本插件的存储是**整体替换**语义（`store.save(全量 state)`）。于是：
 *
 * ⚠️ 后果不是显示问题，而是**行为**问题：解锁后选号继续消耗永久积分，
 * 而积分烧掉**不可撤回**。这与本文件反复记录的那类缺陷（"整体写入漏带字段
 * 就会被静默抹掉"）同源，区别只是这次漏带的一方是**另一条工作区里我们无法
 * 修改的旧版本代码**（用户刻意把 desktop 与 web 分成两个互不影响的工作区）。
 *
 * ⇒ 结论：**把锁定表拆到本文件这份独立文档**，旧代码从不读写它，两个工作区
 * 因此在这一点上真正互不干扰。
 *
 * ## 与旧版 state.json 的兼容（单向迁移，只认"文件不存在"）
 *
 * 该字段早先住在 state.json 的 `loomyPermanentLocked` 里，老用户磁盘上只有它。
 * 故本文档**不存在**时读老字段（保住升级前的状态）；一旦本文档存在，它就是
 * **唯一权威**，不再回看老字段 —— 否则用户在 desktop 里解锁 Loomy 后，会被
 * 老字段里那个陈旧的 `true` 重新拉回锁定态（写侧同时同步老字段，见 AccountPool）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PermanentLockMap } from './channel-pack-store.js'
import { sanitizePermanentLocks } from './channel-pack-store.js'
import { resolveChannelPackHome } from './channel-pack-store.js'

/** 独立文档的文件名（与 state.json 同目录）。 */
export const PERMANENT_LOCKS_FILE = 'permanent-locks.json'

/** 锁定表后端的种类：文件（正常）或内存（无法定位 home 时的显式降级）。 */
export type PermanentLockStoreKind = 'file' | 'memory'

/** 读取结果：区分「文档不存在」与「存在但是空表」—— 见文件头的迁移判据。 */
export type PermanentLockRead =
  | { exists: false; locks: PermanentLockMap }
  | { exists: true; locks: PermanentLockMap }

/**
 * 独立文档的读写接口（同步读、异步写，与 `ChannelPackStore` 同款约定）。
 */
export interface PermanentLockStore {
  readonly kind: PermanentLockStoreKind
  /** 载入锁定表；文档不存在时 `exists: false`（让调用方决定如何迁移）。 */
  load(): PermanentLockRead
  /** 整体写入锁定表（原子写）。 */
  save(locks: PermanentLockMap): Promise<void>
}

/** 仅内存后端：无法定位 dsh home 时的显式降级（与 MemoryStore 同策）。 */
class MemoryLockStore implements PermanentLockStore {
  readonly kind = 'memory' as const
  private locks: PermanentLockMap = {}
  private written = false

  load(): PermanentLockRead {
    return { exists: this.written, locks: { ...this.locks } }
  }

  async save(locks: PermanentLockMap): Promise<void> {
    this.locks = { ...locks }
    this.written = true
  }
}

/** 文件后端：`$DSH_HOME/channel-pack/permanent-locks.json`（原子写：tmp + rename）。 */
class FileLockStore implements PermanentLockStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): PermanentLockRead {
    try {
      if (!existsSync(this.path)) return { exists: false, locks: {} }
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      return { exists: true, locks: sanitizePermanentLocks(locksFieldOf(parsed)) }
    } catch (error) {
      // 损坏时按「文档存在但空表」处理：**不**回落到老的 state.json 字段 ——
      // 那条路径会把用户已解除的锁定重新打开（保守方向在这里是反的）。
      this.logger?.warn(`[channel-pack] 读取 ${this.path} 失败，按未锁定处理: ${String(error)}`)
      return { exists: true, locks: {} }
    }
  }

  async save(locks: PermanentLockMap): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    // 带 schema 标记：与本仓库其它状态文档同惯例，便于将来演进时判别。
    writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, locks }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

const SCHEMA = 'channel-pack/permanent-locks/v1'

/**
 * 取出文档里的锁定表字段，同时兼容**裸表**形态。
 */
function locksFieldOf(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed
  const record = parsed as Record<string, unknown>
  if (record.locks !== undefined) return record.locks
  // 顶层含已知 provider 键或为空对象时视为裸表
  if (record.schema === undefined) return record
  return {}
}

/**
 * 创建锁定表后端。
 *
 * home 的解析与账号池**同一个函数**（`resolveChannelPackHome`），保证两份文档
 * 永远落在同一目录 —— 否则会出现「账号池在 A 处、锁定表在 B 处」的分裂。
 */
export function createPermanentLockStore(ctx: Context): PermanentLockStore {
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[channel-pack] 无法定位 DSH home，永久积分锁定开关仅存在于内存中')
    return new MemoryLockStore()
  }
  return new FileLockStore(join(home, 'channel-pack', PERMANENT_LOCKS_FILE), ctx.logger)
}
