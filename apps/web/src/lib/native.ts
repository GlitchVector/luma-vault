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
 *
 * A browser is not always a dead end, though. A sharing host serves this same
 * SPA over HTTP (see `remote.rs`), which is how a phone gets in: the page then
 * has no Tauri at all, and every call goes to the host's `/luma/v1/rpc` with a
 * session cookie instead of through the IPC. `backend()` decides which of the
 * three worlds this page woke up in — the desktop shell, a browser served by a
 * host, or a bare dev server — and the forty wrappers below stay unaware, the
 * same trick that made desktop remote mode invisible to them.
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
  remoteStatusSchema,
  shareStatusSchema,
  scanProgressSchema,
  deviantArtAccountSchema,
  deviantArtGallerySchema,
  deviantArtSummarySchema,
  timelineBucketSchema,
  characterCountSchema,
  sourceOriginSchema,
  type CharacterCount,
  type TimelineBucket,
  type DeviantArtAccount,
  type DeviantArtDraft,
  type DeviantArtGallery,
  type DeviantArtSummary,
  type Folder,
  type DuplicateReport,
  type ImportSummary,
  type LibraryStats,
  type MediaFrame,
  type MediaItem,
  type MediaPage,
  type MediaQuery,
  type Rating,
  type RemoteStatus,
  type ScanProgress,
  type ShareStatus,
  type SourceOrigin,
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

async function tauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(command, args)
}

/**
 * Commands that always mean *this* machine, even during a remote session.
 *
 * The remote-mode ones for the obvious reason — asking the peer whether we are
 * connected to it is circular. The two OS-integration ones because they act on
 * a screen: a browser tab belongs on the machine somebody is sitting at, and a
 * file-manager window opened on the machine they are not is worse than being
 * told where the file actually is, which is what `reveal_item` does instead.
 *
 * `forge_url` for the same reason as `open_external`, and it has to be for the
 * same reason or the two disagree. The address is only ever used to build a
 * tab that opens *here*, so it has to mean something here. Routed, the peer
 * answered with its own setting — an unconfigured peer returning its
 * `127.0.0.1:7860` default, which then opened on this machine and pointed at
 * this machine, where there is no Forge at all.
 *
 * `forge_select_checkpoint` is deliberately *not* here: it is an HTTP call
 * rather than an address, and letting the peer make it means the peer reaching
 * its own loopback, which no firewall is going to argue with.
 */
const LOCAL_ONLY = new Set([
  'remote_status',
  'remote_connect',
  'remote_disconnect',
  'remote_call',
  'share_status',
  'set_share',
  'open_external',
  'reveal_item',
  'forge_url',
  'set_forge_url',
])

// ---------------------------------------------------------------------------
// Which world this page woke up in
// ---------------------------------------------------------------------------

/**
 * - `tauri` — the desktop shell; calls go through the IPC.
 * - `http` — a browser served by a sharing host, with a live session cookie;
 *   calls go to `/luma/v1/rpc` on the page's own origin. The greeting rides
 *   along so the UI can say whose library this is without a second ask.
 * - `login` — served by a host, but not signed in. The app shows the
 *   passphrase screen and every data call returns its empty shape.
 * - `none` — a bare dev server (`pnpm dev`). Nothing behind the page at all.
 */
export type Backend =
  | { kind: 'tauri' }
  | { kind: 'http'; host: string; folders: number; items: number }
  | { kind: 'login' }
  | { kind: 'none' }

const helloSchema = z.object({
  app: z.string(),
  host: z.string(),
  folders: z.number(),
  items: z.number(),
})

let detected: Backend | null = null
let detecting: Promise<Backend> | null = null

async function detect(): Promise<Backend> {
  if (isTauri()) return { kind: 'tauri' }
  if (typeof window === 'undefined' || window.location.protocol === 'file:') {
    return { kind: 'none' }
  }
  try {
    // Same-origin on purpose: the page only ever talks to whoever served it.
    // The probe doubles as the session check — 200 means the cookie is good.
    const response = await fetch('/luma/v1/hello', { credentials: 'same-origin' })
    if (response.status === 401) return { kind: 'login' }
    if (!response.ok) return { kind: 'none' }
    const hello = helloSchema.parse(await response.json())
    if (hello.app !== 'luma-vault') return { kind: 'none' }
    return { kind: 'http', host: hello.host, folders: hello.folders, items: hello.items }
  } catch {
    // A dev server answers this with HTML or a 404; either way it is not a
    // host, and guessing otherwise would fail every call instead of just this.
    return { kind: 'none' }
  }
}

