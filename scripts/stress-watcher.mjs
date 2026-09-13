#!/usr/bin/env node
/**
 * Reproduce the conditions behind three STATUS_HEAP_CORRUPTION exits.
 *
 *     pnpm stress-watcher --folder "X:\\renders\\2026-09-13"
 *     pnpm stress-watcher --folder … --frames 51 --rewrites 40
 *     pnpm stress-watcher --folder … --cleanup
 *
 * All three crashes had the same shape: frames landing in a watched folder
 * while a set manifest in `.luma-sets/` beside them was rewritten over and
 * over, on a network share, with the app open and indexing. The third was the
 * clearest — a 51-frame board whose render script appends one member to the
 * manifest after *every* frame, so the manifest was rewritten about forty times
 * in thirty-five minutes while the watcher indexed the new pictures.
 *
 * So that is what this does, faster: write a frame, append a member, repeat.
 * It is a stress harness, not a proof. A run that survives does not demonstrate
 * the bug is gone — it raises the odds. A run that crashes is worth far more,
 * because it is a reproduction somebody can attach a debugger to.
 *
 * Start the app first (`pnpm dev:desktop`, logging to the scratchpad), add the
 * folder if it is not already watched, then run this and watch the app.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const folder = option('folder')
if (folder === undefined) {
  console.error('usage: pnpm stress-watcher --folder <a watched folder> [--frames 51] [--rewrites 40] [--cleanup]')
  process.exit(2)
}

const RUN = 'stress-watcher'
const setDir = join(folder, '.luma-sets')
const manifestPath = join(setDir, `${RUN}.json`)
const frames = Number(option('frames', '51'))
const rewrites = Number(option('rewrites', '40'))
const gap = Number(option('gap', '120'))

if (args.includes('--cleanup')) {
  rmSync(manifestPath, { force: true })
  for (let at = 1; at <= 400; at++) {
    rmSync(join(folder, `${RUN}-${String(at).padStart(3, '0')}.png`), { force: true })
  }
  console.log(`removed ${RUN} frames and its manifest from ${folder}`)
  process.exit(0)
}

/* ------------------------------------------------------------------ a PNG */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Big enough that indexing and thumbnailing do real work, not a 1x1 no-op. */
function png(seed, size = 640) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const raw = Buffer.alloc((size * 3 + 1) * size)
  let at = 0
  for (let y = 0; y < size; y++) {
    raw[at++] = 0
    for (let x = 0; x < size; x++) {
      raw[at++] = (x + seed) & 0xff
      raw[at++] = (y * 2 + seed) & 0xff
      raw[at++] = (x ^ y) & 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------- run */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

mkdirSync(setDir, { recursive: true })
console.log(`writing ${frames} frames into ${folder}`)
console.log(`rewriting ${manifestPath} after each of the first ${rewrites}`)
console.log('watch the app. A clean finish is weak evidence; a crash is a reproduction.\n')

const members = []
for (let at = 1; at <= frames; at++) {
  const name = `${RUN}-${String(at).padStart(3, '0')}.png`
  writeFileSync(join(folder, name), png(at))
  members.push({ file: name, label: `stress frame ${at}` })

  if (at <= rewrites) {
    // Written whole, the way the render script does it — not atomically, on
    // purpose. Reproducing the trigger means reproducing its sloppiness.
    writeFileSync(
      manifestPath,
      JSON.stringify({ run: RUN, command: 'shotall', createdAt: Date.now(), members }, null, 2),
    )
  }

  process.stdout.write(`\r  ${at}/${frames}`)
  await sleep(gap)
}

console.log('\n\ndone. If the app is still up, it survived this round.')
console.log(`clean up with: pnpm stress-watcher --folder "${folder}" --cleanup`)
