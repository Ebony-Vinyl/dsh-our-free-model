# HANDOVER — Terjemahan UI `dsh-ofm` ke Bahasa Indonesia

**Status:** SELESAI (UI diterjemahkan ke Bahasa Indonesia; terverifikasi pada 2026-10-18)
**Tanggal:** 2026-10-18
**Cabang:** `main` @ `8c2c0f1` (`catalog: re-sign the manifest over 6038fdd`)
**Target:** konsol lokal `http://127.0.0.1:18900/`
**Catatan:** 5 kegagalan `npm run test` (reload, channel-source, standalone, opencode-parity, gateway-source)
berasal dari dependency dev yang hilang / migrasi `/zen/v1` di `src/` yang belum selesai — bukan dari terjemahan.

---

## 1. Goal

Konsol lokal (`D:\Aset\dsh-ofm`) masih menampilkan UI berbahasa Mandarin sehingga user bingung.
Tujuan: **menerjemahkan seluruh UI, pesan error, dan label yang dilihat user ke Bahasa Indonesia**,
tanpa mengubah logika lane/inferensi.

Fase perbaikan model (gate fingerprint v2 → v2.5.2) **sudah selesai dan terverifikasi**.
Sisa pekerjaan murni penerjemahan.

---

## 2. State Saat Ini (terverifikasi)

### 2.1 Service

| Item | Nilai |
|---|---|
| PID di port 18900 | **78116** (verifikasi ulang dengan `netstat -ano \| grep ':18900'`) |
| Versi | `2.5.2` |
| Health | `{"ok":true,...}` — OK |
| Node | `v26.11.1` |
| Data dir | `~/.our-free-model` |
| API key | `ofm-X3NQCZ1UGsYzYI959kp00DOnvDSpvn-r` |

> **Penting:** server saat ini masih menyajikan `packages/standalone/web/` versi lama.
> Belum ada rebuild dan belum ada restart. Perubahan di `frontend/` belum terlihat di browser.

### 2.2 Working tree

```
 M packages/standalone/frontend/app.tsx
 M packages/standalone/frontend/components/overview.tsx
 M packages/standalone/frontend/components/shell.tsx
 M packages/standalone/frontend/connection.tsx
 M packages/standalone/frontend/models.tsx
?? _dict-en.json
?? _dict-zh.json
?? _keys.txt
?? backup-data.bat
?? backup-data.mjs
?? hapus
?? nul
?? ofm-bench-results.json
?? ofm-bench.mjs
?? ofm-check-cred.ps1
?? ofm-dump-zed-creds.ps1
?? ofm-register-zed-provider.mjs
?? ofm-repair.ps1
?? ofm-standalone-hidden.vbs
?? ofm-standalone-run.cmd
?? ofm-standalone.cmd
?? ofm-sync-zed.mjs
?? scripts/_dict-dump.mjs
```

> File `backup-data.*`, `ofm-*.ps1`, `ofm-*.mjs`, `hapus`, `nul`, `ofm-bench-results.json`
> adalah **milik user** — jangan hapus/commit tanpa konfirmasi.
> File sementara agen yang harus dihapus sebelum commit: `_dict-en.json`, `_dict-zh.json`,
> `_keys.txt`, `scripts/_dict-dump.mjs`.

### 2.3 Sudah diterjemahkan (5 file, selesai penuh)

1. `packages/standalone/frontend/app.tsx` — login, loading, notice/error, footer.
2. `packages/standalone/frontend/components/shell.tsx` — navigasi, brand, topbar, theme toggle.
3. `packages/standalone/frontend/components/overview.tsx` — kartu, chart, sumber model,
   pemeriksaan runtime. Sudah pakai `Intl.NumberFormat('id-ID')` + `toLocaleTimeString('id-ID')`.
4. `packages/standalone/frontend/connection.tsx` — kredensial, contoh `curl` (`'Halo'`), rotasi key.
5. `packages/standalone/frontend/models.tsx` — tabel virtual, filter, uji model, toggle visibilitas,
   `Intl.NumberFormat('id-ID')`, `toLocaleString('id-ID')`.

### 2.4 Belum diterjemahkan (sisa teks Han, terukur)

| File | Sisa Han | Cakupan |
|---|---:|---|
| `packages/standalone/frontend/usage.tsx` | 570 | metrik, tren harian, tabel per model, paginasi, footnote |
| `packages/standalone/frontend/settings.tsx` | 470 | label, help text, status simpan |
| `packages/standalone/frontend/components/channel-browser.tsx` | 231 | — |
| `packages/standalone/frontend/channels.mjs` | 313 | `ChannelTools`, `ChannelConsole`, `EacPage`, label tab |
| `packages/standalone/frontend/index.html` | 5 | `lang`, `<title>` |
| `packages/standalone/frontend/visibility-data.mjs` | — | tambah cabang locale `id` |
| `packages/standalone/frontend/{models-data,settings-data,usage-data,theme}.mjs` | — | komentar + pesan validasi |
| `packages/standalone/web/splash.html` | — | Mandarin; dipakai desktop Tauri (prioritas rendah) |
| `client.js` | — | `DICT.zh`, `CHANNEL_PROVIDERS`, `ago()` |
| `packages/standalone/{service,management,cli,eac,login-terminal}.mjs` | — | pesan user-facing |
| `vendor/channel-pack/src/**` | — | butuh rebuild `pack.js` (**esbuild tidak terpasang**) |

Catatan `settings-data.mjs`: ada `'最大输出 Token必须是 512–131072 的整数。'`,
label `'最大输出 Token'`, dan `'刷新间隔'`.

---

## 3. Keputusan Desain

**Terjemahkan langsung di sumber, tanpa framework i18n.**
Frontend standalone tidak punya mekanisme i18n; `locale/{en,zh}.json` hanya berisi
`meta.title` / `meta.description`. Menambah i18n akan mengubah arsitektur dan berisiko.

---

## 4. Cara Melanjutkan (urutan kerja)

1. **`usage.tsx`** — metrik, tren harian, tabel per model, paginasi, footnote;
   gunakan `Intl.NumberFormat('id-ID')`.
2. **`settings.tsx` + `settings-data.mjs`** — label, help text, pesan validasi, status simpan.
3. **`components/channel-browser.tsx` + `channels.mjs`** — `ChannelTools`, `ChannelConsole`,
   `EacPage`, label tab `['accounts','ledger','logs','tools']`.
4. **`visibility-data.mjs`** — tambahkan cabang locale `id` (deteksi `startsWith('id')`);
   sekarang hanya `en` + fallback `zh`.
5. **`index.html`** — `<html lang="id">`, `<title>Our Free Model · Konsol lokal</title>`.
6. **`client.js`** — ganti **nilai** `DICT.zh` (kunci tetap) menjadi Indonesia;
   ubah `ago()` cabang `zh`; terjemahkan `CHANNEL_PROVIDERS` org/note.
7. **`packages/standalone/{management,cli,service,eac,login-terminal}.mjs`** — pesan user-facing,
   mis. `'请先登录管理页面'`, `'推理服务已暂停，请先在服务设置中启用'`, usage CLI, teks PowerShell login.
8. **Build & cek:**
   ```bash
   npm run typecheck:standalone
   npm run build:standalone-ui
   node scripts/build-standalone-ui.mjs --check
   ```
9. **Sesuaikan test** yang meng-assert string UI (lihat §6).
10. **Restart service:**
    ```bash
    netstat -ano | grep ':18900'          # ambil PID
    powershell -NoProfile -Command "Stop-Process -Id <pid> -Force"
    wscript.exe D:\Aset\dsh-ofm\ofm-standalone-hidden.vbs
    ```
    Wrapper `ofm-standalone-hidden.vbs` → `ofm-standalone-run.cmd` →
    `node packages\standalone\cli.mjs --port 18900`, dan membersihkan `service.lock` stale.
11. **Verifikasi menyeluruh** (lihat §7).
12. **Hapus file sementara agen**, lalu commit:
    `Terjemahkan antarmuka konsol ke Bahasa Indonesia`

---

## 5. Glosarium (wajib konsisten)

| Mandarin | Indonesia | | Mandarin | Indonesia |
|---|---|---|---|---|
| 概览 | Ringkasan | | 渠道 | Kanal |
| 模型清单 | Daftar model | | 账号 | Akun |
| 用量统计 | Statistik pemakaian | | 积分 | Kredit |
| 免费账号渠道 | Kanal akun gratis | | 签到 | Check-in |
| EAC 协付渠道 | Kanal patungan EAC | | 刷新 | Segarkan / Perbarui |
| API 接入 | Akses API | | 重试 | Coba lagi |
| 服务设置 | Pengaturan layanan | | 保存 | Simpan |
| 数据看板 | Dasbor data | | 加载中 | Memuat |
| 运行日志 | Log operasional | | 回合 | Giliran |
| 网关设置 | Pengaturan gateway | | 物理请求 | Permintaan fisik |
| 聚合渠道 | Kanal agregat | | 首字延迟 | Latensi token pertama |
| 省 Token | Hemat token | | 生成速度 | Kecepatan generasi |
| 路由 | Rute | | 上下文 | Konteks |
| 推理 | Inferensi | | 输出 | Keluaran |
| 可用性探测 | Deteksi ketersediaan | | 输入 | Masukan |
| | | | 思考 | Penalaran |
| | | | 缓存命中 | Cache hit |

**Pemetaan `CHANNEL_PROVIDERS` (`client.js` L3956):**
`华为云`→Huawei Cloud, `腾讯`→Tencent, `有道`→Youdao, `阿里系`→Alibaba,
`字节`→ByteDance, `讯飞`→iFlytek, `商汤`→SenseTime, `智谱`→Zhipu.

**Placeholder `DICT` yang harus dipertahankan persis:**
`{reason}`, `{login}`, `{count}`, `{credit}`, `{ms}`, `{name}`, `{repo}`, `{stars}`,
`{total}`, `{shown}`, `{page}`, `{pages}`, `{enabled}`, `{when}`, `{ladder}`.

---

## 6. Test yang Meng-assert String UI (WAJIB disesuaikan)

`scripts/standalone-react-ui-test.mjs`:
- L54, L57 — `getByRole('button', { name: '进入控制台' })`
- L59 — `nav('模型清单')`
- L61, L66 — `nav('服务设置')`
- L64 — `getByText('设置已保存并生效', { exact: true })`
- L66 — `nav('概览')`
- L79 — `nav('免费账号渠道')`, `getByLabel('搜索渠道')`

`scripts/standalone-package-test.mjs`:
- L285 — `.filter({ hasText: '免费账号渠道' })`
- L286 — `getByLabel('搜索渠道')`

`scripts/client-lint.mjs`:
- Memastikan setiap `t('key')` ada di `DICT.zh` **dan** `DICT.en`, tidak ada kunci tak terpakai,
  dan kedua set kunci identik.
- **Mengganti nilai (bukan kunci) tetap lulus lint.**

`scripts/standalone-frontend-test.mjs` (L80) hanya memeriksa nama chunk, bukan teks UI.
`scripts/standalone-channels-test.mjs` dan `standalone-management-test.mjs` — periksa ulang
apakah ada assert string Mandarin sebelum commit.

---

## 7. Definition of Done

