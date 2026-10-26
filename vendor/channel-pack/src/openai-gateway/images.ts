/**
 * 网关的图片入站处理：OpenAI `image_url` → DSH `ImageBlock`。
 *
 * ## 契约来自实测（临时探针，探针已删）
 *
 * `ctx.attachments`（`@deepseek-ai/dsh-attachment-local`）的真实契约：
 * - `saveImage({ data: Uint8Array, mediaType: string })` → `ImageAttachmentRef`
 *   `{ attachmentId: "sha256:<hex>", mediaType, width, height, bytes }`
 * - `attachmentId` 是**内容寻址**的：同一张图落两次得到同一个 id，天然去重。
 * - 媒体类型是**硬校验**：`AttachmentError: Declared image type does not match
 *   its bytes.` —— 声明与字节不符会被拒，故**不能盲信**请求里的 mime。
 * - `saveImages` 的返回形态与直觉相反（传数组返单个 ref），故这里只逐张调用。
 *
 * DSH 侧 `ImageBlock` 是 `{ type: 'image', attachment: ImageAttachmentRef }`
 * —— **不是** OpenAI 的 data URL，这正是初版网关无法转发图片的原因。
 *
 * ## ⚠️ 客户端可能**根本不发**图片（ZCode 的会话级行为，真机报障 2026-10-02）
 *
 * 现象：同一个 ZCode、同一张图，DSH Web 直连能识图、ZCode 走本网关却
 * 「读不出图像数据」，而 ZCode 走 anthropic 端点又能识图 —— 看似协议问题，
 * 实则**与协议无关**。
 *
 * 真实原因：ZCode 在**会话创建时**按当时的模型能力把图片定成两种形态之一，
 * 之后**不随换模型重新评估**（源码依据见
 * `ZCode-official/.../core/src/runtime/helpers/conversation.ts:193` 的
 * `isPastedInlineImageAttachment`）：
 * - `contentBlock.source.kind === 'inline'` → 真内联，发 `image_url`；
 * - 否则退化成**文本占位符** `[Attached image/jpeg: <本地路径>]`。
 *
 * 而真正发请求的 `@ai-sdk/openai-compatible` 只在 `type: 'file'` 且
 * `mediaType` 以 `image/` 开头时才产出 `image_url` ——
 * 占了文本形态，网关就永远收不到图片。
 *
 * **复现/规避**：用声明了图片能力的模型（`GET /v1/models` 的 `input` 含
 * `image`）**新开会话**；换模型不会让已有会话恢复内联发图。
 *
 * ⚠️ **不要**在这里兼容占位符形态 —— 那等于按客户端指定的任意路径读取本机
 * 文件，API 一暴露到网络即成任意文件读取漏洞。
 *
 * ## 只支持 data URL（用户决定）
 *
 * 外部 http(s) 图片**明确拒绝**而不是由网关去下载：那需要在网关里发起出站
 * 请求，是一个真实的 SSRF 面（能打环回地址、内网服务、云元数据端点）。代价是
 * 「客户端给个图片链接」这种用法暂时不支持，README 已写明。
 */

/** 附件服务的最小形态（便于单测替身；真实服务由宿主注入）。 */
export interface AttachmentBridge {
  saveImage(input: { data: Uint8Array; mediaType: string }): Promise<unknown>
}

/**
 * 图片限制，取自附件服务上报的 `imageLimits`。
 *
 * ⚠️ 这些是**实测值**（探针读到的 `ctx.attachments.imageLimits`）。前端校验只是
 * 为了给出可读错误，真正的把关仍在附件服务 —— 宿主可能换实现或换上限，故这里
 * 取不到就用一个保守的兜底，绝不放宽成「无限制」。
 */
export interface ImageLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImageDimension: number
  mediaTypes: readonly string[]
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const DATA_URL = /^data:([^;,]+)(;[^,]*)?,(.*)$/s
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * 解析 data URL 图片。
 *
 * ⚠️ 只接受 base64 的 data URL：非 base64（`data:text/plain,hello`）一律拒绝 ——
 * 让附件服务去"猜"内容类型没有意义。
 *
 * @param url 客户端给的 image_url.url
 * @returns `{ mediaType, data }`；不是可用的 base64 data URL 时返回 undefined
 */
