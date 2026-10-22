/**
 * CLI wrapper for the reference receipt.
 *
 *     node scripts/draft-letter.mjs <letter.md> [--json] [--out <dir>] [--refs <refs.json>]
 *
 * The classifier itself is `src/letter-ledger.js`, which is pure and has no
 * filesystem access — the settings page calls it through the Host API. This file
 * is only the part that has to touch a disk: reading the letter, reading an
 * optional reference file, and writing the ledger out.
 *
 * The reference file is local by design: handing a URL to a script that then
 * reaches the network is how a receipt stops being reproducible.
 *
 * @module scripts/draft-letter.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyse, PLACEHOLDER, hazards, readLetter, reconcile, renderLedger, sentences } from '../src/letter-ledger.js'

// Re-exported so the suite and any existing caller keep importing from here.
export { analyse, PLACEHOLDER, hazards, readLetter, reconcile, renderLedger, sentences }

/** Read reference pages from a local JSON file. */
export function readReferences(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('references must be an object')
  return parsed
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const args = process.argv.slice(2)
  let input = null
  let out = null
  let refs = null
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--out') out = args[++index]
    else if (flag === '--refs') refs = args[++index]
    else if (flag === '--json') json = true
    else if (flag.startsWith('--')) {
      console.error(`unknown flag ${flag}`)
      process.exit(1)
    } else input = flag
  }
  if (input === null) {
    console.error('usage: node scripts/draft-letter.mjs <letter.md> [--json] [--out <dir>] [--refs <refs.json>]')
    process.exit(1)
  }
  const source = fs.readFileSync(input, 'utf8')
  const references = refs === null ? {} : readReferences(refs)
  const ledger = analyse(source, references)
  const title = path.basename(input)

  if (json) {
    console.log(JSON.stringify(ledger, null, 2))
  } else {
    const rendered = renderLedger(ledger, { title })
    process.stdout.write(rendered)
    if (out !== null) {
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'ledger.md'), rendered)
      fs.writeFileSync(path.join(out, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`)
      console.error(`wrote ${path.join(out, 'ledger.md')}`)
    }
  }
}
