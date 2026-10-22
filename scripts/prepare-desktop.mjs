import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
export const resourceDirectory = path.join(repositoryRoot, 'packages/desktop/src-tauri/resources')

/** 明确选择应用资源，排除用户目录、工具索引、依赖及构建缓存。 */
export function stageDesktopService(destination) {
  fs.mkdirSync(destination, { recursive: true })
  const copy = (relative, target = relative) => {
    const source = path.join(repositoryRoot, relative)
    if (!fs.lstatSync(source).isFile()) throw new Error(`不是普通资源文件：${relative}`)
    const output = path.join(destination, target)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.copyFileSync(source, output)
  }
  const tree = (relative, allowed) => {
    for (const entry of fs.readdirSync(path.join(repositoryRoot, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) tree(child, allowed)
      else if (entry.isFile() && allowed(child)) copy(child)
    }
  }
  tree('src', file => /\.(js|json)$/.test(file))
  for (const name of ['cli', 'service', 'management', 'login-terminal', 'open-external', 'eac']) copy(`packages/standalone/${name}.mjs`)
  tree('packages/standalone/channels', file => file.endsWith('.mjs'))
  const web = 'packages/standalone/web'
  const assets = JSON.parse(fs.readFileSync(path.join(repositoryRoot, web, 'assets.json'), 'utf8'))
  if (!Array.isArray(assets) || assets.length === 0
    || assets.some(name => typeof name !== 'string' || !/^[\w-]+\.(js|css)$/.test(name))
    || new Set(assets).size !== assets.length) {
    throw new Error('桌面端资源清单无效')
  }
  for (const name of ['index.html', 'splash.html', 'assets.json', ...assets]) copy(`${web}/${name}`)
  copy('packages/standalone/package.json')
  copy('packages/desktop/service-host.mjs')
  for (const name of ['qoder-auth-wasm.wasm', 'LICENSE', 'NOTICE.md']) copy(`vendor/channel-pack/${name}`)
  copy('LICENSE')
  copy('scripts/standalone-third-party.txt', 'THIRD_PARTY_NOTICES.txt')
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n')
}

export async function prepareDesktop({ nodeExecutable = process.execPath, nodeLicense = process.env.OFM_DESKTOP_NODE_LICENSE } = {}) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('当前桌面安装包只支持 Windows 与 macOS')
  const cleanEnv = { ...process.env }
  delete cleanEnv.NODE_OPTIONS
  delete cleanEnv.NODE_PATH
  const runtime = JSON.parse(execFileSync(nodeExecutable, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { env: cleanEnv, encoding: 'utf8' }))
  const [major, minor] = runtime.version.slice(1).split('.').map(Number)
  if ((runtime.platform !== 'win32' && runtime.platform !== 'darwin') || runtime.arch !== process.arch || !(major === 22 && minor >= 19 || major >= 24)) {
    throw new Error('Node 运行时必须匹配本机架构，且为 22.19+ 或 24+')
  }
  const cache = path.join(repositoryRoot, 'packages/desktop/src-tauri/.node-license-cache', `${runtime.version}.txt`)
  let license
  if (nodeLicense) license = fs.readFileSync(nodeLicense)
  else if (fs.existsSync(cache)) license = fs.readFileSync(cache)
  else {
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${runtime.version}/LICENSE`, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error('无法取得 Node 完整许可证，请设置 OFM_DESKTOP_NODE_LICENSE')
    license = Buffer.from(await response.arrayBuffer())
  }
  if (!license.toString().startsWith('Node.js is licensed for use as follows:') || license.length < 20000) {
    throw new Error('必须提供此 Node 版本包含第三方声明的完整 LICENSE')
  }
  fs.mkdirSync(path.dirname(cache), { recursive: true })
  fs.writeFileSync(cache, license)
  // 只清理固定生成目录，绝不触及用户数据目录。
  fs.rmSync(resourceDirectory, { recursive: true, force: true })
  stageDesktopService(path.join(resourceDirectory, 'service'))
  fs.mkdirSync(path.join(resourceDirectory, 'runtime'), { recursive: true })
  fs.copyFileSync(nodeExecutable, path.join(resourceDirectory, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))
  fs.writeFileSync(path.join(resourceDirectory, 'runtime/LICENSE'), license)
  fs.writeFileSync(path.join(resourceDirectory, 'runtime/version.json'), JSON.stringify(runtime) + '\n')
  console.log(`桌面资源已生成：完整独立服务及 Node ${runtime.version} ${runtime.arch}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await prepareDesktop() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
