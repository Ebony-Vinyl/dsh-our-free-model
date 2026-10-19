# HANDOVER — agent Zed berhenti setelah thinking

**Tanggal:** 2026-10-18
**Cakupan:** `D:\Aset\dsh-ofm` (git) + `D:\Aset\windus` (tanpa git)
**Gejala:** di Zed, model `deepseek-v-4.1-flash` / `deepseek-v4.1-flash-free` menampilkan
thinking lalu turn berakhir tanpa jawaban.

---

## 1. Akar masalah (terbukti, bukan dugaan)

Probe langsung ke `POST http://127.0.0.1:18900/v1/chat/completions`
(`stream:true`, `tools:[read_file]`):

```
reasoning chars : 1416
content chars   : 0
tool_call frames: 0
finish_reason   : stop
```

Model menghabiskan giliran di channel reasoning, tidak pernah mengirim `content`
maupun `tool_calls`, lalu mengirim `finish_reason: stop`. Host menerima
"thinking lalu kosong" dan mengakhiri turn.

Rantainya:

1. `windus/adapter/server.mjs` **tidak menerjemahkan** `tools`/`tool_calls`
   (lihat komentar L18–23). OpenCode menjalankan agent-nya sendiri.
2. `dsh-ofm` menyuntikkan 5 tool stub fingerprint (`bash, edit, glob, grep, read`)
   agar gate upstream lolos, dan memberi tahu model bahwa itu placeholder.
3. Model tetap mencoba memakai tool; sebagian percobaan ditolak / tidak menghasilkan
   teks, sehingga giliran berakhir kosong.
4. `dsh-ofm` menganggap "reasoning-only + stop" sebagai **sukses**, jadi
   `finish_reason: stop` dengan `content` kosong dikirim ke Zed.

### Bug tambahan yang ditemukan saat uji

**A. Bridge crash (fatal).** `withKey()` di `windus/adapter/server.mjs` menyimpan
promise turunan (`next.finally(...)`) ke antrean tanpa `catch`. Di Node 26,
unhandled rejection mematikan proses. Satu giliran gagal (mis. 400) cukup untuk
mematikan seluruh bridge di port 45280 → semua request berikutnya `ECONNREFUSED`.

**B. Retry identik → 400.** `runTurn()` mengubah `forward` menjadi `[]` ketika
hash pesan sama persis dengan giliran sebelumnya dan `lastText` kosong, lalu
melempar `400 Tidak ada teks user untuk dikirim ke OpenCode`. Retry atas giliran
kosong selalu gagal (dan memicu bug A).

---

## 2. Perubahan yang diterapkan

### `D:\Aset\windus\adapter\server.mjs` (backup: `server.mjs.bak-ofm-20261018`)

- `withKey()`: ekor antrean sekarang `next.then(() => {}, () => {})` sehingga
  tidak pernah rejection; error tetap sampai ke pemanggil lewat `next`.
- Retry identik tanpa `lastText`: `forward = messages` (jalankan ulang prompt),
  bukan `forward = []` yang berujung 400.

### `D:\Aset\dsh-ofm\src\adapter.js`

- Setelah blok recovery: jika `silentStop` tetap tidak bisa dijadwalkan
  (mis. budget output sudah habis / checkpoint tidak muat), jangan kembalikan
  `stop` kosong. Kembalikan error eksplisit:
  `our free model ended the turn after thinking without an answer`
  dengan `CODE.empty` (→ `EMPTY_RESPONSE`).
- Kontrak budget **tidak** diubah: bila budget habis, tidak ada request tambahan.

### `D:\Aset\dsh-ofm\scripts\recovery-test.mjs`

- Test `首段输出预算烧尽的纯思考空停不再追加请求` diperbarui: hasilnya sekarang
  `error` + `EMPTY_RESPONSE` (bukan `stop` kosong), jumlah request tetap 1.

---

## 3. Verifikasi

| Uji | Hasil |
|---|---|
| `node scripts/recovery-test.mjs` | **131/131 lulus** |
| `node scripts/stream-failure-test.mjs` | **80/80 lulus** |
| `node scripts/combo-advance-test.mjs` | lulus |
| `node --check src/adapter.js` | lulus |
| `node --check windus/adapter/server.mjs` | lulus |

Probe end-to-end ke `18900` (setelah restart dengan env bridge):

