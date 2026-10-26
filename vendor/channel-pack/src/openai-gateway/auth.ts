import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const KEY_FILE = 'api-key'

/**
 * 密钥的形态判据：`randomBytes(32).toString('base64url')` 的产物。
 *
 * 32 字节 → base64url 定长 43 位，字符集为 `[A-Za-z0-9_-]`。**定长**是关键：
 * 它让「文件里是我们写的东西」这件事可以被机械判定，从而把「损坏」与
 * 「用户自己换过」区分开（见 {@link loadOrCreateApiKey}）。
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** 密钥的来源，供设置页展示与复制（**不要**在日志里打印 `value`）。 */
export interface ApiKeySource {
  /** 密钥本体。 */
  value: string
  /** 是否来自 `DSH_OPENAI_GATEWAY_API_KEY` 环境变量。 */
  fromEnv: boolean
  /**
   * 密钥文件路径；`fromEnv` 为真时为 `null`。
   *
   * 交给 UI 是为了让用户能自己核对/备份，而不必猜 DSH home 到底在哪 ——
   * 它可能来自 `profileContext.home`，未必是 `%USERPROFILE%\.dsh`。
   */
  path: string | null
}

/**
 * 读取网关密钥；没有时生成一次。
 *
 * ## 为什么「文件内容异常」要报错而不是换掉
 *
 * 初版是「读不到就重新生成」，看似自愈，实则有一个隐蔽后果：文件被误删或
 * 被手工改坏时，服务端会**悄悄换一个全新的 key**，所有已配置的客户端同时开始
 * 返回 `unauthorized`。而客户端只给这一句提示，用户无从判断是自己粘错了哪
 * 一位、还是服务端变了 —— 这类「重登一下就好了」之外毫无线索的故障极难排查。
 *
 * 因此这里区分三种情况：
 * - **文件不存在 / 内容为空** ⇒ 从未生成过，正常生成；
 * - **内容符合 {@link KEY_PATTERN}** ⇒ 是我们自己写的，采信；
 * - **内容有值但不符合** ⇒ 明确报错，并给出恢复办法（删掉文件让它重建，
 *   或改用 `DSH_OPENAI_GATEWAY_API_KEY`）。
 */
export function loadOrCreateApiKey(home: string, env: NodeJS.ProcessEnv = process.env): ApiKeySource {
  const configured = env.DSH_OPENAI_GATEWAY_API_KEY?.trim()
  if (configured) return { value: configured, fromEnv: true, path: null }

  const directory = join(home, 'openai-gateway')
  const path = join(directory, KEY_FILE)
  let stored: string | undefined
  try {
    stored = readFileSync(path, 'utf8').trim()
  } catch {
    // 文件不存在或不可读：走生成路径；写入失败会向调用方暴露。
  }

  if (stored) {
    if (KEY_PATTERN.test(stored)) return { value: stored, fromEnv: false, path }
    throw new Error(
      `网关密钥文件内容异常（不是本插件生成的形态）：${path}。`
      + '可能是被手工编辑或被其它程序改写；本插件不会静默更换它，否则已配置的客户端会全部失效。'
      + `如需更换：删除该文件后重启 DSH（会重新生成），或改用 DSH_OPENAI_GATEWAY_API_KEY 环境变量。`,
    )
  }

  const key = randomBytes(32).toString('base64url')
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, key, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temporary, path)
  } catch (error) {
    // 并发启动时另一进程可能已经落盘，优先复用它，避免生成两个有效密钥。
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim()
      if (KEY_PATTERN.test(existing)) return { value: existing, fromEnv: false, path }
    }
    throw error
  }
  return { value: key, fromEnv: false, path }
}