/** Asked once, then cached — the world does not change under a loaded page. */
export function backend(): Promise<Backend> {
  if (detected) return Promise.resolve(detected)
  detecting ??= detect().then((result) => {
    detected = result
    detecting = null
    return result
  })
  return detecting
}

/**
 * Synchronous view of the answer, for the two callers that cannot await —
 * `fileUrl` and the components deciding what to render. Safe for the same
 * reason `source` below is: a tile cannot exist before a query resolved, and
 * no query resolves before detection has.
 */
export function isHttpSession(): boolean {
  return detected?.kind === 'http'
}

/** Whether anything answers at all — the desktop shell or a host session. */
async function hasBackend(): Promise<boolean> {
  const kind = (await backend()).kind
  return kind === 'tauri' || kind === 'http'
}

/**
 * Trade the passphrase for the session cookie. Resolves when the cookie is
 * set; the caller reloads the page, for the same reason connecting does on the
 * desktop — every piece of state above this seam describes one library, and a
 * reload swaps all of it at once.
 */
export async function httpLogin(passphrase: string): Promise<void> {
  const response = await fetch('/luma/v1/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  })
  if (response.status === 401) {
    throw new Error('that is not the passphrase this machine is sharing with')
  }
  if (!response.ok) {
    throw new Error(`the host answered HTTP ${response.status} — is it still sharing?`)
  }
}

async function httpLogout(): Promise<void> {
  await fetch('/luma/v1/logout', { method: 'POST', credentials: 'same-origin' })
}

/**
 * The host stopped answering mid-session.
 *
 * Worth its own type because it is the one failure where the library is fine
 * and the wire is not. Every other throw here means a call was refused and
 * saying so is enough; this one means nothing can be asked at all, and a caller
 * that treats it as "no results" shows an empty grid blaming the filters for a
 * machine being switched off.
 */
export class HostUnreachableError extends Error {
  constructor(readonly host: string | null) {
    super(host ? `cannot reach ${host}` : 'cannot reach the host')
    this.name = 'HostUnreachableError'
  }
}

async function httpCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  let response: Response
  try {
    response = await fetch('/luma/v1/rpc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: command, args: args ?? {} }),
    })
  } catch {
    // `fetch` rejects only when the request never completed at all — the host
    // is down, asleep, or off the network. Forget the cached detection on the
    // way out: `backend()` caches on the premise that the world cannot change
    // under a loaded page, which holds for the desktop shell and does not hold
    // across a wire. Without this the page keeps believing in a host that
    // stopped existing and every later call fails the same silent way.
    const host = detected?.kind === 'http' ? detected.host : null
    detected = null
    throw new HostUnreachableError(host)
  }
  if (response.status === 401) {
    // The host restarted sharing, which rotates the session token. Reloading
    // lands on the login screen — one honest state instead of a page where
    // every button fails with the same toast. No loop risk: detection said
    // `http` when this page booted, so a 401 here means the session ended.
    globalThis.location?.reload()
    throw new Error('the host ended this session — log in again')
  }
  const body = (await response.json()) as { ok?: unknown; error?: unknown }
  // The host reports a refused operation in the body, not the status, and the
  // message is thrown verbatim so the toast shows what it said.
  if (typeof body.error === 'string') throw new Error(body.error)
  return body.ok as T
}

/** `null` until the backend has been asked, which happens on the first call. */
let route: 'local' | 'remote' | null = null
let probing: Promise<void> | null = null
/** Which library the files come from, for the cache key. Empty when it is ours. */
let source = ''

/**
 * Where calls go.
 *
 * Read from the backend once and then cached, rather than passed in: this seam
 * is what makes remote mode invisible to the other forty call sites in this
 * file and to every component above them. Asking lazily also removes a
 * load-order trap — nothing has to make sure the session is known before the
 * first query goes out.
 */