| Kasus | Sebelum | Sesudah |
|---|---|---|
| tools + `max_tokens:512` | 200, content 0, stop | 200, error frame `EMPTY_RESPONSE` (tidak silent) |
| tools + `max_tokens:32768` (Zed-like) | content 0 / stop | **content 1634**, stop |
| tanpa tools | 200 + content | 200 + content |
| bridge `messages: []` | 400 lalu **proses mati** | 400, bridge tetap hidup |

---

## 4. Cara restart (PENTING)

`dsh-ofm` **wajib** dijalankan dengan `OUR_FREE_MODEL_BASE=http://127.0.0.1:45280`.
Tanpa env itu, `dsh-ofm` menembak `opencode.ai` langsung (bukan windus) dan
gejala 403/429 akan kembali.

```powershell
# 1) bridge
cd D:\Aset\windus
python adapter/start-adapter.py restart

# 2) ofm (ambil PID dari netstat dulu)
powershell -NoProfile -Command "Stop-Process -Id <PID> -Force"
powershell -NoProfile -Command "Remove-Item -Force 'C:\Users\Burhan Syam\.our-free-model\service.lock' -ErrorAction SilentlyContinue"
powershell -NoProfile -Command "Set-Item -Path Env:OUR_FREE_MODEL_BASE -Value 'http://127.0.0.1:45280'; Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'packages\standalone\cli.mjs','--port','18900' -WorkingDirectory 'D:\Aset\dsh-ofm' -WindowStyle Hidden"
```

Alternatif resmi: `D:\Aset\windus\ofm-with-windus.cmd` (sudah menyetel env).

> Catatan Git Bash: `$env:...` akan dimakan shell. Gunakan
> `Set-Item -Path Env:OUR_FREE_MODEL_BASE -Value '...'`.

---

## 5. Batasan yang masih tersisa (jujur)

- **Tool calling belum end-to-end.** `windus` tetap tidak mengembalikan
  `tool_calls` ke klien. Model bisa menjalankan tool OpenCode di
  `D:\Aset\windus\scratch` (bukan workspace Zed), lalu menjawab teks. Zed tidak
  akan pernah menerima `tool_calls`, jadi **belum bisa dipakai sebagai agent
  yang mengedit file proyek**.
- Untuk kerja agent sungguhan di Zed, pakai provider yang punya tool calling
  (`Tip`, `Vlee`, `9routerku`) — atau lane `/zen/v1` milik `dsh-ofm` sendiri
  setelah kuota 429 pulih.
- `enable_thinking: false` di settings Zed **diabaikan** oleh lane ini; model
  tetap mengirim reasoning. Tidak berbahaya, hanya menyesatkan.
- Daftar model `Our-Free-Local` di settings Zed belum sinkron:
  - **usang (tidak ada di server):** `cat-jam-free`, `muse-spark-1.2/1.3-contributor-free`,
    `jev-1.13-free`, `step-5-preview-free`, `stepfun/step-5-preview-free`,
    `inclusionai/ling-3.1-flash`
  - **belum terdaftar:** `glm-5.3-flash-free`, `nemotron-3.5-super-vl-free`,
    `beam-free`, `nemotron-3-ultra-free`, `kilo-auto/free`,
    `nvidia/nemotron-3.5-super-vl:free`, `reflection/beam-free`,
    `xingchen-agi/xing4.0-29b-a4b:free`
  - `ofm-sync-zed.mjs` bisa menyinkronkan, tetapi **menimpa** seluruh blok dan
    menghapus `images: true` / `reasoning_effort` yang sudah disetel manual.

---

## 6. Status git

Sudah di-commit atas permintaan pengguna.

| Commit | Isi |
|---|---|
| `14c8617` | Terjemahan antarmuka konsol standalone ke Bahasa Indonesia |
| `098b417` | Pakai lane `/zen/v1` dan laporkan turn kosong |

`098b417` (12 file, +194/−817) memuat:

- `src/upstream.js` — kembali ke bentuk v1.3.7 (`/zen/v1`, UA
  `opencode/1.18.31`, `x-opencode-request`, proyek `prj_<24hex>`, stub
  `bash/edit/glob/grep/read`) karena `/inference/v1` menjawab 403
  `FreeTierError` untuk semua id gratis.
- `src/adapter.js` — `silentStop` yang tak bisa dijadwalkan kini menghasilkan
  galat `EMPTY_RESPONSE`, bukan `stop` kosong.
- `scripts/{fingerprint,forward,free-lane-wire,recovery,standalone}-test.mjs` —
  disesuaikan ke kontrak legacy.
- `packages/standalone/web/channels-DtR2ayCL.js` dihapus; penggantinya
  `channels-C0e2HGt0.js` sudah ada dan tidak ada referensi tersisa.

