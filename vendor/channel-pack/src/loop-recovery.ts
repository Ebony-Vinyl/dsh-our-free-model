/**
 * 思考死循环被中止后的**自动续跑**（auto-resume）。
 *
 * ## 真实报障（用户要求，2026-10-04）
 *
 * > 能不能让模型在病态重复后，让会话自己恢复？现在病态重复后要我打个「继续」
 * > 才继续运行，加个自动中断病态重复和自动继续会话的功能吧。
 *
 * 「自动中断」已经由既有的循环守卫完成（`REASONING_LOOP`，见 `sse.ts`）；
 * 缺的是中止之后那一步 —— 现在必须由**人**补一句「继续」。
 *
 * ## 为什么这不是可有可无的便利，而是既有缺陷的收尾
 *
 * 全库取证（219 会话，`scripts/probe-max-tokens-provenance.mjs`，见 `sse.ts`
 * 的 `REASONING_LOOP_CODE` 注释）：守卫命中的 25 步里，**25 步全部**在截断后
 * 被迫由用户手动补一句（11× 「继续」、9× 「继续上面未完成的任务」，其中 2 次
 * 用户自己诊断出「你陷入思考循环了」）。而守卫命中时**额度远没有用满**
 * （实测单次只烧约 2000 字符），也就是说：**这 25 次停顿全是白停的**。
 *
 * ## 为什么不用 harness 的 `retryPolicy`
 *
 * `REASONING_LOOP` 刻意**不在** `DEFAULT_RETRYABLE_CODES` 里，且这是对的：
 * 死循环是**确定性**病理，同一条请求原样重发只会再烧一轮额度（这正是
 * `sse.ts` 里那条注释的结论）。要跳出循环必须**改变输入**，也就是补一条新的
 * user 消息 —— 那是 harness 的 `followup()` 语义，不是重试策略能表达的东西。
 *
 * ## 为什么是 `agent.followup()` 而不是别的通道
 *
 * - `followup()` 是**公开** Agent 接口（`dsh-agent`）：「排队一条普通的下一个
 *   轮次提示词并唤醒驱动器」。harness 自己的目标续跑驱动器
 *   （`dsh-goal-round-driver`）就是用它在 idle 时投递下一轮的，本实现与它同构。
 * - 投出去的是**一条真正的 `user/message`**，会落盘、会在 UI 上显示、可重放 ——
 *   满足 harness 的「模型可见 ⟺ 已落盘」红线（在适配器里偷偷改请求体则违反它，
 *   且**不可见**，用户会以为模型自己会读心）。
 * - 不用 `ctx.schedule`（定时提醒）：那是**持久化任务**，最小粒度是秒级、走
 *   Session 控制器重新激活会话，用来做「本轮刚失败、此刻就续跑」既重又错。
 *
 * ## 三条安全边界（都按「宁可少续跑，不可无限续跑」选）
 *
 * 1. **只在 idle 投递**。错误发生的那一刻驱动器还在跑，此时 `followup()` 排进
 *    `next-turn` 后**不会**被唤醒（`wakeDriver()` 对 running 相位不latch），
 *    消息会**烂在收件箱里**。故像目标驱动器一样等 `agent/status === 'idle'`。
 *    投递决策延后到状态派发结束，避免同步重入 running 后被外层旧 idle 覆盖。
 * 2. **连续次数上限**（默认 2，见 `LOOP_RESUME_DEFAULT_MAX`）。这是**连续**
 *    计数：任何**别人**投进收件箱的消息（用户手打的、目标驱动器的、子代理的）
 *    都把它清零 —— 语义与「用户自己补一句『继续』之后我们又有预算」一致。
 * 3. **只在循环中止时续跑**。`REASONING_LOOP` 只在「该步没有任何可见产出」时
 *    才报（见各适配器的 `reasoningLoopIsSoleOutput` 门禁），故续跑不会重复
 *    已经给用户看过的东西；其它错误码（TRANSPORT / QUOTA / AUTH …）一律不碰。
 *
 * ⚠️ 续跑次数是**进程内**状态（按 agent id 记）。插件重载即清零 —— 与目标
 * 驱动器的 `activation` 同样是进程内语义，不做持久化（没有格式变更风险）。
 */
