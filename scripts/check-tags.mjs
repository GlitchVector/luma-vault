#!/usr/bin/env node
// Verify every weighted word in a board script against the tagger's vocabulary BEFORE it is queued.
//
// This exists because a note telling me to check was not enough: on Ari's 2026-09-13 board the
// heaviest word in the whole wardrobe, `aqua crop top` at 1.55, was not a tag, and `text` in the
// negative was not either, so the watermark block had never blocked anything. Both had been written
// down as rules and both were applied only after the owner spotted the damage. A check that runs is
// worth more than a rule I have to remember.
//
// usage: node scripts/check-tags.mjs <script.mjs> [--all]
//   default: reports weighted words only (a weighted non-tag is the dangerous case)
//   --all:   reports every comma-separated word, weighted or not
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const CSV = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'models/anime-tagger/selected_tags.csv')
const file = process.argv[2]
if (!file) { console.error('usage: node scripts/check-tags.mjs <script.mjs> [--all]'); process.exit(2) }
const all = process.argv.includes('--all')

const counts = new Map()
for (const line of readFileSync(CSV, 'utf8').split('\n').slice(1)) {
  const [, name, , count] = line.split(',')
  if (name) counts.set(name.trim(), Number(count) || 0)
}

// danbooru writes tags with underscores; prompts write them with spaces
const lookup = (word) => counts.get(word.replaceAll(' ', '_'))

const src = readFileSync(file, 'utf8')
// every string literal in the script, then every comma-separated term inside it
const terms = new Set()
for (const m of src.matchAll(/['"`]([^'"`]{4,})['"`]/g)) {
  for (const raw of m[1].split(',')) {
    let t = raw.trim()
    const weighted = /^\(.+:[\d.]+\)$/.test(t)
    t = t.replace(/^\(+/, '').replace(/:[\d.]+\)+$/, '').replace(/\)+$/, '').trim()
    if (!t || t.includes('${') || t.includes('\n') || /[<>{}/=]/.test(t)) continue
    if (!/^[a-z0-9 '\-.]+$/i.test(t)) continue
    if (t.startsWith('--') || t.split(/\s+/).length > 4) continue
    if (!all && !weighted) continue
    terms.add(`${weighted ? 'W' : ' '}\t${t}`)
  }
}

const missing = [], present = []
for (const entry of [...terms].sort()) {
  const [flag, term] = entry.split('\t')
  const n = lookup(term)
  ;(n === undefined ? missing : present).push({ flag: flag.trim(), term, n })
}

for (const { flag, term, n } of present) console.log(`  ok   ${flag ? '[weighted] ' : ''}${term}  (${n.toLocaleString()})`)
if (missing.length) {
  console.log('\nNOT IN THE VOCABULARY:')
  for (const { flag, term } of missing) console.log(`  MISS ${flag ? '[weighted] ' : ''}${term}`)
  console.log(`\n${missing.length} word(s) the tagger does not know.`)
  console.log('Absence is not proof a word is inert, but a WEIGHTED one is doing something you did not specify.')
  console.log('Never invent a multi-word phrase for the negative: it still tokenises.')
  process.exit(1)
}
console.log(`\nAll ${present.length} checked word(s) are real tags.`)
