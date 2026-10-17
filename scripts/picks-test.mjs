/**
 * The recommendation page's star counts: what the host asks GitHub for, what it
 * keeps when the answer is missing, and when it asks again.
 *
 * The page is a call to action, so a wrong or blank number is the one failure
 * that matters: it must never show a stale count as if it were live, never
 * blank a card whose repo answered five minutes ago, and never leave the route
 * hanging on GitHub. Each of those is a check below, against a stand-in fetch
 * and a controllable clock — no network.
 *
 * Run: node scripts/picks-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PICK_REPOS, createPickStats } from '../src/picks.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-picks-'))

/** A GitHub stand-in: one answer per repo, per call, with a call log. */
function stubGitHub(answers) {
  const calls = []
  const fetchImpl = async url => {
    calls.push(url)
    const repo = String(url).replace('https://api.github.com/repos/', '')
    const answer = answers[repo]
    if (answer === undefined) throw new Error('network down')
    if (typeof answer === 'number') return { ok: false, status: answer, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => answer }
  }
  return { fetchImpl, calls }
}

const ANSWER = {
  'Ebony-Vinyl/EAC-Desktop': { stargazers_count: 2034, forks_count: 74, pushed_at: '2026-10-14T02:48:05Z' },
  'Ebony-Vinyl/EAC-Pack': { stargazers_count: 47, forks_count: 1, pushed_at: '2026-10-09T08:58:09Z' },
  'Ebony-Vinyl/EAC-design-world': { stargazers_count: 7, forks_count: 0, pushed_at: '2026-10-17T06:58:22Z' },
}

await checkAsync('a good answer becomes the numbers the page shows', async () => {
  const { fetchImpl, calls } = stubGitHub(ANSWER)
  const picks = createPickStats({ fetchImpl, now: () => 1_000 })
  const view = await picks.view()
  assert.equal(calls.length, PICK_REPOS.length, 'one request per repo')
  assert.deepEqual(calls.sort(), PICK_REPOS.map(row => `https://api.github.com/repos/${row.repo}`).sort())
  assert.equal(view.ok, true)
  const desktop = view.repos.find(row => row.id === 'eac-desktop')
  assert.equal(desktop.stars, 2034)
  assert.equal(desktop.forks, 74)
  assert.equal(desktop.pushedAt, Date.parse('2026-10-14T02:48:05Z'))
  assert.equal(desktop.stale, false)
})

await checkAsync('a fresh copy is reused without asking GitHub again', async () => {
  const { fetchImpl, calls } = stubGitHub(ANSWER)
  let clock = 1_000
  const picks = createPickStats({ fetchImpl, now: () => clock })
  await picks.view()
  clock += 60_000
  const view = await picks.view()
  assert.equal(calls.length, PICK_REPOS.length, 'still one round of requests')
  assert.equal(view.repos.find(row => row.id === 'eac-desktop').stars, 2034)
})

await checkAsync('a copy older than six hours is refreshed', async () => {
  const { fetchImpl, calls } = stubGitHub(ANSWER)
  let clock = 1_000
  const picks = createPickStats({ fetchImpl, now: () => clock })
  await picks.view()
  clock += 6 * 60 * 60_000 + 1
  await picks.refresh()
  assert.equal(calls.length, PICK_REPOS.length * 2)
})

await checkAsync('a repo that fails keeps its last good numbers, marked stale', async () => {
  let online = true
  const fetchImpl = async url => {
    const repo = String(url).replace('https://api.github.com/repos/', '')
    if (!online && repo === 'Ebony-Vinyl/EAC-Desktop') throw new Error('network down')
    return { ok: true, status: 200, json: async () => ANSWER[repo] }
  }
  let clock = 1_000
  const picks = createPickStats({ fetchImpl, now: () => clock })
  await picks.view()
  online = false
  clock += 6 * 60 * 60_000 + 1
  // A stale copy answers the route immediately and refreshes behind it; the
  // refreshed answer is what the next read — and this check — sees.
  const immediate = await picks.view()
  assert.equal(immediate.repos.find(row => row.id === 'eac-desktop').stars, 2034)
  const view = await picks.refresh()
  const desktop = view.repos.find(row => row.id === 'eac-desktop')
  assert.equal(desktop.stars, 2034, 'the last good count survives the failure')
  assert.equal(desktop.stale, true, 'and is marked as not fresh')
  assert.equal(view.repos.find(row => row.id === 'eac-pack').stale, false, 'the repo that answered is still fresh')
})

