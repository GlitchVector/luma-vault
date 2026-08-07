import type { Generation, MediaKind } from './schemas.ts'

/**
 * Which files the scanner picks up.
 *
 * Kept here rather than in Rust so the frontend, the scanner and the tests all
 * agree on one list; the Rust side reads the same set through the generated
 * contract fixture.
 */
export const IMAGE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'avif',
  'heic',
  'tif',
  'tiff',
] as const

export const VIDEO_EXTENSIONS = [
  'mp4',
  'm4v',
  'mkv',
  'webm',
  'mov',
  'avi',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'ts',
] as const

const IMAGE_SET = new Set<string>(IMAGE_EXTENSIONS)
const VIDEO_SET = new Set<string>(VIDEO_EXTENSIONS)

export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function basenameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * Rebuild the Automatic1111 / Forge parameter block from stored generation data.
 *
 * The exact text those UIs write into a PNG, and the exact text their **↙ "read
 * generation parameters"** button parses back out: paste this into the prompt
 * box, click the arrow, and prompt, negative prompt, sampler, steps, CFG, seed
 * and model all populate at once.
 *
 * That round trip is the only way to get values into a running Forge. It is a
 * Gradio app, so component state cannot be set from a URL and there is no route
 * that accepts these as query parameters — which is why this produces text for
 * the clipboard rather than a link.
 *
 * Fields the file never recorded are omitted rather than guessed. An invented
 * `Steps: 20` would silently generate something other than what you are
 * looking at, which is worse than leaving it at whatever Forge already has.
 */
export function toParameterBlock(generation: Generation): string {
  const lines: string[] = [generation.prompt ?? '']
  if (generation.negativePrompt) {
    lines.push(`Negative prompt: ${generation.negativePrompt}`)
  }

  // Order matches what A1111 writes. The parser does not care, but a person
  // comparing this against the original file does.
  const settings: Array<[string, string | undefined]> = [
    ['Steps', generation.steps],
    ['Sampler', generation.sampler],
    ['CFG scale', generation.cfgScale],
    ['Seed', generation.seed],
    ['Model', generation.model],
  ]
  const tail = settings
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ')
  if (tail) lines.push(tail)

  return lines.join('\n')
}

/** Everything before the last separator, without it. `''` for a bare name. */
export function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut <= 0 ? '' : path.slice(0, cut)
}

/**
 * A path as a person should read it.
 *
 * The index stores canonicalized paths, which on Windows means the
 * extended-length form — `\\?\UNC\server\share\...` for a network location and
 * `\\?\C:\...` for a local one. That prefix exists to lift the 260-character
 * limit and means nothing to anyone reading it; worse, it is not the path you
 * could paste into Explorer.
 *
 * Display only. The stored form is what the `luma://` allowlist checks and what
 * "Reveal" hands to the shell, so nothing may be *stored* in this shape — see
 * `paths::external_path`, the Rust twin of this function.
 */
export function displayPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length)
  return path
}

/** Roughly how much of the folder path a tile's overlay can show. */
const MATCH_WINDOW = 34

/**
 * The stretch of a file's folder path around what a search matched.
 *
 * For the grid, in folder-search mode. A tile shows a picture and its filename;
 * neither says *why* it is in these results, and the whole point of a folder
 * search is that the answer is somewhere in a path long enough that showing all
 * of it would be unreadable. So this returns the part worth reading — the
 * matched run with enough either side to place it — and marks where the match
 * begins and ends so the caller can pick it out.
 *
 * Matching is case-insensitive and on the directory only, exactly as the index
 * does it: the filename is what the ordinary search covers, and highlighting a
 * hit there would claim the folder matched when it did not.
 *
 * `null` when nothing matches, which is normal rather than exceptional — an
 * upscaled variant stands in for an original filed elsewhere, so a row in the
 * results may genuinely not carry the term in its own path.
 */
