import { spawn } from 'node:child_process'

/** 账号渠道共用的系统浏览器打开器。 */
export function openBrowser(url: string): void {
  const warn = (error: unknown): void => {
    console.error('[channel-pack] failed to open browser; open manually:', url, error)
  }
  const win = process.platform === 'win32'
  if (win) {
    // Windows 下 cmd /c start 会把 URL 中每个 '&' 当作命令分隔符，导致参数被截断
    // （浏览器只收到 '?theme=2'）。必须把整个 URL 加引号作为单个参数传给 cmd，
    // 并用 windowsVerbatimArguments 关闭 Node 的二次转义。start 的窗口标题参数
    // 必须显式传 '""'——空字符串参数会被 Node 丢弃，start 会把 URL 当成标题。
    const args = ['/c', 'start', '""', `"${url}"`]
    try {
      const child = spawn('cmd', args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      child.on('error', warn)
      child.unref()
      return
    } catch (error) {
      warn(error)
      return
    }
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' })
    child.on('error', warn)
    child.unref()
  } catch (error) {
    warn(error)
  }
}
