/**
 * Qoder 设备身份：`Cosy-MachineToken` + `Cosy-MachineType`。
 *
 * ## 为什么需要它（真实缺陷，2026-09-25 用抓包 + 消融实验定位）
 *
 * 用户报障：「Qoder 没领过积分却显示『今日已领取』，去 IDE 看还是可领取」。
 *
 * 早期实现认为 `/sash/` 端点**只需 Bearer + `Cosy-ClientType`**（见
 * `qoder-credits.ts` 的旧注释）。该判断**不完整** —— 服务端还要校验
 * 设备身份，**缺少 machine 头族时不下发「可领取」的活动**。
 *
 * ### 证据（2026-09-21 抓包解密 + 逐项消融）
 *
 * 用户提供的 `qoder积分.pcapng` 配 `SSLKEYLOGFILE` 解密后，可见 native 请求
 * `/sash/api/v1/me/campaigns` 时带的头是：
 *
 * ```
 * cosy-clienttype:      10
 * cosy-version:         0.3.4
 * cosy-machineos:       x86_64_win32
 * cosy-machinehostname: DESKTOP-FSEE011
 * cosy-machineid:       8da07a0d-…
 * cosy-machinetoken:    P1gAtkTG…
 * cosy-machinecode:     1a743bcb766a88545c
 * cosy-machinetype:     f4c9a409144dcb6377
 * ```
 *
 * 同一账号当下的对照实验（只改请求头，其它全同）：
 *
 * | 请求头 | `/sash/api/v1/me/campaigns` |
 * |---|---|
 * | 仅 `Cosy-ClientType: 10` | `showCampaign:true, claimable:false`，**1 条** `VIEW_DETAILS` |
 * | ＋ `Cosy-MachineToken` ＋ `Cosy-MachineType` | `claimable:true`，**2 条**，含 `CLAIM_BENEFIT/CLAIMABLE/amount:100` |
 * | 全套 − `Cosy-MachineToken` | 退回 1 条（失效） |
 * | 全套 − `Cosy-MachineType` | 退回 1 条（失效） |
 * | 单独加任一头（不含配对） | 全部无效 |
 *
 * 结论：**`MachineToken` 与 `MachineType` 必须成对出现**，缺一即失效；
 * `Cosy-MachineId` / `Cosy-Version` / `MachineOS` / `MachineHostname` /
 * `MachineCode` 实测**均非必需**（去掉后仍能拿到活动）。
 *
 * 这解释了为什么只把 `Cosy-ClientType` 从 `5` 改成 `10` 仍不够 ——
 * 它是**必要但不充分**条件。
 *
 * ## 值的来源：本机 IDE 的 `machine_token.json`
 *
 * `%APPDATA%\Qoder\SharedClientCache\cache\machine_token.json`：
 *
 * ```json
 * { "token": "P1gA…", "type": "f677427e14abd0f6c1", "updateAt": 1774862945355 }
 * ```
 *
 * 即 `Cosy-MachineToken` = `token`，`Cosy-MachineType` = `type`。
 *
 * ⚠️ **实测该文件即使很旧（`updateAt` 为 179 天前）token 依然有效**，
 * 所以不做时效校验、也不因过期而拒发 —— 发出去最多是服务端忽略，
 * 而漏发会让用户看不到可领取的活动。
 *
 * ⚠️ **读不到时返回 undefined，调用方应照常发请求（只是不带这两个头）**：
 * 这与修复前的行为一致，属**保守降级** —— 用户若未安装 Qoder 桌面端
 * （纯插件登录的账号）就没有该文件，此时不能让整个积分功能报错。
 *
 * 为什么直接读文件而不自己生成 token：官方经 `runtime-info.exe`（UMID 模块）
 * 生成，其内部含设备指纹与签名逻辑，复刻代价高且属重复造轮子；而该文件
 * 就在本机、格式稳定，直接读更可靠（实测有效）。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * `runtime-info.exe` 的单次超时（毫秒）。
 *
 * 实测正常耗时约 **3.8 秒**（它是 bun/Go 单文件程序，启动开销占大头）。
 * 取 20 秒是给冷启动/杀软扫描留余量；超时即放弃并退回磁盘缓存 ——
 * 宁可少发一次头（回到修复前行为），也不要让积分查询长时间挂住。
 */
const RUNTIME_INFO_TIMEOUT_MS = 20_000

/** 设备身份的两个必需值。 */
export interface QoderMachineIdentity {
  /** 发送为 `Cosy-MachineToken`。 */
  token: string
  /** 发送为 `Cosy-MachineType`。 */
  type: string
}