export function folderMatch(
  path: string,
  term: string,
): { text: string; from: number; to: number } | null {
  const needle = term.trim().toLowerCase()
  if (!needle) return null

  const readable = displayPath(path)
  const directory = dirnameOf(readable)
  if (!directory) return null

  // Every whitespace-separated word has to appear — the index ANDs them — but
  // the window is drawn around the *first* one found, because a window around
  // all of them is the whole path again on anything but a lucky ordering.
  const words = needle.split(/\s+/).filter(Boolean)
  const haystack = directory.toLowerCase()
  if (!words.every((word) => haystack.includes(word))) return null

  const hit = words
    .map((word) => ({ at: haystack.indexOf(word), length: word.length }))
    .filter((found) => found.at >= 0)
    .sort((a, b) => a.at - b.at)[0]
  if (!hit) return null

  // Centred on the match, then clamped — so a hit near either end spends its
  // whole budget on the side that actually has path to show.
  const slack = Math.max(0, MATCH_WINDOW - hit.length)
  let start = Math.max(0, hit.at - Math.floor(slack / 2))
  let end = Math.min(directory.length, start + hit.length + slack)
  start = Math.max(0, Math.min(start, end - hit.length - slack))

  const head = start > 0 ? '…' : ''
  const tail = end < directory.length ? '…' : ''
  return {
    text: `${head}${directory.slice(start, end)}${tail}`,
    from: head.length + (hit.at - start),
    to: head.length + (hit.at - start) + hit.length,
  }
}

/**
 * Whether deleting this file could put it in a Recycle Bin.
 *
 * False on a network share, where Windows has none — Explorer deletes outright
 * there and says so. Every path in this library is a share, so this is the
 * normal case, and it decides what the delete confirmation is allowed to
 * promise. `paths::has_recycle_bin` is the Rust twin, and it is the one that
 * enforces it; this exists so the question can be worded correctly before it is
 * asked, rather than the answer being a surprise afterwards.
 */
export function hasRecycleBin(path: string): boolean {
  // `\\?\D:\...` also opens with two backslashes and is local, so the verbatim
  // prefix has to be ruled out before treating `\\` as a share.
  if (path.startsWith('\\\\?\\')) return !path.toUpperCase().startsWith('\\\\?\\UNC\\')
  return !path.startsWith('\\\\')
}

/** `null` for anything the vault does not index. */
export function kindOf(path: string): MediaKind | null {
  const ext = extensionOf(path)
  if (IMAGE_SET.has(ext)) return 'image'
  if (VIDEO_SET.has(ext)) return 'video'
  return null
}

/**
 * Animated formats must never be replaced by a still thumbnail in the grid, or
 * the animation is lost. The tile renders the original file for these.
 */
export function isAnimatedImage(path: string): boolean {
  const ext = extensionOf(path)
  return ext === 'gif' || ext === 'webp' || ext === 'avif'
}

/**
 * Fit `(width, height)` inside a square of `bound`, preserving aspect ratio and
 * never scaling up. Returns integers, because a fractional CSS pixel on a tile
 * is what produces the 1px seams between grid rows.
 */
export function fitWithin(
  width: number,
  height: number,
  bound: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: bound, height: bound }
  if (width <= bound && height <= bound) return { width: Math.round(width), height: Math.round(height) }

  const scale = Math.min(bound / width, bound / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Fit `(width, height)` inside a `boxWidth`×`boxHeight` rectangle, preserving
 * aspect ratio and never scaling up.
 *
 * The sibling of {@link fitWithin}, which bounds both axes by a single number
 * because a grid tile is square-bounded. A window is not, and the lightbox has
 * to know the exact rectangle a picture will occupy *before* it loads — the
 * poster is painted into that rectangle, and if it is not the one the original
 * lands in, swapping one for the other moves the picture.
 *
 * Never up, which is the lightbox's long-standing behaviour: a 200px image in a
 * 1400px window stays 200px. Blowing it up would show its pixels and say
 * nothing the original did not.
 */
export function fitInside(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return { width: 0, height: 0 }
  }

  const scale = Math.min(1, boxWidth / width, boxHeight / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * The longest edge a picture needs before it counts as 4K.
 *
 * 3840, from UHD. Applied to the *longest* edge rather than to width, because a
 * library is not all landscape and a 2160x3840 phone photo is the same picture
 * turned ninety degrees — keying on width would call one of them 4K and not the
 * other.
 *
 * Deliberately one number rather than an area: "at least 4K" is a statement
 * about how big it can be shown, and a 3000x3000 square is 9MP without ever
 * filling a 4K display.
 */
export const FOUR_K_EDGE = 3840

/**
 * Is this at least 4K?
 *
 * The single definition, shared by the grid's badge and the filter — the filter
 * sends {@link FOUR_K_EDGE} to the index, which applies the same comparison in
 * SQL, so a tile can never be badged as something the filter would exclude.
 */
export function isFourK(width: number, height: number): boolean {
  return Math.max(width, height) >= FOUR_K_EDGE
}

/** Human-readable byte size, for the detail panel. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** `1:03:12` / `4:07` — omits the hour segment when there is none. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