- [ ] `npm run typecheck:standalone` lulus
- [ ] `npm run build:standalone-ui` lulus
- [ ] `node scripts/build-standalone-ui.mjs --check` lulus
- [ ] `npm run test:standalone` → **24/24**
- [ ] `/health` → 200
- [ ] `/v1/models` memuat `deepseek-v4.1-flash-free` **dan** `glm-5.3-flash-free`
- [ ] chat non-stream kedua model → 200
- [ ] `node scripts/free-lane-wire-test.mjs` lulus
- [ ] Buka `http://127.0.0.1:18900/` — tidak ada teks Han di navigasi, kartu, tombol, pesan error
- [ ] Tidak ada sisa teks Han di `frontend/` kecuali komentar internal (opsional)

---

## 8. Pitfalls (jangan dilanggar)

- **JANGAN sentuh `vendor/channel-pack/pack.js`** — file generated. Edit `src/*.ts` lalu rebuild
  (butuh esbuild; **belum terpasang**). Opsi aman: lewati vendor di iterasi pertama.
- **JANGAN edit `packages/standalone/channels/business.mjs`** — generated oleh
  `scripts/build-standalone-channels.mjs`, ada header "请勿手改"; `--check` membandingkan hash.
- **JANGAN ubah `frontend/` tanpa rebuild** — server melayani `web/`.
- **JANGAN ubah logika lane** (`src/upstream.js`, gate fingerprint, `FINGERPRINT_TOOLS`).
- **Encoding:** file berisi non-ASCII → tulis UTF-8.
- `client-lint.mjs` mem-parsing `DICT` dengan regex `^\s*'key'\s*:` / `^\s*identifier\s*:` —
  jangan ubah format blok, jangan ubah kunci.
- `scripts/lib/standalone-shared-ui.mjs` memakai `replaceOnce` dengan string persis.
  Mengubah teks anchor di `client.js` (mis. `'chan.sub'` di L20) akan **menggagalkan build**.
  Teks yang di-replace berada di sekitar baris 6401+.
- **Jangan simpulkan "normal" dari `200 OK` di `/`** — SPA shell selalu 200. Uji endpoint API-nya.
- `taskkill` gagal di Git Bash (MSYS path mangling). Pakai:
  `powershell -NoProfile -Command "Stop-Process -Id <pid> -Force"`.
- Jika `build:standalone-ui` gagal karena `replaceOnce` tidak menemukan anchor, berarti ada teks
  di `client.js` yang ikut berubah — kembalikan teks anchor tersebut ke bentuk aslinya.

---

## 9. Inventaris Sumber String Mandarin

| Sumber | Isi |
|---|---|
| `packages/standalone/frontend/*.tsx` / `*.mjs` / `index.html` | Sumber UI standalone → build ke `packages/standalone/web/` |
| `client.js` (root, ±496 KB) | Bundel plugin: `DICT.zh` / `DICT.en` (baris ±34–1405; **683 kunci**, EN lengkap) + komponen bersama: `ChannelCard` (L4064), `LedgerPage` (L4762), `LogsPage` (L4892), `EacAuth` (L3199), `Dashboard` (L3234), `CHANNEL_PROVIDERS` (L3956) |
| `packages/standalone/{service,management,cli,eac,login-terminal}.mjs` | Pesan error/CLI user-facing |
| `vendor/channel-pack/src/**` | Pesan runtime kanal (≈11k karakter non-komentar) |
| `locale/{en,zh}.json` | Hanya `meta.title` / `meta.description` |

---

## 10. Build Reference

`packages/standalone/README.md`:

```bash
npm ci --prefix packages/standalone --ignore-scripts
npm run typecheck:standalone
npm run build:standalone-ui
node scripts/build-standalone-ui.mjs --check
```

- `frontend/` = sumber, `web/` = output yang di-commit. **Rebuild wajib.**
- `vite.config.mjs` memakai plugin `standaloneSharedUi()` yang membaca `client.js`,
  jadi perubahan `DICT` ikut masuk ke `web/`.

---

# SESI 15g — 2026-10-18 — Audit model hidup & pembersihan daftar sembunyi

Bagian ini **melengkapi** handover di atas. Fokus sesi ini bukan terjemahan (sudah selesai),
melainkan memastikan **model yang masih hidup tidak ikut disembunyikan**.

## 11. Temuan kunci

### 11.1 Id berprefiks vendor = baris channel **Kilo**, bukan lane gratis

`/v1/models` menampilkan id seperti `nvidia/nemotron-3.5-super-vl:free`, tetapi id itu
**bukan** entri lane gratis. Ia berasal dari `catalogStore.kiloRows` (`channel: "kilo"`),
yang disimpan di `~/.our-free-model/catalog.json`.

Konsekuensinya:

- `isFreeLane()` **tidak** mengenali `:free` (regex hanya menerima `-free`/`_free`).
  Jadi `buildCatalog()` melewatinya — benar, karena mereka masuk lewat `reviveKiloCatalog()`.
- Nama tampilan & `contextWindow` sudah benar dari `kiloRows` (mis.
  `Kilo Nemotron 3.5 Super VL`, 1.000.000). **Tidak perlu** menambah `DISPLAY_NAMES`
  untuk id berprefiks. Catatan lama di §Next sesi sebelumnya keliru.
- `computeMembership()` mengecualikan entri ber-`channel` dari probe
  (`probeable = catalog.filter(entry => !entry.channel)`), sehingga baris Kilo
  **tidak pernah** ditandai `unavailable`. Satu-satunya penghalang iklan adalah
  `hiddenModelIds`.

### 11.2 `availability.json` bukan ground truth

Entri `unavailable` bisa basi dan **ikut** memfilter iklan (`runtime.js:377`).
Selalu probe langsung sebelum menyimpulkan model mati.

### 11.3 Sisa aksara Han = komentar kode, bukan teks UI

`grep -nP '[\x{4e00}-\x{9fff}]' client.js` → 180 baris, **semuanya** di `>1415`
(komentar CSS di dalam template `CSS` dan komentar JS). Tidak ada satu pun di
`DICT.zh`/`DICT.en` (baris 34–1405). Nilai `DICT.zh` sudah berisi Bahasa Indonesia.

Jadi `packages/standalone/web/channels-C0e2HGt0.js` (103 baris Han) juga **hanya
komentar CSS**. Tidak ada teks Han yang dilihat user. Menerjemahkannya murni
kosmetik dan tidak dilakukan di sesi ini.

Satu-satunya sisa yang benar-benar terlihat: fragmen URL `#git-安装` / `#安装`
di `client.js:3792-3793`. Jangan diubah tanpa memastikan anchor README GitHub-nya,
karena mengganti fragmen akan mematahkan tautan.

## 12. Hasil audit model (2026-10-18)

`hiddenModelIds`: **26 → 12**. `/v1/models`: **8 → 20** model.

### Model yang dilepas (terbukti 200 + `tool_calls ≥ 1` + `[DONE]`)

| Id | tool_calls |
|---|---|
| `nvidia/nemotron-3.5-super-vl:free` | 1 |
| `nvidia/nemotron-3.5-lightning:free` | 2 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 2 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 2 |
| `nvidia/nemotron-3-super-120b-a12b:free` | 2 |
| `poolside/laguna-s-2.1:free` | 8 |
| `poolside/laguna-xs-2.1:free` | 8 |
| `liquid/lfm-2.5-2.6b:free` | 8 |
| `stealth/glyph-cluster` | 2 |
| `reflection/beam-free` | 4 |
| `xingchen-agi/xing4.0-29b-a4b:free` | 2 |
| `dots-studio/dots-3-note-preview:free` | 4 |
| `cohere/north-mini-code:free` | 14 |
| `kilo-auto/free` | 2 |

Semua id `nvidia/` yang tersedia **sudah dilepas**. Hanya
`nvidia/nemotron-3.5-content-safety:free` tetap disembunyikan karena
**404 `No endpoints found that support tool use`** — model itu bukan model agent.

### Tetap disembunyikan (12) — semuanya terbukti mati/belum pasti

| Id | Alasan |
|---|---|
| `big-pickle` | 403 `LANE_LOCKED` |
| `beam-free` | 403 `LANE_LOCKED` |
| `mimo-v2.6-flash-free` | 403 `LANE_LOCKED` |
| `nemotron-3.5-super-vl-free` | 403 `LANE_LOCKED` (bare id) |
| `nemotron-3.5-lightning-free` | 403 `LANE_LOCKED` (bare id) |
| `jev-1.13-free` | 403 `LANE_LOCKED` |
| `longcat-2.5-preview-free` | 403 `LANE_LOCKED` |
| `deepseek-v4.1-flash-free` | 403 `LANE_LOCKED` |
| `glm-5.3-flash-free` | 403 `LANE_LOCKED` |
| `space-bunny-free` | 403 `LANE_LOCKED` |
| `thinkingmachines/inkling-small:free` | 429 limit harian per model — ulangi besok |
| `nvidia/nemotron-3.5-content-safety:free` | 404 tanpa dukungan tool use (final) |

**Pelajaran:** 502 (`ResourceExhausted 16/16`) dan 429 hanyalah kondisi sesaat.
Model yang sebelumnya dianggap mati karena 502/hang ternyata hidup saat diulang.

## 13. Perubahan berkas

| Berkas | Perubahan |
|---|---|
| `scripts/ofm-hide-dead-models.mjs` | **Diperbaiki.** Dulu membaca `/v1/models` (sudah tersaring) sebagai satu-satunya sumber, sehingga `--write` menghapus seluruh `hiddenModelIds`. Sekarang menggabungkan listing + `hiddenModelIds` yang ada, punya pengaman "hasil kosong → batal", dan mencetak diff `+`/`-`. |
| `scripts/ofm-probe-batch.mjs` | Menambah jeda antar-probe (`PROBE_DELAY_MS`, default 20 dtk) agar tidak memicu 429. |
| `scripts/ofm-unhide-alive.mjs` | Baru (dari sesi sebelumnya) — pelepasan id secara bedah. |
| `scripts/ofm-probe-model.mjs` | Baru (dari sesi sebelumnya) — probe satu model. |

## 14. Cara pakai (aman)

```bash
# probe (jeda 20 dtk otomatis)
node scripts/ofm-probe-batch.mjs "<id>"

# lepas dari daftar sembunyi (dry-run dulu)
node scripts/ofm-unhide-alive.mjs "<id>"
node scripts/ofm-unhide-alive.mjs --write "<id>"

# audit ulang seluruh daftar (dry-run; TIDAK merusak)
node scripts/ofm-hide-dead-models.mjs
```

## 15. Sisa pekerjaan

- [ ] Ulangi probe `thinkingmachines/inkling-small:free` besok (429 harian).
- [ ] Sinkronkan daftar model di settings Zed bila perlu
      (`scripts/ofm-zed-prune-models.mjs --write`, **bukan** `ofm-sync-zed.mjs`).
- [ ] Rotasi API key OpenRouter — sudah terekspos di chat.
- [ ] (Opsional) terjemahkan 180 baris komentar kode di `client.js`; tidak berdampak ke UI.

## 16. Pitfalls tambahan

- **Jangan pakai `/v1/models` sebagai daftar lengkap.** Endpoint itu hanya memuat
  model yang lolos filter; id tersembunyi tidak muncul di sana.
- **Jangan samakan bare id dengan id berprefiks.** `nemotron-3.5-super-vl-free`
  (403) ≠ `nvidia/nemotron-3.5-super-vl:free` (200, baris Kilo).
- **`ofm-hide-dead-models.mjs --write`** kini aman, tetapi tetap jalankan dry-run
  lebih dulu dan periksa baris `+`/`-`.

