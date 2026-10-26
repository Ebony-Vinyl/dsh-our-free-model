/**
 * 身份槽组装：把「账号池条目」+「内置匿名槽」摊平成一条**平权**的槽序列。
 *
 * ## 平权语义（设计文档 §5，用户定稿）
 *
 * 序列 = `[账号槽…（账号池手动顺序）] + [匿名槽（固定末位）]`。
 * 免费模型下全序列参与轮换；收费模型只由账号槽承载（匿名槽被剔除）。
 * 匿名殿后**只是位置，不是特权降级** —— 判据见 `pickSlot`（`opencode-adapter.ts`）。
 *
 * ## 为什么「换 PC 指纹」在这里就落不了地
 *
 * opencode CLI 发往 Zen 的请求**没有任何机器级指纹**（1.18.22 源码核对）。
 * 上游能识别的只有：出口 IP、API key、随机会话 id。
 * ⇒ 身份 = 槽：换 key（换账号）或换 proxy（换出口 IP）才是真的换身份；
 * 指纹派生做的是**防关联**与满足形状门禁，不参与配额计算。
 *
 * ## 为什么不把匿名槽也建成账号池条目
 *
 * 账号池条目要求 credentialRef 与 enabled 语义，而匿名通道无凭据可存；
 * 且它需要「不依赖任何 UI 操作恒定存在」这个性质。做成进程内合成槽更贴合。
 */

import { randomBytes } from 'node:crypto'
import { OPENCODE } from './opencode-product.js'
import {
  deriveProjectId,
  normalizeProxy,
  type NormalizedProxy,
  type OpencodeFingerprint,
} from './opencode.js'

/** 账号池条目在本模块需要的最小投影（便于单测直接构造）。 */
export interface PoolEntrySnapshot {
  id: string
  enabled: boolean
  apiKey: string
  /** 代理 URL；空/缺省 = 直连。 */
  proxy?: string
  /** 已持久化的指纹；缺失时按 apiKey 现派生。 */
  fingerprint?: OpencodeFingerprint
}

/** 一个可发起请求的身份。 */
export interface IdentitySlot {
  /** 账号池 id；匿名槽恒为 {@link ANONYMOUS_SLOT_ID}。 */
  readonly id: string
  readonly kind: 'account' | 'anonymous'
  readonly apiKey: string
  /** 未设代理 = 直连（与其它无代理账号共享本机出口 IP）。 */
  readonly proxy: NormalizedProxy | undefined
  readonly fingerprint: OpencodeFingerprint
  readonly userAgent: string
}

/** 匿名槽的固定 id（与账号池 id 空间隔离，不可能撞）。 */
export const ANONYMOUS_SLOT_ID = 'anonymous'

/** 新账号的初始指纹。 */
export function newAccountFingerprint(apiKey: string): OpencodeFingerprint {
  return { projectId: deriveProjectId(apiKey, 0), generation: 0 }
}

/**
 * 轮换到下一代指纹。
 *
 * ⚠️ **返回新对象**而不是就地改：调用方（RPC）常把旧指纹留在内存快照里，
 * 就地改会让已持有的引用提前变成新代次（写单测时实测到过）。
 *
 * ⚠️ project id 用**上一代的 projectId** 作 identity 派生，而非原始 key ——
 * 本函数不持有 key（调用方可能只有代次），这样仍能保证「代次 +1 ⇒ 指纹变化」。
 */
export function nextFingerprintGeneration(current: OpencodeFingerprint): OpencodeFingerprint {
  const generation = Number.isSafeInteger(current.generation) && current.generation >= 0
    ? current.generation + 1
    : 1
  return { projectId: deriveProjectId(current.projectId, generation), generation }
}

