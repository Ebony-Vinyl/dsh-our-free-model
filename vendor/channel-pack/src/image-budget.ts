/**
 * 请求图片的像素预算（issue !IKITT9）。
 *
 * ## 为什么需要它
 *
 * 本插件九个适配器原先一律把附件的**原始字节**内联成 data URL 发出去，
 * 从不按预算缩放。于是一个长会话里积累的截图会把网关的
 * 「单次请求图片视觉 token 总量」顶穿，实测报文：
 *
 * ```
 * {"code":11115,"msg":"prompt is too long: 100001 tokens > 100000 maximum"}
 * ```
 *
 * ⚠️ **这个 100000 不是上下文窗口**（`src/product.ts` 给该模型声明的是
 * 1,000,000，而同一会话纯文本 prompt 到 345,687 仍被正常接受 —— 由报障者
 * 本机 11,351 次成功请求统计证实：图片 token 无一越过 10 万）。
 * 它约束的是**一次请求的图片总量**，所以唯一的出路是让每张图变小。
 *
 * ## 为什么做成「每张固定预算」而不是「按本次张数分摊」
 *
 * 附件服务的请求版本是**确定性且带缓存**的：缓存身份包含附件 id、变换版本、
 * 目标尺寸与字节目标（见 `@deepseek-ai/dsh-attachment` 的 `readImageRequest`）。
 * 若目标尺寸随「这条会话现在有几张图」浮动，同一个附件在不同请求里会派生出
 * 不同的 `variantId` → 缓存反复击穿、每次重编码，而且用户无法预测一张图
 * 到底会被缩成多大。固定预算换来的是确定性、可缓存、可单测。
 *
 * 本模块只提供**纯几何**，实际缩放交给附件服务（它负责 alpha 路由、
 * JPEG/WebP 质量阶梯与字节目标），避免在这里重复实现一遍编码器。
 */

/**
 * 一次请求图片的目标（形状与 `@deepseek-ai/dsh-attachment` 的
 * `ImageRequestTarget` 一致）。
 *
 * ⚠️ 这里**不 import 那个包**：它由宿主提供、不在本插件的依赖声明里，
 * import 会让插件在缺该包的 profile 上直接崩。用结构一致的本地类型，
 * 传值时由 TypeScript 在调用点（桥接处）校验。
 */
export interface ImageRequestTarget {
  /** 目标宽度（像素）；大于原图宽度时服务会保留原宽度。 */
  width: number
  /** 目标高度（像素）；大于原图高度时服务会保留原高度。 */
  height: number
  /** 编码字节目标（base64 展开前）。 */
  maxBytes: number
}

/**
 * 内联图片的编码字节目标，取 **2 MiB**。
 */
export const REQUEST_IMAGE_MAX_BYTES = 2 * 1024 * 1024

/**
 * raccoon 的单张编码字节目标：**512 KB**（issue !IKITT9 的 raccoon 变体）。
 */
export const RACCOON_REQUEST_IMAGE_MAX_BYTES = 512 * 1024

/**
 * 其余按**请求体体积**设限的网关用的字节目标：**1 MiB**。
 *
 * 依据是本轮实测的撞墙张数（fixture 每张 base64 后 ≈3.8 MiB）：
 *
 * | provider | 实测边界 | 原图请求体 |
 * |---|---|---|
 * | qoder | 8 张过 / 15 张 `TRANSPORT` | ≈57 MiB |
 * | lobsterai | 12 张过 / 13 张 `SERVER 500` | ≈50 MiB |
 * | cline | 24 张过 / 32 张 `TRANSPORT` | ≈122 MiB |
 *
 * 取 1 MiB 后每张 base64 后 ≈1.33 MiB：qoder 与 lobsterai 即使攒到 24 张
 * 也只有 ≈32 MiB，**远低于**它们各自的实测边界；而 1 MiB 对 1011×632 的
 * 缩放图来说相当宽松（附件服务只在超出目标时才降质量阶梯），
 * 所以"缩放的代价"几乎全落在像素上、不额外落在字节上。
 *
 * ⚠️ 与 raccoon 的 512 KB **不同值是有意的**：那家硬限 10 MB，
 * 1 MiB 目标下 10 张就到 13 MB 会照样 413。别合并成一个常量。
 */
export const DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES = 1024 * 1024