/**
 * 缓存解析结果。
 *
 * - `undefined` = 尚未解析；
 * - `null` = 已解析过但**拿不到**（不重复读盘）；
 * - 对象 = 解析成功。
 *
 * 用模块级缓存是因为该值要参与**每次**积分请求的头构造，而文件读取是同步
 * IO；缓存后仅在首次调用时有代价。
 */
let cached: QoderMachineIdentity | null | undefined

/**
 * `machine_token.json` 的候选路径。
 *
 * ⚠️ **这只是「拿不到实时身份」时的最后退路**，不是主路径 ——
 * 实测该文件会长期陈旧（开发机上停在 179 天前且跑 `runtime-info.exe`
 * **不会**更新它），照它发头会让服务端**不下发可领活动**（见
 * {@link resolveQoderMachineIdentity} 的说明）。
 *
 * `QODER_MACHINE_TOKEN_PATH` 可覆盖（供单测隔离与排查用：默认路径落在用户真实
 * `%APPDATA%` 下，测试必须能指向 fixture，否则用例结果会随开发机是否装了
 * Qoder 桌面端而变）。
 */
/**
 * 磁盘缓存 `machine_token.json` 的候选路径（**退路**，主路径是实时 spawn）。
 *
 * ⚠️ 这份缓存可能**非常陈旧**（实测停在 179 天前，且跑 exe 也不会更新它），
 * 所以只在实时拿不到时才用它 —— 但「聊胜于无」：带了陈旧头至少比不带强。
 *
 * 桌面端在 `APPDATA` / `Application Support` / `.config` 下的目录名带空格
 * （`Qoder` / `Qoder CN`），**两站都列**：只装了其中一个的用户仍应有机会命中。
 * 读不到的文件会被 `parseFile` 静默跳过，多列无副作用。
 */
function candidatePaths(): readonly string[] {
  const override = process.env.QODER_MACHINE_TOKEN_PATH
  if (override !== undefined && override.length > 0) return [override]

  const paths: string[] = []
  const appData = process.env.APPDATA
  if (appData !== undefined && appData.length > 0) {
    for (const dir of ['Qoder', 'Qoder CN']) {
      paths.push(join(appData, dir, 'SharedClientCache', 'cache', 'machine_token.json'))
    }
  }
  const home = homedir()
  for (const dir of ['Qoder', 'Qoder CN']) {
    paths.push(join(home, 'Library', 'Application Support', dir, 'SharedClientCache', 'cache', 'machine_token.json'))
    paths.push(join(home, '.config', dir, 'SharedClientCache', 'cache', 'machine_token.json'))
  }
  return paths
}

/** 从单个文件解析；形状不符或读取失败返回 undefined。 */
function parseFile(path: string): QoderMachineIdentity | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // 文件不存在 / 无权限：正常降级，不抛错。
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const token = record.token
  const type = record.type
  // 两者必须都是**非空字符串**：缺任一即无法配对，而配对是服务端下发活动的必要条件
  // （见模块头部的消融表），故视为拿不到而不是发一半。
  if (typeof token !== 'string' || token.length === 0) return undefined
  if (typeof type !== 'string' || type.length === 0) return undefined
  return { token, type }
}

