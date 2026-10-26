/** 资源字节与理论 gzip 体积；不将理论压缩体积冒充 HTTP 传输量。 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const directory = new URL('../packages/standalone/web/', import.meta.url)
const assets = JSON.parse(fs.readFileSync(new URL('assets.json', directory), 'utf8'))
const files = ['index.html', ...assets].map(name => {
  const bytes = fs.readFileSync(new URL(name, directory))
  return { name, bytes: bytes.length, gzip: zlib.gzipSync(bytes).length }
})
const html = fs.readFileSync(new URL('index.html', directory), 'utf8')
const initialNames = new Set(['index.html', ...[...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map(match => match[1])])
const sum = rows => rows.reduce((total, row) => ({ bytes: total.bytes + row.bytes, gzip: total.gzip + row.gzip }), { bytes: 0, gzip: 0 })
const current = { files, total: sum(files), initial: sum(files.filter(row => initialNames.has(row.name))) }
console.log(JSON.stringify(current, null, 2))
if (process.argv.includes('--record')) {
  const target = new URL('../docs/verification/standalone-ui-phase1/sizes.json', import.meta.url)
  fs.mkdirSync(new URL('.', target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(current, null, 2) + '\n')
}
