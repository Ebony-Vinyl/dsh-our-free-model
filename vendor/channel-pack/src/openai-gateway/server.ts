import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { loadOrCreateApiKey, type ApiKeySource } from './auth.js'
import { resolveGatewayConfig, type OpenAiGatewayConfig } from './config.js'
import { markGatewayChannel } from './channel.js'
import { toGenerateOptions, OpenAiGatewayError, parseModelRoute, normalizeReasoningEffort, normalizeMaxTokens, type OpenAiChatRequest, type ReasoningEffortNotice } from './messages.js'
import type { AttachmentBridge, ImageLimits } from './images.js'
import { collectGatewayEffortViews, collectGatewayModelIds, collectGatewayModels, toGatewayModelIds, toOpenAiModels } from './models.js'
import { effortResolutions } from './effort-view.js'
import { CANONICAL_REASONING_EFFORTS } from '../reasoning-ladder.js'
import { findCaseInsensitiveSuggestion, looksLikeMissingModel } from './model-errors.js'
import {
  collectResponsesResult,
  responsesMaxOutputTokens,
  responsesReasoningEffort,
  toResponsesGenerateOptions,
  toResponsesSse,
  type OpenAiResponsesRequest,
} from './responses.js'
import { collectOpenAiCompletion, failureToOpenAiError, toOpenAiSse } from './stream.js'

export interface GatewayLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface LlmRuntimeLike {
  listProviders(): readonly { id: string }[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface OpenAiGatewayOptions {
  ctx?: Context
  llm: LlmRuntimeLike
  /**
   * 附件服务桥接（`ctx.attachments.saveImage`）。
   *
   * 缺失时收到图片会明确回「未装载附件服务」而不是静默丢图 —— 静默丢弃会让用户
   * 以为模型看到了图，而答案其实是基于文本生成的。
   */
  attachments?: AttachmentBridge
  /** 图片限制；缺省用 `images.ts` 里附件服务的实测默认值。 */
  imageLimits?: ImageLimits
  home?: string
  env?: NodeJS.ProcessEnv
  logger?: GatewayLogger
}

export interface OpenAiGateway {
  start(): Promise<void>
  close(): Promise<void>
  address(): { host: string; port: number }
  /**
   * 密钥来源（含本体与文件路径）。
   *
   * 刻意**只经由 `createOpenAiGateway()` 拿**（runtime 已持有实例），而不是
   * 另开一条读密钥的通道：多一个入口就多一处「读到的和网关在用的不是同一个」
   * 的可能，而那种偏差会表现为「设置页复制的 key 一律 401」。
   */
  apiKey: ApiKeySource
}

const BODY_LIMIT = 16 * 1024 * 1024

const defaultLogger: GatewayLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  response.end(body)
}

function readJson(request: IncomingMessage, signal: AbortSignal): Promise<OpenAiChatRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const abort = () => reject(new OpenAiGatewayError('request was aborted', 499, 'aborted', 'aborted'))
    signal.addEventListener('abort', abort, { once: true })
    request.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += data.length
      if (size > BODY_LIMIT) {
        reject(new OpenAiGatewayError('request body is too large', 413, 'invalid_request_error', 'request_too_large'))
        request.destroy()
        return
      }
      chunks.push(data)
    })
    request.on('error', reject)
    request.on('end', () => {
      signal.removeEventListener('abort', abort)
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object')
        resolve(value as OpenAiChatRequest)
      } catch {
        reject(new OpenAiGatewayError('request body must be valid JSON'))
      }
    })
  })
}

function authorized(request: IncomingMessage, key: string): boolean {
  const value = request.headers.authorization
  return typeof value === 'string' && value === `Bearer ${key}`
}