import type { Context } from '@deepseek-ai/cordis'
// 仅有类型用途：本文件不 import dsh-agent 的任何运行时值，故它只进
// devDependencies。这行 `import type {}` 的作用是**加载该包的类型声明**
// （`Events` 的 `agent/error` / `agent/status`、`Context.agents` 的声明合并），
// 与 `deepseek-account` 的 `account-tasks.ts` 同一手法。
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { REASONING_LOOP_CODE, resolveReasoningLoopGuardFlag } from './sse.js'

/**
 * 自动续跑时投递的 user 消息正文。
 *
 * ⚠️ 它是**模型可见且会落盘**的文本（不是日志），故按「给模型的指令」写：
 * 说清三件事 —— ①继续未完成的任务；②为什么上一轮停了（思考重复，**不是**
 * 任务做完）；③这次要换思路。不写 harness 内部词汇（「循环守卫」「去重率」），
 * 那是给用户看的诊断，模型只需要知道「上一轮那样想没用」。
 */
export const LOOP_RESUME_PROMPT = '继续未完成的任务。上一轮你的思考陷入了重复（同一段推理反复出现）'
  + '而被中止 —— 请换一种思路，不要重复刚才那段推理，直接推进任务。'

/** 连续自动续跑的**默认**上限（次）。 */
export const LOOP_RESUME_DEFAULT_MAX = 2

/**
 * `…_MAX` 的硬上限。
 *
 * 单次循环只烧约 2000 字符（实测），2 次已足够覆盖「换个思路就能继续」的
 * 绝大多数情况；再往上配（比如 999）不是配置而是事故 —— 真要无限跑，
 * 用户该用的是 goal（`create_goal`）而不是这个兜底。
 */
export const LOOP_RESUME_MAX_LIMIT = 10

/** 总开关环境变量；**默认开启**，与 `DSH_REASONING_LOOP_GUARD` 同族。 */
export const LOOP_RESUME_FLAG_ENV = 'DSH_REASONING_LOOP_AUTO_RESUME'

/** 连续次数上限环境变量；`0` 是**合法**值（= 一次都不续跑）。 */
export const LOOP_RESUME_MAX_ENV = 'DSH_REASONING_LOOP_AUTO_RESUME_MAX'

/** 自动续跑策略。 */
export interface LoopResumePolicy {
  /** 是否启用（`false` 时 `installLoopResume` 不注册任何监听）。 */
  readonly enabled: boolean
  /** 连续续跑上限；落在 `0..{@link LOOP_RESUME_MAX_LIMIT}`。 */
  readonly maxResumes: number
}

/**
 * 归一化 `…_MAX`。
 *
 * ⚠️ **非法值回默认值，而不是回 0**：`0` 是「绝不自动续跑」的**合法**配置，
 * 若把 `=abc` 也变成 0，用户拼错一次就会以为「功能没生效」却查不出原因
 * （与本仓库既有教训同型：`parseInt(…) || 默认值` 会把合法的 `0` 静默吞掉）。
 *
 * @param raw - 环境变量原文；`undefined` / 空白视为未设置。
 * @returns 归一化后的上限（整数、非负、≤ {@link LOOP_RESUME_MAX_LIMIT}）。
 */
export function resolveLoopResumeMax(raw: string | undefined): number {
  const text = raw?.trim() ?? ''
  if (text === '') return LOOP_RESUME_DEFAULT_MAX
  const value = Number(text)
  if (!Number.isInteger(value) || value < 0) return LOOP_RESUME_DEFAULT_MAX
  return Math.min(value, LOOP_RESUME_MAX_LIMIT)
}

/**
 * 读取自动续跑策略。
 * @param env - 环境变量来源，默认 `process.env`（单测注入用）。
 * @returns 归一化后的策略。
 */
export function resolveLoopResumePolicy(env: NodeJS.ProcessEnv = process.env): LoopResumePolicy {
  return {
    // 复用循环守卫自己的开关语义（默认开、显式假值才关），避免两处各写一份。
    enabled: resolveReasoningLoopGuardFlag(env[LOOP_RESUME_FLAG_ENV]),
    maxResumes: resolveLoopResumeMax(env[LOOP_RESUME_MAX_ENV]),
  }
}

