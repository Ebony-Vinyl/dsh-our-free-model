/**
 * ZCode 的阿里云 captcha 产出（**唯一还需要浏览器的环节，但只服务 claim 路径**）。
 *
 * ## 谁还要 captcha（2026-10-01 直连上游实测，别再凭印象改）
 *
 * | 端点 | 不带验证头 | 结论 |
 * |---|---|---|
 * | `/api/v1/zcode-plan/anthropic`（**模型请求**） | **HTTP 200**（6 个采样点） | **自 3.14.4（2026-09-29）起不再索要** |
 * | `/api/v1/zcode-plan/billing/claim`（**领取**） | `400 {"code":3007}` | **始终索要**，且校验**前置于** plan 校验 |
 *
 * ⇒ 模型请求这条路现在**恒不产** param（`src/captcha-requirement.ts` 的
 * 「先探后取」使 mint 次数归零）；仍在产的是**领取**（每日一次 / 手动点「一键领取」，
 * **每个 plan 独立一个**，一次性，复用必 `3007`）。
 * ⚠ 模型请求侧的 `3007` 防御分支**故意保留**：万一上游回滚再开校验，推理请求仍能自愈，
 * 而不是把失败抛给用户。
 *
 * ## 载体：web 版必需浏览器，桌面版可用内部载体
 * captcha 是**网页 SDK**（`o.alicdn.com/.../AliyunCaptcha.js`），任何有 DOM 能跑 JS 的
 * 浏览器都能产。本文件这套外挂 chromium 路径是 **web 版的必需项**；
 * DSH Desktop 下会优先用**桌面自己的 Electron 内核**（`dshDesktop.browser` 租约 +
 * 隐藏 `<webview>` + `executeJavaScript`，见 `src/captcha-carrier.ts`），
 * 本文件退为其**兜底**（`DSH_ZCODE_INTERNAL_CARRIER=0` 可强制只用它）。
 *
 * ## 为什么能用普通浏览器而不是 ZCode 那个壳
 *
 * captcha 是**网页 SDK**，不是 Electron 专有 API：
 *
 * ```
 * script:  https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
 * config:  window.AliyunCaptchaConfig = { region, prefix }
 * 调用:    initAliyunCaptcha({ SceneId, mode, element, button, getInstance, success, … })
 * 取参:    getInstance 里调 instance.startTracelessVerification()（无感验证）
 *          → success(param) 回调给出 param
 * ```
 *
 * 故任何「有 DOM + canvas + 能跑 JS」的浏览器都行。实测
 * **scoop 的 chromium（headful + 基本 stealth 补丁）** 可稳定产出。
 *
 * ## ⚠ 两个实测得到的约束（第 1 条后来**被推翻**，结论以第 2 条为准）
 *
 * ### 1. ~~同一个页面**不能**重复 mint~~ → **已推翻**（当时页面停在 `about:blank`）
 *
 * 同一 page 上连续 `initAliyunCaptcha` 三次的实测结果：
 *
 * | 次序 | 结果 | 耗时 |
 * |---|---|---|
 * | #1 | ✓ len=280 | 817ms |
 * | #2 | ✗ `F001` | 279ms |
 * | #3 | ✗ `F001` | 296ms |
 *
 * ⇒ SDK 实例状态在页面内不可重复初始化。**每次 mint 必须新建 page target**。
 * 采用该策略后实测 **4/4 成功，中位 1246ms**（浏览器冷启动仅 690ms）。
 *
 * ⚠⚠ **上面那两行是当时的结论，现在别再照着做**：真正的变量是页面 origin ——
 * 那三次是在 `about:blank`（origin 为字符串 `"null"`）上跑的。换到真实
 * `https://zcode.z.ai/` 后同一页面可**连续 mint 5/5**，中位 426ms / 平均 546ms，
 * 现行实现因此**复用常驻页面 + 每次重置 DOM**。证据与推理见
 * {@link CAPTCHA_PAGE_ORIGIN}；上面的表保留仅作原始记录（改回去会让耗时翻 2.3 倍）。
 *
 * ### 2. `--headless=new` 过不了，必须 **headful**
 *
 * | 模式 | 结果 |
 * |---|---|
 * | `--headless=new`（+ 补丁） | ✗ `fail` / `verifyCode: F001` |
 * | **headful + 补丁** | ✓ 280 字符合法 param |
 *
 * 阿里云风控会看这个差异。headful 在 Windows 上可以**不打扰用户**
 * （`--window-position=-32000,-32000` 移出屏幕）。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, posix } from 'node:path'

/** 阿里云 captcha 配置（服务端下发；此处为实测兜底值）。 */
export interface ZcodeCaptchaConfig {
  /** 区域：`cn`。 */
  region: string
  /** 前缀：决定请求走到哪个阿里云子域。 */
  prefix: string
  /** 场景 id。 */
  sceneId: string
}

/**
 * 兜底 captcha 配置。
 *
 * ⚠ 这些值**实测自本机账号**（`GET /api/v1/client/configs?platform=unknown`
 * 的 `data.configs.captcha`）。理论上可能随账号/灰度变化，故
 * `ZcodeAuth.fetchCaptchaConfig()` 会优先向服务端索取，此处仅作兜底。
 */
export const ZCODE_CAPTCHA_FALLBACK: ZcodeCaptchaConfig = {
  region: 'cn',
  prefix: 'no8xfe',
  sceneId: '11xygtvd',
}

/** 阿里云 captcha SDK 地址（与官方逐字一致）。 */
export const ALIYUN_CAPTCHA_SDK_URL =
  'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'

/** SDK 需要的 DOM 宿主 id（与官方 `zcode-aliyun-captcha-*` 一致）。 */
export const CAPTCHA_CONTAINER_ID = 'zcode-aliyun-captcha-container'
/** 挂载点 id。 */
export const CAPTCHA_ELEMENT_ID = 'zcode-aliyun-captcha-element'
/** 按钮 id。 */
export const CAPTCHA_BUTTON_ID = 'zcode-aliyun-captcha-button'

/**
 * captcha 页面必须导航到的**真实 origin**。
 *
 * ⚠⚠ **这是能否重复 mint 的关键**（实测矩阵）：
 *
 * | origin | 同一页面连续 mint |
 * |---|---|
 * | `about:blank` | **1/3**（#2 起 `F001`） |
 * | **`https://zcode.z.ai/`** | **5/5，平均 546ms** |
 *
 * 阿里云 SDK 会读 `location.origin` 参与风控判定，而 `about:blank` 的
 * origin 是字符串 `"null"` —— 于是第二次起被拒。
 *
 * ⚠ 这一条此前被**误判**成「同一页面不能重复 mint，必须每次新建 page」，
 * 导致实现多付了 2.3 倍的耗时（1246ms → 546ms）。
 * 结论修正的代价是：**改一个变量、看结果**比堆假设更快。
 */
export const CAPTCHA_PAGE_ORIGIN = 'https://zcode.z.ai/'

/**
 * 解析**载体页 origin**：注入值优先，空白/缺省一律回落实测常量。
 *
 * ## 为什么存在（以及它为什么**不是**配置项）
 * 唯一的用途是让本地探针 `scripts/probe-captcha-local-origin.mjs`（不入库）能验证
 * 「在 `http://127.0.0.1:<port>` 这种本地 origin 上，阿里云 SDK 到底产不产得出合法
 * param」—— 那是「DSH web 版能否用用户浏览器当载体」这条路线的唯一准入问题
 * （跨域 iframe 拿不到 DOM、浏览器也不给页面 CDP 权，所以载体页只能是 GUI 自己的 origin）。
 *
 * ⚠ **不许**把它接到 env / settings / UI：真实 https origin 是实测硬前提
 * （`about:blank` 的 origin 是 `"null"`，第二次 mint 必 `F001`）。
 * 默认值与空白回退由 `tests/unit/zcode-captcha-origin.spec.ts` 锁死。
 *
 * ⚠ 空白也算回落：注入空串会让导航变成 `about:blank`（即上面那条已知失败形态）。
 */
export function resolveCaptchaPageOrigin(
  options: { pageOrigin?: string } = {},
): string {
  const injected = options.pageOrigin?.trim() ?? ''
  return injected.length > 0 ? injected : CAPTCHA_PAGE_ORIGIN
}

/**
 * captcha param 的合法判据（与桥侧 `isUsableCaptchaParam` 同一套）。
 *
 * 三条全中才算合法：
 * 1. 长度 ≥ **200**（实测合法值 280；降级垃圾约 76）
 * 2. 是 base64 且能解出 JSON
 * 3. 含 `securityToken` 且长度 ≥ **50**（实测合法值 128）
 *
 * 任一条不中即判为降级 —— **不发请求**：在索要验证的窗口里那发注定 `3007`；
 * 即便上游此刻不校验这个头，把降级产物发出去也不是「成功」，故本地判据不放宽。
 */
export function validateCaptchaParam(param: unknown): { ok: boolean; reason?: string } {
  if (typeof param !== 'string' || param.length === 0) {
    return { ok: false, reason: 'captcha param 缺失' }
  }
  if (param.length < 200) {
    return {
      ok: false,
      reason: `captcha param 长度 ${param.length} < 200（疑似 SDK 降级输出，发了必 3007）`,
    }
  }
  let decoded: string
  try {
    decoded = Buffer.from(param, 'base64').toString('utf8')
  } catch {
    return { ok: false, reason: 'captcha param 不是合法 base64' }
  }
  let parsed: { securityToken?: unknown; certifyId?: unknown }
  try {
    parsed = JSON.parse(decoded) as typeof parsed
  } catch {
    return { ok: false, reason: 'captcha param 解出的不是 JSON' }
  }
  if (typeof parsed.certifyId !== 'string' || parsed.certifyId.length === 0) {
    return { ok: false, reason: 'captcha param 缺 certifyId' }
  }
  const token = parsed.securityToken
  if (typeof token !== 'string' || token.length < 50) {
    return {
      ok: false,
      reason: `securityToken 缺失或过短（${typeof token === 'string' ? token.length : 0} < 50）`,
    }
  }
  return { ok: true }
}

/**
 * macOS 的 app bundle → `Contents/MacOS/` 下的可执行文件名。
 *
 * ⚠️ **顺序即优先级**：Chrome → Chromium → Edge → Brave，与 Windows 候选链
 * （Chrome → Chromium → Edge）**同序**追加 —— 别把 Edge/Brave 提到 Chrome 前面
 * （同 {@link browserCandidates} 的 ①②③ 编号口径）。
 * ⚠️ `Microsoft Edge` / `Brave Browser` **不带扩展名**：macOS 的 app bundle
 * 内部就是这个名字，与 Windows 的 `msedge.exe` / `brave.exe` 不同。
 */
const MAC_BROWSER_BUNDLES: ReadonlyArray<readonly [bundle: string, exe: string]> = [
  ['Google Chrome.app', 'Google Chrome'],
  ['Chromium.app', 'Chromium'],
  ['Microsoft Edge.app', 'Microsoft Edge'],
  ['Brave Browser.app', 'Brave Browser'],
]

