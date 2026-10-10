/**
 * 缺少厂商视觉计价协议时的同步估算，供宿主的 Token 预算和结果落盘使用。
 * 1024 是兜底估算值，不代表所有厂商的真实消耗或上限。已移出请求的图片只计描述文本。
 */
export const FALLBACK_IMAGE_PRICING = Object.freeze({
  /** @param {readonly { offloaded?: boolean }[]} images */
  priceImages(images) {
    return images.map(image => image.offloaded === true
      ? { visualTokens: 0, text: '[image omitted]' }
      : { visualTokens: 1024, text: '[image]' })
  },
})

/**
 * 每视觉 Token 对应的像素数，用于按真实尺寸估算保留图片的请求成本。
 *
 * 免费出口不公布单图定价，所以这是估算而非报价。它只需保守且保序：内核用它
 * 判断内容是否已大到不该继续内联。
 */
export const IMAGE_PIXELS_PER_TOKEN = 750

/** 尺寸从未到达请求时的视觉 Token 兜底。 */
export const IMAGE_TOKENS_FALLBACK = 1024

/**
 * 与内核自身计数方式一致的单图描述文本。
 *
 * @param {string} mediaType - 附件媒体类型，未知时由调用方兜底为 `image`。
 * @param {number} width - 附件宽度，未测量时为 `NaN`。
 * @param {number} height - 附件高度，未测量时为 `NaN`。
 * @param {string|undefined} attachmentId - 附件标识，缺失时回退到媒体类型。
 * @returns {string} 计入 token 预算的描述文本。
 */
function imageDescriptor(mediaType, width, height, attachmentId) {
  const sized = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
  const name = typeof attachmentId === 'string' && attachmentId !== '' ? attachmentId : mediaType
  return `\n[Image: ${name}; ${mediaType}; ${sized ? `${width}x${height}` : 'size unknown'}]\n`
}

/**
 * 为一次请求中的单张图片计价。
 *
 * 永不抛错，且对每个出现位置恰好给出一个价格：调用方会把数量不匹配当成错误，
 * 一个读不出来的附件必须照常计价，而不是中断整轮对话。
 *
 * @param {object} image - 请求内容里的一个 `ImageBlock`。
 * @returns {{visualTokens: number, text: string}} 该出现位置的计价。
 */
export function priceRequestImage(image) {
  try {
    const attachment = image?.attachment ?? {}
    const width = Number(attachment.width)
    const height = Number(attachment.height)
    const mediaType = typeof attachment.mediaType === 'string' && attachment.mediaType !== '' ? attachment.mediaType : 'image'
    const text = imageDescriptor(mediaType, width, height, attachment.attachmentId)
    // 已移出请求的出现位置以句柄加 `read_image` 指针传输，与内核自身对该情形的
    // 计价一致：不计视觉 Token。
    if (image?.offloaded === true) return { visualTokens: 0, text }
    const sized = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    const visualTokens = sized ? Math.max(1, Math.ceil(width * height / IMAGE_PIXELS_PER_TOKEN)) : IMAGE_TOKENS_FALLBACK
    return { visualTokens, text }
  } catch {
    return { visualTokens: IMAGE_TOKENS_FALLBACK, text: '\n[Image: unreadable]\n' }
  }
}

/**
 * 免费模型通道的视觉计价器：按附件真实尺寸估算，而非统一兜底值。
 *
 * 与 `FALLBACK_IMAGE_PRICING` 的分工：后者服务渠道包的 13 条路由，那里拿不到
 * 附件尺寸，只能给固定兜底；免费通道的请求里带着真实宽高，可以按面积估算。
 *
 * 必须保持同步：Token 计量在每次测量时解析它，没有 I/O 窗口（issue #42）。
 */
export const PIXEL_IMAGE_PRICING = Object.freeze({
  /** @param {readonly object[]} images */
  priceImages(images) {
    return (Array.isArray(images) ? images : []).map(priceRequestImage)
  },
})