function getHome(options: OpenAiGatewayOptions): string {
  return options.home ?? options.env?.DSH_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function createOpenAiGateway(options: OpenAiGatewayOptions): OpenAiGateway {
  const env = options.env ?? process.env
  const config: OpenAiGatewayConfig = resolveGatewayConfig(env)
  // 密钥在**创建时**解析（而不是 start 时）：设置页要能在网关未运行时也能
  // 读到它，用户才能配置外部客户端。
  const apiKey = loadOrCreateApiKey(getHome(options), env)
  const key = apiKey.value
  const logger = options.logger ?? defaultLogger
  let server: Server | undefined
  let boundPort = config.port
  const active = new Set<AbortController>()

  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  const handleModels = async (response: ServerResponse): Promise<void> => {
    // 逐个 catch 的容错在 collectGatewayModels 里（设置页的 RPC 复用同一份，
    // 两处各写一遍必然漂移）。
    const groups = await collectGatewayModels(options.llm, (provider, error) => {
      logger.warn(`[openai-gateway] ${provider} 模型目录读取失败，已从 /v1/models 跳过：${describe(error)}`)
    })
    // 档位视图是**附加信息**：某个模型解析不出来就只是它没有该字段，
    // 绝不能让整份目录跟着失败（同理，见 collectGatewayEffortViews 的注释）。
    const effortViews = await collectGatewayEffortViews(options.llm, groups, (provider, error) => {
      logger.warn(`[openai-gateway] ${provider}：${describe(error)}`)
    })
    jsonResponse(response, 200, { object: 'list', data: toOpenAiModels(groups, effortViews) })
  }

  /**
   * `GET /v1/reasoning-efforts`：**思考档位对照表**（本网关特有的只读端点）。
   *
   * ## 为什么需要它（真实缺陷）
   *
   * 各 provider 的档位 id 是上游 wire 值（`light` / `extra_high` / `xhigh` / `on`），
   * 而走 OpenAI 协议的客户端只有固定 8 档词汇。客户端**无法表达**那些私有 id，
   * 用户只能照 DSH 界面上显示的名字（Max / Extra / Extra High）猜着填，
   * 猜错就是 400。翻译层让「猜错也不会失败」，本端点让「不必猜」：
   * 每个模型的 `openai_efforts` 就是可以直接抄进客户端的那一组，
   * `resolutions` 则把 8 个规范名逐一的结局说清（原样 / 就近 / 无法表达 / 不下发）。
   *
   * ⚠️ `/v1/models` 里也带同一份视图（`reasoning` 字段）。两处**必须同源**：
   * 这里给人和脚本查，那里给会自动扫目录的工具查；各算一遍必然漂移。
   */
  const handleReasoningEfforts = async (response: ServerResponse): Promise<void> => {
    const groups = await collectGatewayModels(options.llm, (provider, error) => {
      logger.warn(`[openai-gateway] ${provider} 模型目录读取失败，已从 /v1/reasoning-efforts 跳过：${describe(error)}`)
    })
    const effortViews = await collectGatewayEffortViews(options.llm, groups, (provider, error) => {
      logger.warn(`[openai-gateway] ${provider}：${describe(error)}`)
    })
    jsonResponse(response, 200, {
      object: 'list',
      // 客户端能说出口的全部档位名（由弱到强）。CC Switch 的档位多选器就是这 8 个。
      canonical: [...CANONICAL_REASONING_EFFORTS],
      data: toGatewayModelIds(groups, effortViews).map((model) => {
        const reasoning = model.reasoning
        const declared = reasoning?.efforts.map((effort) => effort.id) ?? []
        return {
          id: model.id,
          efforts: reasoning?.efforts ?? [],
          ...reasoning?.default === undefined ? {} : { default: reasoning.default },
          // 可以直接抄进 OpenAI 客户端的规范名；`efforts` 为空时它也为空
          // （该模型不声明档位 → 网关不下发任何档位，按模型默认走）。
          openai_efforts: reasoning?.openai_efforts ?? [],
          resolutions: effortResolutions(declared),
        }
      }),
    })
  }

  /**
   * 解析模型元信息。失败按「模型不可解析」回 404，而不是笼统的 502 ——
   * OpenAI 客户端据此区分「换个模型名重试」与「上游故障」，前者不该被当作可重试错误。
   */
  const resolveModelInfo = async (
    route: { provider: string; model: string },
    signal: AbortSignal,
  ): Promise<unknown> => {
    try {
      return await options.llm.resolveModelInfo(route.provider, route.model, signal)
    } catch (error) {
      // 取消导致的抛错不是「模型不存在」，不能被改写成 404。
      if (signal.aborted) throw new OpenAiGatewayError('request was aborted', 499, 'aborted', 'aborted')
      throw new OpenAiGatewayError(
        `model ${route.provider}/${route.model} could not be resolved: ${describe(error)}`,
        404,
        'invalid_request_error',
        'model_not_found',
      )
    }
  }

  /**
   * 失败时给出「你是不是想用 X」的建议。
   *
   * ⚠️ **目录只在出错时才去查**（正常请求零额外开销），且用的是与
   * `/v1/models` 完全相同的采集器 —— 建议里给出的 ID 必须真能被网关接受，
   * 两处各查一遍必然漂移，而漂移的症状是「按提示改了还是不行」。
   */
  const makeSuggestion = (requestedId: string) => async (message: string): Promise<string | undefined> => {
    if (!looksLikeMissingModel(message)) return undefined
    const catalog = await loadModelIdsHint()
    const found = findCaseInsensitiveSuggestion(requestedId, catalog)
    return found === undefined ? undefined : `你是不是想用 ${found}`
  }

  /**
   * 纠错建议用的模型 ID 清单。
   *
   * 惰性 + 只取一次：出错是少数情况，正常路径连这个数组都不会构造。
   * 取失败（某个 provider 未登录）时退化为空清单 —— 拿不到建议只是少一句
   * 提示，绝不能因此把真正的错误盖掉。
   */
  let hintLoaded = false
  let modelIdsHint: readonly string[] = []
  const loadModelIdsHint = async (): Promise<readonly string[]> => {
    if (!hintLoaded) {
      hintLoaded = true
      try {
        modelIdsHint = (await collectGatewayModelIds(options.llm)).map((model) => model.id)
      } catch {
        modelIdsHint = []
      }
    }
    return modelIdsHint
  }

  /**
   * 两个端点共用的「请求生命周期」外壳：绑定取消、统一错误翻译。
   *
   * ⚠️ **必须共用**：`/v1/chat/completions` 与 `/v1/responses` 的错误出口若各写
   * 一遍，迟早出现「同一个错误在一个 URL 上回 404、在另一个上回 502」——
   * 而 502 会被客户端当可重试故障白耗额度，这正是当初引入 404 翻译要修的问题。
   */
  const withRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    run: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    const controller = new AbortController()
    active.add(controller)
    const abort = () => controller.abort()
    const onClose = () => {
      if (!response.writableEnded) controller.abort()
    }
    request.once('aborted', abort)
    response.once('close', onClose)
    try {
      await run(controller.signal)
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const converted = failureToOpenAiError(error)
        jsonResponse(response, converted.status, converted.body)
      }
    } finally {
      request.removeListener('aborted', abort)
      response.removeListener('close', onClose)
      active.delete(controller)
    }
  }

  /** SSE 响应头（两个端点的流式出口一致）。 */
  const writeSseHead = (response: ServerResponse): void => {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    })
  }

  /**
   * 档位被「翻译」或「丢弃」时记一条日志。
   *
   * ⚠️ 两种情况必须分开记，且**级别不同**：
   *
   * - `translated`（客户端给的是通用名、模型用的是私有 id，已就近下发）用 `info`：
   *   加了翻译层之后这是**正常路径**（CC Switch 给 TRAE 的 `low` 每一轮都会被翻译），
   *   用 warn 会把日志刷满，反而掩盖真正的异常；
   * - `unexpressible`（模型根本没有这一族的档位，本次不下发）用 `warn`：
   *   用户的设置确实没生效，这是需要被看见的事。
   *
   * 两件事都不回给客户端（OpenAI 协议里没有承载它的位置），故日志 + 对照表端点
   * （`GET /v1/reasoning-efforts`）是它们唯一的出口。
   */
  const logEffortNotice = (route: { provider: string; model: string }, notice: ReasoningEffortNotice): void => {
    const target = `${route.provider}/${route.model}`
    if (notice.outcome === 'translated') {
      logger.info(
        `[openai-gateway] ${target}：思考档位 ${notice.requested} 不是该模型声明的 id，`
        + `已按强度就近下发 ${notice.applied}`,
      )
      return
    }
    logger.warn(
      `[openai-gateway] ${target}：思考档位 ${notice.requested} 无法表达`
      + '（该模型没有这一族的档位），本次不下发该参数、按模型默认走',
    )
  }

  const handleChat = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    await withRequest(request, response, async (signal) => {
      const body = await readJson(request, signal)
      const route = parseModelRoute(body.model)
      const modelInfo = await resolveModelInfo(route, signal)
      const reasoningEffort = normalizeReasoningEffort(
        body.reasoning_effort, modelInfo, route.provider, route.model, (notice) => logEffortNotice(route, notice),
      )
      const requestedMaxTokens = body.max_completion_tokens ?? body.max_tokens
      const maxTokens = typeof requestedMaxTokens === 'number'
        ? normalizeMaxTokens(requestedMaxTokens, route.provider, route.model)
        : undefined
      const generate = await toGenerateOptions(body, signal, reasoningEffort, maxTokens, {
        bridge: options.attachments,
        limits: options.imageLimits,
      })
      const stream = options.llm.stream(markGatewayChannel(generate))
      const fullId = `${route.provider}/${route.model}`
      if (body.stream === true) {
        writeSseHead(response)
        for await (const event of toOpenAiSse(stream, undefined, fullId, makeSuggestion(fullId))) {
          if (signal.aborted || response.destroyed) break
          response.write(event)
        }
        if (!response.writableEnded) response.end()
      } else {
        const result = await collectOpenAiCompletion(stream, undefined, fullId, makeSuggestion(fullId))
        jsonResponse(response, 200, result)
      }
    })
  }

  /**
   * `POST /v1/responses`（OpenAI Responses API）。
   *
   * 与 `handleChat` 的差别**只在协议外壳**：模型路由、思考档位归一化、输出预算
   * 钳制（`normalizeMaxTokens`）、纠错建议、取消与错误翻译全部同源 —— 换了个
   * URL 就换了套行为是最难排查的一类缺陷。
   */
  const handleResponses = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    await withRequest(request, response, async (signal) => {
      const body = await readJson(request, signal) as OpenAiResponsesRequest
      const route = parseModelRoute(body.model)
      const modelInfo = await resolveModelInfo(route, signal)
      const reasoningEffort = normalizeReasoningEffort(
        responsesReasoningEffort(body), modelInfo, route.provider, route.model,
        (notice) => logEffortNotice(route, notice),
      )
      const requestedMaxTokens = responsesMaxOutputTokens(body)
      const maxTokens = requestedMaxTokens === undefined
        ? undefined
        : normalizeMaxTokens(requestedMaxTokens, route.provider, route.model)
      const generate = await toResponsesGenerateOptions(body, signal, reasoningEffort, maxTokens, {
        bridge: options.attachments,
        limits: options.imageLimits,
      }, (dropped) => {
        // ⚠️ 丢弃是**有意**的降级（拒绝会让 Codex 这类客户端的整轮对话直接失败，
        // 见 responses.ts 文件头「工具」一节），但绝不能连日志都没有 ——
        // 否则「模型看不到某个工具」这件事在事后无从解释。
        logger.warn(
          `[openai-gateway] /v1/responses：工具类型 ${dropped.type}`
          + `${dropped.name === undefined ? '' : `（${dropped.name}）`}`
          + ' 无法用 DSH 的 ToolSchema 表达，已从本次请求丢弃',
        )
      })
      const stream = options.llm.stream(markGatewayChannel(generate))
      const fullId = `${route.provider}/${route.model}`
      // 响应 id 由网关生成：本网关**无状态**，这个 id 只用于客户端关联，
      // 不能拿它回来查（`GET /v1/responses/{id}` 一律 404）。
      const responseId = `resp_${randomUUID().replaceAll('-', '')}`
      if (body.stream === true) {
        writeSseHead(response)
        for await (const event of toResponsesSse(stream, responseId, fullId, body, makeSuggestion(fullId))) {
          if (signal.aborted || response.destroyed) break
          response.write(event)
        }
        if (!response.writableEnded) response.end()
      } else {
        const result = await collectResponsesResult(stream, responseId, fullId, body, makeSuggestion(fullId))
        jsonResponse(response, 200, result)
      }
    })
  }

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      })
      response.end()
      return
    }
    if (!authorized(request, key)) {
      jsonResponse(response, 401, { error: { message: 'Missing or invalid API key', type: 'authentication_error', code: 'invalid_api_key' } })
      return
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/v1/models' && request.method === 'GET') {
      void handleModels(response).catch(error => jsonResponse(response, 502, { error: { message: String(error), type: 'server_error', code: 'model_list_failed' } }))
      return
    }
    // 本网关特有的只读端点：思考档位对照表（见 handleReasoningEfforts 的理由）。
    // ⚠️ 路径不放在 `/v1/models/…` 之下：客户端会把那些路径当模型 ID 解析。
    if (path === '/v1/reasoning-efforts' && request.method === 'GET') {
      void handleReasoningEfforts(response).catch(error => jsonResponse(response, 502, { error: { message: String(error), type: 'server_error', code: 'model_list_failed' } }))
      return
    }
    if ((path === '/v1/chat/completions' || path === '/v1/responses') && request.method === 'POST') {
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        jsonResponse(response, 415, { error: { message: 'Content-Type must be application/json', type: 'invalid_request_error', code: 'invalid_content_type' } })
        return
      }
      void (path === '/v1/responses' ? handleResponses(request, response) : handleChat(request, response))
      return
    }
    jsonResponse(response, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } })
  }

  return {
    async start(): Promise<void> {
      if (server !== undefined) return
      const current = createServer(requestHandler)
      server = current
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          current.off('listening', onListening)
          server = undefined
          reject(error)
        }
        const onListening = () => {
          current.off('error', onError)
          const address = current.address()
          boundPort = typeof address === 'object' && address !== null ? address.port : config.port
          resolve()
        }
        current.once('error', onError)
        current.once('listening', onListening)
        current.listen(config.port, config.host)
      }).catch((error) => {
        logger.error(`[openai-gateway] 启动失败 ${config.host}:${config.port}：${error instanceof Error ? error.message : String(error)}`)
        throw error
      })
      logger.info(`[openai-gateway] 已监听 http://${config.host}:${boundPort}/v1`)
    },
    async close(): Promise<void> {
      for (const controller of active) controller.abort()
      if (server === undefined) return
      const current = server
      server = undefined
      await new Promise<void>((resolve) => {
        current.close(() => resolve())
        current.closeAllConnections?.()
      })
      logger.info('[openai-gateway] 已关闭')
    },
    address(): { host: string; port: number } {
      return { host: config.host, port: boundPort }
    },
    apiKey,
  }
}