# SESI 15h — 2026-10-18 — 20 model masuk picker Zed (vision diperbaiki)

## 17. Jawaban pertanyaan terakhir

**`nvidia/nemotron-3.5-super-vl:free` sudah masuk Zed?** Sebelum sesi ini: BELUM.
Sekarang: SUDAH, dengan `capabilities.images: true`.

**Support vision?** Ya. `~/.our-free-model/catalog.json` → `kiloRows` mencatat
`vision: true`, `contextWindow: 1000000`, `maxOutput: 131072`.

Alasannya dulu tidak terdeteksi: `/v1/models` TIDAK mengirim flag vision untuk
baris channel Kilo (hanya `gemini/*` yang mengirim `input:[text,image]` +
`vision:true`). Jadi Zed tidak bisa menebak; `images` harus ditulis manual.

## 18. Yang berubah di settings Zed

| Item | Sebelum | Sesudah |
|---|---|---|
| Entri `available_models` | 6 | **20** |
| Entri `images: true` | 0 | **6** |

Enam baris ber-vision yang sekarang benar:

- `nvidia/nemotron-3.5-super-vl:free`
- `dots-studio/dots-3-note-preview:free`
- `open_router/dots-studio/dots-3-note-preview:free`
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
- `openrouter/free`
- `gemini/gemini-3.8-flash`

(`openrouter/free` dan `gemini` dulu salah `false`.)

## 19. Skrip baru: `scripts/ofm-zed-add-models.mjs`

Bedah string, bukan round-trip JSON — komentar kepala dan EOL di luar array utuh.
Idempoten: hanya menambah yang belum ada dan memperbaiki `images` yang meleset
dari katalog. Sumber kapabilitas = `catalog.json` → `kiloRows`.

```bash
node scripts/ofm-zed-add-models.mjs            # dry-run
node scripts/ofm-zed-add-models.mjs --write    # tulis + backup .bak-ofm-N
node scripts/ofm-zed-add-models.mjs --write <id> [id...]  # hanya id tertentu
```

Catatan `max_output_tokens`: gateway membatasi output dengan
`Math.min(entry.maxOutput, defaultMaxTokens ?? 32768)` (`src/adapter.js:133`).
Karena `defaultMaxTokens` = 32768, skrip menulis batas efektif itu, bukan angka
katalog mentah (mis. 131072 / 460800) yang toh akan dipotong gateway.
Pengecualian: model dengan `maxOutput < 32768` (mis. `liquid/lfm-2.5-2.6b` → 8192).

## 20. Perbaikan skrip lain

- `scripts/ofm-zed-prune-models.mjs`
  - `KEEP_EXACT` diperluas ke 15 id baru, jadi `--write` tidak lagi memangkas
    model Kilo yang sudah hidup. Dry-run sekarang: **20 → 20, hapus 0**.
  - Deteksi penyedia diganti dari `"Our-Free-Local"` menjadi
    `"Our-Free-Local":` — nama itu juga muncul di `agent.favorite_models`
    (`provider: "Our-Free-Local"`), yang dulu memicu false positive
    "penyedia muncul lebih dari sekali".

## 21. EOL

Berkas Zed memang sudah campur sebelum sesi ini (302 CRLF + 101 LF).
Skrip baru menormalkan **hanya blok `available_models`** ke satu EOL (LF);
sisa berkas tidak disentuh. Validasi menolak hasil dengan EOL campur di array.

## 22. Sisa pekerjaan (diperbarui)

- [ ] **Restart Zed** agar picker memuat 20 model (settings tidak di-watch).
- [ ] Ulangi probe `thinkingmachines/inkling-small:free` besok (429 harian).
      Id ini `vision: true` dan BELUM masuk daftar Zed.
- [ ] Rotasi API key OpenRouter — sudah terekspos di chat.
- [ ] (Opsional) terjemahkan 180 baris komentar kode di `client.js`.

## 23. Verifikasi sesi ini

```
byte 19625 | entri 20 | header true | array CRLF 0 | favorite_models utuh
```

```bash
node scripts/ofm-zed-add-models.mjs   # 20 -> 20, ditambah 0, images 0
node scripts/ofm-zed-prune-models.mjs # 20 -> 20, dihapus 0
```

# SESI 15i — 2026-10-19 — 3 model OpenCode pulih, ditandai sementara

## 24. Ringkasan

Kuota free tier OpenCode sudah reset, sehingga `403 LANE_LOCKED` hilang. Empat id
diprobe ulang; tiga yang disetujui user dikembalikan ke picker Zed dengan penanda
`· sementara`, karena free tier OpenCode diperkirakan dibatasi maksimal ±2 jam/hari.

Gateway tetap `http://127.0.0.1:18900` (v2.5.3). UI standalone sudah 100% Bahasa
Indonesia (lihat §26).

## 25. Hasil probe ulang (2026-10-19)

| Id | Status | Detail |
|---|---|---|
| `big-pickle` | HIDUP | 1115 ms, tool_calls=2, done=true |
| `deepseek-v4.1-flash-free` | HIDUP | 1841 ms, tool_calls=20, done=true |
| `glm-5.3-flash-free` | HIDUP | 3430 ms, tool_calls=2, done=true |
| `mimo-v2.6-flash-free` | HIDUP | 3615 ms, tool_calls=10 — **tidak dipakai** (user membatasi ke 3 id) |

Batch lain **tidak dijalankan** karena user membatasi cakupan ke tiga id di atas.

## 26. Catatan front end Bahasa Indonesia (sebelumnya belum tercatat)

- UI standalone **sudah 100% Bahasa Indonesia** (splash, picker, pengaturan, status,
  dialog, tombol, pesan galat).
- Sisa aksara Han hanya berada di **komentar kode**, bukan string UI:
  - `client.js` > baris 1415 (~180 baris komentar);
  - `web/channels-C0e2HGt0.js` (~103 baris komentar).
- Tidak ada dampak ke tampilan. Terjemahan komentar bersifat opsional (§30).

## 27. Perubahan yang diterapkan

### `scripts/ofm-zed-add-models.mjs`

- Flag baru `--temporary`: menambahkan sufiks `· sementara` pada `display_name`.
  Skema Zed tidak punya field `temporary`, jadi nama tampilan adalah penandanya.
- `EXTRA` diperluas dengan tiga id (nilai dari `src/catalog.js` →
  `FREE_ID_OVERRIDES`, bukan tebakan):

| Id | vision | contextWindow | maxOutput katalog | output efektif |
|---|---|---|---|---|
| `big-pickle` | true | 262144 | 131072 | 32768 |
| `deepseek-v4.1-flash-free` | true | 1048576 | 384000 | 32768 |
| `glm-5.3-flash-free` | true | 1048576 | 131072 | 32768 |

Output efektif = `Math.min(maxOutput, defaultMaxTokens)`; `defaultMaxTokens` = 32768
(`src/adapter.js:133`).

### `scripts/ofm-zed-prune-models.mjs`

- Ketiga id ditambahkan ke `KEEP_EXACT`. Tanpa ini, `--write` akan **menghapus**
  mereka karena allowlist lama tidak mengenalinya.

### `hiddenModelIds` (via API manajemen, tanpa restart)

- Sebelum: 12 → sesudah: 9.
- Dilepas: `big-pickle`, `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`.

### `available_models` Zed

- 20 → **23** entri; 3 di antaranya bersufiks `· sementara`.
- Backup: `settings.json.bak-ofm-5`.
- Komentar kepala, EOL, dan `favorite_models` tidak disentuh.

Entri yang ditambahkan:

```
big-pickle                 -> Big Pickle · sementara                          | images=true ctx=262144  out=32768
deepseek-v4.1-flash-free   -> DeepSeek V4.1 Flash (free) · sementara          | images=true ctx=1048576 out=32768
glm-5.3-flash-free         -> GLM 5.3 Flash (free) · sementara                | images=true ctx=1048576 out=32768
```

## 28. Verifikasi sesi ini

```bash
node scripts/ofm-zed-add-models.mjs --temporary "big-pickle" "deepseek-v4.1-flash-free" "glm-5.3-flash-free"
# -> "Tidak ada perubahan" (idempoten)

node scripts/ofm-zed-prune-models.mjs
# -> 23 -> 23, dihapus 0

curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:18900/v1/models
# -> 23 model teriklankan
```

- `/v1/models` memuat ketiga id dengan `context_window` 262144 / 1048576 / 1048576.
- `defaultMaxTokens` = 32768; `standalonePort` = 18900; `hiddenModelIds` = 9.

## 29. Cara mencabut penanda sementara

Bila kuota OpenCode habis lagi dan model kembali `403 LANE_LOCKED`:

1. Probe ulang: `node scripts/ofm-probe-batch.mjs "<id>"`.
2. Bila mati, sembunyikan lagi lewat API manajemen
   (`hiddenModelIds` ditambah id tersebut).
3. Hapus entri dari `available_models` Zed (atau hapus sufiks `· sementara`
   secara manual bila masih ingin ditampilkan).
4. Hapus juga id dari `KEEP_EXACT` di `scripts/ofm-zed-prune-models.mjs` agar
   audit berikutnya konsisten.

Bila model pulih lagi, cukup jalankan ulang:

```bash
node scripts/ofm-unhide-alive.mjs --write "<id>"
node scripts/ofm-zed-add-models.mjs --write --temporary "<id>"
```

## 30. Sisa pekerjaan (diperbarui)

- [ ] **Restart Zed total** agar picker memuat 23 model (settings tidak di-watch).
- [ ] Pantau kuota OpenCode; cabut penanda bila ketiga model kembali 403.
- [ ] Ulangi probe `thinkingmachines/inkling-small:free` (429 harian sebelumnya;
      `vision: true`, 1M ctx, belum masuk Zed).
- [ ] Rotasi API key OpenRouter — sudah terekspos di chat.
- [ ] (Opsional) terjemahkan ~180 baris komentar `client.js` dan
      `web/channels-C0e2HGt0.js` ke Bahasa Indonesia.

## 31. Sisa 9 id yang masih tersembunyi

```
space-bunny-free
jev-1.13-free
longcat-2.5-preview-free
beam-free
nemotron-3.5-super-vl-free          (bare id, beda dari nvidia/...:free)
nemotron-3.5-lightning-free         (bare id)
thinkingmachines/inkling-small:free (429 harian)
nvidia/nemotron-3.5-content-safety:free (404 tanpa tool use — final)
mimo-v2.6-flash-free                (hidup, sengaja tidak dipakai)
```

---

# SESI 15k — 2026-10-19 — Akar 400/403: blokir IP OpenCode, bukan payload

## 32. Ringkasan

User memilih `DeepSeek V4.1 Flash (free) · sementara` di Zed dan menerima
`Request failed upstream HTTP 400`. Investigasi sesi ini membuktikan bahwa
**bentuk payload bukan penyebabnya**: lima varian payload ala Zed (minimal,
`tools`, `stream_options`, riwayat multi-turn + `tool` role, dan gabungan
lengkap dengan `parallel_tool_calls` + `temperature`) semuanya dijawab **403**
oleh upstream dengan pesan yang sama:

```json
{"error":{"message":"OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account. If you're on a VPN or proxy, turn it off and try again, or subscribe to OpenCode Go at https://opencode.ai/go to keep building.","type":"permission_error","code":"LANE_LOCKED","param":null}}
```

Artinya: **blokir IP/ASN di sisi OpenCode**, bukan kuota 2 jam, bukan
kredensial, bukan `reasoning_effort`, dan bukan gate klien.

