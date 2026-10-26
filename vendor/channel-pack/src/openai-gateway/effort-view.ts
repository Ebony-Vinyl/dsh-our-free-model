/**
 * 思考档位的**机读视图**：把某个模型声明的私有档位翻译成「OpenAI 客户端该怎么填」。
 *
 * ## 为什么需要它（真实缺陷）
 *
 * 网关把「模型声明的 id」原样校验，而走 OpenAI 协议的客户端只有固定的 8 档词汇。
 * 用户照 DSH 界面上的名字填进 CC Switch（LobsterAI 的 **Max** → `max`、
 * Cline 的 **Extra** → `xhigh`、TRAE 的 **Light / Extra High** → `low` / `xhigh`），
 * 全都会撞 400。翻译层（`src/reasoning-ladder.ts`）解决了「不许失败」，
 * 本模块解决**「不许靠猜」**：
 *
 * - `efforts[].canonical`：这个真实档位在客户端里该写成哪个规范名；
 * - `openai_efforts`：直接把这一串复制进 CC Switch 的「思考等级」即可，
 *   一一对应、**无翻译损失**；
 * - {@link effortResolutions}：那 8 个规范名逐一的结局（原样 / 就近 / 无法表达），
 *   让「填了会怎样」在填之前就能查到。
 *
 * ⚠️ 这些字段是**额外附加**的（OpenAI 的模型对象没有档位语义）。客户端不读它
 * 也不受影响；读得懂的工具则不必再靠 DSH 界面上的展示名反推。
 */

import { CANONICAL_REASONING_EFFORTS, canonicalReasoningEffortFor, translateReasoningEffort } from '../reasoning-ladder.js'

/** 一个模型声明的档位在 OpenAI 客户端侧的写法。 */
export interface GatewayEffortView {
  /** 模型真实接受的 id（DSH 的 wire 值），`canonical` 是它在客户端里该写成的名字。 */
  efforts: Array<{ id: string; name: string; canonical?: string }>
  /** 适配器配置的默认档（省略表示交给上游默认）。 */
  default?: string
  /** 可直接填进客户端的规范名清单（与 `efforts` 一一对应，无翻译损失）。 */
  openai_efforts: string[]
}

/** 某个规范名打到该模型上会发生的结局。 */
export interface GatewayEffortResolution {
  requested: string
  /**
   * - `exact`：原样下发；
   * - `mapped`：就近翻译成 `applied`；
   * - `unexpressible`：模型**声明了**档位但没有这一族 → 不下发该参数；
   * - `ignored`：模型**根本没声明**档位 → 网关对任何档位都不下发。
   */
  outcome: 'exact' | 'mapped' | 'unexpressible' | 'ignored'
  /** 实际会下发的 id（`unexpressible` / `ignored` 时缺省）。 */
  applied?: string
}

function effortIdOf(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/**
 * 构造档位视图；模型**没声明**档位时返回 `undefined`。
 *
 * ⚠️ 返回 `undefined` 而不是空对象：调用方据此决定**根本不发**这个字段，
 * 与各适配器「不声明即未知」的口径一致（`reasoning === undefined` 时 DSH 的
 * 选择器显示「当前模型未提供推理等级」）。发一个 `openai_efforts: []` 会让
 * 用户以为「这模型一个档位都没有」，而真相是「我们不知道」。
 */
export function effortView(
  efforts: readonly { id?: unknown; name?: unknown }[] | undefined,
  defaultEffort?: unknown,
): GatewayEffortView | undefined {
  if (!Array.isArray(efforts)) return undefined
  const rows: GatewayEffortView['efforts'] = []
  const canonicalSeen = new Set<string>()
  const openaiEfforts: string[] = []
  for (const effort of efforts) {
    const id = effortIdOf(effort?.id)
    if (id === undefined) continue
    const canonical = canonicalReasoningEffortFor(id)
    rows.push({
      id,
      name: effortIdOf(effort?.name) ?? id,
      ...canonical === undefined ? {} : { canonical },
    })
    if (canonical !== undefined && !canonicalSeen.has(canonical)) {
      canonicalSeen.add(canonical)
      openaiEfforts.push(canonical)
    }
  }
  if (rows.length === 0) return undefined
  const fallback = effortIdOf(defaultEffort)
  return {
    efforts: rows,
    // ⚠️ 默认档必须是模型真声明过的 id，否则客户端照着它填就会 400。
    ...fallback === undefined || !rows.some((row) => row.id === fallback) ? {} : { default: fallback },
    openai_efforts: openaiEfforts,
  }
}

/**
 * 那 8 个规范名逐一的结局（`GET /v1/reasoning-efforts` 的明细）。
 *
 * ⚠️ 「模型没声明档位」（`ignored`）与「声明了但没有这一族」（`unexpressible`）
 * 是**两种不同的结局**，不可合并：前者网关什么都没做（按模型默认走），
 * 后者是用户明确要的档位没生效。合并会让排查时看不到真正的差异。
 *
 * `unknown` 不属于本函数的输出：8 个规范名全部登记在强度序里，逐一必有其结局。
 */
export function effortResolutions(declared: readonly string[]): GatewayEffortResolution[] {
  if (declared.length === 0) {
    return CANONICAL_REASONING_EFFORTS.map((requested) => ({ requested, outcome: 'ignored' as const }))
  }
  return CANONICAL_REASONING_EFFORTS.map((requested) => {
    const result = translateReasoningEffort(requested, declared)
    if (result.kind === 'exact') return { requested, outcome: 'exact' as const, applied: result.effort }
    if (result.kind === 'mapped') return { requested, outcome: 'mapped' as const, applied: result.effort }
    return { requested, outcome: 'unexpressible' as const }
  })
}