/** Windows 候选链（逐字保留自重构前，⚠️ 改这里等于动本仓库绝大多数用户）。 */
function windowsBrowserCandidates(
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  const localAppData = env.LOCALAPPDATA ?? ''
  const programFiles = env.PROGRAMFILES ?? ''
  const programFilesX86 = env['PROGRAMFILES(X86)'] ?? ''
  return [
    /**
     * ① scoop 的 **显式声明的**根目录优先于默认推导。
     *
     * `SCOOP` / `SCOOP_GLOBAL` 是 scoop 自己的「我装在哪」的权威声明 ——
     * 用户设了它们就说明默认路径不对。若排在 `~/scoop` 之后，会出现
     * 「旧默认路径恰好存在 → 用它，而用户实际在用的那个被忽略」。
     */
    ...(env.SCOOP !== undefined && env.SCOOP.trim().length > 0
      ? [join(env.SCOOP.trim(), 'apps', 'chromium', 'current', 'chrome.exe')]
      : []),
    ...(env.SCOOP_GLOBAL !== undefined && env.SCOOP_GLOBAL.trim().length > 0
      ? [join(env.SCOOP_GLOBAL.trim(), 'apps', 'chromium', 'current', 'chrome.exe')]
      : []),
    // ② scoop 默认根目录（`~/scoop`）。实测可用。
    join(home, 'scoop', 'apps', 'chromium', 'current', 'chrome.exe'),
    // ③ 系统 Chrome。
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    // ④ Chromium。
    join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    // ⑤ Edge（Chromium 内核，系统普遍自带）。
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
}

/**
 * macOS 候选链：每个浏览器先找 `/Applications`，再找 `~/Applications`
 * （Mac 上把 app 拖进「应用程序」文件夹会装到后者，而**两者都是常规位置**）。
 *
 * ⚠⚠ **必须用 `posix.join`，不能用 `join`**（真实缺陷，2026-10-03，Gitee issue IKJKNT）。
 *
 * `join` 按**宿主**平台选分隔符：本仓库的 CI 与绝大多数开发机是 Windows，
 * 在那里执行本函数会拼出 `/Applications\Google Chrome.app\Contents\MacOS\…`
 * —— 在真机 macOS 上完全正常（那里 `join` 就是 `posix.join`），
 * 但这意味着**整条 darwin 分支在 Windows 上不可测、CI 永远测不到**。
 * 显式 `posix.join` 与 mac 上的行为逐字一致，同时让本分支可被单测锁死。
 * 回归用例见 `tests/unit/zcode-browser-macos.spec.ts` 的「一个反斜杠都没有」。
 */
function macBrowserCandidates(home: string): string[] {
  const roots = ['/Applications', posix.join(home, 'Applications')]
  const candidates: string[] = []
  for (const [bundle, exe] of MAC_BROWSER_BUNDLES) {
    for (const root of roots) {
      candidates.push(posix.join(root, bundle, 'Contents', 'MacOS', exe))
    }
  }
  return candidates
}

/**
 * Linux 候选链。
 *
 * ## ⚠️ 签名里**刻意没有 `env`** —— 这是对报障人建议的一处**结构性**修正
 *
 * Gitee issue IKJKNT 的报障人在评论里给了实现建议，其中写了
 * `const env = process.env` —— 那会让函数**忽略注入的 `env`**，
 * linux 分支在 Windows CI 上就不可测、永远静默通过。
 * 那正是 {@link macBrowserCandidates} 存在的同一条理由（只是它用 `posix.join` 躲掉了）。
 * 这里**连参数都不给** ⇒ 结构上不可能误读进程环境。
 *
 * ⚠️ **`ZCODE_CHROME_PATH` 本函数不得处理**：{@link browserCandidates} 已统一
 * `unshift`，平台分支再处理一次会出现重复候选。
 *
 * ## ⚠️ flatpak 只能用 `exports/bin/`，**不是 `appstream/`**
 *
 * 报障人建议里写的是 `…/flatpak/appstream/org.chromium.Chromium` —— 那是
 * **AppStream 元数据目录**，不是可执行文件。而 {@link findBrowserExecutable}
 * 的判据只有 `existsSync`（**不做「能不能执行」**），列了它就会
 * 「探测成功 → spawn 时 EACCES」，**比不列更糟**。
 * 反例锁在 `tests/unit/zcode-browser-linux.spec.ts`。
 */
function linuxBrowserCandidates(home: string): string[] {
  return [
    // ① Chrome（`google-chrome` 与 `google-chrome-stable` 是两个包名）。
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    // ② Chromium（Debian/Ubuntu 的 `chromium`、`chromium-browser`；snap 版）。
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // ③ Edge（微软的 Linux 包）。
    '/usr/bin/microsoft-edge',
    // ④ Brave（chromium 内核）。
    '/usr/bin/brave-browser',
    // ⑤ flatpak 导出的**可执行文件**（见函数头关于 appstream 的警告）。
    posix.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.chromium.Chromium'),
  ]
}

/**
 * 浏览器可执行文件的**候选链**（按优先级，`ZCODE_CHROME_PATH` 恒排第一）。
 *
 * ## 为什么抽成**纯函数**
 *
 * 候选链按平台分叉后，**macOS / Linux 分支在本仓库的 Windows CI 上一次都执行不到** ——
 * 直接写在 `findBrowserExecutable()` 里，这些路径会永远「静默通过」，
 * 直到用户报障（IKJKNT 就是 macOS 的 macOS 那条的先例）。
 * 抽出来后它们是纯字符串计算，可在任何平台断言。
 *
 * 三个入参都可注入，正是为了这个：`platform` 定分支、`env` 造 scoop /
 * `ZCODE_CHROME_PATH`、`home` 造 `~/Applications` 与 `~/.local/share/flatpak`。
 *
 * ## ⚠⚠ **`else` 分支是 Windows —— 别把它当「非 Win 也走这儿」
 *
 * 三个平台的分支必须**显式**列全。历史上 `linux` 落在 else 里拼出一套
 * `PROGRAMFILES` / `msedge.exe`（Linux 上全不存在 ⇒ 恒找不到浏览器），
 * 与 macOS 那条**完全同型**。**新增平台时务必在这里加一条显式分支。**
 *
 * ## ⚠ 两个必须防的坑（都实测踩过）
 *
 * ### 1. 空环境变量会产生**相对路径**
 *
 * `join('', 'Google', 'Chrome', …)` 返回 `Google\Chrome\…` —— 一个**相对路径**，
 * `existsSync` 会相对**当前工作目录**解析。于是「当前目录下恰好有个同名文件」
 * 会被误判成浏览器，而真正的浏览器却找不到。
 *
 * ⇒ {@link findBrowserExecutable} 只接受**绝对路径**候选（`isAbsolute` 过滤）。
 *
 * ### 2. `USERPROFILE` 不等于家目录
 *
 * scoop 的安装位置在 `~/.scoop` 或 `~/scoop` 下，而 `~` 应当用
 * `os.homedir()` 求（它还会看 `HOME`，且在 `USERPROFILE` 被改写时仍正确）。
 * 用 `process.env.USERPROFILE` 拼路径会在「环境变量异常/被沙箱改写」时失效 ——
 * 实测：把 `USERPROFILE` 指到沙箱后，原本可用的 scoop chromium 就找不到了。
 */
export function browserCandidates(
  input: {
    platform?: NodeJS.Platform
    env?: Record<string, string | undefined>
    home?: string
  } = {},
): string[] {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  let candidates: string[]
  if (platform === 'darwin') {
    candidates = macBrowserCandidates(home)
  } else if (platform === 'linux') {
    candidates = linuxBrowserCandidates(home)
  } else {
    candidates = windowsBrowserCandidates(env, home)
  }
  const override = env.ZCODE_CHROME_PATH
  if (typeof override === 'string' && override.trim().length > 0) {
    candidates.unshift(override.trim())
  }
  return candidates
}

/** 在候选链里挑第一个**存在**的绝对路径。 */
export function findBrowserExecutable(): string | undefined {
  for (const candidate of browserCandidates()) {
    try {
      /**
       * ⚠ 只接受**绝对路径**：空环境变量产生的相对路径会相对 CWD 解析，
       * 可能误匹配同名本地文件（见 {@link browserCandidates} 的坑 1）。
       */
      if (candidate.length === 0 || !isAbsolute(candidate)) continue
      if (existsSync(candidate)) return candidate
    } catch {
      // 试下一个。
    }
  }
  return undefined
}

/**
 * 找不到浏览器时的**用户可执行提示**（按平台说人话）。
 *
 * ## 为什么必须分平台（Gitee issue IKJKNT）
 *
 * 修复前是单一口径：「已尝试 scoop chromium / Chrome / Chromium / Edge；
 * 可用 ZCODE_CHROME_PATH 显式指定 **chrome.exe** 路径。」
 * —— macOS 上 **scoop 根本不存在**、`chrome.exe` 也不是那个文件名
 * （见 {@link MAC_BROWSER_BUNDLES}），用户照着提示做只会更懵。
 * 回归用例见 `tests/unit/zcode-browser-macos.spec.ts`。
 */
export function browserNotFoundMessage(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return '已尝试 /Applications 与 ~/Applications 下的 Google Chrome / Chromium / Microsoft Edge / Brave；' +
      '可用 ZCODE_CHROME_PATH 显式指定可执行文件路径' +
      '（如 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome）。'
  }
  if (platform === 'win32') {
    return '已尝试 scoop chromium / Chrome / Chromium / Edge；' +
      '可用 ZCODE_CHROME_PATH 显式指定 chrome.exe 路径。'
  }
  if (platform === 'linux') {
    return '已尝试 /usr/bin 下的 google-chrome / chromium / microsoft-edge / brave-browser' +
      '（含 /opt/google/chrome、/snap/bin 与 flatpak 导出位置）；' +
      '可用 ZCODE_CHROME_PATH 显式指定可执行文件路径（如 /usr/bin/chromium）。'
  }
  return '已尝试 Chrome / Chromium / Edge 的常见安装位置；' +
    '可用 ZCODE_CHROME_PATH 显式指定可执行文件路径。'
}

/**
 * 该可执行文件是否是**系统 Edge**（候选链的最后几档）。
 *
 * ## 为什么单独抽成纯函数
 * 「实际用了哪个浏览器」需要被**告警**（issue IKJLB1 的期望行为 2：
 * 用户不知道系统在拿 Edge 兜底）。告警条件必须可测，故不留在 `launch()` 里。
 *
 * ⚠️ 判据是**文件名**（不区分大小写），而不是路径里搜 `Edge`：
 * 前者对 `…\Microsoft\Edge\Application\msedge.exe`、scoop 布局、
 * macOS 的 `…/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` 以及
 * 用户经 `ZCODE_CHROME_PATH` 指向的 Edge 副本都成立；
 * 后者会把路径中恰好含 "Edge" 字样的第三方 chromium 误报成系统 Edge。
 *
 * ⚠⚠ **macOS 那个名字是同型缺陷的修复**（2026-10-03，issue IKJKNT）：
 * 原判据只认 `msedge.exe`，而 macOS 包内二进制叫 **`Microsoft Edge`**
 * （无扩展名）⇒ Mac 用户落到 Edge 兜底时**一声不吭**，与 IKJLB1
 * 的期望行为 2 直接冲突。补这个别名时别把判据改成 `includes('edge')`
 * —— 那会把 `Brave Browser` 之类的路径误伤。
 */
export function isEdgeExecutable(executable: string): boolean {
  const name = basename(executable).toLowerCase()
  return name === 'msedge.exe' || name === 'microsoft edge'
}

/** 极简 CDP 客户端（用 Node 内置 WebSocket，**零第三方依赖**）。 */
class CdpConnection {
  private nextId = 0
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event: MessageEvent) => {
      let message: { id?: number; error?: unknown; result?: unknown }
      try {
        message = JSON.parse(String(event.data)) as typeof message
      } catch {
        return
      }
      if (message.id === undefined) return
      const slot = this.pending.get(message.id)
      if (slot === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) slot.reject(new Error(JSON.stringify(message.error)))
      else slot.resolve(message.result)
    })
  }

  /** 发送一条 CDP 命令并等结果。 */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
        }
      }, timeoutMs)
      timer.unref?.()
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // 已关闭。
    }
  }
}

/**
 * 反检测补丁。
 *
 * ⚠ 必须用 `Page.addScriptToEvaluateOnNewDocument` 装 —— 那样它在
 * **每个新文档**上都先于页面脚本执行。只 evaluate 一次不行：
 * 每次 mint 都是新页面（见文件头说明）。
 */
const STEALTH_PATCH = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
Object.defineProperty(navigator, 'plugins', {
  get: () => [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }, { name: 'Chromium PDF Viewer' }],
});
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
window.chrome = window.chrome ?? { runtime: {}, loadTimes: () => {}, csi: () => {} };
try {
  const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return originalGetParameter.call(this, parameter);
  };
} catch (error) { /* 内核无 WebGL 时忽略 */ }
`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/**
 * 构造请求体里那段「建 DOM + 注入 SDK」的表达式。
 *
 * ## ⚠⚠ 这里的 DOM 重置与下面的 SDK 注入**必须配对**（真实缺陷，2026-10-01）
 *
 * 本函数把 `document.body.innerHTML` **整体替换** —— 于是旧的
 * `#captcha-element` / `#captcha-button` 元素**被销毁**。
 *
 * 而 `buildSdkInjectExpression()` 原本在「SDK 已加载」时**早退**（返回
 * `'already'`），**不重建 SDK 实例**。两者叠加的后果：
 *
 * ```
 * 第 1 次 mint：注入 SDK → initAliyunCaptcha 绑定 #captcha-element → ✓ 成功
 * 第 2 次 mint：DOM 被替换（旧元素销毁）→ SDK 早退（实例仍指向旧元素）
 *              → 用失配的实例发起验证 → ✗ F001
 * ```
 *
 * **实测取证**（同一页面、跨轮、每次先空闲 20 秒）：
 *
 * | 场景 | `inject` 返回 | 结果 |
 * |---|---|---|
 * | 页面未重新导航（SDK 已加载 ⇒ 早退） | `already` | ✗ **F001** ×3（471/454/591ms） |
 * | 每轮重新导航（SDK 全新加载） | `function` | ✓ 成功 ×2（755/670ms） |
 *
 * ⇒ **`F001` 与"空闲时长"无关** —— 真正的变量是「DOM 是否被重置而 SDK 未重建」。
 * 这一条纠正了 2026-09-29 的误判（当时把现象归给空闲，并据此加了
 * 「空闲 8 秒就换页」的预测式重建，白付约 2.7 秒/次）。
 *
 * ⚠ 与之配套的修法在 {@link buildSdkInitExpression}：**DOM 重建后必须
 * 重新 `initAliyunCaptcha`**（销毁旧实例、用新元素重新初始化）。
 */
