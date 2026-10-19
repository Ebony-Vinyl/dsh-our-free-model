/**
 * 签名请求的直发出网通道：不经过 `globalThis.fetch`。
 *
 * ## 为什么必须有它（issue #344 / #444）
 *
 * CodeArts 走 SDK-HMAC-SHA256，签名覆盖 `sha256(body)`（见 `sign.ts` 的
 * `buildCanonicalRequest`）：请求体字节一变，服务端验签必然失败。
 *
 * 会改写出站请求的本地代理插件（billion-context / bili 等）做的第一件事就是替换
 * `globalThis.fetch`，把 body 重新序列化后再发。对签名流量而言这不是「压缩」而是
 * 「篡改」——实测本机（bili 0.1.201）它的原生拦截会直接在本进程内返回
 * `403 signed_request_requires_resign` / `bili_resign_unavailable`，而适配器把
 * 401/403 一律读成凭据问题（`isAuthError` / `httpErrorCode` → `AUTH`），宿主于是
 * 渲染成「API 密钥无效」——凭据其实完全有效。
 *
 * `globalThis.fetch` 可以被同进程的任何插件替换，`undici` 的命名导出不能：那是本
 * 包自己的一份副本（`undici` 是 devDependency，被
 * `scripts/build-channel-pack.mjs` 内联进 `pack.js`），不与宿主的全局名共享。
 * 因此签名字节从本模块出网时，没有任何第三方能看见或改写它。
 *
 * EAC 车道早已按同一思路处理（`src/eac.js` 的 `laneFetch`，见其注释引用的
 * issue #50，那边用 `node:https` 是因为它在宿主半侧、不参与打包）；本模块在渠道包
 * 内部，内联的 `undici` 是现成的一份实现，不必再写一遍 `node:http` 适配。
 *
 * ## 出网路由不变
 *
 * 默认是**直连**，与改造前 `options.fetchImpl ?? fetch` 的实际行为一致：
 * `globalThis.fetch` 本身不读 `HTTPS_PROXY`，渠道包的代理路由只在
 * `createChannelFetch` 里逐请求加 `dispatcher`，CodeArts 从未接入那条路
 * （`src/index.ts` 里其余十二个渠道都显式传 `fetchImpl: network.fetch`，CodeArts
 * 是唯一漏掉的）。本模块不改变已发出的目标地址与代理策略，只改变「谁能改写它」。
 *
 * 需要换出网方式时仍由调用方注入 `fetchImpl`，注入值优先。
 */
import { fetch as undiciFetch } from 'undici'

/**
 * 测试缝：置入一个 fetch 即替换默认实现，用于离线断言「请求确实没经过
 * `globalThis.fetch`」（与 `src/eac.js` 的 `lane` 同款）。生产路径不写入它；
 * 离线套件用它把 CodeArts 出网钉在本进程的桩上，并保证结束时置回。
 */
export const directLane: { fetch: typeof fetch | null } = { fetch: null }

/**
 * undici 的 `fetch` 与 DOM 的 `typeof fetch` 在 `dispatcher` 等扩展字段上的
 * 类型不完全同构；运行时两者都返回 WHATWG `Response`，适配器读取的
 * `status`/`ok`/`text()`/`body.getReader()` 行为一致。
 */
type UndiciFetch = typeof undiciFetch

/** 直发 fetch：测试缝优先，否则用打包内联的 undici。 */
export const directFetch: typeof fetch = (input, init) => {
  const implementation = directLane.fetch
  if (implementation !== null) return implementation(input, init)
  return undiciFetch(
    input as Parameters<UndiciFetch>[0],
    init as Parameters<UndiciFetch>[1],
  ) as unknown as Promise<Response>
}
