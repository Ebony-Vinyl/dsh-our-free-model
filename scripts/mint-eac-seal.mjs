/** Offline worker-seal generator. Never accepts secrets on the command line. */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveSealKey, openSealFrom, SEAL_AAD, IV_BYTES, TAG_BYTES } from '../src/vault.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const inside = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function mintWorkerSeal(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.workerBase !== 'string' || typeof config.signingSecret !== 'string') throw new Error('Invalid private configuration')
  const url = new URL(config.workerBase)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || config.workerBase !== url.href || !/\/v1$/.test(url.pathname)
    || config.signingSecret.length < 32 || config.signingSecret.trim() !== config.signingSecret
    || /[\x00-\x1f\x7f]/.test(config.signingSecret)) throw new Error('Invalid private configuration')
  const shards = Array.from({ length: 3 }, () => crypto.randomBytes(32))
  const rows = shards.map(shard => {
    const seed = crypto.randomBytes(32)
    const mask = Buffer.from(crypto.hkdfSync('sha256', seed, Buffer.from('d21f0a5c7be94f13a68d20e4c9b73f58'), Buffer.from('shard-mask'), shard.length))
    return { s: Buffer.from(shard.map((byte, i) => byte ^ mask[i])).toString('base64'), w: seed.toString('base64') }
  })
  const iv = crypto.randomBytes(IV_BYTES)
  const key = deriveSealKey(shards)
  const plaintext = Buffer.from(JSON.stringify({ v: 1, m: 'eac', t: 'worker', u: config.workerBase, s: config.signingSecret }))
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(Buffer.from(SEAL_AAD))
    const seal = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64')
    const opened = openSealFrom(rows, seal)
    if (opened?.mode !== 'worker' || opened.base !== config.workerBase || opened.signingSecret !== config.signingSecret) throw new Error('Seal verification failed')
    return { rows, seal }
  } finally {
    key.fill(0)
    plaintext.fill(0)
    for (const shard of shards) shard.fill(0)
  }
}

export async function generateFiles(input, output) {
  // Input stays outside the checkout; output must be a NEW directory. Never
  // overwrite the installed pair or accidentally replace the private input.
  const inputPath = await fs.realpath(input)
  if (inside(await fs.realpath(repo), inputPath)) throw new Error('Private input must be outside checkout')
  const config = JSON.parse((await fs.readFile(inputPath, 'utf8')).replace(/^\uFEFF/, ''))
  const { rows, seal } = mintWorkerSeal(config)
  const destination = path.resolve(output)
  await fs.mkdir(destination, { mode: 0o700 })
  const dataFile = path.join(destination, 'vault-data.js')
  const anchorFile = path.join(destination, 'vault-anchor.js')
  const banner = '// Generated offline. Review and install this pair together.\n'
  await fs.writeFile(dataFile, `${banner}export const LANE_SHARDS = ${JSON.stringify(rows.slice(0, 2))}\nexport const LANE_SEAL = ${JSON.stringify(seal)}\n`, { flag: 'wx', mode: 0o600 })
  await fs.writeFile(anchorFile, `${banner}export const LANE_ANCHOR = ${JSON.stringify(rows[2])}\n`, { flag: 'wx', mode: 0o600 })
  // 从实际落盘字节构建显式 ESM，避免继承输出目录上级的 CommonJS 类型。
  const readModule = async file => import(`data:text/javascript;base64,${(await fs.readFile(file)).toString('base64')}`)
  const data = await readModule(dataFile)
  const anchor = await readModule(anchorFile)
  const opened = openSealFrom([...data.LANE_SHARDS, anchor.LANE_ANCHOR], data.LANE_SEAL)
  if (opened?.mode !== 'worker' || opened.base !== config.workerBase || opened.signingSecret !== config.signingSecret) throw new Error('Written seal verification failed')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/mint-eac-seal.mjs <private-json-file> <new-output-directory>')
    process.exitCode = 1
  } else {
    try {
      await generateFiles(process.argv[2], process.argv[3])
      console.log('Seal pair generated and verified. Review both files before installation.')
    } catch {
      // Parsing, URL and filesystem errors can contain private input or paths.
      console.error('Seal generation failed. Check private JSON and a new output directory with an existing parent. Do not install partial output.')
      process.exitCode = 1
    }
  }
}
