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
  /** Ran through the Extras tab — an upscale of an existing image. */
  postprocessed: z.boolean().default(false),
  /**
   * The characters this prompt names, in danbooru's `name (series)` form.
   *
   * Detected on the Rust side and *carried*, never re-derived here. The rule is
   * a dictionary of thousands of names plus a set of conventions about
   * emphasis, weights and escaped parentheses — a second copy of it in this
   * language would be a second copy of a rule, which is the thing the shared
   * vectors exist to prevent. Reading the answer keeps one copy.
   *
   * Defaulted rather than required, so a row written by an older build parses.
   */
  characters: z.array(z.string()).default([]),
})
export type Generation = z.infer<typeof generationSchema>

/**
 * A picture's existing DeviantArt submission.
 *
 * Recorded at *staging*, before the publish is attempted — the file is on their
 * servers either way, which is already enough to stop it going up twice.
 */
export const deviantArtPostSchema = z.object({
  /**
   * The deviation page.
   *
   * Null while it is only staged in Sta.sh, and on rows marked by hand — which
   * know the picture is up but not where, and say so by having no link.
   */
  url: z.string().nullable().default(null),
  /** Posted publicly, as against staged and waiting in Studio. */
  published: z.boolean(),
  /** Unix ms. */
  postedAt: z.number(),
})
export type DeviantArtPost = z.infer<typeof deviantArtPostSchema>

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
  /**
   * The picture this row is an upscaled variant of, by path.
   *
   * Non-null only on a variant. The grid never shows what this names — the
   * variant stands in for it — so this doubles as the only route back to the
   * original, which the lightbox footer offers.
   */
  upscaledFrom: z.string().nullable().default(null),
  /**
   * The variant made from this row, when one exists.
   *
   * The other end of `upscaledFrom`. Non-null only on an original that has
   * been upscaled — which the grid is hiding, so in practice this is only
   * ever seen in the lightbox, where it is the way back to the variant.
   */
  upscaledTo: z.string().nullable().default(null),
  /**
   * Where this picture already is on DeviantArt, when it is.
   *
   * The one field on a row that is a fact about somewhere else. Carried rather
   * than fetched because "have I posted this?" is asked while scrolling past a
   * hundred tiles — a per-tile network answer would not be an answer.
   */
  deviantArt: deviantArtPostSchema.nullable().default(null),
  /**
   * A person's correction of the model's rating, or `null` to trust the model.
   *
   * The detector is wrong often enough that living with it is not an option —
   * a bare shoulder reads as `FEMALE_BREAST_EXPOSED` at 0.4 and the picture is
   * filed as explicit forever. This is the override, and it is a *separate
   * field* for the same reason {@link MediaItem.stars} is: the pipeline
   * rewrites a verdict whenever the rules change, and a correction stored in
   * the verdict would be silently undone by the next threshold tweak.
   *
   * `verdict.rating` therefore stays whatever the model said, always. Read
   * {@link effectiveRating} rather than either field alone — it is the one
   * place that resolves the two, so nothing can filter by one and draw the
   * other.
   */
  ratingOverride: ratingSchema.nullable().default(null),
})
export type MediaItem = z.infer<typeof mediaItemSchema>

/**
 * What an img2img was made from.
 *
 * An img2img keeps its subject in an init image that no parameter block
 * records — so a prompt of twelve words about a face can belong to a picture of
 * a named character in a black dress, and the dress is nowhere in the text. In
 * a library built by generating from its own output that init image is usually
 * still here, and can be recognised by perceptual hash even though it can never
 * be named. The rule lives in `origin.ts` and, mirrored, in
 * `apps/desktop/src/origin.rs`.
 */
