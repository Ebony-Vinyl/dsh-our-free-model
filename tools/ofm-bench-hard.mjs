/**
 * ofm-bench-hard.mjs — benchmark tugas SULIT, bukan sekadar "bisa jawab".
 *
 * Beda dengan ofm-bench.mjs: alat lama hanya mengukur apakah model bisa
 * mengeluarkan teks (prompt mudah `chunk`). Skrip ini menguji tugas yang
 * punya jawaban BENAR/SALAH yang bisa diperiksa mesin, lalu mengukur:
 *
 *   - rapi  : jawaban lulus pemeriksa, tanpa basa-basi, tanpa markdown liar
 *   - cepat : total ms sampai stream selesai
 *   - hemat : token keluar (makin kecil makin murah kuotanya)
 *
 * Tugas sengaja dipilih supaya jebakannya nyata:
 *
 *   1. algo     — jendela geser; solusi naif O(n*k) selalu kehabisan waktu
 *                 pada 200k, jadi kebenaran + efisiensi sekaligus diuji.
 *   2. regex    — validasi email; hampir semua model menulis pola terlalu
 *                 ketat atau terlalu longgar. Ada kasus uji yang harus LULUS
 *                 dan yang harus DITOLAK, jadi asal-jadi langsung kelihatan.
 *   3. bugfix   — kode berisi bug halus (mutasi array saat iterasi).
 *                 Jawaban benar harus menyebut penyebabnya, bukan menulis
 *                 ulang seluruh fungsi.
 *   4. sql      — window function; jawaban benar harus pakai ROW_NUMBER/
 *                 RANK, bukan GROUP BY yang salah untuk kasus ini.
 *
 * Pemakaian:
 *
 *   node tools/ofm-bench-hard.mjs "ovh/Qwen3.8-27B" "kilo-auto/free"
 *   OFM_JUDGE=1 node tools/ofm-bench-hard.mjs ...   # jalankan pemeriksa kode
 *
 * Jeda antar model 4 detik supaya tidak memicu 429 yang sia-sia.
 */
import fs from 'node:fs'

const KEY = process.env.OFM_KEY || 'ofm-X3NQCZ1UGsYzYI959kp00DOnvDSpvn-r'
const BASE = process.env.OFM_BASE || 'http://127.0.0.1:18900'
const ENDPOINT = `${BASE}/v1/chat/completions`
const TIMEOUT_MS = Number(process.env.OFM_TIMEOUT_MS || 180_000)
const MAX_TOKENS = Number(process.env.OFM_MAX_TOKENS || 3000)
// Jeda antar model. OVH membatasi laju per MENIT (terukur: 2 request lalu 429,
// pulih setelah 60 detik), jadi default-nya lebar. Naikkan/turunkan lewat
// OFM_GAP_MS kalau benchmark diarahkan ke lane lain.
const GAP_MS = Number(process.env.OFM_GAP_MS || 20000)
const JUDGE = process.env.OFM_JUDGE === '1'

/**
 * Ambil blok kode pertama dari jawaban. Model yang "rapi" mengembalikan
 * kode saja atau satu blok berpagar; yang berantakan mencampur prosa,
 * beberapa blok, dan penjelasan setelahnya.
 */
function extractCode(text) {
  const fences = [...text.matchAll(/```(?:[a-zA-Z0-9+#]*)\n([\s\S]*?)```/g)]
  if (fences.length > 0) return { code: fences.map(m => m[1]).join('\n'), fences: fences.length }
  return { code: text, fences: 0 }
}

