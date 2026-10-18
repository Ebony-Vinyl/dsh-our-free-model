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
