/**
 * Recording which pictures a command run made.
 *
 * A `/shotall` is forty-six renders of one character and a `/photostory` is a
 * shoot in stages, but both land in the same dated Forge output folder as
 * everything else rendered that day, interleaved with unrelated work. Nothing
 * on the files says they belong together: the prompts differ by design — that
 * is the whole point of a set — and a bracket reuses one seed across five
 * frames, so neither prompt nor seed can be the key.
 *
 * So the run writes a manifest beside its pictures, and the vault reads it on
 * the next scan. See `apps/desktop/src/sets.rs`, which is the other half.
 *
 * **A file, not a call into the app.** Renders queued with `--queue` drain when
 * the GPU is free, which is deliberately the middle of the night — there may be
 * no app running to tell, and a set recorded only in a database would be lost
 * the next time the index is rebuilt. A file on disk survives both.
 *
 * **The member list is discovered, not chosen.** Locally Forge saves its own
 * copy under its own numbering (`00905-4090734728.png`) and never tells the API
 * what it called it, so the run has to go and look. It looks by seed, which the
 * render *does* return, narrowed to files that appeared while this render was
 * running — a seed reused across a bracket would otherwise match its own
 * earlier frames.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { FORGE, IS_REMOTE, RENDER_DIR, forge } from './forge.mjs'

/** The folder a manifest goes in, beside the pictures it describes. */
export const MANIFEST_DIR = '.luma-sets'

/**
 * Parse the `--set` argument.
 *
 * `<command>/<character>/<stamp>[/<title>]` — for example
 * `shotall/alexstrasza/20260903T1431`. One argument rather than four flags, and
 * no separate "begin a run" step, because every render of a set is its own CLI
 * invocation: whatever identifies the run has to be something the caller can
 * repeat verbatim forty-six times, and a string it composed once is the only
 * thing that survives that without a state file to lose.
 *
 * The stamp is what makes two `/shotall`s of the same character on the same day
 * two sets rather than one, so it is required and not defaulted — a run that
 * forgets it would silently swallow the previous one's pictures.
 */
export function parseSet(value) {
  if (!value) return null
  const parts = String(value)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 3) {
    throw new Error(
      `--set wants <command>/<character>/<stamp>, got "${value}"\n` +
        '  e.g. --set shotall/alexstrasza/20260903T1431',
    )
  }
  const [command, character, stamp, ...rest] = parts
  return {
    run: slug(`${command}-${character}-${stamp}`),
    command,
    character,
    title: rest.length > 0 ? rest.join(' / ') : null,
    createdAt: stampToMs(stamp),
  }
}

/** Lowercase, and only the characters a filename and a key can both hold. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * `20260903T1431` → unix ms, falling back to now.
 *
 * Read as local time, because the stamp was written by something looking at a
 * local clock and a set that lists two hours before it was shot reads as a bug.
 */
function stampToMs(stamp) {
  const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?$/.exec(stamp)
  if (!match) return Date.now()
  const [, y, mo, d, h = '0', mi = '0'] = match
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime()
}

/**
 * Where Forge saves its own copies, asked once per process.
 *
 * The API reports the outdir as Forge sees it (`X:/AI/…`), which is not the
 * name the vault indexes the same tree under (`\\jebpot\devs\AI\…`). That is
 * fine and is the reason the manifest lists bare filenames: this path is only
 * used to *find* the files and to decide which folder the manifest goes in, and
 * both sides then resolve members against that folder.
 */
let outdirPromise = null
export function forgeOutdir() {
  outdirPromise ??= forge('/sdapi/v1/options')
    .then((options) => ({
      root: options?.outdir_txt2img_samples || options?.outdir_samples || null,
      // Forge files into `<outdir>/<date>/` unless this is off.
      toDirs: options?.save_to_dirs !== false,
    }))
    .catch(() => ({ root: null, toDirs: true }))
  return outdirPromise
}

/**
 * The folder this render's picture landed in, and what it is called there.
 *
 * Returns `null` when it cannot be found, which is not an error: the picture
 * exists either way, and a set that is missing a frame is better than a run
 * that stops because it could not file one.
 */
async function locate({ seed, since }) {
  // Remote Forge keeps its own copy on the rented machine, so the copy the
  // library sees is the one we filed ourselves — and we know its name exactly.
  if (IS_REMOTE) return null

  const { root, toDirs } = await forgeOutdir()
  if (!root) return null

  // `[date]` is the default directory pattern, and the only one worth guessing
  // at: a render that started before midnight can land in either day's folder,
  // so both are searched.
  const days = toDirs ? [dayFolder(since), dayFolder(Date.now())] : ['']
  for (const day of [...new Set(days)]) {
    const folder = day ? join(root, day) : root
    if (!existsSync(folder)) continue
    const found = readdirSync(folder)
      .filter((name) => new RegExp(`-${seed}\\.[a-z0-9]+$`, 'i').test(name))
      .map((name) => ({ name, at: mtime(join(folder, name)) }))
      // A bracket reuses one seed across five renders, so the seed alone names
      // several files. The one this render made is the one that appeared while
      // it was running; newest wins if two somehow share the moment.
      .filter((entry) => entry.at >= since - 2000)
      .sort((a, b) => b.at - a.at)
    if (found.length > 0) return { folder, file: found[0].name }
  }
  return null
}

const mtime = (path) => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

const dayFolder = (ms) => {
  const at = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * Add one picture to a run's manifest.
 *
 * Appends after every render rather than writing once at the end, so a run that
 * is interrupted — and a forty-six render run gets interrupted — still leaves a
 * set holding everything it managed to make. Re-adding a file already listed
 * updates its label instead of duplicating it, which is what makes a retried
 * shot behave.
 *
 * Never throws. Filing is bookkeeping wrapped around the thing that actually
 * matters, and a picture that rendered must not be lost to a failure to record
 * where it went.
 */
export async function recordMember(set, { seed, since, label, destination }) {
  if (!set) return null
  try {
    const found = IS_REMOTE
      ? RENDER_DIR
        ? { folder: RENDER_DIR, file: basename(destination) }
        : null
      : await locate({ seed, since })
    if (!found) return null

    const dir = join(found.folder, MANIFEST_DIR)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${set.run}.json`)

    const manifest = readManifest(path) ?? {
      run: set.run,
      command: set.command,
      character: set.character,
      title: set.title,
      createdAt: set.createdAt,
      members: [],
    }
    const existing = manifest.members.findIndex((member) => member.file === found.file)
    const member = { file: found.file, ...(label ? { label } : {}) }
    if (existing >= 0) manifest.members[existing] = member
    else manifest.members.push(member)

    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
    return path
  } catch {
    return null
  }
}

function readManifest(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(manifest?.members) ? manifest : null
  } catch {
    // A half-written manifest from a killed run is worth less than the set it
    // is about to describe: start again rather than refuse to record anything.
    return null
  }
}

/** Only for the error message, so a run says where Forge is when it cannot look. */
export const FORGE_URL = FORGE