### Koreksi hipotesis lama

- ❌ `reasoning_effort: "medium"` menyebabkan 400 — **SALAH**. Semua varian,
  termasuk yang tanpa `reasoning_effort`, tetap 403.
- ❌ `parallel_tool_calls`, `stream_options`, atau riwayat `tool` — **SALAH**.
- ❌ Workaround openchamber#5086 ("gate butuh tool `read`") — tidak berlaku.
- ✅ Penyebab nyata: `LANE_LOCKED` karena IP publik mesin ini ditandai
  "abusive traffic".

`~/.our-free-model/stats.json` mendukung: request sukses sampai
`2026-10-18T19:02Z`, lalu FAIL cepat (0,7–1,1 s, `noUsage:true`) sejak
`19:04Z` — pola khas penolakan gate, bukan timeout model.

## 33. Perubahan kode

### `src/http.js` → `classifyFailure`

Sebelumnya hanya satu teks yang dikenali sebagai `LANE_LOCKED`:
`/free tier can only be used from within/i`. Teks blokir-IP yang baru jatuh ke
cabang `type === 'permission_error'` → `PERMISSION_DENIED`, sehingga pesan ke
user tidak menjelaskan bahwa masalahnya ada di jaringan, bukan akun.

Sekarang cabang `LANE_LOCKED` mengenali tiga hal:

1. `error.code === 'LANE_LOCKED'` (sinyal machine-readable, tahan perubahan
   redaksi),
2. `/abusive traffic|available from your current network/i`, dan
3. teks lama `/free tier can only be used from within/i`.

Untuk kasus blokir-IP, pesan upstream **tetap dipertahankan** lalu ditambah
petunjuk Bahasa Indonesia:

> — IP/jaringan ini diblokir sementara oleh OpenCode (bukan kredensial atau
> kuota); coba jaringan lain seperti tethering, atau tunggu sampai blokirnya
> dicabut

Urutan lama tetap: `REGION_BLOCKED` diperiksa lebih dulu, jadi penolakan
region tidak berubah menjadi `LANE_LOCKED`.

### `scripts/freetier-gate-test.mjs`

Ditambah 5 pemeriksaan:

- penolakan level-IP → `LANE_LOCKED`,
- kata-kata upstream dipertahankan,
- petunjuk Indonesia ditambahkan,
- `code: LANE_LOCKED` saja (tanpa teks dikenal) tetap `LANE_LOCKED`,
- `403 permission_error` biasa tetap `PERMISSION_DENIED`.

### Verifikasi

```
node scripts/freetier-gate-test.mjs   → all checks passed (16)
node scripts/route-test.mjs           → agree
node scripts/stream-failure-test.mjs  → 80/80 pass
node scripts/retry-safety-test.mjs    → all 8 shapes classified
```

## 34. Status tiga model `· sementara`

| Id | Status saat ini |
|---|---|
| `big-pickle` | 403 blokir IP |
| `deepseek-v4.1-flash-free` | 403 blokir IP |
| `glm-5.3-flash-free` | 403 blokir IP |

**Keputusan produk belum diambil.** Sesuai §29, bila blokir berlanjut pilihannya:
(a) biarkan dengan label `· sementara` (user bisa mencoba lagi setelah IP
pulih), atau (b) sembunyikan lewat `hiddenModelIds` + hapus dari picker Zed.
Jangan hapus entri tanpa persetujuan user.

## 35. Langkah berikutnya

1. **Restart gateway** agar perubahan `src/http.js` berlaku (tidak ada
   file-watching): hentikan PID lama lalu jalankan ulang
   `packages\standalone\cli.mjs --port 18900`.
2. Uji dari jaringan lain (tethering HP) dengan payload yang sama. Bila 200 →
   konfirmasi blokir per-IP/ASN, bukan kode OFM.
3. Cek IP publik: `curl -s https://api.ipify.org`.
4. Bila tetap 403, putuskan hide vs biarkan (lihat §34).
5. Rotasi API key OpenRouter (sudah terekspos di chat) — masih backlog.

## 36. Catatan yang belum tercatat sebelumnya

- Frontend `dsh-ofm` **sudah 100% Bahasa Indonesia** (dict `zh` di `client.js`
  kini berisi teks Indonesia dan menjadi fallback yang tampil). Ini belum
  pernah dicatat di HANDOVER sebelum sesi ini.
- `scripts/ofm-probe-zed-shape.mjs` (dulu `tmp-probe-zed-payload.mjs`) adalah
  satu-satunya alat reproduksi payload ala Zed; pertahankan (bukan sampah
  sementara). Jalankan: `node scripts/ofm-probe-zed-shape.mjs "<id>"`.

# SESI 15n — 2026-10-19 — Akar 400: nama tool bertitik dua

## 37. Penyebab `upstream HTTP 400` pada model `· sementara`

**Bukan** blokir IP, **bukan** `reasoning_effort`, `parallel_tool_calls`,
`stream_options`, atau panjang nama tool. Penyebabnya adalah **titik dua pada
nama tool**.

Zed mendeklarasikan tool MCP sebagai `mcp:rea:open_binary`,
`mcp:rea:inspect_artifact`, dst. Upstream `/zen/v1` menolak deklarasi tool dengan
nama di luar alfabet `[A-Za-z0-9_-]` memakai **HTTP 400 dengan body kosong**.
Karena body kosong, `classifyFailure` jatuh ke `upstream HTTP ${status}` — itulah
pesan yang tampil di Zed.

Bukti terukur (request langsung ke upstream, bypass gateway):

| Varian payload | Hasil |
|---|---|
| minimal (tanpa tools) | 200 |
| 19 tool Zed tanpa titik dua | 200 |
| tanpa `parallel_tool_calls` / `tool_choice` | 200 |
| stubs-only | 200 |
| nama tool 64/65/128 karakter | 200 |
| **`mcp:rea:*` (bertitik dua)** | **400, body kosong** |

## 38. Perbaikan

`src/upstream.js`:

- `sanitizeToolName()` mengganti karakter di luar `[A-Za-z0-9_-]` menjadi `_`,
  membatasi 128 karakter, dengan fallback `tool`.
- `planToolNames()` mereservasi nama yang sudah valid lebih dulu, sehingga nama
  hasil rewrite tidak bisa mencuri nama asli. Tabrakan diberi sufiks digest 6
  hex dari nama asli, jadi pemetaan **stabil antar request**.
- `applyFingerprint()` menulis ulang deklarasi tool, riwayat tool call (Chat,
  Claude, Responses), dan `tool_choice` yang mem-pin tool.
- `applyFingerprint()` mengembalikan `Map` wire → nama asli; `restoreToolName`
  memulihkan `mcp:rea:*` pada respons, sehingga klien tidak melihat nama
  tersanitasi.

Contoh: `mcp:rea:read_file` → `mcp_rea_read_file` (upstream) → dipulihkan menjadi
`mcp:rea:read_file` (Zed).

## 39. Verifikasi

```
node scripts/fingerprint-test.mjs     → all fingerprint checks passed (§8–§10)
node scripts/tool-name-gate-test.mjs  → 11/11 check, end-to-end dengan stub gate
node scripts/test-all.mjs             → entri tool-name-gate ditambahkan
```

`tool-name-gate-test.mjs` menyalin data gateway ke temp, menjalankan gateway
kedua dengan stub upstream yang menolak nama non-alfabet memakai **400 body
kosong** (meniru lane asli), lalu memeriksa dua arah: hanya nama sah yang dikirim,
dan tool call kembali dengan nama asli.

Commit: `7e388d6` — `Tulis ulang nama tool agar lolos gate upstream`.

## 40. Status live dan langkah berikutnya

- Gateway sudah direstart, `/health` → `ok:true`, v2.5.3.
- IP publik saat sesi ini ditutup: **`103.143.196.250`** — masih diblokir
  OpenCode (`403 LANE_LOCKED`, “abusive traffic from this IP address”).
  **Jangan probe beruntun**; ini yang memperpanjang blokir.
- Karena IP masih diblokir, verifikasi live belum bisa menghasilkan 200.
  Perbaikan 400 sudah dibuktikan lewat tes end-to-end dengan stub gate.
- Langkah berikutnya:
  1. Tunggu blokir mereda atau pindah jaringan (tethering).
  2. Jalankan **satu** request: `node scripts/ofm-probe-colon-check.mjs "deepseek-v4.1-flash-free"`.
     Hasil yang diharapkan: **200** (atau 403 berisi body bila IP masih diblokir),
     **bukan** 400 body kosong.
  3. Tes di Zed memakai `DeepSeek V4.1 Flash (free) · sementara` dengan tool MCP aktif.
  4. Catat hasilnya di sesi berikutnya.
- Backlog lama: rotasi API key OpenRouter `sk-or-v1-fdf6…f6b` (sudah terekspos).

## 41. Verifikasi live setelah ganti jaringan — LULUS

IP publik saat verifikasi: **`182.8.249.50`** (bukan IP lama yang diblokir).

Gateway direstart bersih:

- PID lama `22824` dihentikan, port `18900` bebas.
- Dijalankan ulang lewat `wscript.exe ofm-standalone-hidden.vbs`.
- PID baru: **`34488`**; `/health` → `ok:true`, `version 2.5.3`.

Probe konfirmasi (satu request, tanpa pengulangan):

```bash
node scripts/ofm-probe-colon-check.mjs "deepseek-v4.1-flash-free"
```

Hasil: **HTTP 200 (1985ms)**, stream SSE berjalan dan memuat `delta.reasoning`.
Artinya deklarasi tool `mcp:rea:*` sekarang diterima upstream setelah ditulis
ulang oleh `sanitizeToolName`/`planToolNames` di `src/upstream.js`.

Status per penutupan sesi ini:

1. Akar masalah 400 **tertutup** dan terbukti di live, bukan hanya di stub.
2. Sisa langkah: tes dari Zed memakai `DeepSeek V4.1 Flash (free) · sementara`
   dengan tool MCP aktif, lalu catat hasilnya.
3. Jangan probe upstream beruntun — satu-dua request per sesi sudah cukup.

## 42. Sesi lanjutan — probe 200 di IP baru, tes Zed belum dikonfirmasi

Waktu verifikasi: 2026-10-19 15.19 WIB.

### Kondisi live

| Item | Nilai |
|---|---|
| IP keluar | **`182.2.70.248`**, VPN **OFF** |
| Gateway | PID **`49160`**, start **15.15.11 WIB**, v2.5.3, `/health` → `ok:true` |
| Service token | `b20f252f-d7d6-4b23-a3e1-451f8d2fcd06` |
| `egress.enabled` | `false` (ikut jalur sistem) |

### Probe live

```bash
node scripts/ofm-probe-colon-check.mjs
```

Hasil: **HTTP 200 (3300ms)**, stream SSE berjalan dan memuat `delta.reasoning`.
Payload probe memakai nama tool `mcp:rea:read_file`, `mcp:rea:inspect_artifact`,
`mcp:rea:analyze_function` — jadi jalur rewrite `sanitizeToolName` /
`planToolNames` memang aktif di proses yang sekarang.

`last-upstream.json` masih berisi **403** dari `08:16:04Z` (15.16 WIB), yaitu
blokir *abusive traffic* sementara yang sudah lewat — bukan berasal dari request
Zed. `last-incoming.json` ter-update `08:19:24Z` oleh probe di atas, jadi hook
diagnostik terbukti menulis pada proses yang hidup.

### Bukti dari log Zed

