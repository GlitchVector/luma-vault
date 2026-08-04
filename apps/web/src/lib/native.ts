/**
 * The native seam.
 *
 * Every call into Rust goes through this module, and every return value is
 * `parse`d with its zod schema rather than cast with `invoke<T>()`. A cast
 * would let a shape mismatch travel three layers into the UI before surfacing
 * as a confusing `undefined`; a parse throws at the boundary where the mismatch
 * actually happened.
 *
 * Nothing outside this file imports `@tauri-apps/api` — which is also what
 * keeps the app runnable in a plain browser (`pnpm dev` without the shell) with
 * native features degrading to empty results instead of crashing on load.
 */

import {
  folderSchema,
  libraryStatsSchema,
  mediaFrameSchema,
  mediaItemSchema,
  importSummarySchema,
  duplicateReportSchema,
  throttleLevelSchema,
  mediaPageSchema,
  scanProgressSchema,
  type Folder,
  type DuplicateReport,
  type ImportSummary,
  type LibraryStats,
  type MediaFrame,
  type MediaItem,
  type MediaPage,
  type MediaQuery,
  type ScanProgress,
  type ThrottleLevel,
} from '@luma/core'
import { z } from 'zod'

/** The slice of Tauri's injected globals this module reads directly. */
type TauriInternals = {
  convertFileSrc?: (filePath: string, protocol: string) => string
}

/** Kept as a string, not an identifier — the dangling underscores are Tauri's. */
const INTERNALS_KEY = '__TAURI_INTERNALS__'

function tauriInternals(): TauriInternals | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as Record<string, TauriInternals | undefined>)[INTERNALS_KEY]
}

export function isTauri(): boolean {
  return tauriInternals() !== undefined
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(command, args)
}

const SCHEME = 'luma'

/**
 * The origin the `luma://` handler answers on.
 *
 * WebView2 cannot register a custom URI scheme, so on Windows Tauri serves
 * custom protocols from `http://<scheme>.localhost` instead. A literal
 * `luma://` URL resolves to nothing there and every tile renders broken.
 *
 * Ask Tauri for the origin rather than re-deriving the rule from the user
 * agent: `convertFileSrc` is the function the framework itself uses to build
 * these URLs, so the two cannot drift. Passing an empty path yields the bare
 * origin — `http://luma.localhost/` on Windows, `luma://localhost/` elsewhere.
 */
function protocolOrigin(): string {
  const convert = tauriInternals()?.convertFileSrc
  return convert ? convert('', SCHEME) : `${SCHEME}://localhost/`
}

/**
 * How a local file reaches an `<img>` or `<video>`.
 *
 * The alternative — fetching bytes and building a `data:` or blob URL — inflates
 * every payload, costs a React state update per tile, and bypasses the browser's
 * image cache entirely. Handing the webview a URL it can fetch itself means
 * decoding, caching and eviction stay where they belong.
 */
export function fileUrl(path: string): string {
  return `${protocolOrigin()}?path=${encodeURIComponent(path)}`
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function listFolders(): Promise<Folder[]> {
  if (!isTauri()) return []
  return z.array(folderSchema).parse(await invoke('list_folders'))
}

export async function addFolder(path: string): Promise<Folder> {
  return folderSchema.parse(await invoke('add_folder', { path }))
}

export async function removeFolder(id: number): Promise<void> {
  await invoke('remove_folder', { id })
}

export async function rescanFolder(id: number): Promise<void> {
  await invoke('rescan_folder', { id })
}

/** Opens the OS folder picker. Returns null when the user cancels. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: true, multiple: false, title: 'Watch a folder' })
  return typeof selected === 'string' ? selected : null
}

/**
 * Delete a file and drop it from the library.
 *
 * The Recycle Bin where there is one — this is the one action rescanning cannot
 * undo, so it stays recoverable outside the app wherever that is possible. It
 * is not on a network share, which is this whole library: pass `permanent` only
 * once the person has been told that, because the backend refuses otherwise
 * rather than quietly destroying the file. `hasRecycleBin` decides.
 */
export async function deleteItem(id: number, permanent: boolean): Promise<void> {
  if (!isTauri()) return
  await invoke('delete_item', { id, permanent })
}

/**
 * Select the checkpoint in Forge, before opening its page.
 *
 * Order matters and is not obvious: Forge builds its checkpoint dropdown from
 * the setting once, while the page is being constructed. A checkpoint chosen
 * after the tab opens *is* selected — generation uses it — but the dropdown
 * keeps whatever it rendered with, which reads as the button not working.
 *
 * Best-effort: resolves to the model name on success, or null when the block
 * names none. Rejects when Forge is unreachable, which the caller reports
 * without blocking the tab — the parameters are on the clipboard either way.
 */
export async function forgeSelectCheckpoint(block: string): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('forge_select_checkpoint', { block })
}