/**
 * 解析本机 Qoder 设备身份；拿不到返回 `undefined`。
 *
 * ## 主路径：**实时**调 `runtime-info.exe` 生成
 *
 * ⚠️ **真实缺陷（用户报障，2026-09-26）**：新注册/新登录的 Qoder 账号，
 * 一键领取报「当前没有可领取的活动」，而 IDE 里该账号**可以领**。
 *
 * 根因有**两层**，第二层才是真正的：
 *
 * **① 初版读磁盘缓存**（`machine_token.json`）—— 那是 `runtime-info.exe` 的
 * 一份**陈旧缓存**（实测停在 179 天前，且**跑 exe 也不会更新它**）。
 * 改为实时 spawn 后**部分**账号恢复，但新账号仍失败。
 *
 * **② 实时 spawn 时漏了 `environment` 位置参数**（真正的根因）。
 * 必须调 `runtime-info.exe <environment> --account-stdin`；漏掉第一个参数会
 * 拿到**另一套身份**，服务端因而只回 1 条 `VIEW_DETAILS`：
 *
 * | 调用 | machineType | 服务端下发的活动 |
 * |---|---|---|
 * | 只传 `--account-stdin`（漏 env） | `15e6683914666dab9f` | 仅 1 条 `VIEW_DETAILS` |
 * | **`3 --account-stdin`（IDE 实际）** | **`3582ddfb14d9bf289a`** | **`CLAIM_BENEFIT/CLAIMABLE/100`** |
 *
 * 后者与 IDE 实时抓包（`qoder-live.pcapng`）**逐字节一致**。取值与理由见
 * {@link RUNTIME_INFO_ENVIRONMENT}。
 *
 * ⚠️ **曾因此得出错误结论**：漏参数时对**任何**账号都返回同一套 fallback
 * 身份，看起来「identity 是设备级、与账号无关」。该推断是**错的** ——
 * 身份随 `environment` 变化，必须与 IDE 用同一值。
 *
 * 不过「**进程内缓存**」这一点仍然成立且必需：单次 spawn 实测约 **3.8 秒**，
 * 每次请求都跑会让积分查询慢到不可用；且同一进程内 identity 不会变。
 *
 * ## 退路：实时拿不到时才读磁盘缓存
 *
 * 未安装 Qoder 桌面端（无 exe）时退回读 `machine_token.json`；
 * 两者都拿不到则返回 `undefined`，调用方**不带这两个头**（保守降级）。
 *
 * 结果被缓存（含「拿不到」这一结果）。
 *
 * @param forceExecutable 仅供测试注入（跳过真实 spawn）
 */
export function resolveQoderMachineIdentity(
  forceExecutable?: string,
): QoderMachineIdentity | undefined {
  if (cached !== undefined) return cached ?? undefined
  // 主路径：实时生成
  const live = readFromRuntimeInfo(forceExecutable)
  if (live !== undefined) {
    cached = live
    return live
  }
  // 退路：磁盘缓存（可能陈旧，但聊胜于无）
  for (const path of candidatePaths()) {
    const identity = parseFile(path)
    if (identity !== undefined) {
      cached = identity
      return identity
    }
  }
  cached = null
  return undefined
}

/**
 * 异步版：语义与 {@link resolveQoderMachineIdentity} 相同，但**不阻塞事件循环**。
 *
 * ⚠️ 积分端点在 Cordis 里是 async 上下文，而 spawn 要 ~3.8 秒 —— 用同步
 * `execFileSync` 会把整个事件循环卡住（连带 Web GUI 的其他请求），
 * 故生产路径用本函数。
 */
export async function resolveQoderMachineIdentityAsync(
  forceExecutable?: string,
): Promise<QoderMachineIdentity | undefined> {
  if (cached !== undefined) return cached ?? undefined
  const live = await readFromRuntimeInfoAsync(forceExecutable)
  if (live !== undefined) {
    cached = live
    return live
  }
  for (const path of candidatePaths()) {
    const identity = parseFile(path)
    if (identity !== undefined) {
      cached = identity
      return identity
    }
  }
  cached = null
  return undefined
}

/**
 * 本机 Qoder 系客户端的数据目录名（相对 home，**按顺序尝试**）。
 *
 * ⚠️ 这是**模块常量而不是产品字段**：实测（设计文档 E12）中国版与国际版的
 * `runtime-info.exe` **SHA256 相同**，在同一 `environment` 下返回**逐字节相同**的
 * machine 身份 —— 身份由「设备 + environment」决定，与产品无关。
 * 把它挂进 `QoderProduct` 会让人误以为「一个产品认一个目录」（误导性的抽象），
 * 而且除了本文件没有任何调用方会读它（死配置）。
 *
 * 列两个目录的唯一目的：让**只装了其中一个客户端**的用户也能拿到身份。
 */
const QODER_DATA_DIR_NAMES: readonly string[] = ['.qoder', '.qoder-cn']

/**
 * 在给定 home 下按 `dataDirNames` 顺序定位 `runtime-info.exe`。
 *
 * 路径形态：`<home>/<dataDir>/.bin/umid-<platform>-<hash>/runtime-info(.exe)`
 * —— **目录名带哈希**（随版本变），故必须枚举而不能写死。
 *
 * ⚠️ 必须遍历**多个**数据目录（真实缺陷）：原先只认国际版的 `.qoder`，于是
 * 「只装了中国版」的用户找不到 exe → 退到陈旧磁盘缓存 → 拿不到 machine 头 →
 * `/sash/api/v1/me/campaigns` 只回 `VIEW_DETAILS` → 插件误报「今天已领」。
 * 那正是 2026-09-25 那次修复的复发路径。
 *
 * ⚠️ 某个目录存在但 exe 缺失时**继续试下一个**，不能就此返回 undefined ——
 * 半安装/清理残留会留下 `.bin/umid-*` 空目录。
 *
 * 导出是为了让单测能传入临时 home；生产路径由 {@link locateRuntimeInfo} 调。
 */
