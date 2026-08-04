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
/**
 * What a file says about how it was made.
 *
 * Every field is a string, including the numeric ones, and every field is
 * optional. These are claims copied out of a file rather than values this app
 * computed — `Steps: 28`, `Steps: 28.0` and a truncated `Steps: 2` all occur on
 * disk, and coercing them to numbers here would mean choosing between dropping
 * a record and inventing a value for it.
 */
export const generationSchema = z.object({
  /** The tool that wrote the metadata — "Stable Diffusion", "ComfyUI", … */
  tool: z.string(),
  prompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  model: z.string().optional(),
  seed: z.string().optional(),
  sampler: z.string().optional(),
  steps: z.string().optional(),
  cfgScale: z.string().optional(),
  /**
   * Made from another picture, so these parameters alone cannot reproduce it.
   *
   * An img2img or inpaint result depends on a source image that no parameter
   * block carries. Sending it to txt2img yields a different picture with the
   * same description — which looks like success, so the UI has to say so.
   */
  needsSourceImage: z.boolean().default(false),
})
export type Generation = z.infer<typeof generationSchema>

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
  /**
   * A person's 1-5 judgement, never a model's.
   *
   * Deliberately separate from `verdict.rating`: one says "I like this", the
   * other says "this is explicit". A re-classify rewrites the second and must
   * never touch the first.
   */
  stars: z.number().nullable(),
  generation: generationSchema.nullable(),
  /**
   * Which set of duplicates this row belongs to, or `null` for none.
   *
   * Shared by every member of a set and numbered from its lowest member, so it
   * is stable between searches — the grid can group on it without the
   * arrangement reshuffling under someone half way through reviewing it.
   */
  dupeGroup: z.number().nullable(),
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
  /** Fingerprinting each image so duplicates can be found. */
  'hashing',
  /** Working out what kind of picture each row is — a scan, a generated image. */
  'labelling',
  /**
   * The anime tagger re-examining what NudeNet rated SFW.
   *
   * Runs after everything else and only ever raises a rating, so a library in
   * this phase is already fully rated — the bar is showing an improvement in
   * progress, not work the grid is waiting on.
   */
  'tagging',
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

/**
 * How much of the machine background work may use.
 *
 * A share of the *whole* machine, comparable to what a task manager shows, and
 * an average over seconds rather than an instantaneous ceiling.
 */
export const throttleLevelSchema = z.enum([
  /** Everything available. */
  'off',
  /** ~25%: the desktop stays responsive and a big scan still finishes in hours. */
  'background',
  /** ~5%: for when the machine is busy with something that matters more. */
  'idle',
])
export type ThrottleLevel = z.infer<typeof throttleLevelSchema>

/** What a duplicate search turned up. */
export const duplicateReportSchema = z.object({
  /** Sets of two or more files that are the same picture. */
  groups: z.number(),
  /** How many files are in those sets altogether. */
  files: z.number(),
  imageGroups: z.number(),
  videoGroups: z.number(),
  /** Images that had a perceptual hash to compare. */
  hashed: z.number(),
  /**
   * Rows skipped for sharing a hash with hundreds of others — blank frames and
   * flat colours, which are not duplicates of each other but pictures of
   * nothing. Reported so the cap is never mistaken for "none found".
   */
  skippedCommon: z.number(),
})
export type DuplicateReport = z.infer<typeof duplicateReportSchema>

/** What an Image Browser import did. See `importImageBrowserDb`. */
export const importSummarySchema = z.object({
  /** Usable 1-5 ratings found in the source database. */
  found: z.number(),
  /** Of those, how many had a path that could be reduced to a match key. */
  staged: z.number(),
  /** Rows in this library that gained a rating immediately. The rest attach
   *  later, as the folders they name are scanned. */
  applied: z.number(),
  /** Ratings whose path had no recognisable `outputs` segment. */
  unrecognised: z.number(),
})
export type ImportSummary = z.infer<typeof importSummarySchema>

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

export const sortOrderSchema = z.enum(['recent', 'added', 'oldest', 'name', 'largest', 'random'])
export type SortOrder = z.infer<typeof sortOrderSchema>

export const mediaQuerySchema = z.object({
  /** Null means "every watched folder in one view", which is the default. */
  folderId: z.number().nullable().default(null),
  kind: mediaKindSchema.nullable().default(null),
  rating: ratingSchema.nullable().default(null),
  sexyOnly: z.boolean().default(false),
  search: z.string().default(''),
  /** Show only items carrying this structural tag. */
  tag: z.string().nullable().default(null),
  /** Show only items rated at least this many stars. `1` means "rated at all". */
  minStars: z.number().nullable().default(null),
  /**
   * Show only files that have at least one duplicate.
   *
   * Overrides `sort`: copies of one picture have to sit next to each other or
   * the view is pointless.
   */
  duplicatesOnly: z.boolean().default(false),
  /**
   * Hide items carrying any of these.
   *
   * Separate from `tag` rather than one signed list, because "show me the
   * documents" and "never show me documents" are both wanted and the second is
   * why this exists.
   */
  hideTags: z.array(z.string()).default([]),
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