export function parseImageDataUrl(url: unknown): { mediaType: string; data: Uint8Array } | undefined {
  if (typeof url !== 'string') return undefined
  const matched = DATA_URL.exec(url.trim())
  if (matched === null) return undefined
  const [, mediaType = '', parameters = '', payload = ''] = matched
  // `;base64` 必须在参数里；没有它说明是 URL 编码的纯文本，不是图片。
  if (!/;base64/i.test(parameters)) return undefined
  // 去掉换行/空白：客户端有时会把长 base64 折行
  const compact = payload.replace(/\s+/g, '')
  if (compact.length === 0 || !BASE64.test(compact)) return undefined
  let bytes: Buffer
  try {
    bytes = Buffer.from(compact, 'base64')
  } catch {
    return undefined
  }
  if (bytes.length === 0) return undefined
  return { mediaType: mediaType.trim().toLowerCase(), data: new Uint8Array(bytes) }
}

/**
 * 前置校验，返回可读的错误原因；通过则返回 undefined。
 *
 * 存在的意义是**给出能指路的错误**——附件服务抛的是 `AttachmentError`，用户
 * 看到的是英文内部错误，而这里能说清「超了 20MB 上限」或「不支持该格式」。
 *
 * @param mediaType 声明的媒体类型（只作为白名单筛查；字节是否真的是它由附件服务判定）
 * @param byteLength 解码后的字节数
 * @param limits 限制表
 * @param alreadyInMessage 本条消息里已有的图片数
 * @param alreadyInBytes 本条消息里已有图片的总字节
 */
export function checkImageLimits(
  mediaType: string,
  byteLength: number,
  limits: ImageLimits,
  alreadyInMessage: number,
  alreadyInBytes: number,
): string | undefined {
  if (!limits.mediaTypes.includes(mediaType)) {
    return `图片格式 ${mediaType} 不受支持；可用格式：${limits.mediaTypes.join('、')}`
  }
  if (byteLength > limits.maxImageBytes) {
    return `单张图片 ${formatBytes(byteLength)} 超过上限 ${formatBytes(limits.maxImageBytes)}`
  }
  if (alreadyInMessage + 1 > limits.maxImagesPerMessage) {
    return `一条消息最多 ${limits.maxImagesPerMessage} 张图片，当前已有 ${alreadyInMessage} 张`
  }
  if (alreadyInBytes + byteLength > limits.maxMessageImageBytes) {
    return `一条消息的图片总大小超过上限 ${formatBytes(limits.maxMessageImageBytes)}`
  }
  return undefined
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`
  if (value >= 1024) return `${Math.round(value / 1024)}KB`
  return `${value}B`
}

/**
 * 把 data URL 图片落成 DSH 的 `ImageBlock`。
 *
 * ⚠️ **任何失败都必须抛错，绝不静默丢图**：静默丢弃会让用户以为模型看到了图，
 * 而答案其实是基于文本生成的（与本仓库处理 Qoder 图片丢失时的同一条原则）。
 */
export async function toImageBlock(
  url: unknown,
  bridge: AttachmentBridge,
  limits: ImageLimits,
  already: { count: number; bytes: number },
  // ⚠️ 返回 `never` 而非 `ImageAttachmentRef`：那个类型来自
  // `@deepseek-ai/dsh-attachment`，**未随本插件的依赖安装**（运行时由宿主的
  // `@deepseek-ai/dsh-attachment-local` 提供）。故这里只声明结构、不断言类型 ——
  // 与本仓库处理 `Message['id']`、`tool-call.id` 的同款做法一致。
): Promise<{ type: 'image'; attachment: never }> {
  if (typeof url === 'string' && !url.trim().startsWith('data:')) {
    throw new Error(
      '网关暂不支持 http(s) 图片链接：出于安全考虑（避免 SSRF），'
      + '只接受 base64 内联的 data URL 图片。',
    )
  }
  const parsed = parseImageDataUrl(url)
  if (parsed === undefined) {
    throw new Error('无法解析图片：只接受 base64 内联的 data URL（如 data:image/png;base64,…）')
  }
  const violation = checkImageLimits(
    parsed.mediaType, parsed.data.length, limits, already.count, already.bytes,
  )
  if (violation !== undefined) throw new Error(violation)

  let ref: unknown
  try {
    ref = await bridge.saveImage({ data: parsed.data, mediaType: parsed.mediaType })
  } catch (error) {
    // 附件服务抛的是英文内部错误（AttachmentError…），包一层给出可读原因。
    throw new Error(`图片保存失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (ref === undefined || ref === null) {
    throw new Error('图片保存失败：附件服务没有返回可用的图片引用')
  }
  return { type: 'image', attachment: ref as never }
}
