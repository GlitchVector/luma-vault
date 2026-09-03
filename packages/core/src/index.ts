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
  effectiveRating,
  ratingIsSexy,
} from './classify.ts'
export type { ClassifyOptions } from './classify.ts'

export { rangeBetween, toggleSelected, retainVisible } from './selection.ts'

export { DEFAULT_SAMPLING, planFrameTimestamps } from './sampling.ts'
export type { SamplingOptions } from './sampling.ts'

export {
  MAX_SCALE,
  fitScale,
  fitView,
  clampView,
  zoomAbout,
  isOverPicture,
  isZoomed,
} from './zoom.ts'
export type { View, Point, Size } from './zoom.ts'

export {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  extensionOf,
  basenameOf,
  ancestorsOf,
  dirnameOf,
  displayPath,
  folderMatch,
  hasRecycleBin,
  toParameterBlock,
  kindOf,
  isAnimatedImage,
  isGif,
  FOUR_K_EDGE,
  isFourK,
  fitWithin,
  fitInside,
  formatBytes,
  formatDuration,
} from './media.ts'

export {
  migrateGeneration,
  type Architecture,
  type Migration,
  type MigrationTarget,
} from './migrate.ts'

export {
  SAME_PICTURE,
  MAX_HASH_DISTANCE,
  MAX_COLOUR_DISTANCE,
  MAX_HOPS,
  hashDistance,
  colourDistance,
  walkToOrigin,
  type Origin,
  type OriginCandidate,
} from './origin.ts'

export { highlight, excerpt, searchTerms, type HighlightPart } from './highlight.ts'

export {
  WEEK_MS,
  fillWeeks,
  trimIslands,
  mergeWeeks,
  overlayCounts,
  weekRange,
  selectionRange,
  selectionFromRange,
  barAt,
  dragEdge,
  moveSelection,
  barHeights,
  type BarSelection,
  type TimelineBar,
} from './timeline.ts'

export {
  DISPLAY_ORIGINAL,
  DISPLAY_RESOLUTIONS,
  MAX_TAGS,
  MAX_TITLE,
  POSE_TAGS,
  describeForDeviantArt,
  galleriesForItem,
  poseFromLabel,
  poseOf,
  promptSubjects,
  toTag,
} from './publish.ts'
export type {
  DeviantArtDraft,
  DisplayResolution,
  DraftOptions,
  MatureClassification,
  MatureLevel,
  Pose,
} from './publish.ts'

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
  timelineBucketSchema,
  characterCountSchema,
  setSummarySchema,
  matureLevelSchema,
  matureClassificationSchema,
  deviantArtDraftSchema,
  deviantArtGallerySchema,
  deviantArtAccountSchema,
  deviantArtResultSchema,
  deviantArtSummarySchema,
  remoteStatusSchema,
  shareStatusSchema,
  sourceOriginSchema,
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
  TimelineBucket,
  CharacterCount,
  SetSummary,
  DeviantArtAccount,
  DeviantArtGallery,
  DeviantArtResult,
  DeviantArtSummary,
  RemoteStatus,
  ShareStatus,
  SourceOrigin,
} from './schemas.ts'
