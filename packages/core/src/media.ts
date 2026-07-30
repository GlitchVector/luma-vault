import type { MediaKind } from './schemas.ts'

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