/** Opens a file picker for an Image Browser database. Null when cancelled. */
export async function pickImageBrowserDb(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: false,
    multiple: false,
    title: 'Choose a Stable Diffusion Image Browser database',
    filters: [{ name: 'Image Browser database', extensions: ['sqlite3', 'sqlite', 'db'] }],
  })
  return typeof selected === 'string' ? selected : null
}

/** Reveals a file in Finder / Explorer. */
export async function revealInFileManager(path: string): Promise<void> {
  if (!isTauri()) return
  // Via our own command rather than the opener plugin's JS API: the index
  // stores canonicalized paths, and the Windows shell cannot resolve the
  // extended-length form. Rust normalises it — see `paths::external_path`.
  await invoke('reveal_item', { path })
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export async function queryMedia(query: MediaQuery): Promise<MediaPage> {
  if (!isTauri()) return { items: [], total: 0, offset: 0 }
  return mediaPageSchema.parse(await invoke('query_media', { query }))
}

export async function recentMedia(limit = 40): Promise<MediaItem[]> {
  if (!isTauri()) return []
  return z.array(mediaItemSchema).parse(await invoke('recent_media', { limit }))
}

export async function mediaFrames(mediaId: number): Promise<MediaFrame[]> {
  if (!isTauri()) return []
  return z.array(mediaFrameSchema).parse(await invoke('media_frames', { mediaId }))
}

/**
 * Re-read one item. The detail view uses this rather than trusting the copy the
 * grid handed it, so opening something mid-scan shows its verdict once it lands.
 */
export async function mediaById(id: number): Promise<MediaItem | null> {
  if (!isTauri()) return null
  return mediaItemSchema.nullable().parse(await invoke('media_by_id', { id }))
}

/**
 * Set or clear a person's 1-5 rating.
 *
 * The only rating in this app a human writes. Everything else on a row comes
 * from a model, and a re-classify never touches this one.
 */
export async function setStars(id: number, stars: number | null): Promise<void> {
  if (!isTauri()) return
  await invoke('set_stars', { id, stars })
}

/**
 * Import star ratings from a Stable Diffusion Image Browser `wib.sqlite3`.
 *
 * Ratings whose folder has not been scanned yet are staged and attach as those
 * files are indexed, so importing before scanning is the expected order.
 */
export async function importImageBrowserDb(path: string): Promise<ImportSummary> {
  if (!isTauri()) return { found: 0, staged: 0, applied: 0, unrecognised: 0 }
  return importSummarySchema.parse(await invoke('import_image_browser_db', { path }))
}

/**
 * Find every picture the library holds more than once, and group them.
 *
 * Images are matched perceptually, so a re-encode or a copy at another
 * resolution still counts; videos are matched exactly on their content key,
 * because a re-encoded video is a different video.
 */
export async function findDuplicates(): Promise<DuplicateReport> {
  if (!isTauri()) {
    return { groups: 0, files: 0, imageGroups: 0, videoGroups: 0, hashed: 0, skippedCommon: 0 }
  }
  return duplicateReportSchema.parse(await invoke('find_duplicates'))
}

/** Opens a URL in the default browser. Refused unless http or https. */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener')
    return
  }
  await invoke('open_external', { url })
}

