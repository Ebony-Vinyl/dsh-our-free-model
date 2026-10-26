/** 为旧升级器生成兼容的运行时资源；不改变其 80 文件和 4 MiB 限制。 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const checking = process.argv.includes('--check')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const require = createRequire(import.meta.url)
const esbuild = await import(pathToFileURL(require.resolve('esbuild', { paths: [path.join(root, 'packages/standalone'), root] })).href)
const result = await esbuild.build({
  stdin: { contents: "export * from './src/token-saver/index.js'; export * from './src/token-saver/prompts.js';", resolveDir: root, sourcefile: 'token-saver-entry.js' },
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', legalComments: 'inline',
})
const write = (rel, bytes) => {
  const target = path.join(root, rel)
  const body = Buffer.from(bytes)
  if (checking) {
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(body)) throw new Error(`生成资源不一致：${rel}`)
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
  }
}
write('src/token-saver.js', result.outputFiles[0].contents)
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'vendor/magpie/engine.json'), 'utf8'))
const expectedParts = new Set()
for (const [target, entry] of Object.entries(metadata.binaries)) {
  const binary = fs.readFileSync(path.join(root, 'vendor/magpie', entry.path))
  if (hash(binary) !== entry.sha256) throw new Error(`引擎摘要不匹配：${target}`)
  if (checking) {
    // Node/zlib 版本可能产生不同的 gzip 编码；检查已发布字节与原始引擎的一致性，
    // 不要求另一平台的压缩器重新生成相同编码。
    const value = entry.compressed
    if (value?.algorithm !== 'gzip' || value.outputSize !== binary.length || !Array.isArray(value.parts)) throw new Error(`分片元数据无效：${target}`)
    const chunks = value.parts.map((part, index) => {
      const rel = `src/engine-parts/${target}.${String(index).padStart(3, '0')}.part`
      if (part.path !== rel || part.size <= 0 || part.size > 4 * 1024 * 1024) throw new Error(`分片路径或大小无效：${target}`)
      const bytes = fs.readFileSync(path.join(root, rel))
      if (bytes.length !== part.size || hash(bytes) !== part.sha256) throw new Error(`分片内容不一致：${rel}`)
      expectedParts.add(path.basename(rel))
      return bytes
    })
    const compressed = Buffer.concat(chunks)
    if (compressed.length !== value.size || hash(compressed) !== value.sha256
      || !zlib.gunzipSync(compressed, { maxOutputLength: binary.length }).equals(binary)) throw new Error(`分片还原结果不一致：${target}`)
    continue
  }
  const compressed = zlib.gzipSync(binary, { level: 9 })
  const parts = []
  for (let offset = 0; offset < compressed.length; offset += 4 * 1024 * 1024) {
    const bytes = compressed.subarray(offset, offset + 4 * 1024 * 1024)
    const rel = `src/engine-parts/${target}.${String(parts.length).padStart(3, '0')}.part`
    write(rel, bytes)
    expectedParts.add(path.basename(rel))
    parts.push({ path: rel, size: bytes.length, sha256: hash(bytes) })
  }
  entry.compressed = { algorithm: 'gzip', size: compressed.length, sha256: hash(compressed), outputSize: binary.length, parts }
}
const partsDir = path.join(root, 'src/engine-parts')
for (const name of fs.readdirSync(partsDir)) {
  if (expectedParts.has(name)) continue
  if (!/^[a-z0-9-]+\.\d{3}\.part$/.test(name)) throw new Error(`分片目录包含未知文件：${name}`)
  if (checking) throw new Error(`存在过期分片：${name}`)
  fs.unlinkSync(path.join(partsDir, name))
}
write('vendor/magpie/engine.json', JSON.stringify(metadata, null, 2) + '\n')
console.log(`旧版兼容资源一致：省 Token 单文件，${expectedParts.size} 个引擎分片`)
