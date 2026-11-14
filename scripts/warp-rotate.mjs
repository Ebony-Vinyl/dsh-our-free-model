/**
 * Auto-rotate egress WARP + ukur apakah jatah ZEN ikut berputar.
 *
 * Konteks (2026-11-15): `deepseek-v4.1-flash-free` pernah menjawab 200 lewat
 * pipeline OFM, lalu 429 untuk semua percobaan berikutnya. Ganti IP WARP
 * (disconnect/connect) terbukti mengubah alamat keluar, tapi BELUM terbukti
 * membuka jatah baru. Skrip ini mengukur kedua hal sekaligus supaya keputusan
 * diambil dari data, bukan dugaan:
 *
 *   per rotasi  : IP keluar berubah?  → `ip baru`
 *   per rotasi  : ZEN 200 atau 429?   → hasil
 *
 * Pemakaian:
 *   node scripts/warp-rotate.mjs                 # 3 rotasi, 1 request tiap rotasi
 *   node scripts/warp-rotate.mjs --rounds 5
 *   node scripts/warp-rotate.mjs --model big-pickle
 *   node scripts/warp-rotate.mjs --no-rotate     # ukur tanpa ganti IP (kontrol)
 *
 * Aturan yang dipegang: satu request per rotasi, jeda wajib. Probe beruntun
 * hanya memperbanyak 429 dan tidak menghasilkan informasi baru.
 */
import { execFileSync } from 'node:child_process'

const WARP_CLI = process.env.WARP_CLI ?? 'C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe'
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const rounds = Number(flag('rounds', '3'))
const model = flag('model', 'deepseek-v4.1-flash-free')
const settleMs = Number(flag('settle', '7000'))
const gapMs = Number(flag('gap', '4000'))
const rotate = !args.includes('--no-rotate')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const cli = (...rest) => {
  try { return execFileSync(WARP_CLI, rest, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch (error) { return `error: ${error?.message ?? error}`.slice(0, 120) }
}

async function egressIp() {
  try {
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(15000) })
    const text = await response.text()
    const ip = /^ip=(.+)$/m.exec(text)?.[1] ?? '?'
    const warp = /^warp=(.+)$/m.exec(text)?.[1] ?? '?'
    return { ip, warp }
  } catch (error) {
    return { ip: `error: ${error?.message ?? error}`.slice(0, 60), warp: '?' }
  }
}

/** One probe request through the real OFM pipeline, in a child process. */
function probe(seed) {
  return new Promise(resolve => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(process.execPath, ['scripts/ofm-live-zen-probe-fresh.mjs', model, seed], {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.stderr.on('data', chunk => { out += chunk })
      child.on('exit', () => {
        const status = /STATUS (\d+)/.exec(out)?.[1]
        const code = /ERROR (\S+)/.exec(out)?.[1]
        resolve(status !== undefined ? { ok: Number(status) === 200, label: `HTTP ${status}` } : { ok: false, label: code ?? 'gagal' })
      })
    })
  })
}

console.log(`model ${model} | rotasi ${rotate ? 'aktif' : 'dimatikan'} | ${rounds} putaran\n`)
const rows = []
for (let round = 1; round <= rounds; round += 1) {
  if (rotate) {
    const before = await egressIp()
    cli('disconnect')
    await sleep(2500)
    cli('connect')
    await sleep(settleMs)
    const after = await egressIp()
    const changed = before.ip !== after.ip
    const result = await probe(`rot${round}-${Date.now()}`)
    rows.push({ round, from: before.ip, to: after.ip, changed, result: result.label, ok: result.ok })
    console.log(`putaran ${round}: ${before.ip} -> ${after.ip} ${changed ? '(berubah)' : '(TETAP)'} | ${result.label}`)
  } else {
    const ip = await egressIp()
    const result = await probe(`fix${round}-${Date.now()}`)
    rows.push({ round, from: ip.ip, to: ip.ip, changed: false, result: result.label, ok: result.ok })
    console.log(`putaran ${round}: ${ip.ip} (tanpa rotasi) | ${result.label}`)
  }
  if (round < rounds) await sleep(gapMs)
}

const opened = rows.filter(row => row.ok).length
const changedIps = rows.filter(row => row.changed).length
console.log(`\nringkasan: ${changedIps}/${rows.length} IP berubah, ${opened}/${rows.length} request berhasil (200)`)
if (changedIps > 0 && opened === 0) {
  console.log('kesimpulan: rotasi IP berjalan, tapi jatah ZEN TIDAK ikut berputar — kuota bukan per-IP.')
} else if (opened > 0) {
  console.log('kesimpulan: ada putaran yang berhasil — lihat tabel di atas untuk korelasi IP/jatah.')
}
