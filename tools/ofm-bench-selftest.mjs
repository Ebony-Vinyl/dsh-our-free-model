/**
 * self-test untuk pemeriksa di ofm-bench-hard.mjs.
 *
 * Kalau pemeriksa bisa diloloskan jawaban salah, seluruh benchmark tidak
 * berarti. Jadi tiap tugas diuji dengan jawaban BENAR (harus lulus) dan
 * jawaban SALAH yang khas model (harus gagal).
 *
 * Jalankan: node tools/ofm-bench-selftest.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, 'ofm-bench-hard.mjs'), 'utf8')

// Ambil blok TASKS dari sumber aslinya, lalu jalankan di sini — supaya yang
// diuji benar-benar pemeriksa yang dipakai benchmark, bukan salinannya.
const start = src.indexOf('const TASKS = [')
const end = src.indexOf('\n// ---------------------------------------------------------------- runner')
if (start < 0 || end < 0) throw new Error('blok TASKS tidak ditemukan')
const tasksSrc = src.slice(start, end)

// `extractCode` dan `countProse` dipakai di dalam TASKS.
const helpers = src.slice(src.indexOf('function extractCode'), src.indexOf('\n// ---------------------------------------------------------------- tugas'))

const TASKS = new Function(`${helpers}\n${tasksSrc}\nreturn TASKS`)()

const byId = Object.fromEntries(TASKS.map(t => [t.id, t]))

const CASES = [
  // ---------- algo
  ['algo', 'slide BENAR', `function maxSumWindow(arr, k) {
  let sum = 0
  for (let i = 0; i < k; i++) sum += arr[i]
  let best = sum
  for (let i = k; i < arr.length; i++) {
    sum += arr[i] - arr[i - k]
    if (sum > best) best = sum
  }
  return best
}`, true],
  ['algo', 'naif O(n*k) harus gagal', `function maxSumWindow(arr, k) {
  let best = -Infinity
  for (let i = 0; i + k <= arr.length; i++) {
    let s = 0
    for (let j = 0; j < k; j++) s += arr[i + j]
    if (s > best) best = s
  }
  return best
}`, false],
  ['algo', 'salah logika', `function maxSumWindow(arr, k) { return arr.slice(0, k).reduce((a, b) => a + b, 0) }`, false],
  ['algo', 'sintaks rusak', `function maxSumWindow(arr, k) { return ( }`, false],

  // ---------- regex
  ['regex', 'longgar tapi cukup', `function isValidEmail(s) {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(s) && !/@@/.test(s)
}`, true],
  ['regex', 'terlalu longgar', `function isValidEmail(s) { return s.includes('@') }`, false],
  ['regex', 'terlalu ketat (tolak +tag)', `function isValidEmail(s) {
  return /^[a-z]+@[a-z]+\\.com$/.test(s)
}`, false],

  // ---------- bugfix
  ['bugfix', 'diagnosis tepat', 'Bug-nya: setelah splice, indeks bergeser sehingga elemen berikutnya terlewat.\n\n```js\nfunction removeEvens(a){ for(let i=a.length-1;i>=0;i--){ if(a[i]%2===0) a.splice(i,1) } return a }\n```', true],
  ['bugfix', 'tanpa diagnosis', '```js\nfunction removeEvens(a){ return a.filter(x => x % 2 !== 0) }\n```', false],
  ['bugfix', 'diagnosis tapi perbaikan salah', 'Bug-nya: indeks bergeser/terlewat setelah splice.\n\n```js\nfunction removeEvens(a){ for(let i=0;i<a.length;i++){ if(a[i]%2===0) a.splice(i,1) } return a }\n```', false],

  // ---------- sql
  ['sql', 'window function benar', `WITH t AS (
  SELECT dept, person, SUM(amount) AS total,
         ROW_NUMBER() OVER (PARTITION BY dept ORDER BY SUM(amount) DESC) AS rn
  FROM sales GROUP BY dept, person
) SELECT dept, person, total FROM t WHERE rn = 1`, true],
  ['sql', 'GROUP BY saja (tidak ada top-1 per dept)', `SELECT dept, person, SUM(amount) AS total FROM sales GROUP BY dept, person`, false],
  ['sql', 'window tanpa PARTITION BY', `SELECT dept, person, SUM(amount) AS total FROM (SELECT dept, person, amount, ROW_NUMBER() OVER (ORDER BY amount DESC) rn FROM sales) x WHERE rn = 1`, false],
]

let ok = 0
let bad = 0
for (const [id, label, answer, want] of CASES) {
  const task = byId[id]
  if (!task) { console.log(`?? tugas ${id} tidak ada`); bad++; continue }
  const got = task.check(answer).pass
  const good = got === want
  if (good) ok++
  else bad++
  console.log(`[${good ? 'ok  ' : 'SALAH'}] ${id.padEnd(7)} ${label.padEnd(38)} harap=${String(want).padEnd(5)} dapat=${got}`)
}

console.log(`\nself-test: ${ok}/${CASES.length} pemeriksa berperilaku benar, ${bad} menyimpang`)
process.exit(bad === 0 ? 0 : 1)
