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
  mediaPageSchema,
  scanProgressSchema,
  type Folder,
  type LibraryStats,
  type MediaFrame,
  type MediaItem,
  type MediaPage,
  type MediaQuery,
  type ScanProgress,
} from '@luma/core'
import { z } from 'zod'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(command, args)
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
  return `luma://localhost/?path=${encodeURIComponent(path)}`
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

/** Reveals a file in Finder / Explorer. */
export async function revealInFileManager(path: string): Promise<void> {
  if (!isTauri()) return
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
  await revealItemInDir(path)
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
})
export type Environment = z.infer<typeof environmentSchema>

export async function environment(): Promise<Environment> {
  if (!isTauri()) {
    return { classifierAvailable: false, ffmpegAvailable: false, busy: false }
  }
  return environmentSchema.parse(await invoke('environment'))
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
