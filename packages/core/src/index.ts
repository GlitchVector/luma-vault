/**
 * @luma/core — the pure domain.
 *
 * No I/O, no framework, no DOM (the package tsconfig omits the DOM lib so an
 * accidental `window`/`fetch` reference fails to typecheck). Everything here is
 * a value in, a value out, which is why the classification rules can be pinned
 * by fast unit tests instead of an end-to-end scan.
 */

export {
  NUDENET_LABELS,
  ANIME_LABELS,
  LABEL_WEIGHTS,
  LABEL_TITLES,
  isRatedLabel,
  weightOf,
  titleOf,
} from './labels.ts'
export type { NudeNetLabel, AnimeLabel, RatedLabel, LabelWeight } from './labels.ts'

export {
  DEFAULT_CLASSIFY_OPTIONS,
  rateFrame,
  rollUpVideo,
  fromSingleFrame,
  ratingAtLeast,
  maxRating,
} from './classify.ts'
export type { ClassifyOptions } from './classify.ts'

export { DEFAULT_SAMPLING, planFrameTimestamps } from './sampling.ts'
export type { SamplingOptions } from './sampling.ts'

export {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  extensionOf,
  basenameOf,
  dirnameOf,
  displayPath,
  hasRecycleBin,
  toParameterBlock,
  kindOf,
  isAnimatedImage,
  fitWithin,
  formatBytes,
  formatDuration,
} from './media.ts'

export {
  migrateGeneration,
  type Architecture,
  type Migration,
  type MigrationTarget,
} from './migrate.ts'

export { highlight, excerpt, searchTerms, type HighlightPart } from './highlight.ts'

export {
  detectionSchema,
  ratingSchema,
  frameVerdictSchema,
  mediaVerdictSchema,
  mediaKindSchema,
  folderSchema,
  generationSchema,
  mediaItemSchema,
  mediaFrameSchema,
  jobPhaseSchema,
  scanProgressSchema,
  libraryStatsSchema,
  importSummarySchema,
  duplicateReportSchema,
  throttleLevelSchema,
  sortOrderSchema,
  mediaQuerySchema,
  mediaPageSchema,
} from './schemas.ts'
export type {
  Detection,
  Rating,
  FrameVerdict,
  MediaVerdict,
  MediaKind,
  Folder,
  Generation,
  ImportSummary,
  DuplicateReport,
  ThrottleLevel,
  MediaItem,
  MediaFrame,
  JobPhase,
  ScanProgress,
  LibraryStats,
  SortOrder,
  MediaQuery,
  MediaPage,
} from './schemas.ts'
