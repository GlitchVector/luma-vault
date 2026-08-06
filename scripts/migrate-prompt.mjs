#!/usr/bin/env node
/**
 * Lift one image's generation onto a model you have installed now.
 *
 *     pnpm migrate-prompt <image-name> <target-model>
 *     pnpm migrate-prompt 00166-3997412987 deliberate
 *
 * Finds the image in the Luma Vault index, reads the parameter block out of the
 * file itself, picks the newest installed checkpoint matching `<target-model>`,
 * rewrites the block for that model's architecture, selects it in Forge, and
 * opens a tab with everything filled in.
 *
 * # Why the block comes from the file, not the index
 *
 * The index stores the six fields the app displays. A real block carries
 * schedule type, clip skip, ControlNet and every ADetailer setting, and
 * rebuilding one from the stored fields drops all of it — which produced a
 * *different image with the same description*, the failure this whole feature
 * exists to avoid.
 *
 * # Why the checkpoint is set before the tab opens
 *
 * Forge evaluates the checkpoint dropdown's value once, while building the
 * page. Set it afterwards and the model is genuinely selected — generation uses
 * it — while the dropdown renders empty, which reads as nothing having
 * happened.
 */

import { openSync, readSync, closeSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateGeneration } from '../packages/core/src/migrate.ts'
import {
  DEFAULT_MODEL,
  architectureOf,
  fail,
  forge,
  openWithBlock,
  resolveModel,
  selectCheckpoint,
} from './lib/forge.mjs'

// --- the index --------------------------------------------------------------

function indexPath() {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const candidates = [
    join(local, 'net.glitchvector.luma-vault', 'index.db'),
    join(homedir(), 'Library', 'Application Support', 'net.glitchvector.luma-vault', 'index.db'),
    join(homedir(), '.local', 'share', 'net.glitchvector.luma-vault', 'index.db'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found) fail('Cannot find the Luma Vault index. Looked in:', ...candidates.map((c) => '  ' + c))
  return found
}

function findImage(name) {
  // Read-only: the app may be running, and this must never be the reason a scan
  // fails. SQLite allows concurrent readers under WAL.
  const db = new DatabaseSync(`file:${indexPath().replaceAll('\\', '/')}?mode=ro`, { open: true })
  const rows = db
    .prepare(
      `select path, name from media
        where name like ? and generation_json is not null
        order by length(name), added_at desc limit 25`,
    )
    .all(`%${name}%`)
  db.close()

  if (rows.length === 0) fail(`No indexed image matching "${name}" carries generation metadata.`)
  if (rows.length > 1 && rows[0].name.toLowerCase() !== name.toLowerCase()) {
    const exact = rows.find((row) => row.name.replace(/\.[^.]+$/, '') === name)
    if (!exact) {
      console.error(`"${name}" matches ${rows.length} images. The closest is used; others:`)
      for (const row of rows.slice(1, 6)) console.error('  ' + row.name)
    }
    return exact ?? rows[0]
  }
  return rows[0]
}

// --- the file ---------------------------------------------------------------

/** Windows stores canonicalized paths; nothing outside Rust accepts them. */
function externalPath(path) {
  if (path.startsWith('\\\\?\\UNC\\')) return '\\\\' + path.slice('\\\\?\\UNC\\'.length)
  if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length)
  return path
}

/** The `parameters` text chunk, read without decoding a pixel. */
function parameterBlock(path) {
  const fd = openSync(path, 'r')
  try {
    const signature = Buffer.alloc(8)
    readSync(fd, signature, 0, 8, 0)
    if (!signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null

    let at = 8
    for (;;) {
      const header = Buffer.alloc(8)
      if (readSync(fd, header, 0, 8, at) < 8) return null
      const length = header.readUInt32BE(0)
      const kind = header.toString('latin1', 4, 8)
      // Text chunks all precede the pixel data, so there is never a reason to
      // read past it — these files run to 6MB over a network share.
      if (kind === 'IDAT' || kind === 'IEND') return null
      if (kind === 'tEXt' || kind === 'iTXt') {
        const data = Buffer.alloc(length)
        readSync(fd, data, 0, length, at + 8)
        const split = data.indexOf(0)
        if (data.toString('latin1', 0, split) === 'parameters') {
          return data.toString('utf8', split + 1).replace(/^\0+/, '')
        }
      }
      at += 8 + length + 4
    }
  } finally {
    closeSync(fd)
  }
}

// --- putting it together ----------------------------------------------------

const argv = process.argv.slice(2)
function flag(name) {
  const at = argv.indexOf(name)
  if (at < 0) return undefined
  const value = argv.splice(at, 2)[1]
  if (!value) fail(`${name} needs a value, e.g. ${name} "full body"`)
  return value
}
/** A switch rather than a setting: present or not, no value. */
function switchFlag(name) {
  const at = argv.indexOf(name)
  if (at < 0) return false
  argv.splice(at, 1)
  return true
}
// Prints the file's path and its block, and stops. The path is the point: the
// prompt frequently does not describe the picture — see `/sdxl`, step 1 — and
// the only way to find that out is to open the file.
const show = switchFlag('--show')
const shot = flag('--shot')
const body = flag('--body')
// What the picture shows and its prompt never said. An img2img block keeps its
// subject in the init image, which the PNG does not carry — see the option's
// doc comment in migrate.ts.
const add = flag('--add')
const size = flag('--size')
if (size && !/^\d+\s*x\s*\d+$/.test(size)) fail(`--size takes WxH, e.g. --size 832x1216 (got "${size}")`)
const [imageName, targetName = DEFAULT_MODEL] = argv
if (!imageName) {
  fail(
    'usage: pnpm migrate-prompt <image-name> [target-model] [--shot "full body"]',
    '       [--body "(gigantic ass:2)"] [--add "black dress, demon horns"] [--size 832x1216]',
    '',
    `  pnpm migrate-prompt 00166-3997412987            # onto ${DEFAULT_MODEL}`,
    '  pnpm migrate-prompt 00166-3997412987 illustrious',
    '  pnpm migrate-prompt 00166-3997412987 --shot "wide shot" --body "(huge breasts:1.5)"',
    '  pnpm migrate-prompt 00489 --add "black dress, garter straps" --size 832x1216',
  )
}

const row = findImage(imageName)
const file = externalPath(row.path)
const block = parameterBlock(file)
if (!block) fail(`${row.name} has no readable parameter block.`)

if (show) {
  // Before Forge is contacted, so this works with it closed.
  console.log(file)
  console.log('')
  console.log(block)
  process.exit(0)
}

const target = await resolveModel(targetName)
const architecture = architectureOf(target.filename)
// Read the emphasis Forge is on so the block can state it. Left unstated, the
// paste fills in the default and adds an override that reverts whatever the
// person actually chose — an override they never asked for and did not add.
const options = await forge('/sdapi/v1/options')
const { block: migrated, notes } = migrateGeneration(block, {
  architecture,
  checkpoint: target.name,
  emphasis: options.emphasis,
  shot,
  body,
  add,
  size,
})

console.log(`from  ${row.name}`)
console.log(`to    ${target.name}  (${architecture})`)
console.log('')
for (const note of notes) console.log('  - ' + note)
if (notes.length === 0) console.log('  - Same architecture: model and seed changed, nothing else.')

// Selecting first is the difference between a dropdown that shows the model and
// one that renders empty over a correctly loaded model.
await selectCheckpoint(target.name)
openWithBlock(migrated)
console.log('\nopened Forge with the migrated parameters.')