/**
 * 摊平为平权槽序列。
 *
 * ## 匿名槽的身份（2026-10-02 起为**池内条目**，不再是进程内合成）
 *
 * 早期实现把匿名通道做成「进程内固定合成的末位槽」—— 它恒定存在、不需任何
 * UI 操作，但**也因此不能添加、不能配代理、不能排序**，用户拿不到「多条匿名
 * 通道各走各的出口」这个能力。
 *
 * 现在匿名通道是**账号池里的一条普通条目**（`api_key === 'public'`），
 * 于是拖拽排序 / 停用 / 删除 / 代理配置 / 指纹代次全部复用既有机制。
 * 「零账号也能用」由 {@link ensureDefaultAnonymousSlot} 在首次启用时补一条
 * 默认条目来保证。
 *
 * ## ⚠️ 指纹 identity 不能用 `api_key`（匿名槽全都等于 `public`）
 *
 * 多个匿名槽的 api_key 完全相同，若用它派生 project id，N 个匿名槽会拿到
 * **同一个指纹**（彼此无法区分，且和真实 PC 伪装无关）。故：
 * - 匿名槽：`identity = entry.id`（账号池条目 id，形如 `opencode-anon-xxxx`）
 * - 账号槽：`identity = api_key`
 *
 * ⚠️ 顺带说明这个能力**不增加配额**：匿名通道按**出口 IP** 限额（实测：换 key、
 * 换任意伪装头、换指纹全部无效）。指纹分离的价值是**防关联**；配额扩容只靠
 * **给不同匿名槽配不同代理**（不同出口 IP = 不同配额桶）。面板文案按此口径。
 *
 * @param entries 账号池条目（调用方保证已按手动顺序排好）。
 * @param userAgent 覆盖 UA（通常为真机 `opencode --version` 的结果）。
 */
export function listIdentitySlots(
  entries: readonly PoolEntrySnapshot[],
  userAgent: string,
): IdentitySlot[] {
  const slots: IdentitySlot[] = []
  for (const entry of entries) {
    if (!entry.enabled) continue
    // ⚠️ 非法代理**降级为直连并继续**：用户可能只是临时填了个错地址，
    // 不该让整个 provider 的所有账号都发不出请求（那比「悄悄走了直连」
    // 更难排查 —— 用户会看到「明明配了代理却好像没走」）。
    const normalized = entry.proxy === undefined || entry.proxy.trim().length === 0
      ? undefined
      : normalizeProxy(entry.proxy)
    const anonymous = isAnonymousCredential(entry.apiKey)
    // ⚠️ 指纹 identity：匿名槽用条目 id（api_key 全是 `public`，不可用）。
    const identity = anonymous ? entry.id : entry.apiKey
    slots.push({
      id: entry.id,
      kind: anonymous ? 'anonymous' : 'account',
      apiKey: entry.apiKey,
      proxy: normalized !== undefined && normalized.ok ? normalized.proxy : undefined,
      fingerprint: entry.fingerprint ?? { projectId: deriveProjectId(identity, 0), generation: 0 },
      userAgent,
    })
  }
  return slots
}

/** 该凭据是否为匿名通道（字面量 `public`）。 */
export function isAnonymousCredential(apiKey: string | undefined): boolean {
  return apiKey === OPENCODE.anonymousKey
}

/**
 * 首次启用时保证至少有一个匿名通道（幂等）。
 *
 * ⚠️ 判据是「池里一条匿名条目都没有」—— **不是**「没有账号」：
 * 用户若主动删光匿名通道，那就是明确的选择，不该每次启动又给他塞回来
 * （那会让「删除」按钮看起来失灵）。
 *
 * ⚠️ 幂等且吞异常：它在 `apply()` 的启动路径上被调用，失败不能拖垮插件启动。
 *
 * @returns 新建的条目 id；已有匿名槽或新建失败时返回空串。
 */
export async function ensureDefaultAnonymousSlot(
  addEntry: (entry: {
    id: string; provider: string; nickname: string; enabled: boolean
    credentialRef: string; refreshable: boolean; createdAt: number
  }) => Promise<void>,
  writeCredential: (ref: string, value: string) => Promise<void>,
  listEntries: () => Array<{ id: string }>,
  alreadyHasAnonymous: () => boolean,
): Promise<string> {
  try {
    if (alreadyHasAnonymous()) return ''
    const id = `${OPENCODE.id}-anon-${randomBytes(3).toString('hex')}`
    const refName = `OPENCODE_ANON_${randomBytes(4).toString('hex').toUpperCase()}`
    await writeCredential(refName, JSON.stringify({
      api_key: OPENCODE.anonymousKey,
      nickname: '匿名通道',
    }))
    await addEntry({
      id,
      provider: OPENCODE.id,
      nickname: '匿名通道',
      enabled: true,
      credentialRef: refName,
      // 匿名通道没有凭据可续期 ⇒ 不能标 true（那是不实承诺，UI 会显示「可自动续期」）。
      refreshable: false,
      createdAt: Date.now(),
    })
    return id
  } catch {
    // 启动路径上不抛：没有默认匿名槽只是少一条通道，用户仍可手动添加。
    return ''
  }
}