export const sourceOriginSchema = z.object({
  /** The furthest ancestor the trail reached. */
  item: mediaItemSchema,
  /** How many img2img passes back it was found. Never zero. */
  hops: z.number(),
  /**
   * Whether that ancestor is where the lineage started, or merely where the
   * trail went cold.
   *
   * Measured on a real library: 28% of img2img rows walk to a genuine txt2img
   * root, 40% stop on another img2img that has no findable source of its own.
   * The second is still worth showing — its prompt may well name the character
   * — but presenting it as the original would be a claim the data does not
   * support.
   */
  reachedRoot: z.boolean(),
  /**
   * The widest hop in the chain, in bits.
   *
   * Confidence is set by the worst step, not the first: six tight hops and one
   * loose one is only as trustworthy as the loose one.
   */
  weakestHop: z.number(),
})
export type SourceOrigin = z.infer<typeof sourceOriginSchema>

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
  /**
   * Run `search` against the folder path instead of the filename and prompt.
   *
   * A mode on the one field rather than a second box. The question is the same
   * — *where does this word appear* — and two boxes would mean choosing which
   * one holds the answer before knowing it. It is also why the term is not
   * matched against *both*: a library organised into `\aqua\`, `\moona\` folders
   * has the character's name in the path of every file and in the prompt of
   * most of them, so an either-way match answers "the folder" with the whole
   * library and the toggle would do nothing visible.
   *
   * The path here is the directory only — the filename is what the default
   * mode already searches, and a term matching it in both modes would make the
   * toggle look broken on exactly the searches people try first.
   */
  searchPaths: z.boolean().default(false),
  /** Show only items carrying this structural tag. */
  tag: z.string().nullable().default(null),
  /** Show only items rated at least this many stars. `1` means "rated at all". */
  minStars: z.number().nullable().default(null),
  /**
   * Show only items nobody has starred yet — the triage queue.
   *
   * Not `minStars: 0`, which would mean "everything" under a filter whose whole
   * shape is *at least*. This is the opposite question, so it gets its own
   * field rather than a magic value in one that already means something.
   *
   * Contradicts `minStars` by construction: nothing is both unrated and rated
   * four or better. The bar keeps them from being on together rather than the
   * index arbitrating, in the same way the two star pills already replace each
   * other.
   */
  unstarred: z.boolean().default(false),
  /**
   * Filter by whether a stable diffusion prompt was recovered from the file.
   *
   * Three-valued: null is no filter, true is only-with, false is only-without.
   * Not the same axis as the `generated` tag — a re-saved JPEG can carry a
   * generator marker in EXIF while its parameter block did not survive, so
   * "generated" and "has a prompt" genuinely differ on real files.
   */
  hasPrompt: z.boolean().nullable().default(null),
  /**
   * Filter by whether the image was made from another image (img2img).
   *
   * Three-valued like `hasPrompt`. Derived from the parameter block at scan
   * time — see `needsSourceImage` on the generation — so it is a claim the
   * file makes about itself, not a guess.
   */
  img2img: z.boolean().nullable().default(null),
  /**
   * Filter by whether the image came out of the Extras tab. Three-valued like
   * `img2img`; the claim is the block's own `Postprocess` keys.
   */
  extras: z.boolean().nullable().default(null),
  /**
   * Only rows the detector found this label on.
   *
   * Every label found, not the one the verdict names: `topLabel` is picked by
   * rating weight, so labels carrying none — `FACE_FEMALE`, `FEET_COVERED`,
   * `FEET_EXPOSED` — can never appear there however many pictures show them.
   */
  label: z.string().nullable().default(null),
  /**
   * Only animated images (true), or only still ones (false).
   *
   * By extension, because `kind` cannot express it — a GIF and a PNG are both
   * `image`. "Everything except videos and GIFs" is this set to false *and*
   * `kind` set to image; they are two questions and stay separable.
   */
  animated: z.boolean().nullable().default(null),
  /** Only black-and-white rows (true), or only colour ones (false). */
  greyscale: z.boolean().nullable().default(null),
  /**
   * Show only items whose longest edge is at least this many pixels.
   *
   * A number rather than a `fourKOnly` flag because the rule *is* a number —
   * the 4K filter sends `FOUR_K_EDGE`, and the index applies the same
   * comparison the grid's badge does.
   */
  minLongestEdge: z.number().nullable().default(null),
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
  /**
   * Show only items modified inside `[modifiedAfter, modifiedBefore)`, unix ms.
   *
   * Half-open, so two adjacent week selections share a boundary without
   * double-counting the file that sits exactly on it. Independent nulls: a
   * timeline selection always sends both, but "everything since March" is a
   * reasonable query for something else to make.
   */
  modifiedAfter: z.number().nullable().default(null),
  modifiedBefore: z.number().nullable().default(null),
  sort: sortOrderSchema.default('recent'),
  limit: z.number().int().positive().max(5000).default(500),
  offset: z.number().int().nonnegative().default(0),
})
export type MediaQuery = z.infer<typeof mediaQuerySchema>

/**
 * One week of the library, for the timeline's bars.
 *
 * `start` is the Monday 00:00 UTC of the week, unix ms. Weeks with no items are
 * not sent — the frontend rebuilds the gaps from the range, and a library
 * spanning a decade would otherwise be five hundred rows of zero.
 */
export const timelineBucketSchema = z.object({
  start: z.number(),
  count: z.number(),
})
export type TimelineBucket = z.infer<typeof timelineBucketSchema>