File untracked milik pengguna (`HANDOVER-*.md`, `ofm-*.mjs/.ps1/.cmd/.vbs`,
`backup-data.*`, `hapus`, `nul`) sengaja **tidak** di-commit.

`D:\Aset\windus` bukan git repo — satu-satunya rollback adalah
`adapter/server.mjs.bak-ofm-20261018`.

---

## 7. Status terjemahan antarmuka

**Frontend 100% Bahasa Indonesia.** Selesai di commit `14c8617`; sisa string
tampil di splash dituntaskan di `098b417`.

Cakupan yang sudah Indonesia:

- `packages/standalone/frontend/*` (app, models, settings, usage, komponen UI,
  data model/settings/usage, tema).
- `packages/standalone/web/*` (index, app, bundle per halaman).
- `packages/standalone/{cli,management,login-terminal,service}.mjs` dan
  `client.js` (dictionary `zh` diganti).
- `splash.html` — status `Menginisialisasi... / Menyiapkan / Siap`, subtitle
  `Konsol Lokal`.

### Sisa CJK yang **bukan** UI

`grep -rnP '[\x{4e00}-\x{9fff}]'` masih menemukan ±1250 baris, tetapi setelah
diklasifikasikan semuanya jatuh ke kategori ini:

| Lokasi | Isi |
|---|---|
| `frontend/*.css` (±840 baris) | komentar CSS (nama tema, catatan desain) |
| `client.js` (±180 baris) | komentar CSS/JS dan fragmen anchor GitHub `#git-安装` |
| `web/channels-C0e2HGt0.js` (±103) | komentar CSS di dalam bundle |
| `src/*.js` (±50) | komentar internal, bukan teks tampil |
| `locale/zh.json` | kamus Mandarin yang sengaja dipertahankan |

Tidak ada lagi `content: "…"` CSS maupun teks di dalam HTML yang berbahasa
Mandarin. Jangan retranslasi massal hanya karena grep masih menemukan CJK.

Verifikasi cepat:

```bash
# teks tampil di HTML (harus kosong)
grep -rnP '>[^<]*[\x{4e00}-\x{9fff}]' packages/standalone/web/*.html packages/standalone/frontend/*.html
# string ber-quote di splash (harus kosong)
grep -nP "[\"'\`][^\"'\`]*[\x{4e00}-\x{9fff}]" packages/standalone/web/splash.html
```

---

## Sesi 15 (lanjutan) — 2026-10-18, setelah restart

Ringkas: **lane gratis OpenCode sudah tidak bisa dipakai sama sekali.** Yang
berjalan adalah **agregat OpenRouter**. Empat model sudah dimasukkan ke Zed.

### 1. Hasil pembuktian: gate free lane menolak semuanya

Dua probe baru direkam di repo (commit `cd1ccaf`):

| Probe | Isi | Hasil |
|---|---|---|
| `scripts/probes/gate-schema-probe.mjs` | 3 varian: tanpa tools · stub `properties:{}` · stub satu properti | **403 FreeTierError untuk ketiganya** |
| `scripts/probes/gate-header-matrix.mjs` | 10 varian: `/zen/v1` vs `/inference/v1`, buang `x-opencode-request`, `x-opencode-project: global`, `x-opencode-session-id`, UA pendek, UA os/arch, `x-opencode-client: desktop` | **403 FreeTierError untuk kesepuluhnya** |

Kesimpulan: bukan skema tool, bukan header, bukan nama tool `read` yang hilang.
Hipotesis workaround openchamber#5086 (gate butuh tool `read` di request) **tidak
berlaku di sini** — request dengan stub `read` lengkap pun tetap 403. Gate-nya
memeriksa sesuatu di luar matriks yang bisa diuji dari sisi klien.

⇒ **Jangan ulangi percobaan fingerprint.** `applyFingerprint` sudah benar
menyuntik `bash/edit/glob/grep/read`; jangan diubah hanya karena 403.

Catatan kontradiksi dokumen: `docs/free-lane-wire.md` (2026-10-14) mencatat
`properties: {}` → 403, sedangkan komentar `src/upstream.js` menyatakan stub
kosong lolos. Probe di atas menunjukkan **keduanya sekarang 403**, jadi
perbedaan itu tidak lagi menentukan. Jangan "memperbaiki" stub berdasarkan
dokumen lama.

### 2. Jalur yang hidup: agregat OpenRouter

Verifikasi ulang setelah restart (PID `40200`):

