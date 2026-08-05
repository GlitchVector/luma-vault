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

import { spawn } from 'node:child_process'
import { openSync, readSync, closeSync, statSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateGeneration } from '../packages/core/src/migrate.ts'

const FORGE = process.env.LUMA_FORGE_URL ?? 'http://127.0.0.1:7860'

function fail(...lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

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

// --- the target model -------------------------------------------------------

async function forge(path, options) {
  const response = await fetch(FORGE + path, options)
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  return response.json()
}

/** `sd` or `xl`, from the tensor names in the safetensors header. */
function architectureOf(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(8)
    readSync(fd, head, 0, 8, 0)
    const length = Number(head.readBigUInt64LE(0))
    if (length <= 0 || length > 64 * 1024 * 1024) return 'sd'
    const json = Buffer.alloc(length)
    readSync(fd, json, 0, length, 8)
    const keys = Object.keys(JSON.parse(json.toString('utf8')))
    if (keys.some((key) => key.includes('double_blocks.'))) return 'flux'
    // SDXL is the one with a second text encoder.
    return keys.some((key) => key.startsWith('conditioner.embedders.1.')) ? 'xl' : 'sd'
  } catch {
    return 'sd'
  } finally {
    closeSync(fd)
  }
}

/** The newest installed checkpoint whose name contains `wanted`. */
async function resolveModel(wanted) {
  const installed = await forge('/luma/v1/checkpoints')
  const matches = installed.filter((entry) =>
    entry.name.toLowerCase().includes(wanted.toLowerCase()),
  )
  if (matches.length === 0) {
    fail(
      `No installed checkpoint matches "${wanted}". Installed:`,
      ...installed.map((entry) => '  ' + entry.name),
    )
  }
  // Newest by file date — "the latest one I have" is a question about the
  // filesystem, not about version numbers in names, which are not comparable
  // across authors.
  matches.sort((a, b) => statSync(b.filename).mtimeMs - statSync(a.filename).mtimeMs)
  return matches[0]
}

// --- putting it together ----------------------------------------------------

/**
 * The model to migrate onto when none is named.
 *
 * Naming the model is the part of this you almost never want to think about —
 * there is usually one checkpoint you are moving everything onto, and typing it
 * every time is friction on the common case. Overridable by the argument, and
 * still a substring, so `deliberate` keeps picking the newest installed
 * checkpoint whose filename contains it rather than pinning a version.
 */
const DEFAULT_MODEL = 'deliberate'

const [imageName, targetName = DEFAULT_MODEL] = process.argv.slice(2)
if (!imageName) {
  fail(
    'usage: pnpm migrate-prompt <image-name> [target-model]',
    '',
    `  pnpm migrate-prompt 00166-3997412987            # onto ${DEFAULT_MODEL}`,
    '  pnpm migrate-prompt 00166-3997412987 illustrious',
  )
}

const row = findImage(imageName)
const file = externalPath(row.path)
const block = parameterBlock(file)
if (!block) fail(`${row.name} has no readable parameter block.`)

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
})

console.log(`from  ${row.name}`)
console.log(`to    ${target.name}  (${architecture})`)
console.log('')
for (const note of notes) console.log('  - ' + note)
if (notes.length === 0) console.log('  - Same architecture: model and seed changed, nothing else.')

// Selecting first is the difference between a dropdown that shows the model and
// one that renders empty over a correctly loaded model.
await forge('/luma/v1/checkpoint', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: target.name }),
})

const url = `${FORGE}/#luma_params=${encodeURIComponent(migrated)}`
const opener =
  process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref()
console.log('\nopened Forge with the migrated parameters.')
