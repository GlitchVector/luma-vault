/**
 * `.state.json`, written next to each set.
 *
 * A run that dies at 90% of a 400MB video must resume, not restart. That is
 * cheap to build in and genuinely annoying to retrofit, so it is here from the
 * first commit even though nothing uploads anything yet.
 *
 * The file records *what already exists on Patreon's side*: media ids, the
 * draft post id, how far each media got. It is a cache of remote facts, so a
 * corrupt or stale one is never fatal — it is discarded and the run starts over.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ResolvedMedia, ResolvedPost } from './manifest.ts'

/**
 * How far one file got.
 *
 * `uploaded` and `ready` are separate on purpose: a video is uploaded long
 * before it is usable, because Patreon transcodes it. Attaching at `uploaded`
 * is the bug this state machine exists to make unrepresentable.
 */
export type MediaPhase = 'created' | 'uploaded' | 'ready'

const mediaStateSchema = z.object({
  id: z.string(),
  phase: z.enum(['created', 'uploaded', 'ready']),
  /** Identity of the local file at the time it was uploaded. See `ResolvedMedia.modifiedMs`. */
  bytes: z.number(),
  modifiedMs: z.number(),
  /** Where the bytes go. Presigned, so it expires; a resume re-creates the media if it has. */
  uploadUrl: z.string().optional(),
  uploadFields: z.record(z.string(), z.string()).optional(),
})

const stateSchema = z.object({
  version: z.literal(1),
  postId: z.string().optional(),
  /** Keyed by the name as written in the manifest. */
  media: z.record(z.string(), mediaStateSchema),
  updatedAt: z.string(),
})

export type MediaState = z.infer<typeof mediaStateSchema>
export type RunState = z.infer<typeof stateSchema>

export function statePath(post: ResolvedPost): string {
  return resolve(post.dir, '.state.json')
}

export function emptyState(): RunState {
  return { version: 1, media: {}, updatedAt: new Date().toISOString() }
}

/** Never throws. An unreadable or outdated state file just means "start over". */
export async function loadState(post: ResolvedPost): Promise<RunState> {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(statePath(post), 'utf8')))
    return parsed.success ? parsed.data : emptyState()
  } catch {
    return emptyState()
  }
}

/**
 * Write via a temp file and rename, because the alternative is a truncated
 * `.state.json` when a run is cancelled mid-write — which loses the ids of
 * everything already uploaded, the exact thing this file exists to protect.
 */
export async function saveState(post: ResolvedPost, state: RunState): Promise<void> {
  const path = statePath(post)
  const temp = `${path}.tmp`
  const next = { ...state, updatedAt: new Date().toISOString() }
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/**
 * Whether a recorded upload still describes the file on disk.
 *
 * Size *and* mtime: a re-render that happens to land on the same byte count is
 * not the same picture, and shipping the previous one to patrons is a failure
 * nobody would catch before it was public.
 */
export function isCurrent(recorded: MediaState | undefined, file: ResolvedMedia): recorded is MediaState {
  return recorded !== undefined && recorded.bytes === file.bytes && recorded.modifiedMs === file.modifiedMs
}

/** Drop entries for files the manifest no longer lists, so a shrinking set does not keep stale ids alive. */
export function pruneState(state: RunState, post: ResolvedPost): RunState {
  const live = new Set(post.media.map((file) => file.name))
  const media: Record<string, MediaState> = {}
  for (const [name, entry] of Object.entries(state.media)) {
    if (live.has(name)) media[name] = entry
  }
  return { ...state, media }
}
