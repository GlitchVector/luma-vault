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
import { walkToOrigin } from '../packages/core/src/origin.ts'
import {
  DEFAULT_MODEL,
  familyOf,
  warnAboutVPrediction,
  inspectCheckpoint,
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

/** Read-only, so the app may be running. SQLite allows concurrent readers under WAL. */
function openIndex() {
  return new DatabaseSync(`file:${indexPath().replaceAll('\\', '/')}?mode=ro`, { open: true })
}

/**
 * The picture this one was made from, and the prompt that describes it.
 *
 * An img2img keeps its subject in an init image no parameter block carries, so
 * its own prompt routinely says nothing about the clothes, the character or the
 * setting. That init image is usually still in the library and can be
 * recognised even though it can never be named — see `@luma/core/origin`, whose
 * rule this shares with the app through `contracts/origin-vectors.json`.
 *
 * Null whenever there is nothing trustworthy to say, which is a third of the
 * time.
 */
function findOrigin(id) {
  const db = openIndex()
  try {
    // Only the columns the walk compares on. The colour signatures are 192
    // bytes each and there are six figures of them; they are fetched below for
    // the handful of rows that get that far.
    const candidates = db.prepare(
      `select id, phash, modified_at,
              coalesce(json_extract(generation_json, '$.needsSourceImage'), 0) as img2img
        from media
        where phash is not null and colour_sig is not null and error is null`,
    )
    candidates.setReadBigInts(true)
    const rows = candidates.all().map((row) => ({
      id: Number(row.id),
      phash: BigInt.asUintN(64, row.phash),
      modifiedAt: Number(row.modified_at),
      img2img: Number(row.img2img) === 1,
    }))

    const signature = db.prepare('select colour_sig from media where id = ?')
    const cache = new Map()
    const colourOf = (want) => {
      if (!cache.has(want)) cache.set(want, signature.get(want)?.colour_sig ?? undefined)
      return cache.get(want)
    }

    const origin = walkToOrigin(rows, id, colourOf)
    if (!origin) return null

    const found = db
      .prepare('select name, path, generation_json from media where id = ?')
      .get(origin.id)
    if (!found) return null
    let prompt = ''
    try {
      prompt = JSON.parse(found.generation_json ?? '{}').prompt ?? ''
    } catch {
      // A row whose metadata will not parse still has a name worth naming.
    }
    return { ...origin, name: found.name, path: found.path, prompt }
  } finally {
    db.close()
  }
}

function findImage(name) {
  const db = openIndex()
  const rows = db
    .prepare(
      `select id, path, name, generation_json from media
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

/**
 * Print what this picture was made from, when it was made from anything.
 *
 * Deliberately printed and never merged into the migrated prompt. The point of
 * an img2img chain is frequently to keep a composition and change the subject,
 * so an ancestor's prompt can confidently name a character who is no longer in
 * the picture — merging it would reintroduce exactly what the person replaced.
 * It is evidence to read beside the image, which is step 1 of `/sdxl`, not an
 * input to paste.
 */
function reportOrigin(id) {
  const origin = findOrigin(id)
  if (!origin) {
    console.log('made from   an image that is not in this library, or no longer is')
    return
  }
  const passes = origin.hops === 1 ? '1 img2img pass' : `${origin.hops} img2img passes`
  console.log(`made from   ${origin.name}`)
  console.log(`            ${passes} back, weakest hop ${origin.weakestHop} of 8 bits`)
  console.log(
    origin.reachedRoot
      ? '            this is where the lineage starts'
      : '            the trail goes cold here — this one was made from something too',
  )
  if (!origin.prompt) {
    console.log('            no prompt recorded on it')
    return
  }
  console.log('')
  console.log(origin.prompt)
}

const row = findImage(imageName)
const file = externalPath(row.path)
const block = parameterBlock(file)
if (!block) fail(`${row.name} has no readable parameter block.`)

// The index already decided this, with the rule in `generated.rs`. Re-deriving
// it from the block here would be a third copy of it.
let isImg2img = false
try {
  isImg2img = JSON.parse(row.generation_json ?? '{}').needsSourceImage === true
} catch {
  // Unparseable metadata is not a reason to fail a migration.
}

if (show) {
  // Before Forge is contacted, so this works with it closed.
  console.log(file)
  console.log('')
  console.log(block)
  if (isImg2img) {
    console.log('')
    reportOrigin(row.id)
  }
  process.exit(0)
}

const target = await resolveModel(targetName)
const { architecture, vPred } = inspectCheckpoint(target.filename)
if (vPred) warnAboutVPrediction(target.name)
// Read the emphasis Forge is on so the block can state it. Left unstated, the
// paste fills in the default and adds an override that reverts whatever the
// person actually chose — an override they never asked for and did not add.
const options = await forge('/sdapi/v1/options')
const { block: migrated, notes } = migrateGeneration(block, {
  architecture,
  // Both read from the checkpoint rather than asked for: the mode from the
  // file's own header, the vocabulary from its name.
  vPred,
  family: familyOf(target.name),
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

if (isImg2img) {
  console.log('')
  reportOrigin(row.id)
}

// Selecting first is the difference between a dropdown that shows the model and
// one that renders empty over a correctly loaded model.
await selectCheckpoint(target.name)
openWithBlock(migrated)
console.log('\nopened Forge with the migrated parameters.')