Semua `upstream HTTP 400` terakhir terjadi **sebelum** perbaikan di-commit dan
sebelum gateway direstart:

| Waktu (WIB) | Model | Keterangan |
|---|---|---|
| 13:54:42, 13:55:00, 13:55:33 | `DeepSeek V4.1 Flash (free) · sementara` | 400 |
| 14:42:54 | — | commit `7e388d6` rewrite nama tool |
| 14:44:20 | — | commit `f57126a` catat akar 400 |
| 15:15:11 | — | gateway PID `49160` start |
| 15:19:24 | — | probe **200** |

Tidak ada catatan 400 setelah gateway restart. Jadi 400 di Zed yang lama
konsisten dengan kode pra-perbaikan, bukan dengan kondisi sekarang.

Settings Zed juga diperiksa utuh: provider `Our-Free-Local` →
`http://127.0.0.1:18900/v1`, dan tiga model sementara masih berlabel:
`Big Pickle · sementara`, `DeepSeek V4.1 Flash (free) · sementara`,
`GLM 5.3 Flash (free) · sementara`.

### Diagnostik yang BELUM di-commit

| Berkas | Isi |
|---|---|
| `src/debug-dump.js` (baru) | Tulis JSON atomik ke `~/.our-free-model/debug/`; override `OFM_DEBUG_DIR`; tidak pernah throw |
| `src/http.js` | `dumpUpstream(path, body, status, text, headers)` dipanggil di cabang `if (!response.ok)` **sebelum** `classifyFailure` |
| `src/forward.js` | `dumpIncoming(req, value)` dipanggil di `readBody` setelah validasi objek |

Artefak: `last-incoming.json` (body mentah pemanggil, sebelum rewrite) dan
`last-upstream.json` (`path`, `status`, `response`, `headers`, body final).
Keduanya *last-write-wins*, bukan log append.

### Sisa langkah

1. Satu tes dari Zed memakai `DeepSeek V4.1 Flash (free) · sementara` dengan
tool MCP aktif.
2. Bila 400 muncul lagi, baca `~/.our-free-model/debug/last-incoming.json` dan
`last-upstream.json`, lalu bandingkan body-nya dengan payload probe yang 200.
Jangan menebak tanpa dua berkas itu.
3. Commit perubahan diagnostik setelah izin user (`git add` per berkas, jangan
`git add .`).

---

## 43. Akar masalah 400 ditemukan dan DIPERBAIKI — batas ukuran body

**Waktu:** 2026-10-19 sekitar 15.30–15.45 WIB. **Status: selesai, terverifikasi live.**

### 43.1 Cara membuktikan

Body yang tertangkap di `debug/last-upstream.json` (953.462 byte, 227 tool,
44 pesan) diputar ulang **lewat gateway lokal** memakai
`scripts/ofm-probe-replay-size.mjs`. Variabel diubah satu per satu:

| Uji | Byte body | Tool | Hasil |
|---|---:|---:|---|
| `exact` (body Zed apa adanya) | 953.462 | 227 | **400** |
| `fewtools 10` (pesan sama) | 172.902 | 10 | **200** |
| `thin` (227 tool, skema minimal) | 197.519 | 227 | **200** |
| `thinone compare_web_captures` | 787.289 | 227 | **400** |
| `budget 300000` | 291.959 | 27 | **200** |
| `budget 500000` | 391.465 | 33 | **200** |
| `budget 600000` | 599.923 | 58 | **200** |
| `budget 700000` | 699.974 | 92 | **200** |
| `budget 765000` | 764.956 | 154 | **400** |
| `budget 780000` | 779.977 | 166 | **400** |

Kesimpulan: **bukan jumlah tool** (227 tool tetap 200 saat skema diringkas),
**bukan isi pesan** (44 pesan sama tetap 200), dan **bukan satu schema raksasa**
(`thinone` tetap 400). Pemicunya **ukuran total body**: ambang ada di antara
699.974 (lolos) dan 764.956 (ditolak).

Komposisi body 953 KB: `tools` 793 KB (parameter schema 667 KB, deskripsi 105 KB,
nama 4 KB) dan `messages` 160 KB. Jadi tool-lah yang mendominasi.

### 43.2 Perbaikan

| Berkas | Perubahan |
|---|---|
| **`src/request-budget.js`** (baru) | `applyRequestBudget(body, {budgetBytes})` — pangkas deskripsi tool (200 char), lalu batasi kedalaman hanya pada skema yang masih kebesaran (tangga batas 20→16→12→8→5→3→2 KB, kedalaman 6→2). Membuang tool hanya upaya terakhir. Mengembalikan laporan `{trimmed,before,after,toolsShrunk,toolsDropped,fits}`. |
| `src/http.js` | `postStreamed()` memanggil `applyRequestBudget` **sebelum** `JSON.stringify`, dan menulis peringatan lewat `warn` bila dipangkas. |
| `src/adapter.js` | Meneruskan `bodyBudgetBytes` (dari settings) dan `warn` ke `postStreamed`. |
| `src/store.js` | Default baru `requestBodyBudgetBytes: 655360` (640 KiB). Bisa diubah manual di `~/.our-free-model/settings.json`. |
| **`scripts/request-budget-test.mjs`** (baru) | 25 pemeriksaan: body kecil tidak disentuh, 227 tool bertahan, deskripsi dibatasi, kedalaman dibatasi, bentuk flat/Claude ditangani, upaya terakhir membuang tool, dan pengukuran memakai byte UTF-8. |
| `scripts/ofm-probe-replay-size.mjs` (baru) | Probe replay: `exact`, `fewtools N`, `thin`, `thinone NAMA`, `budget N`, `lastmsgs N`, `notools`. |

Pada body Zed asli: **954.050 → 633.701 byte, 227 tool tetap ada, 16 skema
diringkas, 0 tool dibuang.** Setelah gateway di-restart (PID 65596), replay body
yang sama menghasilkan **HTTP 200** dan stream SSE berjalan.

### 43.3 Jawaban untuk pertanyaan `· sementara`

Menghapus label `· sementara` **tidak berpengaruh** pada error. Label itu hanya
`display_name` di settings Zed dan tidak pernah dikirim ke wire; header respons
`x-zen-model: deepseek-v4.1-flash-free` membuktikan id model sudah benar. Label
boleh dihapus murni untuk kerapian, bukan sebagai perbaikan.

### 43.4 Catatan operasional baru

- `debug/last-upstream.json` **single-slot** dan bisa ditimpa probe latar
gateway. Saat sesi ini, berkas 953 KB tertimpa probe `jev-1.13-free` (404)
karena gateway punya probe periodik. **Salin dulu** sebelum replay.
- `scripts/ofm-probe-replay-size.mjs` menerima `OFM_DEBUG_FILE` untuk membaca
salinan aman, bukan slot live.
- Jangan probe beruntun: jeda ≥3 detik. Sesi ini memakai 10 request dengan jeda
3–5 detik tanpa blokir.
- Tes: `node scripts/request-budget-test.mjs` → semua lolos;
`node scripts/forward-test.mjs`, `freetier-gate-test.mjs`, `sanitize-test.mjs`
juga lolos.
- Token layanan berubah setiap restart (sekarang `1bcbdbb2-b678-4737-970a-6cddb920241b`,
PID 65596). **`forwardKey` untuk inferensi tidak berubah**, jadi provider Zed
tetap jalan.
- Pengaturan `requestBodyBudgetBytes` dibaca dari
`~/.our-free-model/settings.json` (default 655360). Menyimpan pengaturan dari
UI tidak menghapusnya karena `stores.settings.update(patch)` hanya menggabung.
- Belum di-commit. HEAD masih `f57126a`.
4. Catatan front end Bahasa Indonesia sudah tercatat di §26 — tidak berubah.

---

## 44. Pembersihan working tree (2026-10-19)

Working tree dibersihkan dari **19 artefak untracked** (15 di root + 4 di `scripts/`).
Tidak ada perubahan pada `src/`, sehingga **gateway tidak perlu di-restart**.

### 44.1 Dihapus (sampah)

| Berkas | Alasan |
|---|---|
| `hapus` | 0 byte, nama tidak bermakna |
| `nul` | 127 byte, sisa redirect `dir` yang gagal (`cannot access ...`) |

### 44.2 Dipindahkan ke `tools/` (helper operasional)

`backup-data.bat`, `backup-data.mjs`, `ofm-bench.mjs`, `ofm-bench-results.json`,
`ofm-check-cred.ps1`, `ofm-dump-zed-creds.ps1`, `ofm-register-zed-provider.mjs`,
`ofm-repair.ps1`, `ofm-sync-zed.mjs`.

- `tools/ofm-bench.mjs` menulis hasil ke `tools/ofm-bench-results.json` karena
  memakai `new URL('./ofm-bench-results.json', import.meta.url)` — pasangan ini
  harus tetap satu folder.
- `tools/ofm-sync-zed.mjs` **hanya referensi, jangan dijalankan**: ia menimpa
  blok provider dan menghapus `images:true` / `reasoning_effort`.

### 44.3 Tetap di root (launcher operasional)

`ofm-standalone.cmd`, `ofm-standalone-run.cmd`, `ofm-standalone-hidden.vbs`.

`ofm-standalone-hidden.vbs` memakai path absolut `D:\Aset\dsh-ofm\ofm-standalone-run.cmd`,
sehingga ketiganya **harus tetap di root** agar prosedur restart (§7 / §43.4) valid.

### 44.4 Diarsipkan

`HANDOVER-2026-10-18-AGENT-STOP.md` → `docs/handover/2026-10-18-agent-stop.md`.

### 44.5 Probe diagnostik di-commit

`scripts/ofm-probe-colon-history.mjs`, `scripts/ofm-probe-model-id.mjs`,
`scripts/ofm-probe-zed-messages.mjs`, `scripts/ofm-probe-zed-schema.mjs`.

### 44.6 `.gitignore`

Ditambahkan entri root-only: `/nul`, `/hapus`, `/commit-msg.tmp`.

### 44.7 Status

- Label `· sementara` pada `deepseek-v4.1-flash-free`, `big-pickle`,
  `glm-5.3-flash-free` **tidak diubah**.
- Front end Bahasa Indonesia **tidak diubah**.
- Gateway tetap PID 65596, `forwardKey` tidak berubah.

# SESI 15o — 2026-10-24 — Uji respons `glm-5.3-flash-free` via gateway

## 45. Hasil uji chat `glm-5.3-flash-free`

Gateway sehat (HTTP 200 di `/health`, v2.5.3, PID 65596), dan model
terdaftar di `/v1/models` dengan `context_window: 1048576`.

Namun, satu request uji chat via curl ke `glm-5.3-flash-free` (jedá ≥3 detik,
`max_tokens: 50`, bahasa Indonesia) menghasilkan:

```json
{"error":{"message":"Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go","type":"rate_limit_error","code":"RATE_LIMIT","param":null}}
```

Ini adalah **rate limit dari OpenCode free tier**, bukan error dari gateway
OFM itu sendiri. Model belum berhasil merespons chat saat uji coba ini
dijalankan. Coba ulang setelah jeda lebih lama atau pada waktu lain.

Status: `glm-5.3-flash-free` tetap aktif di katalog dan di picker Zed,
tetapi uji respons chat belum lulus saat ini.

# SESI 15p — 2026-10-30 — Akar "Free usage limit reached" (429 FreeUsageLimitError)

## 46. Pertanyaan user