/**
 * 判断一个错误是不是「思考死循环中止」。
 *
 * ⚠️ **不能只靠 `instanceof LlmError`**：`@deepseek-ai/dsh-llm` 在宿主与插件里
 * 可能解析成**两份模块实例**（宿主自带副本 + profile 里另一份），此时
 * `instanceof` 恒为 `false`，表现是「功能完全没反应而且没有任何报错」——
 * 极难定位。故这里再按**错误码**认一次：`REASONING_LOOP` 是本插件自己定义的
 * 常量（`sse.ts`），误判风险为零。
 *
 * @param error - `agent/error` 载荷里的原样错误。
 * @returns 是否为循环中止。
 */
export function isReasoningLoopFailure(error: unknown): boolean {
  if (error instanceof LlmError) return error.code === REASONING_LOOP_CODE
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === REASONING_LOOP_CODE
}

/**
 * 本模块真正用到的 Agent 面（结构化类型）。
 *
 * 刻意只声明这四项：自动续跑的判据是「idle + 没人在排队 + 投一条 followup」，
 * 别的能力一律不碰。单测据此可以直接给假对象，无需伪造整个 Agent。
 */
export interface LoopResumeAgent {
  /** 会话 id（同一会话跨 resume 稳定，故用它作状态键）。 */
  readonly id: string
  /** 当前生命周期状态；只有 `'idle'` 允许投递。 */
  readonly status: string
  /** Optional live session identity, used to reject events from a replaced lifecycle. */
  readonly session?: object
  /** Current hosts expose pending lists; older hosts expose a summary flag. */
  readonly inbox: {
    readonly hasPending?: boolean
    readonly nextTurn?: readonly unknown[]
    readonly nextStep?: readonly unknown[]
  }
  /** 排队一条下一个轮次的 user 消息。 */
  followup(message: UserMessage): void
}

/** 日志面（`ctx.logger` 天然满足）。 */
export interface LoopResumeLog {
  info(message: string): void
  warn(message: string): void
}

/** {@link createLoopResumeController} 的构造参数。 */
export interface LoopResumeControllerOptions {
  /** 策略（开关 + 上限）。 */
  readonly policy: LoopResumePolicy
  /** 日志出口。 */
  readonly log: LoopResumeLog
  /**
   * 实际投递动作；默认 `agent.followup(message)`。
   *
   * 接线侧会传一个包了 `withoutInitiator()` 的版本（见 `installLoopResume`），
   * 单测侧直接传 spy。
   */
  readonly deliver?: (agent: LoopResumeAgent, message: UserMessage) => void
}

/** 自动续跑控制器（纯逻辑，不依赖 cordis）。 */
export interface LoopResumeController {
  /** 记录一次 `agent/error`。 */
  observeFailure(agent: LoopResumeAgent, error: unknown): void
  /** 记录一次 `agent/status`；返回是否真的投了一次续跑。 */
  observeIdle(agent: LoopResumeAgent): boolean
  /** 记录一条进入收件箱的消息（用于区分「我们投的」与「别人投的」）。 */
  observeInput(agent: LoopResumeAgent, message: { readonly id: string }): void
  /** Invalidate an idle decision without resetting the consecutive recovery budget. */
  cancelPending(agent: LoopResumeAgent): void
  /** 丢弃某个 agent 的状态（`agent/disposed`）。 */
  forget(agent: LoopResumeAgent): void
  /** 当前**连续**续跑计数（诊断/单测用）。 */
  attemptsOf(agentId: string): number
}

/** 每个 agent 的进程内状态。 */
interface AgentRecoveryState {
  /** 连续循环失败次数（成功被「别人投消息」清零）。 */
  attempts: number
  /** 刚发生过循环失败，等下一次 idle 决定要不要续跑。 */
  pending: boolean
  /** 本控制器投出去、尚未在收件箱里见过的消息 id。 */
  readonly injected: Set<string>
}