export function findRuntimeInfoExecutable(
  home: string,
  dataDirNames: readonly string[] = QODER_DATA_DIR_NAMES,
): string | undefined {
  const exeName = process.platform === 'win32' ? 'runtime-info.exe' : 'runtime-info'
  for (const dirName of dataDirNames) {
    const binDir = join(home, dirName, '.bin')
    let entries: string[]
    try {
      entries = readdirSync(binDir)
    } catch {
      // 该目录不存在（未安装该版本）：试下一个
      continue
    }
    const dir = entries.find((name) => name.startsWith('umid-'))
    if (dir === undefined) continue
    const exe = join(binDir, dir, exeName)
    if (existsSync(exe)) return exe
  }
  return undefined
}

/**
 * 定位本机 `runtime-info.exe`（生产入口）。
 *
 * ⚠️ `QODER_RUNTIME_INFO` 可覆盖（**供单测隔离**：默认会真的 spawn 开发机上
 * 的可执行文件，单测必须能把它指到不存在的路径以强制走磁盘缓存退路，
 * 否则用例结果随「开发机是否装了 Qoder 桌面端」而变，且每次跑 3.8 秒）。
 * 指向不存在的路径即等价于「未安装」。
 */
function locateRuntimeInfo(override?: string): string | undefined {
  const fromEnv = process.env.QODER_RUNTIME_INFO
  const candidate = override ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined)
  if (candidate !== undefined) {
    // 显式指定的路径必须真实存在，否则视为「没有可执行文件」而走退路。
    return existsSync(candidate) ? candidate : undefined
  }
  return findRuntimeInfoExecutable(homedir())
}

/**
 * `runtime-info.exe` 的第一个位置参数 `environment`。
 *
 * ⚠️ **不可省略**（真实缺陷，2026-09-26 由实时抓包定位）。asar 源码：
 *
 * ```js
 * function LWe(t) {
 *   const e = t.platform === 'darwin' || t.platform === 'win32'
 *   const A = lI(t.executablePath,
 *     e ? [String(t.environment), '--account-stdin'] : [String(t.environment)],
 *     …)
 * }
 * function O3e(t, e) {
 *   return OWe({ …, environment: e === 'global' ? 3 : 0 })
 * }
 * ```
 *
 * 即**环境值是第一个参数、`--account-stdin` 在其后**。
 *
 * ## 漏传它会拿到「另一套身份」，且症状极具迷惑性
 *
 * 实测（同一账号，只改这一个参数）：
 *
 * | 调用 | machineType | machineCode | 服务端下发的活动 |
 * |---|---|---|---|
 * | 只传 `--account-stdin`（漏 env） | `15e6683914666dab9f` | `7a08a919764bd8648a` | 仅 1 条 `VIEW_DETAILS` |
 * | **`3 --account-stdin`（IDE 实际）** | **`3582ddfb14d9bf289a`** | **`c1ecbb8c76c9ad3616`** | **`CLAIM_BENEFIT/CLAIMABLE/100`** |
 *
 * 后者的 token/type/code **与 IDE 抓包逐字节一致**（`qoder-live.pcapng`）。
 *
 * ⚠️ **这曾导致一个错误的结论**：漏参数时对**任何**账号都返回同一套
 * fallback 身份，于是看起来「身份是设备级、与账号无关」。我当时据此写下
 * 了错误注释 —— 现在改为：身份**随 environment 变化**，且必须与 IDE 用同一个值。
 *
 * 取 `3`（对应源码的 `'global'` 分支）：本机 IDE 抓包实测用的就是它。
 */
const RUNTIME_INFO_ENVIRONMENT = '3'

/**
 * 构造 `runtime-info.exe` 的参数。
 *
 * 顺序**必须**是 `[environment, '--account-stdin']` —— 与 asar 源码一致。
 *
 * ⚠️ **导出仅供测试**：`runtime-info-args` 的回归用例直接断言这个数组，
 * 因为单测路径刻意禁用了真实 spawn（见 `vitest.config.ts`），
 * 若不可导出就**无法用单测锁住参数形态** —— 而漏参数正是本函数出过的缺陷。
 */