await checkAsync('an answer without a star count is treated as a failure, not as zero', async () => {
  const { fetchImpl } = stubGitHub({ 'Ebony-Vinyl/EAC-Desktop': { message: 'Not Found' }, 'Ebony-Vinyl/EAC-Pack': ANSWER['Ebony-Vinyl/EAC-Pack'] })
  const picks = createPickStats({ fetchImpl, now: () => 1_000 })
  const view = await picks.view()
  const desktop = view.repos.find(row => row.id === 'eac-desktop')
  assert.equal(desktop.stars, undefined)
  assert.equal(desktop.stale, true)
  assert.equal(view.ok, true, 'the other repo still answered')
})

await checkAsync('a rate-limit answer is a failure too', async () => {
  const { fetchImpl } = stubGitHub({ 'Ebony-Vinyl/EAC-Desktop': 403, 'Ebony-Vinyl/EAC-Pack': 403 })
  const picks = createPickStats({ fetchImpl, now: () => 1_000 })
  const view = await picks.view()
  assert.equal(view.ok, false)
  assert.ok(view.repos.every(row => row.stars === undefined))
})

await checkAsync('the last good answer survives a restart on disk', async () => {
  const dir = temp()
  const cacheFile = path.join(dir, 'picks.json')
  const first = createPickStats({ fetchImpl: stubGitHub(ANSWER).fetchImpl, cacheFile, now: () => 5_000 })
  await first.view()
  assert.ok(fs.existsSync(cacheFile), 'the cache was written')
  const offline = createPickStats({ fetchImpl: async () => { throw new Error('network down') }, cacheFile, now: () => 6_000 })
  const view = await offline.view()
  assert.equal(view.repos.find(row => row.id === 'eac-desktop').stars, 2034)
  assert.equal(view.fetchedAt, 5_000, 'the age is the original fetch, not the read')
})

await checkAsync('a cache written for a different roster is ignored', async () => {
  const dir = temp()
  const cacheFile = path.join(dir, 'picks.json')
  fs.writeFileSync(cacheFile, JSON.stringify({ at: 9_000, repos: [{ id: 'other', repo: 'someone/other', stars: 1 }] }))
  const picks = createPickStats({ fetchImpl: stubGitHub(ANSWER).fetchImpl, cacheFile, now: () => 9_500 })
  const view = await picks.view()
  assert.equal(view.repos.length, PICK_REPOS.length)
  assert.equal(view.repos.find(row => row.id === 'eac-desktop').stars, 2034)
})

await checkAsync('a failed refresh is retried sooner than a good one expires', async () => {
  const { fetchImpl, calls } = stubGitHub({ 'Ebony-Vinyl/EAC-Desktop': 500, 'Ebony-Vinyl/EAC-Pack': 500 })
  let clock = 1_000
  const picks = createPickStats({ fetchImpl, now: () => clock })
  await picks.view()
  clock += 60_000
  await picks.view()
  assert.equal(calls.length, PICK_REPOS.length, 'inside the retry window nothing is re-asked')
  clock += 15 * 60_000
  await picks.refresh()
  assert.equal(calls.length, PICK_REPOS.length * 2, 'past it, GitHub is asked again')
})

await checkAsync('an unreadable cache is the same as no cache', async () => {
  const dir = temp()
  const cacheFile = path.join(dir, 'picks.json')
  fs.writeFileSync(cacheFile, '{ not json')
  const picks = createPickStats({ fetchImpl: stubGitHub(ANSWER).fetchImpl, cacheFile, now: () => 1_000 })
  const view = await picks.view()
  assert.equal(view.repos.find(row => row.id === 'eac-desktop').stars, 2034)
})

await checkAsync('concurrent callers share one round of requests', async () => {
  const { fetchImpl, calls } = stubGitHub(ANSWER)
  const picks = createPickStats({ fetchImpl, now: () => 1_000 })
  await Promise.all([picks.view(), picks.view(), picks.refresh()])
  assert.equal(calls.length, PICK_REPOS.length)
})

console.log(failures === 0 ? '\npicks: the numbers are real or absent, never invented' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
