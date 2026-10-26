/** 将共享广告组件及本地图片内联到零构建插件；--check 用于 CI。 */
import fs from 'node:fs'
const root = new URL('../', import.meta.url)
// Git 发布文件统一使用 LF，Windows 工作区也必须生成相同字节。
const readText = file => fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n')
const source = readText(new URL('src/sponsor.js', root)).replace(/^export /gm, '')
const css = readText(new URL('src/sponsor.css', root))
const image = fs.readFileSync(new URL('docs/images/sponsor-beichen-examples.jpg', root)).toString('base64')
const block = `    // BEGIN GENERATED SPONSOR\n${source}\n    const SPONSOR_CSS = ${JSON.stringify(css)}\n    const SPONSOR_IMAGE = 'data:image/jpeg;base64,${image}'\n    const { SponsorPage, SponsorNotice } = createSponsorUI(React, SPONSOR_IMAGE, ReactDOM.createPortal)\n    // END GENERATED SPONSOR`
const file = new URL('client.js', root)
const old = readText(file)
if (!old.includes('    // BEGIN GENERATED SPONSOR')) {
  console.log('插件端已移除赞助组件，跳过广告内联')
} else {
const next = old.replace(/    \/\/ BEGIN GENERATED SPONSOR[\s\S]*?    \/\/ END GENERATED SPONSOR/, block)
if (next === old && !old.includes(block)) throw new Error('广告内联位置不存在')
if (process.argv.includes('--check')) { if (next !== old) throw new Error('请运行 node scripts/build-sponsor.mjs 更新插件广告组件') }
else fs.writeFileSync(file, next)
console.log('共享赞助广告组件与插件内联内容一致')
}