async function currentRoute(): Promise<'local' | 'remote'> {
  if (route) return route
  probing ??= tauri<unknown>('remote_status')
    .then((status) => {
      remember(remoteStatusSchema.parse(status))
    })
    // A backend that cannot answer is this machine. Guessing "remote" would
    // make every call fail instead of just this one.
    .catch(() => {
      route = 'local'
    })
    .finally(() => {
      probing = null
    })
  await probing
  return route ?? 'local'
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // A host session first: there is no Tauri to fall back to in a browser, and
  // the LOCAL_ONLY set does not apply — every command that must mean "this
  // machine" is answered before invoke() by its wrapper, because on a phone
  // there is no meaningful "this machine" to run anything on.
  if (isHttpSession()) return httpCall<T>(command, args)
  if (LOCAL_ONLY.has(command)) return tauri<T>(command, args)
  if ((await currentRoute()) === 'remote') {
    // The peer runs the same operation under the same name, so nothing here
    // needs a remote variant — see `api::dispatch` on the Rust side.
    return tauri<T>('remote_call', { name: command, args: args ?? {} })
  }
  return tauri<T>(command, args)
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
 * How a file reaches an `<img>` or `<video>`.
 *
 * The alternative — fetching bytes and building a `data:` or blob URL — inflates
 * every payload, costs a React state update per tile, and bypasses the browser's
 * image cache entirely. Handing the webview a URL it can fetch itself means
 * decoding, caching and eviction stay where they belong.
 *
 * `&from=` is what keeps that cache honest across machines. Responses are
 * `immutable` — safe, because the watcher drops the row when a file changes — and
 * a thumbnail is addressed by a hash of its **absolute source path**. Two
 * machines that lay their folders out the same way therefore produce the *same*
 * URL for different pictures, and without this the grid would serve one
 * machine's thumbnail for the other's file. The backend ignores the parameter;
 * only the cache key cares.
 *
 * It is always set by the time it matters: a tile cannot exist before the query
 * that produced it resolved, and no call resolves before the route is known.
 */
export function fileUrl(path: string): string {
  // A host session fetches straight from the origin that served the page. No
  // `&from=` needed here: the browser's cache is already per-origin, so two
  // hosts with identical folder layouts cannot collide the way two luma://
  // caches on one desktop can.
  if (isHttpSession()) return `/luma/v1/file?path=${encodeURIComponent(path)}`
  const from = source ? `&from=${encodeURIComponent(source)}` : ''
  return `${protocolOrigin()}?path=${encodeURIComponent(path)}${from}`
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function listFolders(): Promise<Folder[]> {
  if (!(await hasBackend())) return []
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
  if (!(await hasBackend())) return
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
  if (!(await hasBackend())) return null
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
  if (!(await hasBackend())) return { items: [], total: 0, offset: 0 }
  return mediaPageSchema.parse(await invoke('query_media', { query }))
}

/**
 * How many items the query matches per week, for the timeline's bars.
 *
 * Honours every filter except the query's own date range — the bars keep
 * showing the whole span while a selection narrows the grid, so there is
 * always something outside the selection left to grab.
 */
/**
 * The most-depicted characters, biggest first. Detected from prompts at
 * labelling time; the name is danbooru's `name (series)` form, which doubles
 * as a search term because the prompt contains it verbatim.
 */
export async function topCharacters(query: MediaQuery, limit = 10): Promise<CharacterCount[]> {
  if (!(await hasBackend())) return []
  // Outgoing parse fills defaults, the same lesson the timeline taught.
  return z.array(characterCountSchema).parse(
    await invoke('top_characters', { query: mediaQuerySchema.parse(query), limit }),
  )
}

export async function mediaTimeline(query: MediaQuery): Promise<TimelineBucket[]> {
  if (!(await hasBackend())) return []
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
  if (!(await hasBackend())) return []
  return z.array(mediaItemSchema).parse(await invoke('recent_media', { limit }))
}

export async function mediaFrames(mediaId: number): Promise<MediaFrame[]> {
  if (!(await hasBackend())) return []
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
  if (!(await hasBackend())) return null
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
  if (!(await hasBackend())) return { reachable: false, busy: false, job: null, progress: 0 }
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
  if (!(await hasBackend())) return { deleted: 0, missing: 0, failed: 0, errors: [] }
  return invoke<DeleteSummary>('delete_media', { ids, permanent })
}

/**
 * The original an Extras-tab upscale was made from, linked perceptually via
 * the duplicate grouping. Null when the pair has no dupe group yet — Find
 * Duplicates has not run — which the panel says rather than hiding.
 */
export async function extrasOriginal(id: number): Promise<MediaItem | null> {
  if (!(await hasBackend())) return null
  return mediaItemSchema.nullable().parse(await invoke('extras_original', { id }))
}

export async function mediaById(id: number): Promise<MediaItem | null> {
  if (!(await hasBackend())) return null
  return mediaItemSchema.nullable().parse(await invoke('media_by_id', { id }))
}

/**
 * What an img2img was made from, walked back to the picture that started the
 * lineage.
 *
 * Null is an ordinary answer rather than a failure: a third of img2img rows
 * have no findable source, because it was never in this library or is no longer
 * in it. Worth asking only when `generation.needsSourceImage` is set — for
 * anything else the walk has nothing to look for.
 */
export async function sourceOrigin(id: number): Promise<SourceOrigin | null> {
  if (!(await hasBackend())) return null
  return sourceOriginSchema.nullable().parse(await invoke('source_origin', { id }))
}

/**
 * Set or clear a person's 1-5 rating.
 *
 * The only rating in this app a human writes. Everything else on a row comes
 * from a model, and a re-classify never touches this one.
 */
export async function setStars(id: number, stars: number | null): Promise<void> {
  if (!(await hasBackend())) return
  await invoke('set_stars', { id, stars })
}

/**
 * Rate a whole selection at once. Returns how many rows changed.
 *
 * One call rather than one per id — a selection can be hundreds — and atomic,
 * so a rating lands on all of it or on none.
 */
export async function setStarsMany(ids: number[], stars: number | null): Promise<number> {
  if (!(await hasBackend())) return 0
  return z.number().parse(await invoke('set_stars_many', { ids, stars }))
}

/**
 * Correct the model's rating on a selection, or hand it back to the model.
 *
 * `null` clears the correction, which costs no inference — the detector's own
 * verdict was never overwritten, so restoring it is a read. Returns how many
 * rows changed.
 */
export async function setRatingOverride(
  ids: number[],
  rating: Exclude<Rating, 'unrated'> | null,
): Promise<number> {
  if (!(await hasBackend())) return 0
  return z.number().parse(await invoke('set_rating_override', { ids, rating }))
}

/**
 * Import star ratings from a Stable Diffusion Image Browser `wib.sqlite3`.
 *
 * Ratings whose folder has not been scanned yet are staged and attach as those
 * files are indexed, so importing before scanning is the expected order.
 */
export async function importImageBrowserDb(path: string): Promise<ImportSummary> {
  if (!(await hasBackend())) return { found: 0, staged: 0, applied: 0, unrecognised: 0 }
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
  if (!(await hasBackend())) {
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
  if (!(await hasBackend())) return null
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
  canBrowse: false,
}

export async function deviantArtAccount(): Promise<DeviantArtAccount> {
  if (!(await hasBackend())) return NO_ACCOUNT
  return deviantArtAccountSchema.parse(await invoke('deviantart_account'))
}

/**
 * The account's own gallery folders, for filing a submission into.
 *
 * Empty rather than an error when the connection predates the `browse` scope —
 * the backend checks before asking — so a caller can render the picker from
 * whatever comes back without treating a missing scope as a failure.
 */
export async function deviantArtGalleries(): Promise<DeviantArtGallery[]> {
  if (!(await hasBackend())) return []
  return z.array(deviantArtGallerySchema).parse(await invoke('deviantart_galleries'))
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

/**
 * Mark a selection as already on DeviantArt, or clear the mark.
 *
 * For everything the app did not upload itself — posted from the website, or
 * posted before it recorded anything. A row marked this way knows the picture
 * is up but not where, so its badge carries no link.
 */
export async function deviantArtMark(ids: number[], posted: boolean): Promise<number> {
  if (!(await hasBackend())) return 0
  return (await invoke('deviantart_mark', { ids, posted })) as number
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
// Remote mode
// ---------------------------------------------------------------------------

const NOT_CONNECTED: RemoteStatus = {
  connected: false,
  address: '',
  host: '',
  folders: 0,
  items: 0,
  lastAddress: '',
  hasPassphrase: false,
}

const NOT_SHARING: ShareStatus = {
  sharing: false,
  port: 0,
  addresses: [],
  hasPassphrase: false,
}

/** Remembers the answer, so the next call knows where to go without asking. */
function remember(status: RemoteStatus): RemoteStatus {
  route = status.connected ? 'remote' : 'local'
  // Part of every file URL from here on — see `fileUrl`.
  source = status.connected ? status.address : ''
  return status
}

export async function remoteStatus(): Promise<RemoteStatus> {
  // A host session *is* a remote session, just without a desktop in front of
  // it — so it reports as connected, to the machine that served this page.
  // Synthesized rather than asked over the wire: `remote_status` on the host
  // would describe the host's own outward connection, which is a different
  // question (and the same circularity LOCAL_ONLY exists to avoid).
  const world = await backend()
  if (world.kind === 'http') {
    return {
      connected: true,
      address: globalThis.location?.host ?? '',
      host: world.host,
      folders: world.folders,
      items: world.items,
      lastAddress: '',
      hasPassphrase: false,
    }
  }
  if (!isTauri()) return NOT_CONNECTED
  return remember(remoteStatusSchema.parse(await invoke('remote_status')))
}

/**
 * Point the whole app at another machine's library.
 *
 * Everything follows: folders, grid, lightbox, ratings, deletions. Pass an
 * empty passphrase to use the remembered one, which is what makes reconnecting
 * a single click.
 *
 * Rejects with the reason when the address is not on this network, the machine
 * is not sharing, or the passphrase is wrong — all three are things to show in
 * the dialog rather than swallow.
 */
export async function remoteConnect(address: string, passphrase: string): Promise<RemoteStatus> {
  if (!isTauri()) return NOT_CONNECTED
  return remember(
    remoteStatusSchema.parse(await invoke('remote_connect', { address, passphrase })),
  )
}

export async function remoteDisconnect(): Promise<RemoteStatus> {
  // Disconnecting a host session means ending it: expire the cookie. The
  // caller reloads, which lands on the passphrase screen.
  if (isHttpSession()) {
    await httpLogout()
    return NOT_CONNECTED
  }
  if (!isTauri()) return NOT_CONNECTED
  return remember(remoteStatusSchema.parse(await invoke('remote_disconnect')))
}

export async function shareStatus(): Promise<ShareStatus> {
  if (!isTauri()) return NOT_SHARING
  return shareStatusSchema.parse(await invoke('share_status'))
}

/**
 * Start or stop answering for other machines on this network.
 *
 * A passphrase is required to start, and it is the only thing between the LAN
 * and a library a session can delete from. `null` reuses the stored one, so
 * switching sharing back on does not ask again; a new value replaces it, and
 * the other machine then has to be told.
 */
export async function setShare(enabled: boolean, passphrase: string | null): Promise<ShareStatus> {
  if (!isTauri()) return NOT_SHARING
  return shareStatusSchema.parse(await invoke('set_share', { enabled, passphrase }))
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

export async function listExclusions(): Promise<string[]> {
  if (!(await hasBackend())) return []
  return z.array(z.string()).parse(await invoke('list_exclusions'))
}

/**
 * Stop scanning a folder and drop what it already contributed.
 *
 * Returns how many rows were removed. Files on disk are never touched.
 */
export async function excludeFolder(path: string): Promise<number> {
  if (!(await hasBackend())) return 0
  return z.number().parse(await invoke('exclude_folder', { path }))
}

export async function includeFolder(path: string): Promise<void> {
  if (!(await hasBackend())) return
  await invoke('include_folder', { path })
}

export async function libraryStats(): Promise<LibraryStats> {
  if (!(await hasBackend())) {
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
  if (!(await hasBackend())) return 0
  return z.number().parse(await invoke('retry_failed', { folderId }))
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function scanProgress(): Promise<ScanProgress> {
  if (!(await hasBackend())) {
    return { phase: 'idle', folderId: null, done: 0, total: 0, current: null, errors: [] }
  }
  return scanProgressSchema.parse(await invoke('scan_progress'))
}

export async function processPending(): Promise<void> {
  if (!(await hasBackend())) return
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
  if (!(await hasBackend())) {
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
  if (!(await hasBackend())) return
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
