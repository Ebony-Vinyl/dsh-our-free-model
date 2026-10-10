/** 跨宿主版本的同步视觉 Token 估算；不是厂商账单或上限。 */
export declare const FALLBACK_IMAGE_PRICING: Readonly<{
  priceImages(images: readonly { offloaded?: boolean }[]): {
    visualTokens: number
    text: string
  }[]
}>

/** 每视觉 Token 对应的像素数，用于按真实尺寸估算保留图片的请求成本。 */
export declare const IMAGE_PIXELS_PER_TOKEN: number

/** 尺寸从未到达请求时的视觉 Token 兜底。 */
export declare const IMAGE_TOKENS_FALLBACK: number

/** 单张请求图片的计价结果。 */
export declare interface RequestImagePrice {
  visualTokens: number
  text: string
}

/**
 * 为一次请求中的单张图片计价；永不抛错，对每个出现位置恰好给出一个价格。
 *
 * @param image - 请求内容里的一个 `ImageBlock`。
 */
export declare function priceRequestImage(image: unknown): RequestImagePrice

/**
 * 免费模型通道的视觉计价器：按附件真实尺寸估算，而非统一兜底值。
 *
 * 与 `FALLBACK_IMAGE_PRICING` 的分工：后者服务渠道包的 13 条路由，那里拿不到
 * 附件尺寸，只能给固定兜底；免费通道的请求里带着真实宽高，可以按面积估算。
 */
export declare const PIXEL_IMAGE_PRICING: Readonly<{
  priceImages(images: readonly unknown[]): RequestImagePrice[]
}>
