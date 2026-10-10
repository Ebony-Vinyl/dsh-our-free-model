/**
 * 渠道包「模型目录可见性总开关」。
 *
 * ## 为什么需要它
 *
 * 渠道包（`vendor/channel-pack/pack.js`）的 13 个 provider 会各自向 DSH 的模型
 * 选择器贡献一个分组。用户只想保留自己在 profile 里配置的那十几个 provider，
 * 于是希望一次性把这些渠道分组收起来。
 *
 * 渠道包自己已有一条门控 `providerCatalogVisible()`（`src/account-pool.ts`）：
 * 适配器 `listModels()` 的第一行调用它，返回 `false` 就返回 `[]`，而
 * `dsh-api-session-controller` 的 `buildModelCatalog()` 会
 * `.filter(group => group.models.length > 0)` —— **空数组即整组消失**。
 *
 * 但那条门控按「是否已登录账号」判定，**只要有一个可解析凭据就放行**。用户机器
 * 上 13 个 provider 全都有账号，因此它对收拢分组完全无效；而「逐模型关闭」也不
 * 可靠：远端目录会持续新增模型，黑名单追不上（实测 Loomy 的 8 个模型全被关掉、
 * 分组却仍在，因为远端还有黑名单里没有的模型）。
 *
 * ## 做法
 *
 * 不改 2.8MB 的 `pack.js`（它标注了「do not edit」，且无法逐字节重现构建）。
 * 渠道包在 `apply()` 末尾用 `ctx.provide('accountPool', pool)` 暴露账号池，而
 * 每个适配器持有的正是**同一个对象**（`this.options.accountPool`）。因此在
 * `pack.apply()` 返回后包裹该对象的 `hasLoggedInAccount` 即可 —— 适配器每次
 * `listModels()` 都会重新调用它，包裹立即生效，且开关状态**每次调用现读**，
 * 不在安装时定格。
 *
 * ## 边界（务必保持）
 *
 * - **只影响目录展示，不影响路由**：`hasLoggedInAccount` 的唯一调用点就是那条
 *   展示门控；`resolveModel()` / `resolveModelInfo()` 都不经过它，而网关的请求
 *   路径只走 `resolveModelInfo()`。被隐藏的模型仍能正常收发。
 * - **`listAllModels()` 不受影响**：渠道包设置页的「显示列表」「关闭全部」读的是
 *   它（它有意绕过黑名单），必须保持原样，否则用户无法再打开被关掉的模型。
 * - **失败即放行**：账号池缺失、未实现该方法、或包裹过程抛错时一律视为「未安装」，
 *   宁可多显示也不让整组模型凭空消失（与上游门控同一取向）。
 */

/** `providerCatalogVisible()` 读取的开关：缺省即开启，只有显式假值才关闭。 */
const HIDE_FLAG = 'DSH_HIDE_MODELS_WITHOUT_ACCOUNT'

/** 与上游 `resolveHideWithoutAccountFlag()` 一致的假值集合。 */
const FALSEY = new Set(['0', 'false', 'no', 'off'])

/** 上游 `resolveHideWithoutAccountFlag()` 的等价实现，用于还原用户原本的取值。 */
function flagEnabled(raw) {
  if (raw === undefined) return true
  return !FALSEY.has(String(raw).trim().toLowerCase())
}

/**
 * 把账号池的门控换成「总开关」驱动。
 *
 * @param pool 渠道包暴露的账号池（`ctx.get('accountPool')`）。
 * @param options.shouldHide 每次判定现读的回调：`true` = 隐藏全部渠道分组。
 * @returns `{ installed, sync }`；`installed: false` 表示未接管（调用方无需处理）。
 */
export function installChannelCatalogVisibility(pool, { shouldHide } = {}) {
  // 能力检测：与上游门控一致，替身/无账号池时静默放行。
  if (!pool || typeof pool.hasLoggedInAccount !== 'function') {
    return { installed: false, sync() {} }
  }
  const shouldHideNow = typeof shouldHide === 'function' ? shouldHide : () => false

  const original = pool.hasLoggedInAccount
  // 记录用户自己的环境变量取值，关闭总开关时原样还回去（可能是 undefined）。
  const originalFlag = process.env[HIDE_FLAG]
  let hiding = null

  const applyFlag = hide => {
    if (hide) process.env[HIDE_FLAG] = '1'
    else if (originalFlag === undefined) delete process.env[HIDE_FLAG]
    else process.env[HIDE_FLAG] = originalFlag
  }

  // 只包裹一次：热重载会重新 apply，重复包裹会层层叠加。
  if (pool[Symbol.for('our-free-model.catalog-visibility')] !== true) {
    try {
      pool.hasLoggedInAccount = async function hasLoggedInAccount(provider) {
        // 现读开关：适配器构造时捕获的是账号池对象，开关变化无需重装。
        try {
          if (shouldHideNow()) return false
        } catch {
          // 读开关异常时退回上游判定，绝不因为一次抖动隐藏整组。
        }
        return await original.call(this, provider)
      }
      Object.defineProperty(pool, Symbol.for('our-free-model.catalog-visibility'), {
        value: true, enumerable: false, configurable: true,
      })
    } catch {
      return { installed: false, sync() {} }
    }
  }

  /** 让环境变量与当前开关一致；上游门控先读它，必须由总开关说了算。 */
  const sync = () => {
    let hide = false
    try { hide = shouldHideNow() === true } catch { hide = false }
    if (hide === hiding) return
    hiding = hide
    applyFlag(hide)
  }

  sync()
  return { installed: true, sync }
}