/**
 * The verbatim parameter block a file records, or null if it has none.
 *
 * Read from the file each time rather than stored — a real block with
 * ControlNet and ADetailer is kilobytes, and this is only needed on a click.
 * Sending Forge *this* rather than a block rebuilt from the parsed fields is
 * the difference between regenerating the same image and a similar one.
 */
export async function generationParameters(id: number): Promise<string | null> {
  if (!isTauri()) return null
  return z.string().nullable().parse(await invoke('generation_parameters', { id }))
}

/** Where the local Stable Diffusion UI answers. */
export async function forgeUrl(): Promise<string> {
  if (!isTauri()) return 'http://127.0.0.1:7860'
  return z.string().parse(await invoke('forge_url'))
}

export async function setForgeUrl(url: string): Promise<void> {
  if (!isTauri()) return
  await invoke('set_forge_url', { url })
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

export async function listExclusions(): Promise<string[]> {
  if (!isTauri()) return []
  return z.array(z.string()).parse(await invoke('list_exclusions'))
}

/**
 * Stop scanning a folder and drop what it already contributed.
 *
 * Returns how many rows were removed. Files on disk are never touched.
 */
export async function excludeFolder(path: string): Promise<number> {
  if (!isTauri()) return 0
  return z.number().parse(await invoke('exclude_folder', { path }))
}

export async function includeFolder(path: string): Promise<void> {
  if (!isTauri()) return
  await invoke('include_folder', { path })
}

export async function libraryStats(): Promise<LibraryStats> {
  if (!isTauri()) {
    return { folders: 0, images: 0, videos: 0, classified: 0, pending: 0, sexy: 0, failed: 0 }
  }
  return libraryStatsSchema.parse(await invoke('library_stats'))
}

/**
 * Clear recorded failures and reprocess them. Returns how many were cleared.
 *
 * Worth offering because a failure is not always permanent: an unmounted share
 * or a missing ffmpeg fails everything it touches at once.
 */
export async function retryFailed(folderId: number | null = null): Promise<number> {
  if (!isTauri()) return 0
  return z.number().parse(await invoke('retry_failed', { folderId }))
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function scanProgress(): Promise<ScanProgress> {
  if (!isTauri()) {
    return { phase: 'idle', folderId: null, done: 0, total: 0, current: null, errors: [] }
  }
  return scanProgressSchema.parse(await invoke('scan_progress'))
}

export async function processPending(): Promise<void> {
  if (!isTauri()) return
  await invoke('process_pending')
}

const environmentSchema = z.object({
  classifierAvailable: z.boolean(),
  ffmpegAvailable: z.boolean(),
  busy: z.boolean(),
  /** How much of the machine background work may use. */
  throttle: throttleLevelSchema,
})
export type Environment = z.infer<typeof environmentSchema>

export async function environment(): Promise<Environment> {
  if (!isTauri()) {
    return {
      classifierAvailable: false,
      ffmpegAvailable: false,
      busy: false,
      throttle: 'off',
    }
  }
  return environmentSchema.parse(await invoke('environment'))
}

/**
 * Cap background work at a share of the machine.
 *
 * Takes effect on the next unit of work, not immediately — a batch already
 * inside the classifier finishes at full speed.
 */
export async function setThrottle(level: ThrottleLevel): Promise<void> {
  if (!isTauri()) return
  await invoke('set_throttle', { level })
}

/**
 * Subscribe to scan progress. Returns an unsubscribe function that is safe to
 * call in a browser too, so callers never need their own `isTauri()` guard.
 */
export function onScanProgress(handler: (progress: ScanProgress) => void): () => void {
  if (!isTauri()) return () => {}

  let dispose: (() => void) | null = null
  let cancelled = false

  void (async () => {
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen<unknown>('luma://progress', (event) => {
      const parsed = scanProgressSchema.safeParse(event.payload)
      // A malformed event is dropped rather than thrown: this runs inside the
      // event loop, where a throw would take down the listener for good.
      if (parsed.success) handler(parsed.data)
    })
    if (cancelled) unlisten()
    else dispose = unlisten
  })()

  return () => {
    cancelled = true
    dispose?.()
  }
}