/**
 * 创建自动续跑控制器。
 * @param options - 策略、日志出口与投递动作。
 * @returns 控制器；内部状态按 `agent.id` 记，`forget()` 清理。
 */
export function createLoopResumeController(
  options: LoopResumeControllerOptions,
): LoopResumeController {
  const { policy, log } = options
  const deliver = options.deliver ?? ((agent, message) => { agent.followup(message) })
  const states = new Map<string, AgentRecoveryState>()

  function stateFor(agent: LoopResumeAgent): AgentRecoveryState {
    const existing = states.get(agent.id)
    if (existing !== undefined) return existing
    const state: AgentRecoveryState = { attempts: 0, pending: false, injected: new Set() }
    states.set(agent.id, state)
    return state
  }

  return {
    observeFailure(agent, error) {
      const state = stateFor(agent)
      if (!isReasoningLoopFailure(error)) {
        // 别的失败（TRANSPORT / QUOTA / AUTH …）说明「连续循环」已经断了：
        // 清零预算，让下一次真循环重新有额度。此处**不**置 pending —— 续跑
        // 只对循环中止负责，别的错误续跑只会掩盖真故障。
        state.attempts = 0
        state.pending = false
        return
      }
      state.attempts += 1
      state.pending = true
    },

    observeIdle(agent) {
      const state = states.get(agent.id)
      if (state === undefined || !state.pending) return false
      // 先清 pending：无论下面走哪条分支，这次失败都已经处理过了，
      // 否则后续每一次 idle 都会重试一遍（无界）。
      state.pending = false
      if (state.attempts > policy.maxResumes) {
        log.warn(
          `[channel-pack] ${agent.id} 连续第 ${state.attempts} 次思考陷入重复，`
          + `已达到自动续跑上限（${policy.maxResumes} 次），不再自动续跑 —— `
          + '建议降低思考档位或更换模型。',
        )
        return false
      }
      // 防御性再确认：本函数由 `agent/status` 的 idle 分支调用，但状态可能
      // 在该事件与本次调用之间被别的监听器改回 running。
      if (agent.status !== 'idle') return false
      // 已经有人排了活（用户手打了、目标驱动器排了下一轮）→ 让它跑，
      // 我们插一脚只会多烧一轮。
      if (agent.inbox.hasPending === true
        || (agent.inbox.nextTurn?.length ?? 0) > 0
        || (agent.inbox.nextStep?.length ?? 0) > 0) return false

      // ⚠️ 构造 + 投递整体兜住：本函数跑在宿主的 `agent/status` 派发里，让异常
      // 冒到派发方会污染宿主的事件链，而我们只是「额外帮忙」，失败必须是降级。
      let injectedId: string | undefined
      try {
        const message = createUserMessage({
          content: [{ type: 'text', text: LOOP_RESUME_PROMPT }],
          // `kind: 'user'`：这就是一条普通用户指令（与用户手打「继续」同形），
          // 故 UI 显示、落盘、重放全部走既有路径，无需任何格式变更。
          source: { kind: 'user' },
        })
        injectedId = message.id
        state.injected.add(message.id)
        deliver(agent, message)
      } catch (error: unknown) {
        if (injectedId !== undefined) state.injected.delete(injectedId)
        log.warn(`[channel-pack] 自动续跑投递失败（${agent.id}）：${String(error)}`)
        return false
      }
      log.info(
        `[channel-pack] ${agent.id} 思考陷入重复被中止，已自动续跑`
        + `（第 ${state.attempts}/${policy.maxResumes} 次）。`,
      )
      return true
    },

    observeInput(agent, message) {
      const state = states.get(agent.id)
      if (state === undefined) return
      // 我们自己投的那条：既不算「别人介入」，也不该占着标记不放。
      if (state.injected.delete(message.id)) return
      // 别人（用户 / 目标驱动器 / 子代理）投了消息 → 预算清零。
      state.attempts = 0
      state.pending = false
    },

    cancelPending(agent) {
      const state = states.get(agent.id)
      if (state !== undefined) state.pending = false
    },

    forget(agent) {
      states.delete(agent.id)
    },

    attemptsOf(agentId) {
      return states.get(agentId)?.attempts ?? 0
    },
  }
}

