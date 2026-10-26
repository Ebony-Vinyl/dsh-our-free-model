import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { materializeEngine, hasEnginePayload } from '../src/engine-payload.js'
import * as source from '../src/token-saver/index.js'
import * as bundled from '../src/token-saver.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-'))
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const content = Buffer.from('可信引擎夹具\n'.repeat(1000))
const compressed = zlib.gzipSync(content)
const rel = 'src/engine-parts/fixture-x64.000.part'
const entry = { sha256: sha(content), compressed: { algorithm: 'gzip', size: compressed.length, sha256: sha(compressed), outputSize: content.length, parts: [{ path: rel, size: compressed.length, sha256: sha(compressed) }] } }
const target = path.join(scratch, rel)
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, compressed)
let checks = 0
const check = async (name, run) => { await run(); console.log(`ok ${++checks} - ${name}`) }
const materialize = (tag, value = entry) => materializeEngine({ pkgDir: scratch, dataDir: path.join(scratch, tag), entry: value })
try {
  await check('完整本地分片还原且并发调用共用已校验结果', async () => {
    assert.equal(hasEnginePayload(scratch, entry), true)
    const files = await Promise.all(Array.from({ length: 8 }, () => materialize('valid')))
    assert.equal(new Set(files).size, 1)
    assert.deepEqual(fs.readFileSync(files[0]), content)
    assert.equal(fs.readdirSync(path.dirname(files[0])).length, 1)
  })
  await check('缓存损坏时重新还原，不复用坏文件', async () => {
    const file = await materialize('valid')
    fs.writeFileSync(file, '坏缓存')
    assert.equal(await materialize('valid'), file)
    assert.deepEqual(fs.readFileSync(file), content)
  })
  await check('分片篡改、缺片与符号链接被拒绝', async () => {
    const corrupted = Buffer.from(compressed); corrupted[10] ^= 1
    fs.writeFileSync(target, corrupted)
    await assert.rejects(materialize('corrupted'), /checksum mismatch/)
    fs.unlinkSync(target)
    assert.equal(hasEnginePayload(scratch, entry), false)
    await assert.rejects(materialize('missing'), /ENOENT/)
    if (process.platform !== 'win32') {
      const other = path.join(scratch, 'other'); fs.writeFileSync(other, compressed); fs.symlinkSync(other, target)
      assert.equal(hasEnginePayload(scratch, entry), false)
      await assert.rejects(materialize('symlink'), /size mismatch/)
      fs.unlinkSync(target)
    }
    fs.writeFileSync(target, compressed)
  })
  await check('压缩体摘要与最终可执行文件摘要分别校验', async () => {
    const badCompressed = structuredClone(entry); badCompressed.compressed.sha256 = '0'.repeat(64)
    await assert.rejects(materialize('compressed-hash', badCompressed), /compressed checksum mismatch/)
    const badOutput = { ...entry, sha256: '0'.repeat(64) }
    await assert.rejects(materialize('output-hash', badOutput), /output checksum mismatch/)
  })
  await check('非法路径、重复片及无效大小不会进入还原流程', async () => {
    for (const mutate of [
      value => { value.compressed.parts[0].path = '../outside.part' },
      value => { value.compressed.parts.push(value.compressed.parts[0]) },
      value => { value.compressed.parts[0].size = 4 * 1024 * 1024 + 1 },
      value => { value.compressed.outputSize = 128 * 1024 * 1024 + 1 },
    ]) {
      const value = structuredClone(entry); mutate(value)
      await assert.rejects(materialize('invalid', value), /metadata is invalid/)
    }
  })
  await check('解压输出受声明大小限制，失败不遗留临时可执行文件', async () => {
    const value = structuredClone(entry); value.compressed.outputSize--
    await assert.rejects(materialize('overflow', value), /exceeds/)
    assert.deepEqual(fs.readdirSync(path.join(scratch, 'overflow/engine-runtime')), [])
  })
  await check('已生成省 Token 代码与源码对各协议保持相同行为', () => {
    assert.deepEqual(bundled.PROMPT_FAMILIES, source.PROMPT_FAMILIES)
    for (const settings of [{}, { tokenSaver: { rtk: true, caveman: 'medium', ponytail: 'medium' } }]) {
      const config = source.saverConfig(settings)
      assert.deepEqual(bundled.saverConfig(settings), config)
      for (const wire of ['openai', 'anthropic', 'responses']) {
        const payload = { model: 'fixture', messages: [{ role: 'user', content: '测试' }, { role: 'tool', tool_call_id: 'fixture', content: 'same output\n'.repeat(200) }], input: [{ role: 'user', content: '测试' }] }
        assert.deepEqual(bundled.applyTokenSavers(structuredClone(payload), wire, config), source.applyTokenSavers(structuredClone(payload), wire, config))
      }
    }
    const total = source.emptySavings()
    assert.equal(bundled.describeSavingsTotal(total), source.describeSavingsTotal(total))
  })
  console.log(`${checks}/${checks} 引擎分片及运行时打包检查通过`)
} finally {
  if (!path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('清理路径越界')
  fs.rmSync(scratch, { recursive: true, force: true })
}