```
POST http://127.0.0.1:18900/v1/chat/completions
model: open_router/cohere/north-mini-code:free
→ HTTP 200 text/event-stream
   events 103 | content 0 | tool_calls 1 | finish tool_calls | [DONE] true
   tool: read_file {"path": "package.json"}
```

Uji teks murni (tanpa tools) juga 200, `finish stop`, 46 karakter konten —
jadi bukan cuma tool call yang jalan.

`reasoning chars: 0` tetap seperti sesi sebelumnya. Model-model OpenRouter yang
dipilih memang tidak mengirim `reasoning_content`; ini bukan kerusakan gateway.

### 3. Perubahan di settings Zed (di luar repo)

`C:\Users\Burhan Syam\AppData\Roaming\Zed\settings.json` — **disisipkan
tekstual**, komentar 8 baris di kepala file masih utuh, CRLF dipertahankan,
validasi dilakukan dengan pengupas komentar `//` lalu `JSON.parse`.

Backup: `settings.json.bak-ofm-1` (23.502 byte → 25.717 byte).

Empat entri ditambahkan di awal `available_models` milik `Our-Free-Local`:

| `name` (id gateway) | `display_name` | `max_tokens` |
|---|---|---|
| `open_router/cohere/north-mini-code:free` | OpenRouter North Mini Code (free) | 256000 |
| `open_router/dots-studio/dots-3-note-preview:free` | OpenRouter Dots 3 Note Preview (free) | 512000 |
| `open_router/nvidia/nemotron-3.5-lightning:free` | OpenRouter Nemotron 3.5 Lightning (free) | 1000000 |
| `open_router/xingchen-agi/xing4.0-29b-a4b:free` | OpenRouter Xing 4.0 29B A4B (free) | 262144 |

Semua memakai `max_output_tokens: 32768`, `tools: true`, `images: false`,
`parallel_tool_calls: true`, `prompt_cache_key: false`,
`chat_completions: true`, `interleaved_reasoning: false`,
`max_tokens_parameter: true`.

### 4. ⚠️ Jebakan yang menjelaskan "kenapa error lagi"

Gateway mengiklankan **dua id berbeda untuk model yang sama**:

| Id | Lane | Status |
|---|---|---|
| `dots-studio/dots-3-note-preview:free` | katalog free lane | **403** |
| `open_router/dots-studio/dots-3-note-preview:free` | agregat OpenRouter | **200** |

Daftar `available_models` di Zed **masih memuat id tanpa prefiks**
(`dots-studio/...`, `nvidia/nemotron-3.5-lightning:free`,
`poolside/laguna-*:free`, `liquid/lfm-*:free`, dst.). Semua itu masuk lane
gratis dan akan 403. **Kalau memilih model dari daftar itu, error `LANE_LOCKED`
akan muncul lagi** — bukan karena perbaikan gagal.

Id yang bekerja selalu berawalan `open_router/`. Entri tanpa prefiks sengaja
**tidak dihapus** (keputusan user); kalau nanti ingin dibersihkan, hapus hanya
baris yang id-nya tidak berawalan `open_router/` dan sudah punya kembaran
berprefiks.

### 5. Kuota

OpenRouter free: 50 request/hari. Terpakai sesi ini ±5 (3 probe skema + 10 probe
header + 2 uji gateway — probe 403 tidak dihitung karena ditolak sebelum
inferensi). Sisa ±40-an. Jangan burst.

### 6. Verifikasi yang sudah dijalankan

| Perintah | Hasil |
|---|---|
| `node scripts/registry-test.mjs` | lolos — `75 providers, 504 model ids, every wire path resolves` |
| `node /tmp/ofm-probe.mjs open_router/cohere/north-mini-code:free` | 200, `tool_calls: 1`, `finish tool_calls` |
| `curl :18900/v1/models` | 32 entri, 4 di antaranya `open_router/*` |
| `head -12` settings Zed | komentar kepala utuh |

### 7. Langkah berikutnya

1. Di Zed: pilih **OpenRouter North Mini Code (free)** (bukan `dots-studio/...`
   tanpa prefiks), lalu minta `baca package.json dan sebutkan name + version`.
2. Kalau tool call berjalan, gejala "berhenti setelah thinking" selesai —
   penyebabnya lane gratis yang mati, bukan gateway kita.
3. Kalau masih berhenti: rekam request Zed dengan
   `capture_process_scenario` atau bandingkan lewat `curl` ke gateway dengan
   payload yang sama, lalu periksa `src/adapter.js` bagian
   `silentStop`/`EMPTY_RESPONSE`.