/**
 * 装上自动续跑（在插件 `apply()` 里调用一次）。
 *
 * ⚠️ `agents` 用 `ctx.inject([...])` 而**不**写进静态 `inject`：宿主侧 agent-loop
 * 缺席的 profile（纯 `ctx.llm` 的脚本、部分 headless 场景）里静态 inject 会让
 * 本插件**永久 pending**，整个 profile 启动失败（与 `connection` 同理，见
 * `index.ts` 的 `inject` 注释）。缺席时本功能整体不生效，其余 provider 照常。
 *
 * @param ctx - 插件上下文。
 */
export function installLoopResume(ctx: Context): void {
  const policy = resolveLoopResumePolicy()
  if (!policy.enabled || policy.maxResumes === 0) {
    ctx.logger.info(
      `[channel-pack] 思考循环后的自动续跑未启用（${LOOP_RESUME_FLAG_ENV} / ${LOOP_RESUME_MAX_ENV}）。`,
    )
    return
  }
  ctx.inject(['agents'], (scope) => {
    let active = true
    const scheduled = new Map<LoopResumeAgent, symbol>()
    const live = new Map<string, LoopResumeAgent>()
    const disposed = new WeakSet<LoopResumeAgent>()
    const controller = createLoopResumeController({
      policy,
      log: ctx.logger,
      // ⚠️ 用 `withoutInitiator()` 排队：这几行跑在别的 agent 的事件派发里
      // （`agent/status` / `agent/error`），排队动作不该继承「当时恰好是谁在
      // 运行」的发起者归属 —— 与 harness 自己的 `goal-round-driver` 同一手法。
      deliver: (agent, message) => { scope.agents.withoutInitiator(() => { agent.followup(message) }) },
    })
    const cancelPending = (agent: LoopResumeAgent): void => {
      scheduled.delete(agent)
      if (live.get(agent.id) === agent) controller.cancelPending(agent)
    }
    scope.effect(() => () => {
      active = false
      scheduled.clear()
      for (const agent of live.values()) controller.forget(agent)
      live.clear()
    })
    scope.on('agent/error', ({ agent, error }) => {
      if (!active || disposed.has(agent)) return
      const previous = live.get(agent.id)
      if (previous !== undefined && previous !== agent) {
        cancelPending(previous)
        controller.forget(previous)
      }
      live.set(agent.id, agent)
      scheduled.delete(agent)
      controller.observeFailure(agent, error)
    })
    scope.on('agent/status', ({ agent, status }) => {
      if (!active || disposed.has(agent)) return
      if (status !== 'idle') {
        cancelPending(agent)
        return
      }
      if (live.get(agent.id) !== agent || scheduled.has(agent)) return
      const token = Symbol()
      scheduled.set(agent, token)
      // Let every subscriber observe this idle transition before followup can emit running.
      queueMicrotask(() => {
        if (!active || ctx.fiber?.uid === null || scope.fiber?.uid === null
          || disposed.has(agent) || scheduled.get(agent) !== token) return
        scheduled.delete(agent)
        if (live.get(agent.id) !== agent) return
        controller.observeIdle(agent)
      })
    })
    scope.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!active || disposed.has(agent) || live.get(agent.id) !== agent) return
      scheduled.delete(agent)
      controller.observeInput(agent, message)
    })
    scope.on('agent/inbox/discarded', ({ agent }) => { cancelPending(agent) })
    scope.on('session/event', (session, event) => {
      const agent = live.get(session.id)
      if (agent === undefined || (agent.session !== undefined && agent.session !== session)) return
      if (event.type === 'turn/start'
        || (event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')
        || (event.type === 'turn/end'
          && !(event.data.reason.kind === 'error' && event.data.reason.error.code === REASONING_LOOP_CODE))) {
        cancelPending(agent)
      }
    })
    scope.on('agent/disposed', ({ agent }) => {
      disposed.add(agent)
      cancelPending(agent)
      if (live.get(agent.id) === agent) {
        live.delete(agent.id)
        controller.forget(agent)
      }
    })
  })
}