/**
 * 单张请求图片的默认像素预算：**640,000 px**（约合 1050×610）。
 *
 * 取值依据（issue !IKITT9 的失败点反推）：
 * 网关按 ≈ **617 px / 视觉 token** 计价（1721×997 = 1,716,237 px ≈ 2,781 token），
 * 于是 640,000 px ≈ **1,037 token/张** → 10 万 token 的预算约能容纳 **96 张**
 * （原先 36 张就顶穿了）。留出这个余量是因为截图张数在 agent 会话里
 * 会不受控地增长，而顶穿的后果是**整个会话报废**。
 *
 * ⚠️ 不要把它调得过小：UI 小字、终端输出这类截图全靠像素辨认，
 * 作者明确要求「1050×610 上 UI 小字仍可辨认」的档位。
 */
export const DEFAULT_IMAGE_PIXEL_BUDGET = 640_000

/**
 * 按「总像素预算」把尺寸缩小到预算内，保持宽高比、**绝不放大**。
 *
 * 与 `@deepseek-ai/dsh-attachment` 导出的纯函数 `requestImageDimensions`
 * 同语义（那边也是 `maxPixels` 总面积口径），因此换成 harness 的路由不会产生
 * 第二种几何。
 *
 * @returns 目标尺寸；输入非法（非有限正数）时返回 `undefined`，
 *          调用方据此**回退原图**而不是发一个坏请求。
 */
export function fitImageToPixelBudget(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } | undefined {
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) return undefined
  if (!isPositiveFinite(maxPixels)) return undefined
  // 小图原样发送：缩放只会让文字更糊，且没有任何预算压力需要它让。
  if (width * height <= maxPixels) return { width: Math.floor(width), height: Math.floor(height) }
  // 面积按 scale² 变化 → 线性缩放因子取 sqrt，等比缩小到预算内。
  const scale = Math.sqrt(maxPixels / (width * height))
  const targetWidth = Math.max(1, Math.floor(width * scale))
  const targetHeight = Math.max(1, Math.floor(height * scale))
  return { width: targetWidth, height: targetHeight }
}

/**
 * 派生一张图片的请求目标。
 *
 * @param width / height 附件引用里的**固有尺寸**（`ImageAttachmentRef` 必有）。
 * @param maxPixels 像素预算；`undefined` 表示产品未配置（用默认档）。
 * @param maxBytes 编码字节目标；`undefined` 用 `REQUEST_IMAGE_MAX_BYTES`。
 *   ⚠️ 这条是给**按请求体字节**设限的网关准备的（raccoon 实测
 *   `HTTP_413 request body exceeds 10MB`）—— 那种约束下光缩像素不够，
 *   必须同时压字节目标，否则一张高分辨率但低压缩率的图就能吃掉大半配额。
 */
export function requestImageTargetFor(
  width: number,
  height: number,
  maxPixels: number | undefined,
  maxBytes: number | undefined = REQUEST_IMAGE_MAX_BYTES,
): ImageRequestTarget | undefined {
  const fitted = fitImageToPixelBudget(width, height, maxPixels ?? DEFAULT_IMAGE_PIXEL_BUDGET)
  if (fitted === undefined) return undefined
  return { width: fitted.width, height: fitted.height, maxBytes: maxBytes ?? REQUEST_IMAGE_MAX_BYTES }
}

/**
 * 返回 `undefined` 表示**本次发原图**，四种情形都属正常而非错误：
 *
 * 1. 调用方没桥接 `readImageRequest`（老宿主 / 其它入口构造的适配器）；
 * 2. 附件引用里没有可用的固有尺寸 —— 没尺寸就算不出目标，
 *    绝不能瞎猜一个把图缩坏；
 * 3. 桥接层按契约吞掉异常返回 `undefined`（服务没装、拒绝投影…）；
 * 4. 桥接层**没吞**异常 —— 由下面的 `try/catch` 兜住。缩放是优化，
 *    不能因为"想缩图"把一次本来能成功的请求打死。
 *    （记日志的责任在桥接层，本函数只保证回退方向正确。）
 */
export async function projectRequestImage(
  attachment: unknown,
  options: {
    readImageRequest: ((
      attachment: unknown,
      target: ImageRequestTarget,
    ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>) | undefined
    pixelBudget?: number
    maxBytes?: number
  },
): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
  const readImageRequest = options.readImageRequest
  if (readImageRequest === undefined) return undefined
  const { width, height } = attachment as { width?: unknown, height?: unknown }
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  const target = requestImageTargetFor(width, height, options.pixelBudget, options.maxBytes)
  if (target === undefined) return undefined
  try {
    return await readImageRequest(attachment, target)
  } catch {
    return undefined
  }
}

function isPositiveFinite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