export function buildDomExpression(): string {
  return `document.body.innerHTML =
    '<div id="${CAPTCHA_CONTAINER_ID}" aria-hidden="true">' +
    '<div id="${CAPTCHA_ELEMENT_ID}"></div>' +
    '<button id="${CAPTCHA_BUTTON_ID}">verify</button></div>'; 'ok'`
}

/**
 * 构造注入 SDK 的表达式（用 `<script src>`，简单可靠）。
 *
 * ⚠ **无参**：SDK 地址是常量，`region`/`prefix`/`SceneId` 由 {@link buildMintExpression}
 * 在 `initAliyunCaptcha` 那一刻才用 —— 别在这里塞 config，那会多出一条无人读的形参。
 */
export function buildSdkInjectExpression(): string {
  return `new Promise((resolve) => {
    if (typeof window.initAliyunCaptcha === 'function') { resolve('already'); return; }
    const script = document.createElement('script');
    script.src = ${JSON.stringify(ALIYUN_CAPTCHA_SDK_URL)};
    script.async = true;
    script.onload = () => resolve(typeof window.initAliyunCaptcha);
    script.onerror = () => resolve('onerror');
    document.head.appendChild(script);
    setTimeout(() => resolve('timeout'), 25000);
  })`
}

/**
 * 一次 captcha 产出的**结果 + 观测**。
 *
 * `interactive` 的语义（对齐官方 `mnn` 的 `interactive_displayed`）：
 * - `false` = **无感验证**直接通过（正常路径）
 * - `true`  = 被要求**交互式验证**（滑块/拼图）⇒ **设备信誉可能已下降**
 *
 * ⚠ 判据是「曾经观察到交互元素」——因为阿里云的这一层**不对外透出**
 *（官方文档 Q9 原文：「该安全策略逻辑不支持自定义，不对外透出」），
 * 只能靠看 DOM。
 */
export interface CaptchaMintOutcome {
  /** 产出的 param。 */
  param: string
  /** 本次是否被降级为交互式验证（`true` = 信誉预警信号）。 */
  interactive: boolean
}

/**
 * 构造「触发无感验证并等 param」的表达式。
 *
 * ## 为什么这三个表达式构造函数现在**导出**（二期 Task 3）
 * 内部载体的**载体页**（`src/zcode-carrier-page.ts`）必须由 server 渲染，
 * 才守得住「captcha 表达式只在 server 侧一份」这条约束 ——
 * client 里再写一遍 SDK 调用必然与本文件漂移（本仓库反复吃过同型缺陷）。
 * 除载体页外**不得**有第二个消费方。
 *
 * ⚠ 与 {@link STEALTH_PATCH} 的区别刻意为之：那份反检测补丁是**外挂 chromium**
 * 为了遮 `--headless` 痕迹才需要的，内部载体是 Electron 真实 guest，
 * 实测 `webdriver=false`、UA 带 `Electron/44.0.0` 时 4/4 产出合法 param
 * ⇒ 补丁**既不导出也不使用**（搬进载体页属于无据扩面）。
 */
export function buildMintExpression(config: ZcodeCaptchaConfig): string {
  return `new Promise((resolve) => {
    const done = (payload) => resolve(JSON.stringify(payload));
    /**
     * ★ **降级检测**（2026-10-01，对齐官方 \`mnn\` 的 interactive_displayed）。
     *
     * 我们调的是无感验证（\`startTracelessVerification\`）。阿里云若把本设备
     * 判为风险用户，会**静默弹出交互式验证**（滑块/拼图）—— 而官方文档明确说
     * 「该安全策略逻辑不支持自定义，不对外透出」（验证码 2.0 功能相关问题 Q9）。
     * 也就是说**没有回调告诉我们被降级了**，只能自己看 DOM。
     *
     * ⇒ 轮询检测那些交互元素是否出现过，用一个标志记住「曾经出现过」。
     *
     * ⚠ 用「曾经出现」而不是「此刻存在」：交互元素在验证完成后会被 SDK 移除，
     * 只在 success 那一刻查 DOM 会**漏报**（那正是最需要知道的场景）。
     *
     * ⚠ 选择器取自 dsh-free-glm 对空开源版 renderer 的实测记录
     *（\`bench/CAPTCHA-SLIDER-ATTEMPT.md\` 的 2.1 节，四个 id 逐字一致）。
     */
    let sawInteractive = false;
    const detectInteractive = () => {
      try {
        if (sawInteractive) return;
        if (document.querySelector('#aliyunCaptcha-window-popup')
          || document.querySelector('#aliyunCaptcha-sliding-slider')
          || document.querySelector('#aliyunCaptcha-puzzle')) {
          sawInteractive = true;
        }
      } catch (error) { /* 检测失败不影响产出 */ }
    };
    const pollTimer = setInterval(detectInteractive, 200);
    try {
      window.AliyunCaptchaConfig = ${JSON.stringify({ region: config.region, prefix: config.prefix })};
    } catch (error) { done({ stage: 'cfg-throw', err: String(error) }); }
    try {
      initAliyunCaptcha({
        SceneId: ${JSON.stringify(config.sceneId)},
        mode: 'popup',
        element: '#${CAPTCHA_ELEMENT_ID}',
        // ⚠ 必须传**元素对象**：传字符串会报「button参数传入值不合法」。
        button: document.getElementById('${CAPTCHA_BUTTON_ID}'),
        getInstance: (instance) => {
          try {
            if (typeof instance.startTracelessVerification === 'function') {
              instance.startTracelessVerification();
            } else if (typeof instance.show === 'function') {
              /**
               * ⚠ 走 \`show()\` 说明 SDK 里**没有**无感验证能力 —— 那本身
               * 就是一种降级形态（我们请求的是无感，拿到的是强制交互）。
               */
              sawInteractive = true;
              instance.show();
            }
          } catch (error) {
            done({ stage: 'call-throw', err: String((error && error.message) || error) });
          }
        },
        success: (param) => {
          /**
           * ⚠ 收尾前再查一次 DOM（轮询间隔 200ms，可能在两次轮询之间就完成了）。
           */
          detectInteractive();
          clearInterval(pollTimer);
          done({ stage: 'success', param, interactive: sawInteractive });
        },
        fail: (error) => {
          clearInterval(pollTimer);
          done({
            stage: 'fail',
            err: String((error && error.message) || JSON.stringify(error)),
            interactive: sawInteractive,
          });
        },
        onError: (error) => {
          clearInterval(pollTimer);
          done({
            stage: 'onError',
            err: String((error && error.message) || JSON.stringify(error)),
            interactive: sawInteractive,
          });
        },
      });
    } catch (error) {
      clearInterval(pollTimer);
      done({ stage: 'init-throw', err: String((error && error.message) || error) });
    }
    setTimeout(() => {
      clearInterval(pollTimer);
      done({ stage: 'timeout', interactive: sawInteractive });
    }, 60000);
  })`
}

/** 常驻浏览器的启动选项。 */
export interface ZcodeCaptchaBrowserOptions {
  /** 可执行文件；缺省自动探测。 */
  executablePath?: string
  /** 调试端口；缺省随机（9300-9799）。 */
  debugPort?: number
  /** 是否隐藏窗口（默认 true —— 用户不应被打扰）。 */
  hideWindow?: boolean
  /**
   * 载体页 origin（缺省 `CAPTCHA_PAGE_ORIGIN` = `https://zcode.z.ai/`）。
   *
   * ⚠ 仅供本地探针验证「本地 origin 行不行」，**不是生产配置**；
   * 取值规则与红线见 {@link resolveCaptchaPageOrigin}。
   */
  pageOrigin?: string
  /** 就绪等待上限（毫秒）。 */
  readyTimeoutMs?: number
  /**
   * 页面导航后的等待（毫秒）。
   *
   * ⚠ 真实 origin 的页面需要等 `domcontentloaded` 才有 `body`
   * （实测约 1.5 秒足够；`about:blank` 只需几百毫秒）。
   */
  navigationWaitMs?: number
  /**
   * 页面**空闲多久后主动换页**（毫秒）。
   *
   * ## ⚠ 默认已改为「**不因空闲换页**」（`Number.POSITIVE_INFINITY`）
   *
   * ### 为什么会改（原设计基于一个**未能复现**的前提）
   *
   * 原默认 `8_000`（8 秒）的依据是一条实测：*「同一页面空闲 15 秒后 mint
   * 必然 `F001`」*。但 2026-10-01 用更严格的变量分离**复测时无法复现**：
   *
   * | 场景（同一页面、零换页） | 结果 | 耗时 |
   * |---|---|---|
   * | 空闲 20 秒后**什么都不做**直接 mint | ✓ 3/3 | **467ms** |
   * | 空闲 20 秒后**重置 DOM** 再 mint（= 原生产行为） | ✓ 3/3 | 479ms |
   * | 空闲 20 秒后清 SDK 全局 + 重注入 | ✓ 2/2 | 488ms |
   *
   * 而**走生产 `mint()` 路径**时空闲 20 秒后：成功但**每次都换页**，
   * 耗时 **2.6–3.5 秒**。
   *
   * ⇒ 结论：**「空闲必然失效」不成立**；那个阈值让每次空闲后都白付一次
   * 建页成本（约 2.7 秒）。这正是用户报障「一键签到里 ZCode 很久」的成因
   * —— 而不是 captcha 本身慢（**失败时**的自愈能力仍然保留：`mint()` 里
   * `attempt > 1` 会 `forceFresh` 换页重试）。
   *
   * ### 现在的策略：**复用优先，失败才换页**
   *
   * ```
   * 默认（Infinity）           → 只要页面还在就复用（约 0.5 秒）
   * mint 失败（F001 等）        → 丢弃该页 + 换新页重试一次（原有的自愈链）
   * ```
   *
   * ⚠ 这**不增加 captcha 调用次数**：失败那次本就发了请求，且它是恢复所必需的。
   * 最坏情况（真遇到 F001）比原来多花约 0.5 秒，而**常态下省掉约 2.7 秒**。
   *
   * ⚠ 若将来又观测到「空闲后必失败」，把这里设成一个有限值即可回到
   * 「预测式换页」——但请**先复现证据**，别只看单次现象（本参数就是这么来的）。
   *
   * 设成 `0` 等于「每次新建」（慢，仅在排查时用）。
   */
  idleReuseMs?: number
  /**
   * 等**别的 mint** 让出页面时的上限（毫秒，默认 30000）。
   *
   * ⚠ 这不是「性能参数」而是**防死锁参数**（真实缺陷，2026-09-29）：
   * 取页是 `while (pageBusy) await sleep(50)` 的自旋，一旦某个持有者没能
   * 复位标志，这里就是**永久自旋** —— 而它既不看 signal 也没有上限，
   * 表现为「请求根本不发出、UI 永远深度求索中、点停止也无反应」。
   * 有界失败远好于永久挂起（失败会被上报成错误，挂起只能重启宿主）。
   */
  pageWaitTimeoutMs?: number
  /**
   * 新建页面时等待 CDP WebSocket `open` 的上限（毫秒，默认 10000）。
   *
   * ⚠ 同理是防死锁：旧实现只等 `open` / `error` 两个事件，Chromium 僵死时
   * **两个都不来**，于是永久挂起（且因为不抛错，`pageBusy` 也不会复位）。
   */
  connectTimeoutMs?: number
  /**
   * 诊断输出（可选，缺省静默）。
   *
   * ⚠ 只用于**说明性**信息，目前只有一条：实际落到系统 Edge 兜底时告警
   * （Gitee issue IKJLB1 的期望行为 2 —— 此前 Edge 是被静默选中的，
   * 用户既不知道用了哪个浏览器，也不知道该去哪换）。
   *
   * ⚠ 形参与 `src/captcha-carrier.ts` 的 `CaptchaCarrierDeps.log` 一致，
   * 由 `zcode-auth.ts` 传 `ctx.logger` 进来；**不给也不影响功能**。
   */
  log?: (message: string) => void
}

