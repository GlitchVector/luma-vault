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
  mediaQuerySchema,
  scanProgressSchema,
  deviantArtAccountSchema,
  deviantArtSummarySchema,
  timelineBucketSchema,
  type TimelineBucket,
  type DeviantArtAccount,
  type DeviantArtDraft,
  type DeviantArtSummary,
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

/**
 * How many items the query matches per week, for the timeline's bars.
 *
 * Honours every filter except the query's own date range — the bars keep
 * showing the whole span while a selection narrows the grid, so there is
 * always something outside the selection left to grab.
 */
export async function mediaTimeline(query: MediaQuery): Promise<TimelineBucket[]> {
  if (!isTauri()) return []
  // Parsed on the way OUT as well as back. The schema fills defaults for any
  // field a caller left off, and Rust rejects a partial struct outright — the
  // first version of the timeline panel sent one with `offset` deleted, every
  // fetch failed with a serde error, and the failure surfaced as an empty
  // timeline. Filling at the boundary makes that class of mistake unsendable.
  return z
    .array(timelineBucketSchema)
    .parse(await invoke('media_timeline', { query: mediaQuerySchema.parse(query) }))
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
/**
 * One item by its exact stored path.
 *
 * For the original behind an upscaled variant. The grid hides it once a variant
 * exists, so it is in no list and there is no id anywhere in the UI for it —
 * only the path the variant carries.
 */
export async function mediaByPath(path: string): Promise<MediaItem | null> {
  if (!isTauri()) return null
  return mediaItemSchema.nullable().parse(await invoke('media_by_path', { path }))
}

/** One picture the upscaler produced. */
export interface UpscaledFile {
  source: string
  destination: string
  name: string
  sourceWidth: number
  sourceHeight: number
  finalWidth: number
  finalHeight: number
  seconds: number
}

export interface UpscaleSummary {
  upscaled: number
  skipped: number
  /** Selected but already at or past the target, so never sent to the model. */
  alreadyLarge: number
  failed: number
  seconds: number
  peakVramMb: number
  model: string
  architecture: string
  outputs: UpscaledFile[]
  errors: string[]
}

export interface ForgeStatus {
  /** False when Forge is not running, which is not a reason to block anything. */
  reachable: boolean
  busy: boolean
  /** What it is doing — "Batch 3 out of 3". */
  job: string | null
  progress: number
}

/**
 * Whether Forge is mid-generation.
 *
 * Both it and the upscaler want the whole GPU, and running them together does
 * not fail — it makes each take about twice as long. Unreachable reads as not
 * busy: a Forge that is not running is not a reason to stop anything.
 */
export async function forgeStatus(): Promise<ForgeStatus> {
  if (!isTauri()) return { reachable: false, busy: false, job: null, progress: 0 }
  return invoke<ForgeStatus>('forge_status')
}

export interface UpscaleProgress {
  phase: string
  done: number
  total: number
  current: string | null
  destination: string | null
  finalWidth: number | null
  finalHeight: number | null
}

/**
 * Upscale the selected rows, writing each result beside its source.
 *
 * Takes ids, not paths. The backend resolves them, so the webview can never
 * name an arbitrary file for a GPU process to write next to.
 *
 * Resolves when the whole batch is finished — minutes for a large one. Watch
 * {@link onUpscaleProgress} for what it is doing meanwhile.
 */
export async function upscaleMedia(ids: number[], longEdge?: number): Promise<UpscaleSummary> {
  return invoke<UpscaleSummary>('upscale_media', { ids, longEdge: longEdge ?? null })
}

/** Per-file progress while an upscale runs. Returns an unsubscribe. */
export async function onUpscaleProgress(
  handler: (progress: UpscaleProgress) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<UpscaleProgress>('luma://upscale', (event) => {
    handler(event.payload)
  })
  return unlisten
}

export interface DeleteSummary {
  deleted: number
  /** Already gone from the index. Not a failure — nothing to do. */
  missing: number
  failed: number
  errors: string[]
}

/**
 * Delete many files at once.
 *
 * One call rather than one per id: a selection can be hundreds, and that many
 * round trips is slow and impossible to report on sensibly. One failure does not
 * stop the rest, so the summary says what actually happened.
 */
export async function deleteMedia(ids: number[], permanent: boolean): Promise<DeleteSummary> {
  if (!isTauri()) return { deleted: 0, missing: 0, failed: 0, errors: [] }
  return invoke<DeleteSummary>('delete_media', { ids, permanent })
}

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
 * Rate a whole selection at once. Returns how many rows changed.
 *
 * One call rather than one per id — a selection can be hundreds — and atomic,
 * so a rating lands on all of it or on none.
 */
export async function setStarsMany(ids: number[], stars: number | null): Promise<number> {
  if (!isTauri()) return 0
  return z.number().parse(await invoke('set_stars_many', { ids, stars }))
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
// DeviantArt
// ---------------------------------------------------------------------------

/**
 * Where staged submissions wait to be reviewed and posted by hand.
 *
 * Sta.sh moved into Studio in 2024. Uploading puts a picture here and nowhere
 * else — nothing is public until it is published, from this page or from the
 * panel.
 */
export const DEVIANTART_STUDIO_URL = 'https://www.deviantart.com/studio'

/** Where an application is registered, to get the client id this needs. */
export const DEVIANTART_APPS_URL = 'https://www.deviantart.com/developers/apps'

const NO_ACCOUNT: DeviantArtAccount = {
  configured: false,
  connected: false,
  username: null,
  clientId: null,
  redirectUri: '',
  scopes: [],
  canPublish: false,
}

export async function deviantArtAccount(): Promise<DeviantArtAccount> {
  if (!isTauri()) return NO_ACCOUNT
  return deviantArtAccountSchema.parse(await invoke('deviantart_account'))
}

/**
 * Record the application registered on DeviantArt.
 *
 * The secret is optional. An app registered as *public* has none, which is the
 * honest shape for a desktop program — a secret shipped to someone's machine is
 * not a secret. PKCE is what actually protects the exchange.
 *
 * Changing either identifier drops any existing authorization, because tokens
 * issued to one client id cannot be used by another.
 */
export async function deviantArtConfigure(
  clientId: string,
  clientSecret: string | null,
): Promise<DeviantArtAccount> {
  return deviantArtAccountSchema.parse(
    await invoke('deviantart_configure', { clientId, clientSecret }),
  )
}

export async function deviantArtSetRedirect(uri: string): Promise<void> {
  await invoke('deviantart_set_redirect', { uri })
}

/**
 * Open the browser and wait for DeviantArt to send an authorization back.
 *
 * Resolves once the tokens are stored — which means it stays pending for as
 * long as the login takes, including a 2FA challenge. Rejects if the tab is
 * closed, after a few minutes.
 */
export async function deviantArtConnect(): Promise<DeviantArtAccount> {
  return deviantArtAccountSchema.parse(await invoke('deviantart_connect'))
}

export async function deviantArtDisconnect(): Promise<void> {
  await invoke('deviantart_disconnect')
}

export interface DeviantArtProgress {
  /** `uploading`, `publishing` or `done`. */
  phase: string
  done: number
  total: number
  current: string | null
}

/**
 * Upload reviewed drafts, optionally publishing each as it lands.
 *
 * Sends what the panel holds rather than ids, so a person's edits are what gets
 * posted. The file itself is still resolved in Rust from the id, so the webview
 * never names a path for the backend to read.
 *
 * With `publish` false, everything lands privately in Sta.sh and nothing is
 * visible to anyone until it is submitted from DeviantArt.
 */
export async function deviantArtSend(
  drafts: DeviantArtDraft[],
  publish: boolean,
  stack: string | null = null,
): Promise<DeviantArtSummary> {
  return deviantArtSummarySchema.parse(
    await invoke('deviantart_send', { drafts, publish, stack }),
  )
}

/** Per-file progress while a batch uploads. Returns an unsubscribe. */
export async function onDeviantArtProgress(
  handler: (progress: DeviantArtProgress) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<DeviantArtProgress>('luma://deviantart', (event) => {
    handler(event.payload)
  })
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
