import { z } from 'zod'

/**
 * The wire format between the Rust backend and the web frontend.
 *
 * These schemas are the single source of truth: every TS type below is
 * `z.infer`'d from its schema, and every value crossing the FFI boundary is
 * `parse`d rather than cast, so a shape mismatch throws at the boundary where
 * it happens instead of surfacing as a confusing error three layers up.
 *
 * Every schema here has a matching golden fixture in `/contracts`, exercised by
 * a round-trip test on BOTH sides (serde in Rust, zod here). Adding a field to
 * a struct without updating the fixture fails both test suites.
 */

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

/**
 * One detected region.
 *
 * `box` is `[x, y, width, height]` as **fractions of the classified image**,
 * not pixels. Normalising in Rust at store time means the UI multiplies by
 * whatever size it happens to render the tile at, and nothing has to remember
 * which pixel space the boxes were computed in. (The previous generation of
 * this app stored 320px-space boxes, rendered tiles at 640px, and carried a
 * `ratio` field through three components to reconcile them.)
 */
export const detectionSchema = z.object({
  label: z.string(),
  score: z.number(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
})
export type Detection = z.infer<typeof detectionSchema>

export const ratingSchema = z.enum(['unrated', 'sfw', 'suggestive', 'explicit'])
export type Rating = z.infer<typeof ratingSchema>

/** The verdict for a single still — an image, or one sampled video frame. */
export const frameVerdictSchema = z.object({
  person: z.boolean(),
  sexy: z.boolean(),
  nude: z.boolean(),
  rating: ratingSchema,
  topLabel: z.string().nullable(),
  topLabelTitle: z.string().nullable(),
  topScore: z.number(),
  detections: z.array(detectionSchema),
})
export type FrameVerdict = z.infer<typeof frameVerdictSchema>

/** The verdict for a whole media item, after rolling its frames up. */
export const mediaVerdictSchema = z.object({
  person: z.boolean(),
  sexy: z.boolean(),
  nude: z.boolean(),
  rating: ratingSchema,
  topLabel: z.string().nullable(),
  topLabelTitle: z.string().nullable(),
  topScore: z.number(),
  frameCount: z.number(),
  sexyFrameCount: z.number(),
  posterFrameIndex: z.number().nullable(),
})
export type MediaVerdict = z.infer<typeof mediaVerdictSchema>

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export const mediaKindSchema = z.enum(['image', 'video'])
export type MediaKind = z.infer<typeof mediaKindSchema>

export const folderSchema = z.object({
  id: z.number(),
  path: z.string(),
  addedAt: z.number(),
  lastScanAt: z.number().nullable(),
  /** False while a folder is being removed, or when its drive is unmounted. */
  available: z.boolean(),
  mediaCount: z.number(),
})
export type Folder = z.infer<typeof folderSchema>

/**
 * One row of the grid.
 *
 * Carries everything a tile needs to lay itself out and render — crucially
 * `thumbWidth`/`thumbHeight`, so the grid can size every tile before a single
 * image byte is fetched. That is what makes the wall lay out in one pass with
 * zero reflow, and it is the reason this grid does not need virtualization.
 */
export const mediaItemSchema = z.object({
  id: z.number(),
  folderId: z.number(),
  path: z.string(),
  name: z.string(),
  kind: mediaKindSchema,
  width: z.number(),
  height: z.number(),
  sizeBytes: z.number(),
  /** File mtime, unix ms. The sort key for "recent files". */
  modifiedAt: z.number(),
  /** When the scanner first indexed it, unix ms. */
  addedAt: z.number(),
  /** Absolute path of the generated thumbnail; for a video, its poster frame. */
  thumbPath: z.string().nullable(),
  thumbWidth: z.number().nullable(),
  thumbHeight: z.number().nullable(),
  /** Video only. */
  durationSec: z.number().nullable(),
  verdict: mediaVerdictSchema.nullable(),
  classifiedAt: z.number().nullable(),
})
export type MediaItem = z.infer<typeof mediaItemSchema>

/** A sampled video frame, kept so the detail view can show what was found where. */
export const mediaFrameSchema = z.object({
  id: z.number(),
  mediaId: z.number(),
  frameIndex: z.number(),
  timestampSec: z.number(),
  path: z.string(),
  verdict: frameVerdictSchema,
})
export type MediaFrame = z.infer<typeof mediaFrameSchema>

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const jobPhaseSchema = z.enum([
  'idle',
  'globbing',
  /** Reading each file's dimensions so the grid can size tiles before it can paint them. */
  'measuring',
  'thumbnailing',
  'classifying',
  'done',
])
export type JobPhase = z.infer<typeof jobPhaseSchema>

/**
 * Progress for the background pipeline, emitted on the `luma://progress` event.
 *
 * One event shape for all three phases rather than three shapes, so the status
 * bar is a single component and a new phase costs nothing on the frontend.
 */
export const scanProgressSchema = z.object({
  phase: jobPhaseSchema,
  folderId: z.number().nullable(),
  /** Items finished in the current phase. */
  done: z.number(),
  /** Items known to be in the current phase. Grows while globbing. */
  total: z.number(),
  /** Path of the item most recently finished, for the "…now processing" line. */
  current: z.string().nullable(),
  /** Non-fatal per-item failures. A bad file never aborts a scan. */
  errors: z.array(z.string()),
})
export type ScanProgress = z.infer<typeof scanProgressSchema>

export const libraryStatsSchema = z.object({
  folders: z.number(),
  images: z.number(),
  videos: z.number(),
  classified: z.number(),
  pending: z.number(),
  sexy: z.number(),
  /** Files the pipeline gave up on, with a reason recorded on the row. */
  failed: z.number(),
})
export type LibraryStats = z.infer<typeof libraryStatsSchema>

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const sortOrderSchema = z.enum(['recent', 'oldest', 'name', 'largest', 'random'])
export type SortOrder = z.infer<typeof sortOrderSchema>

export const mediaQuerySchema = z.object({
  /** Null means "every watched folder in one view", which is the default. */
  folderId: z.number().nullable().default(null),
  kind: mediaKindSchema.nullable().default(null),
  rating: ratingSchema.nullable().default(null),
  sexyOnly: z.boolean().default(false),
  search: z.string().default(''),
  sort: sortOrderSchema.default('recent'),
  limit: z.number().int().positive().max(5000).default(500),
  offset: z.number().int().nonnegative().default(0),
})
export type MediaQuery = z.infer<typeof mediaQuerySchema>

export const mediaPageSchema = z.object({
  items: z.array(mediaItemSchema),
  total: z.number(),
  offset: z.number(),
})
export type MediaPage = z.infer<typeof mediaPageSchema>