/**
 * 挑一个**确实空闲**的调试端口。
 *
 * ⚠ 为什么不能随机取（见 `launch()` 里 `this.port` 处的完整缺陷链）：
 * 随机撞上「尚未退干净的旧实例」会让新实例启动失败、而我们连到旧实例上，
 * 最终 `dispose()` 打空 ⇒ 旧实例整棵树泄漏。
 *
 * 做法：先用 `net.createServer` **真的占用**一下候选端口来验证可用性
 * （比查「谁在监听」可靠：既覆盖监听态，也避开刚关闭进入 TIME_WAIT 的端口）。
 *
 * ⚠ 探测与真正启动之间仍有理论竞态，故 `launch()` 里还有第二道
 * 「应答端口是否一致」的校验。
 */
async function pickFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 9300 + Math.floor(Math.random() * 500)
    if (await isPortFree(candidate)) return candidate
  }
  // 兜底：极端情况下退回随机（后续的端口校验会把问题暴露成明确报错）。
  return 9300 + Math.floor(Math.random() * 500)
}

/** 试占一个端口判断是否空闲（能绑上就算空闲）。 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    // 只绑回环：chromium 的调试端口也在回环上。
    try {
      server.listen(port, '127.0.0.1')
    } catch {
      resolve(false)
    }
  })
}

/**
 * ★ 把 chromium 的窗口从**任务栏**移除（Windows）。
 *
 * ## 为什么需要（用户报障 2026-09-29）
 *
 * > captcha 打开的 chromium 虽然最小化在任务栏，但**每次刷新页面完成都会闪烁
 * > 提示**。任务栏设成自动隐藏时，它会不停**浮上来**显示那个闪烁提示，
 * > 挡住屏幕最下面一排。
 *
 * ## 根因（Win32 实测取证）
 *
 * 枚举窗口的 `exStyle` 发现，**主窗口缺 `WS_EX_TOOLWINDOW`（0x80）**：
 *
 * | 时机 | 窗口类 | exStyle | toolWindow | inTaskbar |
 * |---|---|---|---|---|
 * | 启动后（不可见） | `Chrome_WidgetWin_1` | `0x200100` | ✗ | false（未显示） |
 * | **页面加载后（可见）** | 同上 | `0x200100` | ✗ | **true** ★ |
 *
 * ⇒ 页面一渲染，窗口就**获得任务栏按钮**。有按钮，Windows 就有可闪的东西；
 * 任务栏自动隐藏时便浮出来显示它。
 *
 * ## 修法
 *
 * 给窗口加上 `WS_EX_TOOLWINDOW`：Win32 文档原话是「工具窗口**不出现在任务栏**」。
 * 没有按钮 ⇒ 没有可闪烁的提示 ⇒ 任务栏不会浮出。
 * 同时加 `WS_EX_NOACTIVATE`（不抢焦点、不前置），并清掉 `WS_EX_APPWINDOW`
 * （它会**强制**出现在任务栏，与目的相反）。
 *
 * ## 实测验证
 *
 * | 项 | 结果 |
 * |---|---|
 * | 打上后 `inTaskbar` | 13 个窗口**全部 false** |
 * | 连续 3 次 mint 后样式是否被重置 | **全部保持**（不会被 chromium 重置） |
 * | 对 captcha 功能的影响 | mint 仍成功（1802~1950ms） |
 * | 成本 | 约 1.2 秒（**这是这一步 PowerShell 自身的耗时，不是 mint 的耗时**；mint 的稳态口径见上面 `CAPTCHA_PAGE_ORIGIN` 的矩阵）；**只需在启动时做一次**，可与 3.7 秒的启动并行 ⇒ 几乎免费 |
 *
 * ⚠ **失败必须静默**：这是「减少打扰」的优化，不是功能依赖。
 * 借外部 PowerShell 有失败可能（策略限制/无权限），此时最坏结果是回到
 * 修复前的行为（窗口在任务栏），**绝不能让 captcha 因此不可用**。
 *
 * ⚠ 用 **`powershell.exe`**（Windows 5.1，系统自带）而不是 `pwsh` ——
 * 后者是可选安装，不能假设存在。实测本机 5.1 存在且 Add-Type 可用。
 *
 * @param pid 目标浏览器主进程 pid。
 * @param log 诊断回调（可选）。macOS 藏窗失败时用它告警一次，原因见
 *   {@link hideWindowMacos}：失败被静默吞掉，用户报「窗口还是弹出来」时
 *   没有这条日志就只能猜。
 */
function hideWindowFromTaskbar(pid: number, log?: (message: string) => void): void {
  try {
    if (process.platform === 'win32') hideWindowWindows(pid)
    else if (process.platform === 'linux') hideWindowLinux(pid)
    else if (process.platform === 'darwin') hideWindowMacos(pid, log)
  } catch {
    // 静默：优化失败不影响 captcha。
  }
}

/**
 * Windows：直接改窗口的**扩展样式**。
 *
 * 见 {@link hideWindowFromTaskbar} 的取证表（`WS_EX_TOOLWINDOW` 一出，
 * 窗口即不在任务栏）。
 */
