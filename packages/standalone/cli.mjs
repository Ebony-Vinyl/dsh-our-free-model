#!/usr/bin/env node
import path from 'node:path'
import { startStandalone } from './service.mjs'

const usage = `Our Free Model — layanan lokal mandiri
Penggunaan: node packages/standalone/cli.mjs [opsi]

  --port <port>       Port listen, bawaan 18900 (memilih port tersedia bila bentrok)
  --data-dir <dir>    Direktori data, bawaan OFM_HOME atau ~/.our-free-model
  --no-refresh        Lewati penyegaran saat mulai dan berkala; penyegaran manual dan inferensi tetap tersedia
  --probe             Aktifkan dan simpan deteksi otomatis; akan menghasilkan permintaan upstream
  --lan               Aktifkan dan simpan relai inferensi LAN (kunci terpisah; halaman manajemen tetap hanya perangkat ini)
  --no-lan            Matikan dan simpan relai inferensi LAN
  --lan-port <port>   Simpan port LAN yang diinginkan, bawaan 0; tidak mengaktifkan relai sendiri
  --help              Tampilkan bantuan
`

async function main() {
  const options = {}
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index]
    if (flag === '--help') { process.stdout.write(usage); return }
    if (flag === '--no-refresh') { options.refresh = false; continue }
    if (flag === '--probe') { options.probe = true; continue }
    if (flag === '--lan' || flag === '--no-lan') { options.lanEnabled = flag === '--lan'; continue }
    if (!['--port', '--data-dir', '--lan-port'].includes(flag) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
      throw new Error(`Opsi tidak dikenal atau parameter hilang: ${flag}`)
    }
    const value = process.argv[++index]
    if (flag === '--port' || flag === '--lan-port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('Port harus berupa bilangan bulat 0 sampai 65535')
      options[flag === '--port' ? 'port' : 'lanPort'] = Number(value)
    } else options.dataDir = path.resolve(value)
  }
  const service = await startStandalone(options)
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    void service.close().catch(error => {
      process.stderr.write(`Gagal berhenti: ${error.message}\n`)
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.stdout.write(`${service.product} ${service.version}\nHalaman manajemen (login sekali dalam 10 menit): ${service.managementUrl}\nAPI: ${service.url}/v1\nAPI Key disimpan di: ${service.keyFile}\n`)
  if (service.lan.running) {
    process.stdout.write(`LAN API: ${service.lan.baseUrls.join(', ') || `port ${service.lan.port}`}\nLAN Key: lihat di antarmuka manajemen perangkat ini (terpisah dari API Key lokal)\n`)
  } else if (service.lan.error) process.stderr.write(`${service.lan.error}\n`)
}

main().catch(error => {
  process.stderr.write(`Gagal memulai: ${error.code === 'EEXIST' ? 'Direktori data sudah dipakai layanan lain, atau kepemilikan service.lock tidak dapat dipastikan; keluar dari layanan yang sudah berjalan terlebih dahulu. Windows dan Linux akan otomatis membersihkan kunci usang yang prosesnya sudah dipastikan berhenti.' : error.message}\n`)
  process.exitCode = 1
})