function countProse(text) {
  // Baris yang bukan kode dan bukan pagar: penanda basa-basi.
  return text.split('\n').filter(l => {
    const t = l.trim()
    if (t === '' || t.startsWith('```')) return false
    if (/^(\/\/|\/\*|\*|#|--|import|export|const|let|var|function|def|return|if|for|while|class|from|\}|\{|\)|]|select|with|rank|row_number)/i.test(t)) return false
    // baris kode umum lain: mengandung ; { } = ( ) atau indentasi
    if (/[;{}=()[\]]/.test(t)) return false
    return t.length > 25
  }).length
}

// ---------------------------------------------------------------- tugas

const TASKS = [
  {
    id: 'algo',
    name: 'Jendela geser (harus efisien)',
    prompt:
      'Write a JavaScript function `maxSumWindow(arr, k)` that returns the maximum sum of any ' +
      'contiguous subarray of length `k`. It must handle arr.length up to 200000 within one second. ' +
      'Return ONLY the function code, no explanation, no markdown fences.',
    // Pemeriksa: kebenaran + efisiensi pada 200k.
    check(code) {
      const notes = []
      let fn
      try {
        fn = new Function(`${code}\nreturn typeof maxSumWindow === 'function' ? maxSumWindow : null`)()
      } catch (e) {
        return { pass: false, notes: [`sintaks: ${e.message.slice(0, 80)}`] }
      }
      if (!fn) return { pass: false, notes: ['fungsi maxSumWindow tidak ada'] }

      const cases = [
        [[1, 2, 3, 4, 5], 3, 12],
        [[5, 5, 5], 2, 10],
        [[-1, -2, -3], 2, -3],
        [[2, 1, 5, 1, 3, 2], 3, 9],
        [[1], 1, 1],
      ]
      for (const [arr, k, want] of cases) {
        const got = fn(arr.slice(), k)
        if (Math.abs(got - want) > 1e-9) notes.push(`[${arr}],k=${k} => ${got} (harus ${want})`)
      }
      // Efisiensi: naif O(n*k) dengan k besar = 200 juta operasi, jauh di atas
      // batas. k=1000 pada n=200k sempat lolos di uji awal, jadi k dinaikkan
      // sampai perbedaannya tidak bisa ditutupi kecepatan mesin.
      const big = Array.from({ length: 200000 }, () => Math.floor(Math.random() * 200) - 100)
      const t0 = performance.now()
      fn(big, 100000)
      const ms = performance.now() - t0
      // Solusi jendela geser: ~200k langkah. Naif: 200k*100k = 2e10. Batas 800ms
      // memisahkan keduanya dengan jarak orde besaran, bukan tipis-tipis.
      if (ms > 800) notes.push(`terlalu lambat: ${Math.round(ms)}ms untuk 200k,k=100k (batas 800ms) — bukan jendela geser`)
      return { pass: notes.length === 0, notes, timing: `${Math.round(ms)}ms/200k` }
    },
  },
  {
    id: 'regex',
    name: 'Validasi email (jebakan ketat/longgar)',
    prompt:
      'Write a JavaScript function `isValidEmail(s)` returning true/false. It must accept ' +
      'normal addresses and reject clearly invalid ones. Return ONLY the function code, no explanation.',
    check(code) {
      const notes = []
      let fn
      try {
        fn = new Function(`${code}\nreturn typeof isValidEmail === 'function' ? isValidEmail : null`)()
      } catch (e) {
        return { pass: false, notes: [`sintaks: ${e.message.slice(0, 80)}`] }
      }
      if (!fn) return { pass: false, notes: ['fungsi isValidEmail tidak ada'] }

      const mustPass = ['a@b.co', 'user.name+tag@example.com', 'x_y@sub.domain.org', 'john@example.io']
      const mustFail = ['plainaddress', '@no-local.com', 'no-at.com', 'a@b', 'two@@at.com', 'a b@c.com', 'a@.com']
      for (const s of mustPass) if (fn(s) !== true) notes.push(`harus LULUS: ${s}`)
      for (const s of mustFail) if (fn(s) !== false) notes.push(`harus TOLAK: ${s}`)
      return { pass: notes.length === 0, notes }
    },
  },
  {
    id: 'bugfix',
    name: 'Temukan bug halus (mutasi saat iterasi)',
    prompt:
      'This function should remove all even numbers but it skips some. Explain the bug in ONE sentence ' +
      'and give the fixed function. Code:\n\n' +
      'function removeEvens(a){ for(let i=0;i<a.length;i++){ if(a[i]%2===0) a.splice(i,1) } return a }\n\n' +
      'Be brief.',
    check(text) {
      const notes = []
      const low = text.toLowerCase()
      // Diagnosis harus menyebut inti masalah: indeks bergeser setelah splice.
      const saysShift = /(skip|geser|shift|indeks|index|loncat|terlewat|miss)/.test(low)
      const saysSplice = /(splice|hapus|remove|mutasi|modif|ubah array)/.test(low)
      if (!saysShift) notes.push('tidak menyebut indeks bergeser/terlewat')
      if (!saysSplice) notes.push('tidak menyebut splice/mutasi array')
      // Perbaikan harus benar: uji hasil fungsi yang dikembalikan bila ada.
      const { code } = extractCode(text)
      const cleaned = code.replace(/```[a-z]*/gi, '')
      let fixed = null
      try {
        fixed = new Function(`${cleaned}\nreturn typeof removeEvens === 'function' ? removeEvens : null`)()
      } catch { /* tidak wajib bisa dijalankan */ }
      if (fixed) {
        const got = fixed([1, 2, 2, 3, 4, 6, 7])
        const ok = JSON.stringify(got) === JSON.stringify([1, 3, 7])
        if (!ok) notes.push(`perbaikan salah: [1,2,2,3,4,6,7] => ${JSON.stringify(got)} (harus [1,3,7])`)
      } else {
        notes.push('tidak ada fungsi perbaikan yang bisa dijalankan')
      }
      if (notes.length === 0) notes.push('diagnosis + perbaikan benar')
      return { pass: notes.length === 1 && notes[0].startsWith('diagnosis'), notes }
    },
  },
  {
    id: 'sql',
    name: 'SQL window function',
    prompt:
      'Table sales(dept TEXT, person TEXT, amount INT). Write ONE SQL query returning the top earner ' +
      'per department by total amount, with columns dept, person, total. Use a window function. ' +
      'Return only SQL, no explanation.',
    check(text) {
      const notes = []
      const low = text.toLowerCase()
      if (!/row_number|rank\s*\(|dense_rank/.test(low)) notes.push('tidak memakai window function (row_number/rank)')
      if (!/over\s*\(/.test(low)) notes.push('tidak ada OVER(...)')
      if (!/partition\s+by/.test(low)) notes.push('tidak ada PARTITION BY (salah untuk per-departemen)')
      if (!/sum\s*\(/.test(low)) notes.push('tidak menjumlahkan amount dengan SUM')
      if (!/group\s+by/.test(low)) notes.push('tidak mengagregasi per person (butuh GROUP BY di subquery)')
      if (notes.length === 0) notes.push('pola window function benar')
      return { pass: notes.length === 1, notes }
    },
  },
]

// ---------------------------------------------------------------- runner

async function runTask(model, task) {
  const r = {
    task: task.id,
    status: 0,
    error: null,
    totalMs: 0,
    outTokens: null,
    reasoningTokens: null,
    text: '',
    reasoning: '',
    proseLines: 0,
    fences: 0,
    pass: false,
    notes: [],
  }

  const t0 = performance.now()
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: task.prompt }],
        max_tokens: MAX_TOKENS,
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    r.status = res.status
    if (!res.ok) {
      r.error = (await res.text()).slice(0, 200)
      r.totalMs = Math.round(performance.now() - t0)
      return r
    }

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '' || data === '[DONE]') continue
        let j
        try { j = JSON.parse(data) } catch { continue }
        if (j.error) {
          r.error ??= (typeof j.error === 'string' ? j.error : j.error.message || '').slice(0, 200)
          continue
        }
        const choice = j.choices?.[0]
        if (choice?.finish_reason) r.finishReason = choice.finish_reason
        const delta = choice?.delta || {}
        if (delta.content) r.text += delta.content
        const rc = delta.reasoning_content ?? delta.reasoning
        if (rc) r.reasoning += rc
        if (j.usage) {
          r.outTokens = j.usage.completion_tokens ?? j.usage.output_tokens ?? r.outTokens
          r.reasoningTokens = j.usage.completion_tokens_details?.reasoning_tokens
            ?? j.usage.output_tokens_details?.reasoning_tokens ?? r.reasoningTokens
        }
      }
    }
  } catch (e) {
    r.error = `${e?.name ?? 'Error'}: ${e?.message ?? e}`.slice(0, 200)
    r.totalMs = Math.round(performance.now() - t0)
    return r
  }

  r.totalMs = Math.round(performance.now() - t0)
  if (r.error) return r

  if (r.text.trim() === '') {
    r.notes = ['tidak ada teks jawaban' + (r.reasoning ? ' (hanya thinking)' : '')]
    return r
  }

  const { fences } = extractCode(r.text)
  r.fences = fences
  r.proseLines = countProse(r.text)

  const verdict = task.check(r.text)
  r.pass = verdict.pass
  r.notes = verdict.notes
  if (verdict.timing) r.timing = verdict.timing
  return r
}

const models = process.argv.slice(2)
if (models.length === 0) {
  console.error('pakai: node tools/ofm-bench-hard.mjs <model> [model...]')
  process.exit(1)
}

const only = (process.env.OFM_TASKS || '').split(',').map(s => s.trim()).filter(Boolean)
const tasks = only.length ? TASKS.filter(t => only.includes(t.id)) : TASKS

console.log(`Benchmark tugas sulit — ${models.length} model x ${tasks.length} tugas`)
console.log(`Tugas: ${tasks.map(t => t.id).join(', ')}`)
console.log(`Gateway: ${ENDPOINT}\n`)

const rows = []
for (const model of models) {
  console.log(`\n### ${model}`)
  const perTask = []
  for (const task of tasks) {
    const r = await runTask(model, task)
    perTask.push(r)
    const mark = r.status !== 200 ? `HTTP ${r.status}` : (r.pass ? 'LULUS' : 'GAGAL')
    console.log(
      `  [${mark.padEnd(9)}] ${task.id.padEnd(7)} ${String(r.totalMs).padStart(6)}ms ` +
      `out=${String(r.outTokens ?? '-').padStart(5)} rsn=${String(r.reasoningTokens ?? '-').padStart(5)} ` +
      `teks=${String(r.text.length).padStart(5)} pikir=${String(r.reasoning.length).padStart(5)} ` +
      `prosa=${r.proseLines} pagar=${r.fences}` +
      (r.notes.length && !r.pass ? `\n              -> ${r.notes.join('; ').slice(0, 150)}` : '') +
      (r.error ? `\n              -> ERR ${r.error.slice(0, 120)}` : '')
    )
    await new Promise(res => setTimeout(res, GAP_MS))
  }
  const served = perTask.filter(r => r.status === 200)
  const passed = perTask.filter(r => r.pass)
  const totalMs = served.reduce((s, r) => s + r.totalMs, 0)
  const tokens = served.reduce((s, r) => s + (r.outTokens ?? 0), 0)
  const prose = served.reduce((s, r) => s + r.proseLines, 0)
  rows.push({
    model,
    lulus: `${passed.length}/${tasks.length}`,
    totalMs,
    rerataMs: served.length ? Math.round(totalMs / served.length) : null,
    token: tokens || null,
    prosa: prose,
    gagalTask: perTask.filter(r => !r.pass).map(r => r.task),
  })
}

// ---------------------------------------------------------------- ringkasan

console.log('\n\n=== RINGKASAN (urut: lulus terbanyak, lalu tercepat) ===')
const ranked = rows.slice().sort((a, b) => {
  const pa = parseInt(a.lulus.split('/')[0], 10)
  const pb = parseInt(b.lulus.split('/')[0], 10)
  if (pb !== pa) return pb - pa
  return (a.totalMs ?? 1e12) - (b.totalMs ?? 1e12)
})
console.log(
  'model'.padEnd(46),
  'lulus'.padStart(7),
  'rerata'.padStart(8),
  'total'.padStart(8),
  'token'.padStart(7),
  'prosa'.padStart(6),
  ' gagal'
)
for (const r of ranked) {
  console.log(
    r.model.padEnd(46),
    r.lulus.padStart(7),
    String(r.rerataMs ?? '-').padStart(8),
    String(r.totalMs ?? '-').padStart(8),
    String(r.token ?? '-').padStart(7),
    String(r.prosa ?? '-').padStart(6),
    ' ' + r.gagalTask.join(',')
  )
}

const out = new URL('./ofm-bench-hard-results.json', import.meta.url)
fs.writeFileSync(out, JSON.stringify(rows, null, 2))
console.log(`\nDetail: ${out.pathname}`)