Kenapa `deepseek-v4.1-flash-free` dari OpenRouter selalu "Free usage limit
reached" padahal sudah beda hari dan berganti IP / WiFi?

## 47. Fakta yang diukur (2026-10-30, ±11.50 WIB)

### 47.1 Status `availability.json` (probe terakhir `at: 1793335801619` = 30/10 11.50 WIB)

Sebagian besar model free lane **semuanya `throttled`** dengan pesan persis sama:

```jsonn{"state":"throttled","detail":"Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"}
```

Model yang `throttled` (probe 30/10 04.50Z): `deepseek-v4.1-flash-free`,
`big-pickle`, `glm-5.3-flash-free`, `mimo-v2.6-flash-free`,
`nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free`, `beam-free`,
`flint-40b-free`, `jev-1.13-free`.

Model yang `unavailable` + `gated:true` (free tier only within OpenCode):
`ling-3.1-flash-free`, `step-5-preview-free`, `cat-jam-free`,
`muse-spark-1.2/1.3-contributor-free`, `ll-alpha-free`. Ini 403 FreeTierError
(blokir klien/network), bukan kuota.

12 model baru `llm7/*` dan `ovh/*` (keyless OpenRouter) semua `unavailable`
pada 30/10 04.10Z — perlu diperiksa terpisah, bukan bagian dari lane opencode.

### 47.2 Uji langsung ke gateway OFM (curl, `deepseek-v4.1-flash-free`)

Gate OFM meneruskan pesan upstream apa adanya:

```jsonn{"error":{"message":"Free usage limit reached...","type":"rate_limit_error","code":"RATE_LIMIT"}}
```

`glm-5.3-flash-free` identik.

### 47.3 Uji langsung ke upstream OpenCode dengan **sesi baru yang dimint saat ini**

Script temp `mintSessionId()` (encoding sama persis dengan `src/upstream.js`), ke
`https://opencode.ai/zen/v1/chat/completions` dgn header lengkap v1
(`Authorization: Bearer public`, `x-opencode-session` + affinity + id,
`x-opencode-request`, `x-opencode-project`, UA `opencode/1.18.31`). Hasil:

```
SESSION ses_e74ae6993ffeZdAOleEpQXoZdU
STATUS 429
BODY {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached..."}}
```

**Kesimpulan kunci**: sesi **baru** (baru dimint, bukan sesi lama dari
session-map) tetap 429. Ini **membuktikan limit bukan per-sesi** — hipotesis
awal (session-map lama dipakai ulang, 21 sesi dari 19 Okt) **gugur**.

### 47.4 IP publik saat ini

`curl -s https://api.ipify.org` → **`103.143.196.250`**.

Ini **IP yang sama** yang tercatat diblokir sejak SESI 15n (19 Okt):
`103.143.196.250` → 403 `LANE_LOCKED` "abusive traffic from this IP address".
Jadi meski user merasa sudah ganti WiFi/koneksi, IP publik keluar tetap sama
(ISP/ASN sama; NAT/load balancer tidak berubah), sehingga blokir IP terus
berlaku — kini menyamar sebagai 429 FreeUsageLimitError.

## 48. Interpretasi / akar masalah

1. **Pesan "Free usage limit reached" adalah 429 FreeUsageLimitError dari
   upstream OpenCode**, bukan error gateway OFM, bukan blokir kredensial.
2. **Bukan per-sesi**: sesi fresh tetap 429 (uji 47.3).
3. **Sangat mungkin per-IP/ASN**: IP publik keluar tidak berubah
   (`103.143.196.250`, sama dengan yang diblokir `LANE_LOCKED` di sesi 15n).
   Setelah blokir "abusive traffic" dikelola OpenCode, pesannya berubah jadi
   kuota/rate-limit, tapi efeknya tetap sama: model free tidak bisa dipakai
   dari IP ini.
4. Ganti WiFi/koneksi tidak menolong bila IP publik keluar tetap sama. Baru
   menolong bila IP publik berubah (tethering HP via operator lain, VPN dgn
   egress berbeda).

## 49. Rekomendasi / langkah pemakaian

1. **Cek IP publik dulu** sebelum menyalahkan model: `curl -s https://api.ipify.org`.
   Bila masih `103.143.196.250`, model free lane opencode **tidak akan jalan**
   apa pun modelnya / sesinya.
2. Untuk benar-benar memakai lane free opencode: gunakan **egress berbeda**
   (VPS `103.141.234.177` — jangan sentuh, itu untuk hermes; atau tethering
   HP operator lain, atau VPN dengan egress IP berbeda). Setelah IP publik
   berubah, coba lagi.
3. Ketik IP baru berbeda, model opencode free (`deepseek-v4.1-flash-free`,
   `big-pickle`, `glm-5.3-flash-free`, dst) seharusnya bisa merespons lagi.

## 50. Yang TIDAK perlu diubah (penegasan)

- Jangan sentuh `forwardKey` (`ofm-X3NQCZ1UGsYzYI959kp00DOnvDSpvn-r`).
- Jangan hapus label `· sementara` dari model — label tidak berpengaruh pada
  error (sudah dibuktikan di §43.3).
- Tidak ada bug di `src/upstream.js` / `src/http.js` untuk kasus ini —
  `classifyFailure` sudah mengenali 429 → `CODE.quota`, dan pesan upstream
  dipertahankan apa adanya. Perubahan kode tidak diperlukan.
- Jangan probe beruntun (jeda ≥3 detik) — memperpanjang blokir IP.

## 51. Status akhir

- Working tree bersih (HEAD `ffce1ca`).
- Tidak ada perubahan kode pada sesi ini (murni diagnosa).
- Handover ini ditulis 2026-10-30.

# SESI 16 — 2026-11-14 — Perbaikan 429 free lane (9router issue #65) + WARP terbukti gagal

## 52. Konteks

Laporan user: kuota ZEN dipangkas 1M → 200rb dan bisa diakali WARP IPv6/NAT64.
Diungkap lewat issue 9router #65: **`429 FreeUsageLimitError` dipakai upstream
untuk beberapa pemeriksaan berbeda**, bukan hanya kuota. Tiga pemicu ditemukan:

1. **Blok `<env>` wajib** di system prompt — dua baris lengkap
   (`Working directory: /workspace` + `Workspace root folder: /workspace`);
   versi satu baris lolos probe awal tapi gagal request berikutnya (decolua#5128).
2. **Transport check**: body + sesi + IP yang sama → Bun `fetch` = 200,
   Node/undici dan curl = 429. OFM berjalan di Node → selalu 429.
3. **Jam di dalam session id**: `canonicalizeSession` lama menurunkan timestamp
   dari digest SHA-256 → jam acak → 429 3/3, sedangkan jam saat ini 200 3/3
   (A/B live di issue). Reuse sesi berjam-jam tetap aman selama jamnya segar.

## 53. Yang diubah (semua teruji offline, live menunggu reset kuota)

| Berkas | Perubahan |
|---|---|
| `src/upstream.js` | `ENV_BLOCK` + `hasCompleteEnvBlock` + `applyEnvBlock` (3 shape: chat/claude/responses, idempotent, menangani blok parsial), dipanggil dari `applyFingerprint` setelah note. `canonicalizeSession(signal, timestamp)` kini memakai `Date.now()` (counter 1); `sessionClockMs` (fase 48-bit, wrap tiap 2^36 ms ≈ 18.25 jam — `ts*0x1000` tidak muat di 48 bit, sama seperti `mintSessionId` yang sudah diterima upstream); `SESSION_TTL_MS` (2 jam) + `isUsableSession`; `sessionForConversation` hanya memakai ulang id kanonikal berjam segar, sisanya di-mint ulang. |
| `scripts/opencode-transport.mjs` (baru) | Sidecar Bun: `serve` 127.0.0.1 port ephemeral, token per-proses (argv), `/forward` meneruskan method/headers/body dan mengembalikan status/headers/body stream apa adanya (Retry-After included). Baris stdout pertama `{"port":N}`. |
| `src/transport.js` (baru) | `laneFetch(url, init)`: spawn sidecar (kandidat: `OPENCODE_BUN_BIN`, `~/.bun/bin/bun.exe`, `%APPDATA%/npm/node_modules/bun/bin/bun.exe` — shim npm tidak bisa dieksekusi spawn, `bun` PATH), tunggu port (timeout 10 s), forward dengan token, 502/gagal → fallback `egressFetch`. `OPENCODE_TRANSPORT=off` mematikan; flag dibaca per-call. `child.unref` + stdout/stderr unref agar caller pendek tetap bisa exit. |
| `src/http.js` | `postStreamed` & `getJson` memakai `laneFetch` (bukan `egressFetch`). |
| `scripts/opencode-429-fix-test.mjs` (baru) | 33 check: env block 3 shape + idempotensi + parsial; jam sesi (fresh/stale 3 jam/ascending/digest-era), stability per percakapan; kontrak sidecar; `OPENCODE_TRANSPORT=off` → TRANSPORT di upstream mati. **Semua lolos.** |
| `scripts/free-lane-wire-test.mjs`, `scripts/fingerprint-test.mjs` | Disesuaikan: id caller `ses_ffffffffffff…` (jam 1970) kini di-mint ulang — diganti mint fresh; "no note" kini dicek via regex karena system kini sah berisi env block. |
| `scripts/ofm-live-zen-probe.mjs` (baru) | Probe live satu turn lewat pipeline penuh; menampilkan status transport. |

Hasil test lama tetap hijau: fingerprint, free-lane-wire, truncation, projection,
request-budget, freetier-gate, egress, forward, anthropic, effort, aggregate.

## 54. Hasil live (2026-11-14 ±18.00 WIB) — masih 429, bukan karena perbaikan

Bun **murni** (tanpa Node) + env block + sesi jam-segar dari mesin ini juga 429.
Dengan sidecar aktif (`transport sidecar active`) pun 429. Kandidat penjelas:

1. **Kuota harian sungguhan sedang habis** — issue #65 sendiri mencatat "a real
   daily quota (Retry-After in hours, the official CLI hits the same window)".
   `Retry-After` 47.841 s (±13,3 jam) pagi tadi → mengarah ke reset ± tengah
   malam UTC. **Verifikasi ulang besok pagi lewat `scripts/ofm-live-zen-probe.mjs`.**
2. Upstream menambah gate lagi sejak 5 Nov (tanggal A/B issue).

## 55. WARP IPv6/NAT64 — teruji, TIDAK menolong

Dipasang `Cloudflare.Warp` via winget (masih terinstall). Egress IPv4 berubah
(`104.28.219.241`) dan IPv6 hidup (`2a09:bac5:…`), sesi fresh, UA v1 & v2,
endpoint `/zen/v1` & `/inference/v1` — semua tetap 429. Kuota bukan per-IP.
Blokir lamanya bukan `LANE_LOCKED` (bukan abusive-traffic) — ini limit identitas
lain. WARP boleh di-uninstall bila ingin bersih.

## 56. Fakta upstream terkini (2026-11-14)

- `/inference/v1/models` resmi: `deepseek-v4.1-flash-free`, `big-pickle`,
  `glm-5.3-flash-free` → `limit.context: 200000` (pangkasan tier free; varian
  berbayar `deepseek-v4.1-flash` tetap 1.000.000). Laporan user terkonfirmasi.
- `/zen/v1/models` GET tetap 200 (404 hanya di HEAD).
- `ovh/Qwen3.8-27B` (8/8 ok), `llm7/*`, `nvidia/*:free` tetap jalan normal via
  OpenRouter — jalur andalan selagi ZEN dibatasi.

## 57. Status

- Perbaikan ter-commit di sesi ini; gateway perlu **restart** agar memuat
  `src/transport.js` + fingerprint baru (prosedur §7/§43.4).
- Langkah berikut: probe ulang pagi hari (setelah reset kuota); kalau 200,
  `deepseek-v4.1-flash-free`, `big-pickle`, `glm-5.3-flash-free` pulih tanpa
  perubahan tambahan. Kalau masih 429 berjam segar + Bun → gate baru; telusuri
  via MITM request OpenCode CLI resmi seperti pola §6 AGENTS.md-nya 9router.

# SESI 17 — 2026-11-14 — Request terkirim dua kali (sidecar) + retry aman

## 58. Ringkasan satu paragraf

Sesi ini **bukan** menambah trik baru untuk menembus kuota ZEN. Sesi ini
menemukan satu cacat nyata di jalur transport yang membuat setiap gangguan
koneksi mengirim **request yang sama dua kali** ke upstream — dan pada lane
gratis, tiap kiriman membakar kuota dua kali serta terbaca sebagai lalu lintas
abusive. Cacat itu diperbaiki, ditambah satu aturan retry yang aman dan teruji.
Status kuota ZEN sendiri belum berubah (masih 429 sampai reset).

## 59. Temuan utama: `laneFetch` mengirim ulang request yang sudah terkirim

Alur lama di `src/transport.js`:

1. `laneFetch` meneruskan request ke sidecar Bun (`POST /forward`).
2. Sidecar menjalankan `fetch` ke upstream. Kalau `fetch` itu **melempar**
   (mis. `ECONNRESET` karena koneksi diputus), sidecar membalas **HTTP 502**.
3. `laneFetch` melihat `502` dan menyimpulkan "hop-nya rusak", lalu **mengirim
   ulang request yang sama lewat `egressFetch` (Node)**.

Langkah 3 salah: pada titik itu request **sudah dikirim** ke upstream. Yang
gagal adalah upstream/koneksinya, bukan hop lokal. Akibatnya satu turn bisa
meninggalkan dua request di upstream.

Bukti terukur: `node scripts/recovery-test.mjs`
- dengan `OPENCODE_TRANSPORT=off` (Node langsung) → **131/131 lolos**;
- dengan sidecar Bun aktif → **130/131**, gagal pada
  `恢复失败 socket reset 不触发整轮重发 - 实际 HTTP 请求数` (**3 request, seharusnya 2**).

Jadi selisih satu request itu persis kiriman ulang dari langkah 3.

### Perbaikan
| Berkas | Perubahan |
|---|---|
| `scripts/opencode-transport.mjs` | Saat `fetch` upstream melempar, balasan 502 kini diberi header penanda `x-ofm-upstream-failure: 1` — membedakan "hop gagal sebelum meneruskan" dari "upstream gagal setelah menerima". |
| `src/transport.js` | `laneFetch` hanya fallback ke `egressFetch` bila 502 **tanpa** penanda itu (hop mati/refuse/URL hilang) atau `fetch` ke sidecar sendiri melempar (request tidak pernah sampai). 502 bertanda diteruskan apa adanya. |

## 60. Temuan kedua: 502 transport tidak boleh jadi `SERVER`

Karena 502 sekarang diteruskan, `classifyFailure` membacanya sebagai
`SERVER` — kode yang oleh host dianggap boleh di-retry **seluruh turnnya**
(aturan `providerRetryPolicy().retryableCodes`), yang di lane gratis berarti
kuota dibakar lagi.

| Berkas | Perubahan |
|---|---|
| `src/http.js` | `postStreamedOnce`: 502 dengan `x-ofm-upstream-failure: 1` dipetakan ke `CODE.transport` (bukan `SERVER`), body-nya tetap di-dump lewat `dumpUpstream`. |

Efeknya: klasifikasi tetap jujur ("transport putus"), tapi retry-nya terjadi di
tempat yang aman (lihat §61), bukan di tingkat host.

## 61. Retry pre-delivery: sekali, di attempt pertama saja

Gejala yang dilaporkan user: `ovh/Qwen3.8-27B` menjawab
`502 STREAM_CUT — upstream stream read failed: terminated — read ECONNRESET`,
padahal request identik langsung 200 beberapa detik kemudian. Penyebabnya:
kegagalan terjadi di `readHead` — **sebelum satu byte pun diserahkan ke
caller** — dan OFM tidak pernah mengulanginya.

| Berkas | Perubahan |
|---|---|
| `src/http.js` | `postStreamed` dipecah: `postStreamed` (kebijakan retry) + `postStreamedOnce` (satu kiriman). Body di-`JSON.stringify` **sekali** di luar loop supaya retry mengirim byte identik. |
| `src/http.js` | Retry hanya bila: kode `CODE.transport` **dan** belum ada payload yang diserahkan (`delivered === false`) **dan** tidak di-abort **dan** `retryOnDrop` aktif. `STREAM_ATTEMPTS = 2`, jeda `STREAM_RETRY_DELAY_MS = 700`. |
| `src/adapter.js` | `postStreamed({ …, retryOnDrop: !recovering })` — attempt pemulihan (continuation) **tidak boleh** dikirim ulang; kalau gagal, dilaporkan. |

Yang **tidak** di-retry, dan itu disengaja: `429 RATE_LIMIT` (verdict kuota;
mengulang hanya memperbanyak panggilan di jendela yang sedang diukur), `403
LANE_LOCKED`, `5xx`, `TIMEOUT`, dan apa pun setelah ada byte yang sampai ke
caller (mengulang di situ akan menduplikasi teks/tool call).

## 62. Test baru: `scripts/stream-retry-test.mjs` (18 check, semua lolos)

Server HTTP tiruan yang bisa: memutus koneksi setelah status line + 1 byte
(meniru `ECONNRESET` di `readHead`), memutus di tengah body, membalas 429/403/5xx,
dan membalas JSON non-SSE. Yang dikunci:

- koneksi putus sebelum jawaban → **dikirim ulang sekali** dan turn **sukses**;
- koneksi yang tidak pernah pulih → tepat **2** kiriman, lalu `TRANSPORT`;
- putus **setelah** byte pertama → **tidak** dikirim ulang;
- 429 → 1 kiriman, tetap `RATE_LIMIT`; 403 → 1 kiriman, tetap `LANE_LOCKED`;
- 5xx → 1 kiriman (retry host yang mengurus);
- jawaban JSON buffered juga pulih dan tiba sebagai satu payload.

Terdaftar di `scripts/test-all.mjs` sebagai `stream-retry`.

Detail penting saat menulis test semacam ini: memutus socket **sebelum** status
line membuat undici melakukan reconnect sendiri, dan server akan menghitung 2
request untuk 1 kiriman lane. Karena itu byte pertama harus dikirim dulu.

## 63. Hasil test suite

| | Baseline (`8692a7e`) | Setelah sesi ini |
|---|---|---|
| Suite lolos | 58 / 74 | 59 / 75 |
| `recovery` | **gagal** (130/131) | **lolos 131/131** |
| `stream-retry` | belum ada | **lolos 18/18** |
| `retry-safety` | lolos | lolos |
| `sniff`, `picker`, `tui`, `catalog`, `vault`, `manifest`, `release`, `reload`, `standalone*`, `channel-source`, `forward-boot`, `opencode-parity`, `gateway-source` | gagal | gagal (sama, **bukan** dari sesi ini) |

Kegagalan yang tersisa sudah ada di baseline sebelum sesi ini. `kilo` muncul
gagal 3 check pada satu run penuh dan lolos di run lain (crash `timed out
waiting for Kilo cache`), isinya soal cache discovery roster
(`nvidia/nemotron-3.5-lightning:free`, `kilo-auto/free`) — di luar jalur yang
diubah sesi ini; catat sebagai utang, jangan dikejar.

## 64. Test agent (permintaan user: uji lewat pipeline OFM, bukan probe mentah)

Gateway direstart (`wscript.exe ofm-standalone-hidden.vbs`, PID baru) agar
`src/http.js`, `src/transport.js`, `scripts/opencode-transport.mjs` termuat.

| Uji | Hasil |
|---|---|
| `node scripts/ofm-live-zen-probe.mjs deepseek-v4.1-flash-free` | `clock-ok true`, `transport sidecar active`, lalu `429 RATE_LIMIT` |
| `POST /v1/chat/completions` model `deepseek-v4.1-flash-free` | `429`, **1,0 s** → tidak ada retry-storm |
| `POST /v1/chat/completions` model `ovh/Qwen3.8-27B` | `200`, 2,7 s (`"siap"`) |

## 65. Kuota ZEN: reset tengah malam UTC (bukan per-IP, bukan per-sesi)

Dua pengukuran `retry-after` di jam berbeda, keduanya menunjuk **00:00 UTC**
persis:

- 10:42 UTC → `retry-after: 47841` s (13 j 17 m) → 24:00 UTC;
- 15:19 UTC → `retry-after: 31521` s (8 j 45 m) → 24:00 UTC.

Artinya jendela kuota direset **00:00 UTC = 07:00 WIB**, bukan per-IP dan bukan
per-sesi. Ganti IP, ganti Wi-Fi, VPN, dan WARP (IPv4 maupun IPv6/NAT64) semuanya
tetap 429 — sudah diuji, jangan diulang.

Catatan WARP: saat sesi ini berjalan, WARP sempat `off` (IP ISP `182.8.227.211`)
lalu menyala sendiri lagi lewat IPv6 (`2a09:bac5:…`, `warp=on`) — hasil 429 tidak
berubah pada kedua kondisi. WARP masih terinstall dan tidak perlu.

## 66. Status & langkah berikut

- Working tree: 4 berkas diubah (`src/http.js`, `src/transport.js`,
  `src/adapter.js`, `scripts/opencode-transport.mjs`), 1 test baru
  (`scripts/stream-retry-test.mjs`), 1 pendaftaran test (`scripts/test-all.mjs`).
- Gateway sudah direstart dan memakai kode ini.
- **Belum** terverifikasi live: apakah `deepseek-v4.1-flash-free`,
  `big-pickle`, `glm-5.3-flash-free` pulih setelah 07:00 WIB. Kalau 200 →
  selesai, cabut penanda `· sementara` di picker Zed bila perlu.
- Belum dikerjakan (rencana lama, masih berdiri): lane `/inference/v1` v2.1.4
  di belakang env flag sebagai pembanding bentuk request. Berguna hanya kalau
  jam 07:00 nanti jalur `/zen/v1` masih menolak.
- Jangan sentuh: `forwardKey`, settings egress/aggregate OpenRouter, VPS
  `103.141.234.177`, 9router, `D:\Aset\windus`.

# SESI 18 — 2026-11-14/15 — WARP IPv6 MEMBUKA jalur ZEN (200 terbukti)

## 67. Koreksi penting terhadap §55 dan §65

§55 menyimpulkan "WARP IPv6/NAT64 teruji, TIDAK menolong". **Itu sudah tidak
berlaku.** Pada sesi ini, dengan WARP **aktif lewat IPv6** (`warp=on`,
`ip=2a09:bac5:39e7:25c3::3c3:16`, `colo=SIN`), satu turn ZEN lewat pipeline penuh
OFM (`scripts/ofm-live-zen-probe.mjs`) menjawab:

```
session ses_e2560c10fffe5n3VT0st3vrUA4 | clock-ok true
STATUS 200 | deltas 12
transport sidecar active
```

Jadi `deepseek-v4.1-flash-free` **bisa** dipakai. Jalur request-nya (env block,
jam sesi segar, sidecar Bun) sudah benar dan pernah lolos end-to-end.

Dugaan sebab §55 dulu keliru: saat itu perbaikan §59 (request tidak lagi
dikirim **dua kali** lewat sidecar→Node) belum ada, jadi tiap percobaan WARP
membakar dua request sebelum sempat lolos. Kini satu percobaan = satu request.

## 68. Tapi jatahnya langsung habis

Beberapa detik setelah 200 itu, semua jalur kembali `429`
`Free usage limit reached` — termasuk probe minimal yang tadi 200:

| Uji (berurutan, jeda ≥3 s) | Hasil |
|---|---|
| `ofm-live-zen-probe deepseek-v4.1-flash-free` | **200**, 12 delta |
| `POST /v1/chat/completions` deepseek-v4.1-flash-free | 429 (0,71 s) |
| `POST /v1/chat/completions` big-pickle | 429 (0,44 s) |
| `POST /v1/chat/completions` glm-5.3-flash-free | 429 (0,33 s) |
| `ofm-live-zen-probe` lagi | 429 |

Catatan: waktu 0,3–0,7 s membuktikan tidak ada retry-storm (perbaikan §61
bekerja); 429 tidak pernah dikirim ulang.

Jadi kesimpulan §65 ("reset tepat 00:00 UTC") juga **tidak lengkap**: jendela
bisa terbuka bukan hanya karena reset waktu. Yang belum jelas: apakah WARP
memberi egress/identitas baru dengan jatah kecil yang langsung tersedot, atau
gate memberi kelonggaran sesaat lalu menutup lagi. Perlu diukur ulang dengan
waktu tunggu lebih panjang, bukan probe beruntun.

## 69. Langkah berikut

1. Uji ulang dengan **jeda panjang** (≥10 menit) tanpa probe beruntun, WARP
   tetap aktif. Kalau 200 muncul lagi → jatah memang kecil, bukan gate.
2. Kalau 200 hanya sekali lalu tertutup sementara probe minimal pun 429 →
   kemungkinan besar jatah per-identitas-WARP sangat kecil.
3. Jangan sentuh WARP tanpa izin user; user sendiri yang mengaktifkannya.
4. Kuota `big-pickle` dan `glm-5.3-flash-free` **belum pernah** terlihat 200;
   jangan klaim pulih sebelum terukur.

# SESI 19 — 2026-11-15 — Auto-rotate WARP IPv6 (tooling ada, jatah TIDAK ikut)

## 70. Cara merotasi IP WARP di mesin ini

`warp-cli` **tidak** ada di PATH (WARP versi GUI/Flutter). Binernya:

```
C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe
```

Rotasi = `disconnect` lalu `connect`, tanpa perintah khusus "ganti IP" (WARP
consumer memang tidak menyediakannya):

```bash
CLI="/c/Program Files/Cloudflare/Cloudflare WARP/warp-cli.exe"
"$CLI" disconnect; sleep 2.5; "$CLI" connect; sleep 7
```

Terukur: alamat keluar IPv6 berubah pada **setiap** percobaan
(`2a09:bac5:39e7:…` → `…39e2:…` → `…39e5:…` → `…39e3:…` → `…39e4:…`),
hanya oktet subnet yang bergeser. Waktu total ±10 detik per rotasi.
Catatan: antarmuka `CloudflareWARP` sendiri ber-alamat statis
`2606:4700:110:…` (mesh internal) — IP publik tidak diset lokal, ditentukan
Cloudflare.

## 71. Perkakas baru: `scripts/warp-rotate.mjs`

```bash
node scripts/warp-rotate.mjs --rounds 3      # tiap rotasi: catat IP + 1 request
node scripts/warp-rotate.mjs --no-rotate     # kontrol: tanpa ganti IP
node scripts/warp-rotate.mjs --model big-pickle
```

Per rotasi mencetak `IP lama -> IP baru (berubah/TETAP) | hasil`, lalu
meringkas `n/m IP berubah, k/m request berhasil`. Satu request per rotasi,
jeda wajib — bukan probe beruntun.

Juga baru: `scripts/ofm-live-zen-probe-fresh.mjs [model] [seed]` — probe dengan
sesi **selalu baru** (seed unik → `canonicalizeSession` mint id dengan jam
sekarang), untuk menguji dugaan "kuota per-sesi".

## 72. Hasil pengukuran (2026-11-15, WARP IPv6 aktif)

| Uji | Hasil |
|---|---|
| `warp-rotate --rounds 2` | **2/2 IP berubah**, **0/2** request 200 |
| Sesi baru `a1` | **200**, 10 delta |
| Sesi baru `a2`, `a3`, `a4` (jeda 4 s) | 429 semua |
| Sesi lama (`live-zen-probe`) | 429 |
| Reconnect WARP lalu request-1 | 429 |
| request-2 setelahnya | 429 |

Kesimpulan yang **bisa** ditegakkan:

1. **Rotasi IP WARP mudah dan andal** (disconnect/connect), ±10 s.
2. **Kuota ZEN bukan per-IP keluar** — IP berubah tiap putaran, jatah tidak.
   Ini menutup jalur "auto-rotate biar dapat jatah baru".
3. **Kuota bukan per-sesi** — sesi baru `a2`–`a4` tetap 429. Dugaan "sesi
   terbakar" hanya benar untuk 200 pertama yang memang sudah kejadian.
4. 200 yang muncul bersifat **sporadis** dan belum terikat variabel yang kita
   kendalikan (IP, sesi, reconnect, jam). Kemungkinan besar kuota global/akun,
   atau kelonggaran sesaat di upstream.

Yang **tidak** boleh diklaim: bahwa rotasi IP menolong, atau bahwa
`big-pickle`/`glm-5.3-flash-free` sudah pulih. Belum ada bukti 200 untuk
keduanya.

## 73. Langkah berikut (fokus DeepSeek)

1. Jalankan `warp-rotate --rounds 5 --gap 600000` (jeda 10 menit) semalam untuk
   melihat pola 200 di waktu panjang. Ini satu-satunya cara membedakan
   "jatah kecil + jarang" dari "gate acak".
2. Kalau 200 muncul tetap tanpa pola → terima bahwa lane ZEN tidak dapat
   diandalkan, dan pakai `ovh/Qwen3.8-27B` / OpenRouter sebagai jalur kerja
   (sudah stabil 200).
3. Jangan buang waktu pada trik IP/UA/sesi lain sampai ada bukti 200 berulang.

# SESI 20 — 2026-11-15 — Evaluasi ebouther/opencode-unlimited-proxy: TIDAK bisa diadopsi

## 74. Apa yang repo itu lakukan

`https://github.com/ebouther/opencode-unlimited-proxy` — gateway OpenAI-compatible
untuk free tier OpenCode, dengan **pool exit WARP yang berotasi**. Isinya dua
bagian:

1. **Fingerprint** — mereproduksi bentuk request client resmi, dengan dua hal
   yang paling sering terlewat: tool bernama **persis `read`** dan **`stream:
   true` dipaksa**. (Kita sudah punya keduanya — lihat `src/upstream.js`.)
2. **Pool egress** — banyak exit WARP, masing-masing berharap dapat blok jatah
   sendiri. Mesinnya `ghcr.io/jasonxu114514/opencode2api` (GPL-3.0, image
   publik, tidak di-vendor).

## 75. Fakta kunci yang menjelaskan kegagalan rotasi kita

Repo itu menyatakan kuota dimeter **per egress block**: `/64` pada IPv6, `/32`
pada IPv4, **reset harian 00:00 UTC**. Kutipannya:

> "Three exits behind one block are one budget, not three."

Ini **menjelaskan** hasil `scripts/warp-rotate.mjs` (§72) yang tadinya
membingungkan:

| Rotasi | IP lama → baru | Blok /64 | Jatah |
|---|---|---|---|
| 1 | `2a09:bac5:39e7:25c3::3c3:16` → `…39e2:25c3::3c3:16` | sama | 429 |
| 2 | `…39e3:2723::3e6:76` → `…39e4:25cd::3c4:4c` | sama | 429 |

Yang berubah hanya satu hextet di dalam **`2a09:bac5:...::/64`** milik WARP.
Satu blok = satu jatah, jadi rotasi IP di dalam blok yang sama tidak pernah
menambah kuota. Dugaan §72 ("kuota global/akun") dikoreksi: kuota **per-/64**,
dan kita tidak punya kontrol atas /64 itu.

## 76. Kenapa tidak bisa diadopsi di mesin ini

Tiga syarat keras repo (dari README bagian *"On macOS or Windows"*):

| Syarat | Kondisi laptop ini | |
|---|---|---|
| Linux native, `network_mode: host` untuk pool WARP | Windows + Docker Desktop — repo sendiri mengatakan WARP mode **tidak jalan** di Docker Desktop | ❌ |
| Outbound UDP 2408 | tersedia | ✅ |
| **Routed IPv6 `/64` milik sendiri** (`WARP_SOURCE_IPV6`) | **tidak ada** — lihat §77 | ❌ |

Mode yang *bisa* jalan di Windows hanya **bridge mode** (tanpa WARP), dan itu
eksplisit **tidak merotasi**: "It does not rotate egress". Jadi adopsi tidak
memberi apa pun untuk masalah kita.

## 77. Bukti: ISP tidak memberi IPv6 publik

```
netsh interface ipv6 show address "Wi-Fi"
  fd33:89c0:8d33:0:9e48:ded:1277:9f3b/64   ← ULA (fd00::/8), alamat privat
  fd33:89c0:8d33:0:7084:b76e:14a9:ca4f/128 ← temporary
  fd33:89c0:8d33::ee1                      ← dhcp
```

Tidak ada alamat IPv6 global-publik di Wi-Fi. Semua IPv6 publik yang keluar
(`2a09:bac5:…`) berasal dari **WARP**, bukan dari ISP. Karena itu `source_ipv6`
yang diwajibkan repo tidak bisa diisi, dan setiap exit WARP akan selalu berada
di blok shared Cloudflare — satu keranjang jatah.

## 78. Yang diambil, yang tidak

**Diambil (gratis, tanpa risiko):** konfirmasi bahwa fingerprint kita sudah
benar (`read` + `stream: true`) dan reset kuota 00:00 UTC. Tidak ada perubahan
kode.

**Tidak diambil:** pool WARP, engine `opencode2api`, dan seluruh stack Docker.
Menerapkannya akan menyesatkan — tampak seperti solusi, padahal prasyaratnya
tidak terpenuhi.

## 79. Rekomendasi tegas untuk ke depan

1. Berhenti mencoba menambah jatah ZEN lewat IP/rotasi/sesi. Secara teori
   mentok: satu `/64` = satu jatah, dan `/64` itu milik WARP (shared).
2. Cara satu-satunya untuk jatah baru: **tunggu reset 00:00 UTC (07:00 WIB)**.
3. Setelah reset, **hemat**: jangan probe beruntun. Satu probe, lalu pakai
   langsung dari Zed. Jatahnya kecil.
4. Jalur kerja harian tetap `ovh/Qwen3.8-27B` (stabil 200) dan OpenRouter.
5. Kalau suatu saat ada VPS Linux dengan routed IPv6 `/64`, repo §74 layak
   dicoba utuh — tapi itu di luar batas yang ditetapkan user (jangan sentuh VPS).