/**
 * One row of the character leaderboard.
 *
 * `name` is danbooru's `name (series)` form, lowercase — which doubles as a
 * ready-made search term, because the prompt it was detected in contains it
 * verbatim and search runs over prompts.
 */
export const characterCountSchema = z.object({
  name: z.string(),
  count: z.number(),
})
export type CharacterCount = z.infer<typeof characterCountSchema>

export const mediaPageSchema = z.object({
  items: z.array(mediaItemSchema),
  total: z.number(),
  offset: z.number(),
})
export type MediaPage = z.infer<typeof mediaPageSchema>

// ---------------------------------------------------------------------------
// DeviantArt
// ---------------------------------------------------------------------------

export const matureLevelSchema = z.enum(['moderate', 'strict'])
export const matureClassificationSchema = z.enum([
  'nudity',
  'sexual',
  'gore',
  'language',
  'ideology',
])

/**
 * One submission, as a person approved it.
 *
 * Travels *into* Rust rather than out of it, which is the opposite direction to
 * everything else here — `publish.ts` derives it, the panel edits it, and the
 * backend uploads exactly what it is handed. That is deliberate: it means the
 * mapping from a verdict to a submission exists once, in one language.
 */
export const deviantArtDraftSchema = z.object({
  mediaId: z.number(),
  title: z.string(),
  /** `artist_comments` on the wire. */
  description: z.string(),
  tags: z.array(z.string()),
  isMature: z.boolean(),
  /** Null exactly when `isMature` is false — the API rejects one without the other. */
  matureLevel: matureLevelSchema.nullable(),
  matureClassification: z.array(matureClassificationSchema),
  isAiGenerated: z.boolean(),
  noai: z.boolean(),
  /**
   * `display_resolution`: how wide the deviation page draws the image, 0-8 with
   * 0 meaning original. Defaulted so an older payload still parses — and the
   * value it lands on is the one this app wants anyway.
   */
  displayResolution: z.number().int().min(0).max(8).default(0),
})
export type DeviantArtDraftWire = z.infer<typeof deviantArtDraftSchema>

export const deviantArtAccountSchema = z.object({
  /** A client id has been entered. Without one there is nothing to connect. */
  configured: z.boolean(),
  /** A refresh token is held. Says nothing about whether it still works. */
  connected: z.boolean(),
  username: z.string().nullable(),
  clientId: z.string().nullable(),
  /** Has to be pasted into the app's whitelist on DeviantArt *exactly*. */
  redirectUri: z.string(),
  /** What the last authorization granted, which need not be what was asked. */
  scopes: z.array(z.string()),
  /** Whether `publish` was among them. A new app may not be given it. */
  canPublish: z.boolean(),
})
export type DeviantArtAccount = z.infer<typeof deviantArtAccountSchema>

export const deviantArtResultSchema = z.object({
  mediaId: z.number(),
  title: z.string(),
  /** The Sta.sh item, once staged. Publishing needs it. */
  itemId: z.number().nullable(),
  /** The public deviation, once published. */
  url: z.string().nullable(),
  deviationId: z.string().nullable(),
  published: z.boolean(),
  error: z.string().nullable(),
})
export type DeviantArtResult = z.infer<typeof deviantArtResultSchema>

export const deviantArtSummarySchema = z.object({
  staged: z.number(),
  published: z.number(),
  failed: z.number(),
  results: z.array(deviantArtResultSchema),
})
export type DeviantArtSummary = z.infer<typeof deviantArtSummarySchema>

// ---------------------------------------------------------------------------
// Remote
// ---------------------------------------------------------------------------

export const remoteStatusSchema = z.object({
  connected: z.boolean(),
  /** `192.168.1.42:7870`, or empty when this is the machine's own library. */
  address: z.string(),
  /** The peer's hostname, empty when it did not report one. */
  host: z.string(),
  folders: z.number(),
  items: z.number(),
  /** Prefilled next time, so reconnecting is one click and not a memory test. */
  lastAddress: z.string(),
  /** A passphrase is remembered. Never the passphrase itself. */
  hasPassphrase: z.boolean(),
})
export type RemoteStatus = z.infer<typeof remoteStatusSchema>

export const shareStatusSchema = z.object({
  sharing: z.boolean(),
  port: z.number(),
  /** What to type on the other machine. Empty when it could not be worked out. */
  addresses: z.array(z.string()),
  hasPassphrase: z.boolean(),
})
export type ShareStatus = z.infer<typeof shareStatusSchema>