function hideWindowWindows(pid: number): void {
  let dirCreated: string | undefined
  try {
    /**
     * 脚本**纯 ASCII**（无中文注释）—— PS 5.1 对无 BOM 的 UTF-8 会按 ANSI
     * 解读，含中文的脚本会损坏（实测过）。
     *
     * ⚠ 关键设计：**回读校验 + before 为 0 时跳过**。
     * 内联版失败时的特征是「读到的 `exStyle` 恒为 0」，而脚本仍把样式
     * 写成 0（可能破坏窗口）。这里明确要求 before 非 0 才写。
     */
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ZcodeWinStyle {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  public static List<IntPtr> All() {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
}
"@
$EX = -20
$TOOL = 0x80
$APP = 0x40000
$NOACT = 0x8000000
$target = ${String(pid)}
$n = 0
$all = @([ZcodeWinStyle]::All())
if ($all.Count -eq 0) { Write-Output 'enum-empty'; exit 0 }
foreach ($h in $all) {
  $wp = 0
  [void][ZcodeWinStyle]::GetWindowThreadProcessId($h, [ref]$wp)
  if ([int]$wp -ne $target) { continue }
  $before = [int64][ZcodeWinStyle]::GetWindowLongPtr($h, $EX)
  if ($before -eq 0) { continue }
  $new = (($before -bor $TOOL -bor $NOACT) -band (-bnot $APP))
  [void][ZcodeWinStyle]::SetWindowLongPtr($h, $EX, [IntPtr]$new)
  $n++
}
Write-Output "hidden=$n"
`
    const dir = mkdtempSync(join(tmpdir(), 'zcode-hide-'))
    const file = join(dir, 'hide.ps1')
    dirCreated = dir
    writeFileSync(file, script, 'ascii')
    /**
     * ⚠ 用 `-File`（**不是** `-Command`）—— 见函数头的实测对比表。
     * `stdio: 'ignore'`：装饰路径不该因沙箱下的 stdio EPERM 而失败。
     *
     * ⚠ 闭包里用 `file`（局部 const）而不是可变的 let：后者在回调里会
     * **丢失类型收窄**（TS 报 undefined 不可赋值）。
     */
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', file,
    ], { stdio: 'ignore', windowsHide: true })
    child.on('exit', () => { safeRemoveDir(dir) })
    child.on('error', () => { safeRemoveDir(dir) })
  } catch {
    if (dirCreated !== undefined) safeRemoveDir(dirCreated)
  }
}

/**
 * Linux（X11）：用 **EWMH** 标准机制把窗口从任务栏移除。
 *
 * ## ⚠⚠ 与 Windows 的**本质差异**（先读这段）
 *
 * | | Windows | Linux（X11） |
 * |---|---|---|
 * | 机制 | 窗口**属性**（`SetWindowLongPtr`） | **WM 协议**（EWMH 客户端消息） |
 * | 生效条件 | 立刻生效，不需 WM 配合 | **需 WM 支持 `_NET_WM_STATE_SKIP_TASKBAR`** |
 * | 依赖 | 系统自带 `powershell.exe` | **外部工具 `wmctrl`**（非自带，可能没装） |
 * | Wayland | 不适用 | **完全无效**（无 X11 访问权） |
 *
 * ⇒ **本路径是「尽力而为」**：装了就生效，没装就静默跳过（回到修复前行为）。
 * **不引入 npm 依赖**去直接发 X11 协议（那要动 X11 连接层，风险与体积都不划算）。
 *
 * ## 为什么用 `wmctrl` 而不是 `xdotool`
 *
 * `xdotool` 的 `windowstate` 只支持 `add/remove` 少数几项，**不含
 * `SKIP_TASKBAR`**；而 `wmctrl -r <win> -b add,skip_taskbar` 正是干这个的。
 * 故主选 `wmctrl`，`xdotool` 仅用于**按 pid 找窗口 id**（若 `wmctrl` 的
 * `-lp` 不够用时作为补充）。
 *
 * ## ⚠ 未在本机实测（如实标注）
 *
 * 开发机是 Windows，且 WSL 实例损坏、无 X11 工具 —— **无法真机验证 Linux 行为**。
 * 故：
 *   - 命令构造抽成纯函数 {@link buildLinuxSkipTaskbarArgs} 并**单测锁死**
 *   - 失败路径**完全静默**（最坏回到修复前）
 *   - 这里只依赖 `wmctrl` 的**文档化语义**，不做任何"猜测式"的额外调用
 */
function hideWindowLinux(pid: number): void {
  /**
   * ⚠ `wmctrl -lp` 列出所有窗口，格式（文档）：
   * ```
   * 0x0320000a  0 12345  hostname  Window Title
   * ```
   * 第 1 列是窗口 id、**第 3 列是 pid** —— 据此筛出我们自己的窗口。
   *
   * 用 `-r <id> -b add,skip_taskbar` 逐个设置。
   * `-i` 表示按**窗口 id**（而不是标题）匹配（标题可能含特殊字符）。
   *
   * 为什么不写 shell 脚本（与 Windows 侧对称）：Linux 侧没有「内联脚本
   * 被转义破坏」那类问题（`spawn` 不经 shell），但**需要解析 `-lp` 输出**
   * 才能按 pid 过滤 —— 那段解析逻辑放在 JS 里更好测（见 `parseWmctrlList`）。
   *
   * ⚠ 不检查 `wmctrl` 是否存在：`spawn` 失败会走 `error` 事件（静默处理），
   * 比预先 `which` 探测更简单且无竞态。
   */
  const list = spawn('wmctrl', ['-lp'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const chunks: Buffer[] = []
  list.stdout?.on('data', (c: Buffer) => chunks.push(c))
  list.on('error', () => { /* 没装 wmctrl —— 静默跳过 */ })
  list.on('exit', () => {
    try {
      const ids = parseWmctrlList(Buffer.concat(chunks).toString('utf8'), pid)
      for (const id of ids) {
        const child = spawn('wmctrl', buildLinuxSkipTaskbarArgs(id), {
          stdio: 'ignore',
          windowsHide: true,
        })
        child.on('error', () => { /* 静默 */ })
      }
    } catch {
      // 静默：优化失败不影响 captcha。
    }
  })
}

/**
 * macOS：把该 pid 的 chrome 窗口**最小化**（`set miniaturized of every window to true`）。
 *
 * ## 为什么是最小化（而非 osascript 移屏 / 1x1）
 *
 * 真机（macOS，主屏 0,0 1470×956）对 4 种藏法逐一验证了「窗口是否仍挂在
 * 屏幕可见区」与「captcha 是否仍能 mint」：
 *
 * | 藏法 | 命令 | captcha 实测 |
 * |---|---|---|
 * | 最小化 | `set miniaturized … to true` | **稳**（10/10 mint OK，paramLen 280） |
 * | 移到 -32000 | `set position … to {-32000,-32000}` | **偶发 `F001`**（窗口离屏时 SDK 取证帧偶尔拿到空 canvas） |
 * | 1×1 缩到角 | `set size … to {2,2}` | 偶发 F001（同上，渲染尺寸过小触发 SDK 重试） |
 * | `--headless=new` | （启动参数） | 一律 `F001`，**不可用** |
 *
 * 结论：macOS 上**最小化是唯一同时满足「不挡屏幕」与「mint 稳定」**的做法。
 * 最小化后窗口缩到屏幕右下角（Dock 区），肉眼几乎不可见，且不破坏 captcha。
 *
 * ## 为什么不用 osascript `set position`（移屏）
 *
 * `--window-position=-32000,-32000` 已经由 `launch()` 传给了 chromium，但
 * **macOS 的 WindowServer 会把离屏窗口钳回屏幕内**（与 `--headless` 相反，
 * 这是系统行为，不是 chromium 行为）。所以「移屏」这条在 macOS 上等于没移。
 * 最小化则不受该钳制影响（窗口仍在屏幕坐标系内，只是缩到角上）。
 *
 * ## ⚠⚠ 依赖：宿主必须已授予 macOS「辅助功能」权限（与 Linux 的 wmctrl 不同）
 *
 * | | Linux | macOS |
 * |---|---|---|
 * | 机制 | WM 协议（EWMH 客户端消息） | `osascript` 驱动 System Events 的 UI 脚本 |
 * | 依赖 | 外部工具 `wmctrl` | 系统自带 `osascript`，**但 UI 脚本需宿主被授予「辅助功能」权限** |
 * | 缺了怎么办 | `apt install wmctrl`，一条命令 | 系统设置 → 隐私与安全性 → 辅助功能 → 勾选宿主，**通常还要重启应用** |
 * | 用户知道吗 | 报错会说「没装 wmctrl」 | **大多数人不知道这个权限存在**，且授权可能随应用升级被重置 |
 *
 * ⇒ 未授权时 `osascript` 非零退出，被本函数的静默语义吞掉，**窗口照常弹出**。
 * 这是「减少打扰」的优化失效，不是功能故障；用户报「窗口还是弹出来」时先查这一项。
 *
 * ## 接入与失败语义（与 Windows/Linux 侧对称）
 *
 * - **失败必须静默**：这是「减少打扰」的优化，不是功能依赖。`spawn` 的
 *   `error`/非零退出都直接吞掉，最坏结果回到修复前的行为（窗口正常弹出），
 *   **绝不能让 captcha 因此不可用**。
 * - 与 Windows 侧一样用 `windowsHide: true` + `stdio: 'ignore'` 异步 fire-and-forget。
 * - **只按 pid 匹配**（`unix id`），刻意没有「按进程名兜底」—— 理由与代价见
 *   {@link hideWindowMacos} 的函数头。
 * - ⚠ 本函数是本文件**唯一**拼 AppleScript 的地方，且**只插值一个整数**：
 *   没有字符串插值 ⇒ 没有引号/反斜杠转义问题（初版的进程名兜底栽在这里）。
 *
 * @param pid 目标浏览器主进程 pid。
 * @returns `osascript` 参数数组（`-e <script>`），纯函数便于单测锁死。
 */
export function buildMacosMiniaturizeArgs(pid: number): string[] {
  // AppleScript：遍历该 pid 名下所有窗口并最小化。
  // `System Events` 需要 `process` 句柄，`pid` 用 `unix id` 精确匹配。
  const appleScript =
    `tell application "System Events" to set miniaturized of every window of ` +
    `(first process whose unix id is ${pid}) to true`
  return ['-e', appleScript]
}

/**
 * 对 macOS 该 pid 的窗口执行最小化（异步、失败静默）。
 *
 * ## ⚠⚠ 刻意**没有**「按进程名兜底」——那会最小化用户自己的浏览器
 *
 * 初版在 pid 匹配非零退出后，用 `first process whose name is "Google Chrome"`
 * 再试一次。**已删除**，两个原因：
 *
 * ① **会误伤用户真实浏览器**：`whose name is` 匹配**任意**同名进程，不是「我们
 *    那个」。用户在用 Chrome 时兜底一旦触发，其全部真实窗口被最小化。
 *    ⚠ 而触发条件比想象中宽：本函数以「osascript 非零退出」触发兜底，
 *    `stdio: 'ignore'` 又丢掉 stderr ⇒ **分不清「pid 落空」与「辅助功能未授权
 *    （-1719）」**。后者才是更常见的失败原因（真机第一轮实测就撞到过）。
 * ② **字符串插值未转义**：`"${exeName}"` 里若进程名含 `"`，字面量会被撑开
 *    （实测 `evil".do shell script "id` → `… whose name is "evil".do shell
 *    script "id") to true`）。删掉兜底后**本文件不再有任何字符串插值进
 *    AppleScript**，注入面随之一并消失。
 *
 * ⇒ pid 落空就**什么都不做**：窗口短暂可见，正是**修复前**的行为。代价是
 * Chrome re-exec 换 pid 时最小化失效 —— 那是「少一个优化」，不是功能回退。
 * 拿「少隐藏一次」换「绝不最小化用户自己的浏览器」，这笔账划算。
 *
 * 契约锁在 `tests/unit/zcode-window-hide-macos-review.spec.ts`。
 *
 * 一次性告警闸门：同一进程里只提醒一次，避免每次 `launch()` 刷屏。
 */
let macosHideWarned = false

/**
 * macOS 藏窗失败时告警一次。
 *
 * ⚠ 只说「可能的原因」而不下断言：`stdio: 'ignore'` 丢掉了 stderr，
 * 区分不出「pid 落空」与「辅助功能未授权（-1719）」，而后者更常见。
 */
function warnMacosHideOnce(log: ((message: string) => void) | undefined, reason: string): void {
  if (log === undefined || macosHideWarned)
    return
  macosHideWarned = true
  log(
    `[channel-pack] zcode macOS 藏窗未生效（${reason}）—— 窗口会照常弹出，但不影响 captcha。` +
    '最常见原因是宿主未获 macOS「辅助功能」权限：系统设置 → 隐私与安全性 → 辅助功能 → 勾选宿主（通常需重启应用）。',
  )
}

/**
 * @param pid 目标浏览器主进程 pid。
 * @param log 诊断回调（可选），见 {@link hideWindowFromTaskbar}。
 */
function hideWindowMacos(pid: number, log?: (message: string) => void): void {
  const child = spawn('osascript', buildMacosMiniaturizeArgs(pid), {
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => { warnMacosHideOnce(log, 'osascript 不可用') })
  // 非零退出同样静默继续（不重试，见函数头 ①），但留一条告警。
  child.on('close', (code) => {
    if (code !== 0)
      warnMacosHideOnce(log, `osascript 退出码 ${code}`)
  })
}

/**
 * 构造「把窗口加入 `_NET_WM_STATE_SKIP_TASKBAR`」的 `wmctrl` 参数。
 *
 * ⚠ `-i` 必带：让 `-r` 按**窗口 id** 匹配（`0x...`），而不是按标题 ——
 * 标题里有空格/括号（chromium 的标题是「新标签页 - Chromium」）会被误解析。
 *
 * ⚠ **只加 `skip_taskbar`，不加 `skip_pager`**：前者即「不出现在任务栏」
 * （这正是要的）。`skip_pager` 是「不出现在工作区切换器」，与本次目的无关，
 * 多加会改变用户对窗口的既有预期（用户没要求隐藏工作区条目）。
 *
 * ⚠ 也**不**用 `-b add,hidden`（最小化）：chromium 已经用
 * `--window-position=-32000,-32000` 移出屏幕，再改最小化状态会与
 * captcha 流程的窗口假设冲突（那些流程依赖窗口"存在且可渲染"）。
 */
export function buildLinuxSkipTaskbarArgs(windowId: string): string[] {
  return ['-i', '-r', windowId, '-b', 'add,skip_taskbar']
}

/**
 * 从 `wmctrl -lp` 的输出里筛出**属于指定 pid** 的窗口 id。
 *
 * 输出格式（每行，字段以空白分隔）：
 * ```
 * 0x0320000a  0 12345  hostname  Window Title
 * └─ 窗口 id  │  └─ pid
 *            └─ 桌面号
 * ```
 *
 * ⚠ **标题可能含任意空白**，故只能按「前 4 个字段」切分，**不能**整体
 * `split(/\s+/)` 后取全部 —— 那样标题会被拆散（对本用途无害，但会让人
 * 误以为解析"完全正确"）。
 *
 * ⚠ 只取**前 4 个字段**：第 4 列（hostname）之后全是标题。
 * 用 `split(/\s+/, 5)`（限 5 段）恰好把标题保留为最后一段。
 *
 * @returns 属于该 pid 的窗口 id（形如 `0x0320000a`）；解析不到就返回空数组。
 */
export function parseWmctrlList(output: string, pid: number): string[] {
  const ids: string[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    // 限 5 段：id / desktop / pid / host / 其余（标题）
    const fields = line.split(/\s+/, 5)
    if (fields.length < 3) continue
    const id = fields[0] ?? ''
    // 窗口 id 必须是 0x 开头的十六进制（防把标题行当数据行）
    if (!/^0x[0-9a-f]+$/i.test(id)) continue
    const linePid = Number(fields[2])
    if (!Number.isInteger(linePid) || linePid !== pid) continue
    ids.push(id)
  }
  return ids
}

/** 尽力删除临时目录（失败无妨，系统会回收临时目录）。 */
function safeRemoveDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch { /* 忽略 */ }
}

/**
 * 一个可复用的 captcha 页面。
 *
 * ⚠ **页面被复用**（不再每次新建）—— 见 `mint()` 的说明。
 * 复用要求它一直停在 {@link CAPTCHA_PAGE_ORIGIN} 上。
 */
interface CaptchaPage {
  /** CDP target id（诊断用）。 */
  readonly targetId: string
  /** 页面级 WebSocket。 */
  readonly ws: WebSocket
  /** 页面级 CDP 连接。 */
  readonly cdp: CdpConnection
  /** 上次成功使用它的时刻（用于空闲判定）。 */
  lastUsedAt: number
  /**
   * 是否已做过「建 DOM + 注入 SDK」的完整准备。
   *
   * ⚠ **不能每次都重做**（真实缺陷，见 `mintOnPage` 的取证）：
   * 重置 `document.body.innerHTML` 会销毁 captcha 元素，而 SDK 已加载时
   * 不会重建实例 —— 两者叠加必然 `F001`。
   *
   * 故只在**首次使用**时准备（`undefined`/`false` ⇒ 准备一次），
   * 之后复用同一元素与实例。
   */
  prepared?: boolean
}

/**
 * 常驻浏览器会话。
 *
 * ## 为什么常驻
 *
 * 冷启动实测约 690ms，但**每次请求都冷启动**会让首字延迟凭空多一秒。
 * 而 mint 只在**上游索要验证时**才发生：复用常驻页面的稳态约 0.4–0.5 秒
 * （中位 426ms / 平均 546ms，见 `CAPTCHA_PAGE_ORIGIN` 的矩阵），含 chromium
 * 冷启动的首发实测 4.2 秒；至于「每次新建 page」那个 1246ms，是 origin 修正
 * **之前**的历史值，别当现行口径（数字汇总见 README 的 ZCode 章节）。
 * （上游不要验证的窗口里这条路**一次都不走**，见文件头的「按需」段。）
 *
 * ## 生命周期
 *
 * `dispose()` 必须被调用（`ZcodeAuth.stop()` 里做），否则会留下
 * 一个孤儿 chromium 进程（约 200-400MB）。此外还注册了进程退出钩子兜底。
 */
export class ZcodeCaptchaBrowser {
  private child: ChildProcess | undefined
  private browserWs: WebSocket | undefined
  private browserCdp: CdpConnection | undefined
  private profileDir: string | undefined
  private port = 0
  private starting: Promise<void> | undefined
  /**
   * 复用的 captcha 页面（停在 {@link CAPTCHA_PAGE_ORIGIN} 上）。
   *
   * ⚠ 复用而非每次新建：实测 546ms vs 1246ms（快 2.3 倍）。
   * 前提是 origin 必须真实 —— 见 `mint()` 的说明。
   */
  private reusablePage: CaptchaPage | undefined
  /**
   * 页面是否正被某次 mint 占用。
   *
   * captcha param 是**一次性**的，两个并发 mint 共用同一页面会互相踩状态。
   * 故用该标志把取页串行化（并发调用排队，而不是拿到同一个页面）。
   */
  private pageBusy = false
  /** 诊断输出（见 {@link ZcodeCaptchaBrowserOptions.log}），缺省 undefined = 静默。 */
  private readonly log: ((message: string) => void) | undefined
  /**
   * 浏览器**起不来 / 自己没了**的可读原因（由 `launch()` 里的
   * `'error'` / `'exit'` 监听写入，见该处注释）。
   *
   * `undefined` = 一切正常。轮询循环每轮检查它，命中即立刻失败 ——
   * 否则「浏览器秒退」要白等满 `readyTimeoutMs`（默认 30 秒）才报错。
   */
  private spawnFailure: Error | undefined

  constructor(private readonly options: ZcodeCaptchaBrowserOptions = {}) {
    this.log = options.log
  }

  /** 浏览器是否已就绪。 */
  get ready(): boolean {
    return this.browserCdp !== undefined && this.browserWs?.readyState === 1
  }

  /** 启动（幂等；并发调用共享同一次启动）。 */
  async start(): Promise<void> {
    if (this.ready) return
    if (this.starting !== undefined) {
      await this.starting
      return
    }
    const task = this.launch().finally(() => {
      this.starting = undefined
    })
    this.starting = task
    await task
  }

  private async launch(): Promise<void> {
    const executable = this.options.executablePath ?? findBrowserExecutable()
    if (executable === undefined) {
      /**
       * ⚠ 文案按平台生成（2026-10-03，issue IKJKNT）：原先是单一口径
       * 「已尝试 scoop chromium / Chrome / Chromium / Edge；用 ZCODE_CHROME_PATH
       * 显式指定 chrome.exe 路径」—— 在 macOS 上 scoop 不存在、`chrome.exe`
       * 也不是那个文件名，Mac 用户照着做只会更懵。口径见 {@link browserNotFoundMessage}。
       */
      throw new Error(
        'zcode: 找不到可用的浏览器（用于产出阿里云 captcha）。' +
          browserNotFoundMessage(),
      )
    }

    /**
     * ★ **Edge 兜底必须出声**（Gitee issue IKJLB1 的期望行为 2）。
     *
     * 候选链里 Edge 排最后（见 {@link findBrowserExecutable} 的 ⑤），于是
     * **没装 Chrome/Chromium 的机器上它是唯一可选项** —— 而这是国内 Windows
     * 的常见状态。原先它被**静默**选中：用户既不知道用的是哪个浏览器，
     * 也不知道该去哪换，于是只能靠翻崩溃日志反推。
     *
     * ⚠️ 只在**确实落到 Edge** 时告警：装了 Chrome/Chromium 的用户不受打扰。
     * ⚠️ 判断用文件名（`msedge.exe`）而不是 `includes('Edge')` ——
     * 前者对路径里的 `Microsoft\Edge\` 与 scoop 布局都成立，且不会把
     * `ZCODE_CHROME_PATH` 指向的第三方 chromium 误报成 Edge。
     */
    if (isEdgeExecutable(executable)) {
      this.log?.(
        '[channel-pack] zcode captcha 未检测到 Chrome/Chromium，改用系统 Edge（msedge.exe）产出 —— ' +
        '若 Edge 异常导致 captcha 失败，可安装 Chrome/Chromium 或用 ZCODE_CHROME_PATH 指定其它浏览器。',
      )
    }

    /**
     * 每次 `launch()` 都是一次全新的尝试：上一次的失败原因必须清掉，
     * 否则上一轮「浏览器起不来」会让后续**所有**轮次秒失败。
     */
    this.spawnFailure = undefined

    this.profileDir = mkdtempSync(join(tmpdir(), 'zcode-captcha-'))
    /**
     * ★ **必须挑一个确实空闲的端口**（真实缺陷）。
     *
     * 早期是 `9300 + Math.floor(Math.random() * 500)` —— 纯随机、**不检查占用**。
     * 若撞上一个**尚未完全退出的旧实例**的端口，会串成一条隐蔽的失效链：
     *
     * 1. 新 chromium 因端口被占而启动失败（自行退出）
     * 2. 但 `fetch('/json/version')` **成功** —— 应答的是**旧实例**！
     * 3. 于是我们连上了旧浏览器，而 `this.child` 指向那个**已死**的新进程
     * 4. `dispose()` 的 `taskkill` 打在一个死 pid 上 → **毫无效果**
     * 5. 真正在跑的旧实例从此无人回收 ⇒ **整棵树泄漏**（实测 10~14 个进程）
     *
     * 实测证据：`dispose()` 立即接下一轮时**偶发**泄漏（随机端口才撞得上），
     * 而每轮间隔 2.5 秒时 5/5 干净 —— 正是「旧实例还没退干净」的特征。
     *
     * 故改为：在候选端口里**探测到空闲**的那个。
     */
    this.port = this.options.debugPort ?? await pickFreePort()
    const hide = this.options.hideWindow !== false

    this.child = spawn(executable, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate',
      '--lang=zh-CN',
      '--window-size=1280,900',
      /**
       * ⚠ **不用 `--headless=new`** —— 实测 headless 一律 `F001`，必须 headful。
       * 为了不打扰用户，把窗口移到屏幕外。
       */
      ...hide ? ['--window-position=-32000,-32000'] : [],
    ], {
      stdio: 'ignore',
      windowsHide: hide,
      /**
       * ⚠ POSIX 上必须 `detached: true`：这样 chromium 自成**进程组**，
       * `killProcessTree()` 才能用负 pid 一次杀掉全部子进程。
       * 不加的话子进程会脱离、变成孤儿（实测留下 12 个 chrome.exe）。
       *
       * ⚠ Windows 不用这个（它有 `taskkill /T`），且 `detached` 在 Windows
       * 上会额外开一个控制台窗口 —— 与「不打扰用户」冲突。
       */
      detached: process.platform !== 'win32',
    })

    /**
     * ★★ **必须监听 `error` 与 `exit`**（真实缺陷，2026-10-03，Gitee issue IKJLB1）
     *
     * ## 为什么这是**能杀掉整个宿主**的缺陷（不是「浏览器崩了」的泛泛之谈）
     *
     * `ChildProcess` 是 EventEmitter，而 **`'error'` 事件在没有监听器时会被
     * `throw` 成未捕获异常**。实测（`spawn` 一个不存在的绝对路径、且不注册
     * `error`）：
     *
     * ```
     * Error: spawn …\msedge.exe ENOENT
     *   throw er; // Unhandled 'error' event
     * → 进程立刻退出，exit code = 1
     * ```
     *
     * 插件是通过 `ctx.plugin()` 跑在 **dsh desktop host 进程内**的，而
     * `cordis` 没有装 `uncaughtException` / `unhandledRejection` 处理器 ⇒
     * 插件侧的未捕获异常会**直接终止 host**；Electron main 收到 `close`
     * 回调（`app.asar/lib/main.js:3724` 打印 `dsh desktop host exited with …`）
     * 便弹出宿主级错误框。
     *
     * ⚠️ **触发条件是「起不来」而非「崩溃」**：`exit` 事件有监听器时不会抛，
     * 所以浏览器**运行中崩溃**只会被静默吞掉（实测：父进程存活、exit code 0）。
     * 真正致命的是 spawn 阶段的 `ENOENT` / `EACCES` / `EPERM` —— 也就是
     * 「候选链选中的那个 exe 存在但打不开」（权限、被占用、文件损坏、
     * Edge 正在自我更新等）。
     *
     * ⚠️ 同仓库 `src/qoder-machine.ts` 的 `child.once('error', …)` 是现成范式
     * —— 证明这里此前是**遗漏**而非有意。
     */
    const child = this.child
    child.once('error', (error: Error) => {
      /**
       * ⚠️ 存起来**而不是就地抛**：此刻 `launch()` 还在下面的轮询循环里，
       * 直接抛会变成「循环外的 promise rejection」，而 `start()` 仍会等满
       * `readyTimeoutMs` 才返回。存下来让循环**下一轮立刻**失败（见下）。
       */
      this.spawnFailure = new Error(
        `zcode: 浏览器无法启动（${executable}）：${error.message}` +
        '。可安装 Chrome/Chromium，或用 ZCODE_CHROME_PATH 指定其它 chromium 内核浏览器。',
      )
    })
    child.once('exit', (code, signal) => {
      /**
       * 判据是「`this.child` 还是不是它」——因为 `killProcessTree()` 会先把
       * `this.child` 置空，故**主动停机**（`dispose()` / 轮询超时 / 端口错配）
       * 走到这里时 `this.child !== child`，只有**浏览器自己没了**才等于。
       * ⇒ 不需要额外的 `stopping` 标志，也不会把正常清理误报成崩溃。
       */
      if (this.child !== child) return
      this.child = undefined
      const how = signal !== null && signal !== undefined
        ? `signal=${signal}`
        : `code=${String(code)}`
      this.spawnFailure ??= new Error(
        `zcode: 浏览器进程异常退出（${executable}，${how}）` +
        '。请重试，或用 ZCODE_CHROME_PATH 指定其它 chromium 内核浏览器。',
      )
    })

    const timeoutMs = this.options.readyTimeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    let debuggerUrl: string | undefined
    while (Date.now() < deadline) {
      /**
       * ⚠️ **每轮先看 `spawnFailure`**：浏览器起不来 / 秒退时立刻失败，
       * 而不是白等满 `readyTimeoutMs`（默认 30 秒）才报一个含糊的「超时」。
       * 旧实现的用户体感就是「签到卡住半分钟然后失败」—— 根因就在这里。
       */
      if (this.spawnFailure !== undefined) {
        const failure = this.spawnFailure
        this.kill()
        throw failure
      }
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
          signal: AbortSignal.timeout(2_000),
        })
        if (response.ok) {
          const version = await response.json() as { webSocketDebuggerUrl?: unknown }
          if (typeof version.webSocketDebuggerUrl === 'string') {
            debuggerUrl = version.webSocketDebuggerUrl
            break
          }
        }
      } catch {
        // 还没起来。
      }
      await sleep(300)
    }
    if (debuggerUrl === undefined) {
      this.kill()
      /**
       * ⚠️ 走到这里若 `spawnFailure` 已就位，优先抛它 ——
       * 「浏览器起不来」比「端口没就绪」更贴近根因，用户才知道该换浏览器。
       */
      throw this.spawnFailure
        ?? new Error(`zcode: 浏览器调试端口未就绪（${timeoutMs}ms 超时）`)
    }
    /**
     * ★ **确认应答的确实是我们启动的那个浏览器**（防「连到旧实例」）。
     *
     * 端口已经挑空闲的了，这里是**第二道防线**：万一仍有竞态（别的进程
     * 在我们探测之后抢占了端口），`/json/version` 的 `Browser` 值/`webSocketDebuggerUrl`
     * 里的端口会暴露它。启动时 chromium 一定会占住我们给的端口，
     * 故再校验一次 `debuggerUrl` 里的端口号是否等于 `this.port`。
     *
     * ⚠ 不等就**抛错**而不是继续用 —— 继续用会导致「dispose 打空 + 真实例泄漏」
     * 那条隐蔽链（见上面 `pickFreePort` 的说明）。
     */
    if (!debuggerUrl.includes(`:${this.port}/`)) {
      this.kill()
      throw new Error(
        `zcode: 调试端口 ${this.port} 应答的不是本实例（${debuggerUrl}）—— ` +
        '疑似端口被其它 chromium 占用，已放弃以避免泄漏',
      )
    }

    const ws = new WebSocket(debuggerUrl)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('zcode: 连接浏览器调试端口失败')), { once: true })
    })
    this.browserWs = ws
    this.browserCdp = new CdpConnection(ws)

    /**
     * ★ 把窗口从**任务栏**移除（Windows）—— 见 {@link hideWindowFromTaskbar}
     * 的完整取证。
     *
     * ⚠ 必须在**页面渲染之前**做（此处正好：已连上 CDP、还没导航）——
     * 实测窗口此时已存在但 `visible=false`，`exStyle` 已可设置；
     * 而一旦页面渲染、窗口变可见，它就会获得任务栏按钮并开始闪烁。
     *
     * ⚠ **不 await**：这是装饰性优化，让它在后台跑（那个「约 1.2 秒」是这一步 PowerShell 自身的耗时，**与 mint 的 0.4–0.5 秒无关**），
     * 与后续导航重叠。失败静默，不影响 captcha。
     */
    if (hide && this.child?.pid !== undefined) hideWindowFromTaskbar(this.child.pid, this.log)
  }

  /**
   * 产出**一个新鲜**的 captcha param。
   *
   * ## ⚠⚠ 实测约束（第 2 条曾在 2026-10-01 被**推翻并修正**，务必读完）
   *
   * ### 1. 页面 origin 必须是**真实 https**，不能用 `about:blank`
   *
   * | origin | 同页连续 mint |
   * |---|---|
   * | `about:blank` | **1/3**（#2 起 `F001`） |
   * | `https://zcode.z.ai/` | 连续 5/5 |
   *
   * 阿里云 SDK 会检查 origin（`about:blank` 的是 `"null"`），风控据此拒绝。
   *
   * ### 2. ~~空闲约 15 秒后同一页面必然失效~~ → **已推翻**
   *
   * 曾经（2026-09-29）观测到下面这张表，据此加了「空闲 8 秒就换页」：
   *
   * | 用例 | 当时的结果 |
   * |---|---|
   * | 立即 mint | ✓ 3786ms |
   * | **间隔 15s**（复用页面） | ✗ `F001` 416ms |
   * | 间隔 45s / 90s（复用页面） | ✗ `F001` |
   * | 全新浏览器 + 新页面 | ✓ 3692ms |
   *
   * ⚠ 但 2026-10-01 用**变量分离**复测（同一页面、零换页、每组都先预热成功）
   * **无法复现**：
   *
   * | 场景 | 结果 | 耗时 |
   * |---|---|---|
   * | 空闲 20 秒后**什么都不做**直接 mint | ✓ **3/3** | **467ms** |
   * | 空闲 20 秒后**重置 DOM** 再 mint（= 当时的生产行为） | ✓ 3/3 | 479ms |
   * | 空闲 20 秒后清 SDK 全局 + 重注入 | ✓ 2/2 | 488ms |
   *
   * ⇒ **`F001` 与"空闲时长"没有稳定因果关系**（当时那次更可能是环境/风控
   * 的瞬时状态，或与实验方法有关 —— 我早期两个实验分别在 baseline 前
   * 跑了注入、以及误用了私有 `acquirePage`，两者都污染过结论）。
   *
   * ### 3. 因此现在的策略：**复用优先，失败才换页**
   *
   * ```
   * 默认（idleReuseMs = Infinity）  → 只要页面还在就复用（约 0.5 秒）
   * 任一次 mint 失败（F001 等）      → 丢弃该页、换新页重试一次（自愈链）
   * ```
   *
   * ⚠ 原来的「预测式换页」让**每次空闲后都白付约 2.7 秒**建页成本 ——
   * 这正是用户报障「一键签到里 ZCode 很久」的成因（而不是 captcha 慢）。
   * 改成失败兜底后：**常态省约 2.7 秒、不增加 captcha 调用次数**，
   * 真遇到 `F001` 时的自愈能力与原来一致（甚至更快：
   * 原来"先换页"是必然付费，现在只在真失败时才付）。
   */
  /**
   * 产出 captcha param，**并报告本次是否被降级为交互式验证**。
   *
   * ## 为什么需要（对齐官方 ZCode 的观测，2026-10-01）
   *
   * 官方闭源版对每次产出结果都会区分并上报（`out/renderer/assets/styles-*.js`）：
   *
   * ```js
   * mnn({ result: e ? 'interactive_displayed' : 'traceless_passed', … })
   * // pnn() 里维护 traceless_passed_count / captcha_displayed_count
   * ```
   *
   * 那是它判断**设备信誉是否在恶化**的手段 —— 而此前我们没有任何这个数，
   * 排查「为什么突然 502 mint failed」时只能靠猜（这正是本次最缺的东西）。
   *
   * ⚠ 与 {@link mint} 的关系：那个是「只要 param」的既有签名（多处调用），
   * 这个是它的**超集**，内部复用同一条产出路径 —— 不要各写一份。
   */
  async mintWithOutcome(
    config: ZcodeCaptchaConfig = ZCODE_CAPTCHA_FALLBACK,
    options: { signal?: AbortSignal } = {},
  ): Promise<CaptchaMintOutcome> {
    return await this.mintInternal(config, options)
  }

  /**
   * 产出 captcha param。
   *
   * ## 复用策略（⚠ 空闲失效，见本方法上方的实测表）
   *
   * ```
   * 默认（idleReuseMs = Infinity）→ 复用（约 0.5 秒）
   * 任一次 mint 失败（F001 等）    → 丢弃页面、换新重试一次
   * ```
   *
   * ⚠ **不再按空闲时长预测式换页**（2026-10-01 修正）：原「空闲 15 秒必然
   * 失效」的推论在变量分离复测中**无法复现**，详见 `mintInternal` 上方的
   * 完整对照表。预测式换页让每次空闲后白付约 2.7 秒。
   */
  async mint(
    config: ZcodeCaptchaConfig = ZCODE_CAPTCHA_FALLBACK,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    return (await this.mintInternal(config, options)).param
  }

  /** `mint` / `mintWithOutcome` 的共用实现（**唯一**的产出路径）。 */
  private async mintInternal(
    config: ZcodeCaptchaConfig,
    options: { signal?: AbortSignal },
  ): Promise<CaptchaMintOutcome> {
    await this.start()
    /**
     * ⚠ 最多两次：第一次用（可能复用的）页面，失败则**丢掉它换新**再试。
     *
     * 第二次仍失败才上抛 —— 那种情况通常是服务端限频/风控，
     * 换页面也救不了（实测过：全新浏览器也失败）。
     */
    const attempts = 2
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      /**
       * ⚠ 每轮先看中断：用户点了「停止」就不该再开新一轮
       * （否则会出现「停了还在后台 mint」的错觉）。
       */
      if (options.signal?.aborted === true) {
        throw lastError ?? new Error('zcode: captcha 产出已取消')
      }
      const forceFresh = attempt > 1
      const page = await this.acquirePage(forceFresh, options.signal)
      try {
        const outcome = await this.mintOnPage(page, config)
        page.lastUsedAt = Date.now()
        return outcome
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        /**
         * ⚠ **失败的页面必须作废**：它已进入坏的 captcha 会话状态，
         * 留在池里会让下一次也失败（实测：失败页面上再 mint 依然 `F001`）。
         */
        this.discardPage(page)
        if (attempt < attempts) {
          // 换新页面前稍微让一下，避免与刚作废的会话竞争。
          await sleep(300)
        }
      } finally {
        /**
         * ⚠⚠ **必须无条件复位 `pageBusy`**（真实缺陷，2026-09-29）。
         *
         * 旧写法是 `if (this.reusablePage === page) this.releasePage(page)` ——
         * 而 catch 里已经 `discardPage(page)`（它把 `reusablePage` 置空），
         * 于是这个条件**恒为假**，`pageBusy` 永远停在 `true`。
         * 下一次 `acquirePage()` 就卡在 `while (this.pageBusy) await sleep(50)`
         * 里永久自旋 ⇒ 适配器的 `await this.mintCaptcha()` 永不返回，
         * 请求根本不发出，UI 永远「深度求索中」。
         *
         * 故这里补上 else 分支：`pageBusy = false` 原本只出现在
         * `releasePage` / `kill` 里，而那两条都不是本路径的必然出口。
         */
        if (this.reusablePage === page) this.releasePage(page)
        else this.pageBusy = false
      }
    }
    throw lastError ?? new Error('zcode: captcha 产出失败（未知原因）')
  }

  /** 在**指定页面**上跑一次 captcha（不含页面获取/重试逻辑）。 */
  private async mintOnPage(page: CaptchaPage, config: ZcodeCaptchaConfig): Promise<CaptchaMintOutcome> {
    /**
     * ★★ **复用已就绪的页面时，跳过 DOM 重置与 SDK 注入**（2026-10-01 修正）。
     *
     * ## 为什么（真实缺陷，且此前被误判为「空闲失效」）
     *
     * 旧实现**每次**都做：
     *
     * ```js
     * ① document.body.innerHTML = '<div id="captcha-container">…'  // 销毁旧元素
     * ② buildSdkInjectExpression()   // SDK 已加载 ⇒ 返回 'already'（**不重建实例**）
     * ③ initAliyunCaptcha({element:'#captcha-element', button:<新元素>})
     * ```
     *
     * ⚠ ①②③ 互相踩：SDK 的实例仍绑定 ① **已销毁**的旧元素，
     * 于是发起验证时服务端回 `F001`。
     *
     * **实测取证**（同一页面、跨轮、每轮先空闲 20 秒）：
     *
     * | 场景 | `inject` 返回 | 结果 |
     * |---|---|---|
     * | 页面未重新导航（SDK 已加载 ⇒ 早退） | `already` | ✗ **F001 ×3**（471/454/591ms） |
     * | 每轮重新导航（SDK 全新加载） | `function` | ✓ 成功 ×2（755/670ms） |
     *
     * ⇒ **`F001` 与"空闲时长"无关**，真正的变量是「DOM 被重置而 SDK 未重建」。
     * 这纠正了 2026-09-29 的误判 —— 当时据此加了「空闲 8 秒就换页」的
     * 预测式重建，让**每次空闲后白付约 2.7 秒**（用户报障「签到很久」的成因）。
     *
     * ## 修法
     *
     * ```
     * 页面是**新建的**（首次使用） → 完整准备：重置 DOM + 注入 SDK
     * 页面是**复用且已就绪**的         → **跳过**，直接用（元素与实例都还匹配）
     * ```
     *
     * ⚠ 为什么跳过是安全的：`mint` 成功**不会移除** `#captcha-element` /
     * `#captcha-button`（实测：空闲前后 `el=true btn=true sdk=function`）。
     * 既然元素与实例都还在，重置 DOM 反而是**破坏**它们。
     *
     * ⚠ 若页面状态不明（`prepared` 未标记），仍走完整准备 —— 保守优先。
     */
    if (page.prepared !== true) {
      await page.cdp.send('Runtime.evaluate', { expression: buildDomExpression(), returnByValue: true })

      const injected = await page.cdp.send('Runtime.evaluate', {
        expression: buildSdkInjectExpression(),
        awaitPromise: true,
        returnByValue: true,
      })
      const injectedType = (injected as { result?: { value?: unknown } })?.result?.value
      if (injectedType !== 'function' && injectedType !== 'already') {
        throw new Error(`zcode: 阿里云 captcha SDK 未加载（${String(injectedType)}）`)
      }
      page.prepared = true
    }

    const minted = await page.cdp.send('Runtime.evaluate', {
      expression: buildMintExpression(config),
      awaitPromise: true,
      returnByValue: true,
    }, 75_000)

    const raw = (minted as { result?: { value?: unknown } })?.result?.value
    let parsed: { stage?: string; param?: string; err?: string; interactive?: unknown }
    try {
      parsed = JSON.parse(String(raw)) as typeof parsed
    } catch {
      throw new Error(`zcode: captcha 结果无法解析（${String(raw).slice(0, 160)}）`)
    }
    if (parsed.stage !== 'success' || typeof parsed.param !== 'string') {
      throw new Error(
        `zcode: captcha 产出失败（stage=${parsed.stage ?? '?'}` +
          `${parsed.err !== undefined ? `, err=${parsed.err}` : ''}）`,
      )
    }
    const verdict = validateCaptchaParam(parsed.param)
    if (!verdict.ok) {
      throw new Error(`zcode: captcha param 不可用（${verdict.reason ?? '未知'}）`)
    }
    /**
     * ⚠ `interactive` 缺失时取 `false`（保守）：我们**只在明确观察到弹窗时**
     * 才认定被降级。宁可不报（少一次误导性告警），也不要把正常无感通过
     * 错报成降级 —— 那会让用户以为信誉出了问题而去做无谓处置。
     */
    return { param: parsed.param, interactive: parsed.interactive === true }
  }

  /**
   * 取一个可用的页面。
   *
   * ## 复用策略：**复用优先，失败才换页**
   *
   * ```
   * forceFresh = true            → 丢弃旧页、建新页（`mint()` 第一次失败后的重试）
   * 空闲 > idleReuseMs           → 丢弃旧页、建新页（默认 Infinity ⇒ 不触发）
   * 否则                          → 复用（约 0.5 秒）
   * ```
   *
   * ⚠ **默认不再按空闲时长换页**（2026-10-01 修正）：原「空闲 15 秒必然
   * `F001`」的推论在变量分离复测中**无法复现**（空闲 20 秒后直接复用
   * 仍 3/3 成功、约 0.47 秒），而每次换页要付约 2.7 秒。
   * 详见 `ZcodeCaptchaBrowserOptions.idleReuseMs` 的完整说明。
   *
   * ⚠ 串行化：captcha 是**一次性**的，两个并发 mint 共用同一页面会互相
   * 踩状态。故用 `busy` 标志把取页串起来 —— 并发调用会排队，
   * 而不是拿到同一个页面。
   */
  private async acquirePage(forceFresh = false, signal?: AbortSignal): Promise<CaptchaPage> {
    /**
     * ⚠ 等待必须**有界且可取消**（真实缺陷，2026-09-29）。
     *
     * 旧实现是裸的 `while (this.pageBusy) await sleep(50)`：一旦某个持有者
     * 没能复位标志（见 `mint()` 的 finally），这里就是**永久自旋** ——
     * 而它既不看 signal 也没有上限，于是表现为「请求根本不发出 +
     * 用户点停止也无反应」，只能重启宿主。
     *
     * ⚠ 超时**不**复位 `pageBusy`：此刻它属于**另一个**持有者，
     * 越权复位会让两个 mint 同时用同一页面（captcha 是一次性的，必串状态）。
     */
    const waitTimeoutMs = this.options.pageWaitTimeoutMs ?? 30_000
    const deadline = Date.now() + waitTimeoutMs
    while (this.pageBusy) {
      if (signal?.aborted === true) throw new Error('zcode: captcha 取页等待已取消')
      if (Date.now() >= deadline) {
        throw new Error(
          `zcode: captcha 页面被占用超过 ${waitTimeoutMs}ms（疑似上一次 mint 未归还）`,
        )
      }
      await sleep(50)
    }
    this.pageBusy = true

    /**
     * ★ **复用优先，失败才换页**（默认 `Infinity` = 不因空闲换页）。
     *
     * 见 `ZcodeCaptchaBrowserOptions.idleReuseMs` 的完整说明：
     * 原默认 8 秒基于「空闲 15 秒必然 F001」这条推论，而它在 2026-10-01 的
     * 严格复测中**无法复现** —— 空闲 20 秒后直接复用仍 3/3 成功（约 0.47 秒），
     * 而每次换页要付约 2.7 秒。用户报障的「签到很久」正源于此。
     *
     * 失败时 `mint()` 的 `attempt > 1` 会传 `forceFresh = true` 换页重试，
     * 故**自愈能力不变**。
     */
    const idleReuseMs = this.options.idleReuseMs ?? Number.POSITIVE_INFINITY
    const existing = this.reusablePage
    if (existing !== undefined) {
      const idle = Date.now() - existing.lastUsedAt
      if (!forceFresh && idle <= idleReuseMs) return existing
      /**
       * ⚠ 该换新了 —— **必须先丢弃**（关闭它），否则页面会累积，
       * 且旧的坏会话可能仍有副作用。
       */
      this.discardPage(existing)
    }

    const browser = this.browserCdp
    if (browser === undefined) {
      this.pageBusy = false
      throw new Error('zcode: 浏览器未就绪')
    }
    /**
     * ⚠ `createTarget` 必须包在 try 里（真实缺陷，2026-09-29）：它走 CDP，
     * 超时（30s）或浏览器僵死时会**抛错**，而旧代码把它放在 try 之外 ——
     * 抛出后 `pageBusy` 不复位 ⇒ 后续**每一次** mint 都在自旋里死等。
     */
    let targetId: string | undefined
    try {
      const created = await browser.send('Target.createTarget', { url: 'about:blank' }) as {
        targetId?: unknown
      }
      targetId = typeof created.targetId === 'string' ? created.targetId : undefined
    } catch (error) {
      this.pageBusy = false
      throw error
    }
    if (targetId === undefined) {
      this.pageBusy = false
      throw new Error('zcode: 无法新建页面 target')
    }

    let ws: WebSocket | undefined
    try {
      const targets = await (await fetch(`http://127.0.0.1:${this.port}/json/list`, {
        signal: AbortSignal.timeout(5_000),
      })).json() as Array<{ id?: unknown; webSocketDebuggerUrl?: unknown }>
      const target = targets.find((item) => item.id === targetId)
      if (typeof target?.webSocketDebuggerUrl !== 'string') {
        throw new Error('zcode: 新页面没有可用的调试地址')
      }
      ws = new WebSocket(target.webSocketDebuggerUrl)
      const connectTimeoutMs = this.options.connectTimeoutMs ?? 10_000
      await new Promise<void>((resolve, reject) => {
        /**
         * ⚠ **必须有超时**（真实缺陷，2026-09-29）：旧实现只等 `open` / `error`，
         * 而 Chromium 僵死时**两个事件都不会来** —— 永久挂起；更糟的是
         * 它不抛错，`pageBusy` 也就不会复位（下一轮直接死锁）。
         *
         * ⚠ signal 也要接进来：用户点「停止」时不该继续等建连。
         */
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }
        const done = (settle: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          settle()
        }
        const onAbort = (): void => done(() => reject(new Error('zcode: 连接新页面已取消')))
        timer = setTimeout(
          () => done(() => reject(new Error(`zcode: 连接新页面超时（${connectTimeoutMs}ms）`))),
          connectTimeoutMs,
        )
        timer.unref?.()
        ws?.addEventListener('open', () => done(resolve), { once: true })
        ws?.addEventListener('error', () => done(() => reject(new Error('zcode: 连接新页面失败'))), { once: true })
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      const cdp = new CdpConnection(ws)
      await cdp.send('Page.enable')
      await cdp.send('Runtime.enable')
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_PATCH })
      /**
       * ⚠ **导航到真实 https origin**（不是 `about:blank`）——
       * 这是能否重复 mint 的关键（实测 1/3 → 5/5）。
       */
      await cdp.send('Page.navigate', { url: resolveCaptchaPageOrigin(this.options) })
      // 等 DOM 可用（domcontentloaded 之后 body 就存在了）。
      await sleep(this.options.navigationWaitMs ?? 1_500)
      const page: CaptchaPage = { targetId, ws, cdp, lastUsedAt: Date.now() }
      this.reusablePage = page
      return page
    } catch (error) {
      try { ws?.close() } catch { /* 已关闭 */ }
      this.pageBusy = false
      try {
        await fetch(`http://127.0.0.1:${this.port}/json/close/${targetId}`, {
          signal: AbortSignal.timeout(3_000),
        })
      } catch { /* ignore */ }
      throw error
    }
  }

  /**
   * 作废一个页面：关掉它、从池里摘掉。
   *
   * ⚠ **必须真的关闭 target**（不只是清引用）—— 否则页面会累积，
   * 且每个坏页面都占着一份 SDK 实例。
   *
   * ⚠ 关不掉也不抛错：这是清理路径，不该因为清理失败而让 mint 报错。
   */
  private discardPage(page: CaptchaPage): void {
    if (this.reusablePage === page) this.reusablePage = undefined
    try { page.cdp.close() } catch { /* 已关闭 */ }
    try { page.ws.close() } catch { /* 已关闭 */ }
    void (async () => {
      try {
        await fetch(`http://127.0.0.1:${this.port}/json/close/${page.targetId}`, {
          signal: AbortSignal.timeout(3_000),
        })
      } catch { /* 关不掉也无妨 */ }
    })()
  }

  /** 归还页面（保留复用）。 */
  private releasePage(page: CaptchaPage): void {
    void page
    this.pageBusy = false
  }

  /**
   * 终止浏览器进程**树**并清理所有 CDP 连接。
   *
   * ## ⚠ 为什么必须杀**整棵树**（真实缺陷）
   *
   * 早期只写 `this.child?.kill()` —— 那只杀**主进程**。而 Chromium 是
   * **多进程架构**（browser / gpu / renderer / utility 各一个进程），
   * 主进程被 `SIGTERM` 后**子进程会变成孤儿继续运行**。
   *
   * 实测证据（一次被中断的测试后）：
   *   - **12 个** 残留 `chrome.exe` 全指向同一个 `--user-data-dir`
   *   - **28 个**残留的 `zcode-captcha-*` 临时 profile 目录
   *
   * 生产影响：**每次会话泄漏约 200MB**（一个 Chromium 实例），
   * 且残留进程占着调试端口，会干扰后续启动（曾让一次 `max` 档位测试
   * 表现得像「卡住 80 秒」，实为旧实例干扰）。
   *
   * 修法：POSIX 用进程组（`detached: true` + `kill(-pid)`），
   * Windows 用 `taskkill /T /F`（`/T` = 含子进程树）。
   */
  private kill(): void {
    try { this.reusablePage?.cdp.close() } catch { /* 已关闭 */ }
    try { this.reusablePage?.ws.close() } catch { /* 已关闭 */ }
    this.reusablePage = undefined
    this.pageBusy = false
    try { this.browserCdp?.close() } catch { /* 已关闭 */ }
    try { this.browserWs?.close() } catch { /* 已关闭 */ }
    this.browserCdp = undefined
    this.browserWs = undefined
    this.killProcessTree()
  }

  /**
   * 终止浏览器及其**全部子进程**。
   *
   * ⚠ 不能退回成 `child.kill()`（见 {@link kill} 的说明：会留下孤儿）。
   *
   * ⚠⚠ **必须同步等它做完**（真实缺陷）：早期用异步 `spawn('taskkill', …)`
   * 后立即返回 —— 调用方以为清理完了、紧接着启动下一轮，而旧实例**还活着
   * 占着端口**。若下一轮随机撞到同一端口就会串成：
   * 连到旧实例 → `child` 指向已退出的新进程 → `dispose()` 打空 →
   * **旧实例整棵树泄漏**（实测 10~14 个进程）。
   *
   * 实测对照：`dispose()` 后**立即**下一轮会偶发泄漏；
   * 每轮间隔 2.5 秒则 5/5 干净 —— 正是「没等它退完」的特征。
   *
   * 故改用 `spawnSync`：清理路径阻塞几十毫秒是可接受的，
   * 换来确定性的「返回即已终止」。
   */
  private killProcessTree(): void {
    const child = this.child
    this.child = undefined
    if (child === undefined || child.pid === undefined) return
    const pid = child.pid
    if (process.platform === 'win32') {
      /**
       * ⚠ Windows 没有进程组信号，用 `taskkill /T`（树）+ `/F`（强制）。
       * 必须 `stdio: 'ignore'`：某些沙箱下捕获子进程输出会 EPERM，
       * 而这是清理路径，不该因此失败。
       */
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          // 最多等 10 秒（正常几十毫秒；卡住说明系统异常，别无限等）。
          timeout: 10_000,
        })
      } catch { /* 尽力而为 */ }
      // 兜底：万一 taskkill 不可用，至少杀掉主进程。
      try { child.kill() } catch { /* 已退出 */ }
      return
    }
    /**
     * POSIX：`detached: true` 时子进程自成进程组，负 pid 即整组。
     * ⚠ 失败（ESRCH 等）就退回单进程 kill。
     */
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }
  }

  /** 关闭浏览器并清理临时 profile。 */
  dispose(): void {
    this.kill()
    const dir = this.profileDir
    this.profileDir = undefined
    if (dir === undefined) return
    /**
     * ⚠ 删除要**重试几次**：chromium 的子进程刚被 taskkill 掉，
     * 句柄释放有延迟 —— 一次性 `rmSync` 实测会留下 28 个残留目录。
     * 用退避重试（100/500/1500ms），全部失败就交给系统回收临时目录。
     */
    const attempts = [0, 100, 500, 1_500]
    const tryRemove = (index: number): void => {
      if (index >= attempts.length) return
      const delay = attempts[index]
      const run = (): void => {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          tryRemove(index + 1)
        }
      }
      if (delay === 0) run()
      else setTimeout(run, delay).unref?.()
    }
    tryRemove(0)
  }
}

/**
 * 用户主目录（导出给测试注入用；避免测试真的去碰 `~/.zcode`）。
 *
 * 目前仅用于文档目的 —— 实际路径解析在 `zcode.ts` 的候选表里。
 */
export const ZCODE_HOME = homedir()