export function runtimeInfoArgs(): readonly string[] {
  return [RUNTIME_INFO_ENVIRONMENT, '--account-stdin']
}

/**
 * 从 `runtime-info.exe` 的输出里取出身份。
 *
 * 输出形如（单行 JSON）：
 * ```json
 * {"machineToken":"P1gA…","machineType":"15e6…","machineCode":"7a08…",
 *  "vmInfo":{…},"accountOutcome":"success"}
 * ```
 *
 * ⚠️ 即便 `accountOutcome` 不是 `success`（如 `invalid_input`），
 * `machineToken` / `machineType` 仍然返回 —— 实测该身份与传入的
 * `account` 字段无关（由 environment 与设备决定），故不因账号字段而丢弃。
 */
function parseRuntimeInfoOutput(out: string): QoderMachineIdentity | undefined {
  const start = out.indexOf('{')
  if (start < 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(out.slice(start))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const token = record.machineToken
  const type = record.machineType
  if (typeof token !== 'string' || token.length === 0) return undefined
  if (typeof type !== 'string' || type.length === 0) return undefined
  return { token, type }
}

/**
 * 同步实时生成身份（供同步调用方与测试）。
 *
 * ⚠️ 实测约 **3.8 秒**，生产路径请用异步版（见
 * {@link resolveQoderMachineIdentityAsync}），否则会阻塞事件循环。
 */
function readFromRuntimeInfo(override?: string): QoderMachineIdentity | undefined {
  const exe = locateRuntimeInfo(override)
  if (exe === undefined) return undefined
  try {
    const out = execFileSync(exe, [...runtimeInfoArgs()], {
      input: JSON.stringify({ account: '' }),
      encoding: 'utf8',
      timeout: RUNTIME_INFO_TIMEOUT_MS,
      windowsHide: true,
    })
    return parseRuntimeInfoOutput(out)
  } catch {
    // 超时 / spawn 失败：交给退路（磁盘缓存）或降级
    return undefined
  }
}

/** 异步实时生成身份（生产路径）。 */
async function readFromRuntimeInfoAsync(override?: string): Promise<QoderMachineIdentity | undefined> {
  const exe = locateRuntimeInfo(override)
  if (exe === undefined) return undefined
  return await new Promise<QoderMachineIdentity | undefined>((resolve) => {
    let settled = false
    const done = (value: QoderMachineIdentity | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(exe, [...runtimeInfoArgs()], { windowsHide: true })
    } catch {
      done(undefined)
      return
    }
    const timer = setTimeout(() => {
      // 超时即放弃并 kill，避免留下孤儿进程
      try { child.kill() } catch { /* 忽略 */ }
      done(undefined)
    }, RUNTIME_INFO_TIMEOUT_MS)
    timer.unref?.()

    let stdout = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    // stderr 不用于判定，但必须消费掉，否则管道填满会让子进程阻塞
    child.stderr?.on('data', () => {})
    child.once('error', () => { clearTimeout(timer); done(undefined) })
    child.once('close', () => {
      clearTimeout(timer)
      done(parseRuntimeInfoOutput(stdout))
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify({ account: '' }))
  })
}

/** 仅供测试：清空缓存（生产代码不需要）。 */
export function resetQoderMachineIdentityCache(): void {
  cached = undefined
}

/**
 * 把设备身份并入请求头。
 *
 * 拿不到身份时**原样返回**，不写空串 —— 发空头会让服务端可能按非法设备处理，
 * 漏发才是安全的降级（与修复前行为一致）。
 *
 * 同步版：只在身份**已缓存**时才会命中；否则请用
 * {@link withQoderMachineHeadersAsync}。
 */
export function withQoderMachineHeaders(headers: Record<string, string>): Record<string, string> {
  const identity = resolveQoderMachineIdentity()
  if (identity === undefined) return headers
  return {
    ...headers,
    // 两者必须同时出现（见模块头部消融表：缺一即拿不到可领活动）。
    'Cosy-MachineToken': identity.token,
    'Cosy-MachineType': identity.type,
  }
}

/** 异步版：生产路径用（首次会真实 spawn，约 3.8 秒，之后走缓存）。 */
export async function withQoderMachineHeadersAsync(
  headers: Record<string, string>,
  forceExecutable?: string,
): Promise<Record<string, string>> {
  const identity = await resolveQoderMachineIdentityAsync(forceExecutable)
  if (identity === undefined) return headers
  return {
    ...headers,
    'Cosy-MachineToken': identity.token,
    'Cosy-MachineType': identity.type,
  }
}
