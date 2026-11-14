/**
 * Probe langsung ke gerbang ZEN, dijalankan DI VPS — bukan lewat gateway OFM.
 *
 * Gunanya: memisahkan "pipeline OFM salah" dari "jatah kuota habis", tanpa
 * menyentuh gateway di laptop. Sengaja hanya memakai `fetch` polos, jadi kalau
 * versi ini pun 429, penyebabnya bukan kode kita.
 *
 * Hasil terukur 15 Nov 2026 05:14 UTC dari VPS tambalan (WARP, blok
 * 2a09:bac5:3a52:137d::/64) — ketiganya 429 dengan retry-after ±24780 s yang
 * menuju tepat 00:00 UTC:
 *
 *   deepseek-v4.1-flash-free  429
 *   big-pickle                429
 *   glm-5.3-flash-free        429
 *
 * Cara pakai di VPS:
 *   cd /root/ofm-probe && node q.mjs deepseek-v4.1-flash-free big-pickle
 *
 * Jeda 3 detik antar model supaya probe-nya sendiri tidak memperburuk 429.
 */
const base = 'https://opencode.ai/zen/v1'
const models = process.argv.slice(2)
if (models.length === 0) {
  console.log('pakai: node q.mjs <model> [model...]')
  process.exit(1)
}

for (const m of models) {
  const t0 = Date.now()
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'opencode/1.0.0',
        'x-opencode-session': 'ses_' + Math.random().toString(36).slice(2, 20),
      },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 8 }),
    })
    const txt = (await r.text()).slice(0, 160).replace(/\s+/g, ' ')
    console.log(m, '=>', r.status, '| retry-after:', r.headers.get('retry-after'), '|', Date.now() - t0 + 'ms', '|', txt)
  } catch (e) {
    console.log(m, '=> ERR', e?.message)
  }
  await new Promise(r => setTimeout(r, 3000))
}