4. Rotasi API key OpenRouter (`sk-or-v1-fdf6…`) — sudah terekspos di chat.

### 8. Status git

```
cd1ccaf Tambahkan empat model OpenRouter terverifikasi
ff16e81 Terjemahkan status splash ke Bahasa Indonesia
098b417 Pakai lane /zen/v1 dan laporkan turn kosong
```

File baru yang ikut commit: `scripts/probes/gate-schema-probe.mjs`,
`scripts/probes/gate-header-matrix.mjs`.

Catatan: antarmuka standalone **sudah 100% Bahasa Indonesia** (lihat bagian
sebelumnya di file ini) — ini belum tercatat di ringkasan commit mana pun.

---

## Sesi 15b — Pembersihan daftar model Zed (2026-10-18)

### 1. Hasil uji dua id yang belum dipastikan

| id | Hasil | Keputusan |
|---|---|---|
| `openrouter/free` | HTTP 200, 1 `tool_calls`, `finish tool_calls`, `[DONE]` | dipertahankan |
| `gemini/gemini-3.8-flash` | HTTP 200, 1 `tool_calls`, `finish tool_calls`, `[DONE]` | dipertahankan |

Keduanya ternyata baris `kiloRows` di `catalog.json`, bukan lane gratis — karena
itu id-nya tampil tanpa prefiks `open_router/` dan tetap hidup.

### 2. Pembersihan settings Zed

Skrip baru: `scripts/ofm-zed-prune-models.mjs`.

- Membaca settings sebagai teks mentah; **tidak** round-trip JSON.
- Menghapus hanya objek di dalam `available_models` milik `Our-Free-Local`.
- Mempertahankan id berawalan `open_router/` plus allowlist dua id di atas.
- Memvalidasi hasil dengan pengupas komentar `//` lalu `JSON.parse` sebelum menulis.
- Backup otomatis; mode `--write` untuk menulis, tanpa flag = dry-run.

Hasil: **31 → 6 entri**, ukuran `25.717 → 12.221` byte.
Backup: `C:\Users\Burhan Syam\AppData\Roaming\Zed\settings.json.bak-ofm-2`.

Enam entri yang tersisa:

1. `open_router/cohere/north-mini-code:free`
2. `open_router/dots-studio/dots-3-note-preview:free`
3. `open_router/nvidia/nemotron-3.5-lightning:free`
4. `open_router/xingchen-agi/xing4.0-29b-a4b:free`
5. `openrouter/free`
6. `gemini/gemini-3.8-flash`

Dihapus 25 id lane gratis yang semuanya 403 / duplikat tanpa prefiks.

### 3. Verifikasi

| Pemeriksaan | Hasil |
|---|---|
| Komentar kepala `// Zed settings` | utuh (12 baris pertama) |
| JSON hasil edit | valid (parse dengan pengupas komentar) |
| Dry-run ulang | `6 -> 6`, `Dihapus: 0` (idempoten) |
| Provider lain (`Kiosapi`, `Shit`, `9routerku`, `Vlee`, `Tip`) | masih ada |
| `node scripts/registry-test.mjs` | lolos — `75 providers, 504 model ids` |

### 4. Sisi gateway — BELUM diubah

`GET :18900/v1/models` masih mengiklankan **32 id**, termasuk 26 id lane mati.
Sumbernya `catalog.json` (`entries` + `kiloRows`) dan `aggregate.providers`.
`availability.json` menandai hampir semua `unavailable`; satu-satunya
`available` adalah `nemotron-3-ultra-free` yang justru tidak diiklankan.

Pilihan yang disiapkan (belum dijalankan, menunggu persetujuan user):

- Isi `hiddenModelIds` di `C:\Users\Burhan Syam\.our-free-model\settings.json`
  dengan id lane mati — reversibel, tidak menyentuh `catalog.json`.
- Urutan wajib: `Stop-Process -Id 40200 -Force` → hapus `service.lock` →
  tulis settings → `Start-Process node` → cek `/v1/models`.
- Menulis saat proses hidup akan tertimpa state in-memory.

### 5. Tindakan user

1. **Restart Zed** agar daftar model baru terbaca.
2. Pilih model berprefiks `open_router/` (atau `openrouter/free` /
   `gemini/gemini-3.8-flash`), jangan yang tanpa prefiks.
3. Rotasi API key OpenRouter — sudah terekspos di chat.

### 6. Status git

`scripts/ofm-zed-prune-models.mjs` **belum di-commit** (untracked). Tidak ada
file user lain yang disentuh. Perubahan settings Zed berada di luar repo.
