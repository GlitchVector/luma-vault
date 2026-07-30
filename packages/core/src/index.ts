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
  LABEL_WEIGHTS,
  LABEL_TITLES,
  isNudeNetLabel,
  weightOf,
  titleOf,
} from './labels.ts'
export type { NudeNetLabel, LabelWeight } from './labels.ts'

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
  kindOf,
  isAnimatedImage,
  fitWithin,
  formatBytes,
  formatDuration,
} from './media.ts'

export {
  detectionSchema,
  ratingSchema,
  frameVerdictSchema,
  mediaVerdictSchema,
  mediaKindSchema,
  folderSchema,
  mediaItemSchema,
  mediaFrameSchema,
  jobPhaseSchema,
  scanProgressSchema,
  libraryStatsSchema,
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
  MediaItem,
  MediaFrame,
  JobPhase,
  ScanProgress,
  LibraryStats,
  SortOrder,
  MediaQuery,
  MediaPage,
} from './schemas.ts'
