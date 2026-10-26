/** 从受签名发布清单保护的本地分片还原引擎，不访问网络。 */
import fs from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

const SHA = /^[a-f0-9]{64}$/
const MAX_BYTES = 128 * 1024 * 1024
const pending = new Map()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function descriptor(entry) {
  const value = entry?.compressed
  if (!SHA.test(entry?.sha256 ?? '') || value?.algorithm !== 'gzip' || !SHA.test(value.sha256 ?? '')
    || !Number.isInteger(value.outputSize) || value.outputSize <= 0 || value.outputSize > MAX_BYTES
    || !Number.isInteger(value.size) || value.size <= 0 || value.size > MAX_BYTES
    || !Array.isArray(value.parts) || value.parts.length === 0 || value.parts.length > 32) {
    throw new Error('Engine payload metadata is invalid')
  }
  const seen = new Set()
  let total = 0
  for (const part of value.parts) {
    if (!/^src\/engine-parts\/[a-z0-9-]+\.\d{3}\.part$/.test(part?.path ?? '') || seen.has(part.path)
      || !SHA.test(part.sha256 ?? '') || !Number.isInteger(part.size) || part.size <= 0 || part.size > 4 * 1024 * 1024) {
      throw new Error('Engine payload part metadata is invalid')
    }
    seen.add(part.path)
    total += part.size
  }
  if (total !== value.size) throw new Error('Engine payload compressed size mismatch')
  return value
}

async function matches(file, entry, size) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size !== size) return false
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    return hash.digest('hex') === entry.sha256
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export function hasEnginePayload(pkgDir, entry) {
  try {
    return descriptor(entry).parts.every(part => fs.lstatSync(path.join(pkgDir, part.path)).isFile())
  } catch { return false }
}

export async function materializeEngine({ pkgDir, dataDir, entry, platform = process.platform }) {
  const value = descriptor(entry)
  const executable = path.join(dataDir, 'engine-runtime', `${entry.sha256}${platform === 'win32' ? '.exe' : ''}`)
  if (pending.has(executable)) return pending.get(executable)
  const work = (async () => {
    if (await matches(executable, entry, value.outputSize)) return executable
    await mkdir(path.dirname(executable), { recursive: true, mode: 0o700 })
    const temporary = `${executable}.${randomUUID()}.tmp`
    try {
      const compressedHash = createHash('sha256')
      async function* parts() {
        for (const part of value.parts) {
          const file = path.join(pkgDir, part.path)
          const stat = fs.lstatSync(file)
          if (!stat.isFile() || stat.size !== part.size) throw new Error('Engine payload part size mismatch')
          const bytes = fs.readFileSync(file)
          if (bytes.length !== part.size || digest(bytes) !== part.sha256) throw new Error('Engine payload part checksum mismatch')
          compressedHash.update(bytes)
          yield bytes
        }
        if (compressedHash.digest('hex') !== value.sha256) throw new Error('Engine payload compressed checksum mismatch')
      }
      let size = 0
      const outputHash = createHash('sha256')
      const verifyOutput = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length
        if (size > value.outputSize) return callback(new Error('Engine payload output exceeds its declared size'))
        outputHash.update(chunk)
        callback(null, chunk)
      } })
      await pipeline(Readable.from(parts()), createGunzip(), verifyOutput, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o700 }))
      if (size !== value.outputSize || outputHash.digest('hex') !== entry.sha256) throw new Error('Engine payload output checksum mismatch')
      try { await rename(temporary, executable) } catch (error) {
        // 另一个进程可能已经完成同一份还原；仅接受摘要一致的文件。
        if (!await matches(executable, entry, value.outputSize)) throw error
      }
      return executable
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  })()
  pending.set(executable, work)
  try { return await work } finally { if (pending.get(executable) === work) pending.delete(executable) }
}
