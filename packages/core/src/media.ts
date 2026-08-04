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
