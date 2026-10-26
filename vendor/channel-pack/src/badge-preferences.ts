/**
 * 「用量徽标显示偏好」的**独立**持久化文档。
 *
 * ## 存的是什么
 *
 * 模型选择器旁那枚徽标在折叠态只显示一个读数：订阅（窗口百分比 / 套餐剩余）
 * 或积分余额。偏好就是「先显示哪个」：
 *
 * - `auto`（默认）：有订阅读数就显示订阅，否则显示积分；
 * - `subscription`：始终先试订阅（没有订阅数据的渠道自然回落到积分）；
 * - `credits`：始终显示积分（**也是套餐判定误判时的兜底开关**）。
 *
 * ## 为什么拆成独立文档，而不是塞进 state.json
 *
 * 与 `permanent-lock-store.ts` 同因：`$DSH_HOME/channel-pack/state.json` 是
 * **dsh home 级、多 profile 共享**、且**整体替换**语义的文档。同机上另一条
 * 工作区里的旧版本代码不认识新字段，它做任何一次整体写入（加删账号、改模型
 * 开关）都会把新字段静默抹掉。偏好被抹掉的后果只是「显示回落到默认」，
 * 远没有锁定表那么危险，但**没有理由把注定会被抹掉的字段放进去** ——
 * 独立文档的读写者只有本文件，跨工作区天然互不干扰。
 *
 * ## 与 state.json 不同，这里没有「迁移」问题
 *
 * 本文件是新增能力，磁盘上不存在历史字段，故不需要 `permanent-lock-store.ts`
 * 那套「文档不存在时读老字段」的单向迁移。文档损坏 / 字段非法一律回落到
 * 默认值 `auto` 并留一条 warn —— 偏好是展示层设置，配置写坏不该让插件起不来。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveChannelPackHome } from './channel-pack-store.js'

/** 独立文档的文件名（与 state.json 同目录）。 */
export const BADGE_PREFERENCES_FILE = 'ui-preferences.json'

/**
 * 三态偏好的**唯一权威枚举**。
 *
 * ⚠️ 前端（`plugin-src/client/badge-model.js`）与 RPC 校验都必须以它为准：
 * 客户端另写一份字面量数组会在将来加档位时静默漂移 —— 表现为「UI 能选、
 * 服务端一律 bad-request」。
 */
export const BADGE_PREFERENCES = ['auto', 'subscription', 'credits'] as const

/** 偏好取值。 */
export type BadgePreference = (typeof BADGE_PREFERENCES)[number]

/** 默认偏好：自动（有订阅显示订阅，否则积分）。 */
export const DEFAULT_BADGE_PREFERENCE: BadgePreference = 'auto'

/**
 * 归一化偏好：非法值（缺省 / null / 数字 / 大小写不同的串 / 未知档位）
 * 一律回落默认值。
 *
 * ⚠️ 刻意**不做**「宽松匹配」（如 `'Auto'` 判成 `auto`）：RPC 写入路径要求
 * 严格取值并拒绝非法输入（见 `usage.badgePreference`），若这里又悄悄接受
 * 变体，两处判据就会不一致。
 */
export function sanitizeBadgePreference(raw: unknown): BadgePreference {
  return typeof raw === 'string' && (BADGE_PREFERENCES as readonly string[]).includes(raw)
    ? (raw as BadgePreference)
    : DEFAULT_BADGE_PREFERENCE
}

/** 偏好文档后端的种类：文件（正常）或内存（无法定位 dsh home 时的显式降级）。 */
export type BadgePreferenceStoreKind = 'file' | 'memory'

/** 偏好文档的读写接口（同步读、异步写，与 `ChannelPackStore` 同款约定）。 */
export interface BadgePreferenceStore {
  readonly kind: BadgePreferenceStoreKind
  /** 载入偏好；文档不存在 / 损坏 / 字段非法时返回默认值。 */
  load(): BadgePreference
  /** 写入偏好（原子写）。 */
  save(preference: BadgePreference): Promise<void>
}

/** 仅内存后端：无法定位 dsh home 时的显式降级（与 MemoryStore 同策）。 */
class MemoryPreferenceStore implements BadgePreferenceStore {
  readonly kind = 'memory' as const
  private preference: BadgePreference = DEFAULT_BADGE_PREFERENCE

  load(): BadgePreference {
    return this.preference
  }

  async save(preference: BadgePreference): Promise<void> {
    this.preference = preference
  }
}

/** 文件后端：`$DSH_HOME/channel-pack/ui-preferences.json`（原子写：tmp + rename）。 */
class FilePreferenceStore implements BadgePreferenceStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): BadgePreference {
    try {
      if (!existsSync(this.path)) return DEFAULT_BADGE_PREFERENCE
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      return sanitizeBadgePreference(preferenceFieldOf(parsed))
    } catch (error) {
      // 损坏时回落默认值而不是抛错：徽标是展示层功能，读不到偏好最多是
      // 「显示口径回到自动」，不该让整个 RPC 端点连坐失败。
      this.logger?.warn(`[channel-pack] 读取 ${this.path} 失败，用量徽标偏好按默认值处理: ${String(error)}`)
      return DEFAULT_BADGE_PREFERENCE
    }
  }

  async save(preference: BadgePreference): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    // 带 schema 标记：与本仓库其它状态文档同惯例，便于将来演进时判别。
    writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, badgePreference: preference }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

const SCHEMA = 'channel-pack/ui-preferences/v1'

/**
 * 取出文档里的偏好字段，同时兼容**裸字符串**形态。
 *
 * 裸字符串（文件内容就是 `"credits"`）不是本实现写出的形态，但状态文档可能
 * 被手工编辑过；认它比把它当非法值更贴近用户意图（后者会静默回到 `auto`，
 * 用户会以为「设置没保存」）。
 */
function preferenceFieldOf(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed
  const record = parsed as Record<string, unknown>
  return record.badgePreference
}

/**
 * 创建偏好后端。
 *
 * home 的解析与账号池 / 锁定表**同一个函数**（`resolveChannelPackHome`），保证三份
 * 文档永远落在同一目录 —— 否则会出现「账号池在 A 处、偏好文档在 B 处」的分裂。
 */
export function createBadgePreferenceStore(ctx: Context): BadgePreferenceStore {
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[channel-pack] 无法定位 DSH home，用量徽标偏好仅存在于内存中')
    return new MemoryPreferenceStore()
  }
  return new FilePreferenceStore(join(home, 'channel-pack', BADGE_PREFERENCES_FILE), ctx.logger)
}
