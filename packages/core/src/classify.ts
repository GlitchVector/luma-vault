import { ratesOnPresence, titleOf, weightOf } from './labels.ts'
import type { Detection, FrameVerdict, MediaVerdict, Rating } from './schemas.ts'

/**
 * Thresholds applied on top of the detector's own NMS (which already drops
 * anything under score 0.25). Raising these makes the vault more conservative
 * about calling something sexy; it never makes it call something *less* than
 * what a higher-confidence detection would.
 */
export interface ClassifyOptions {
  /** A `suggestive` label at or above this score sets `sexy`. */
  suggestiveMinScore: number
  /** An `explicit` label at or above this score sets `nude` (and `sexy`). */
  explicitMinScore: number
  /** Any label at or above this score sets `person`. */
  personMinScore: number
}

export const DEFAULT_CLASSIFY_OPTIONS: ClassifyOptions = {
  // 0.4 for the suggestive band only — see the note on the Rust side, which
  // carries the measurement. Explicit stays at 0.5.
  suggestiveMinScore: 0.4,
  explicitMinScore: 0.5,
  personMinScore: 0.35,
}

const RATING_ORDER: Record<Rating, number> = {
  unrated: 0,
  sfw: 1,
  suggestive: 2,
  explicit: 3,
}

/** True when `a` is at least as severe as `b`. */
export function ratingAtLeast(a: Rating, b: Rating): boolean {
  return RATING_ORDER[a] >= RATING_ORDER[b]
}

/** The more severe of two ratings. */
export function maxRating(a: Rating, b: Rating): Rating {
  return RATING_ORDER[a] >= RATING_ORDER[b] ? a : b
}

/**
 * What a row is actually rated: the person's correction if there is one, the
 * model's verdict otherwise.
 *
 * The **only** place the two are resolved, and everything that draws, filters
 * or uploads goes through it. Reading `verdict.rating` directly is the bug this
 * exists to prevent — it is the model's opinion, which a correction is
 * precisely a statement about being wrong, and a tile that colours from one
 * while the grid filters on the other is a picture that is explicit in the
 * corner and safe in the results.
 *
 * `unrated` for a row nothing has looked at yet, which is also what a row with
 * no verdict and no correction reports.
 */
export function effectiveRating(item: {
  verdict: { rating: Rating } | null
  ratingOverride: Rating | null
}): Rating {
  return item.ratingOverride ?? item.verdict?.rating ?? 'unrated'
}

/**
 * Whether a row counts as sexy under its effective rating.
 *
 * The same rule the frame verdict uses — anything the rules called suggestive
 * or explicit is sexy — restated here so a correction lands on the `sexyOnly`
 * filter as well as the badge. The index stores this alongside the rating; this
 * is what it stores.
 */
export function ratingIsSexy(rating: Rating): boolean {
  return rating === 'suggestive' || rating === 'explicit'
}

/**
 * Collapse one frame's raw detections into a verdict.
 *
 * Order-independent by construction: every detection is folded into a max, so
 * the detector may return boxes in any order (and it does — NMS output order is
 * not stable) without changing the result.
 */
export function rateFrame(
  detections: readonly Detection[],
  options: ClassifyOptions = DEFAULT_CLASSIFY_OPTIONS,
): FrameVerdict {
  let person = false
  let sexy = false
  let nude = false
  let topLabel: string | null = null
  let topScore = 0

  for (const detection of detections) {
    const weight = weightOf(detection.label)

    if (detection.score >= options.personMinScore) person = true

    const rated =
      (weight === 'explicit' &&
        (ratesOnPresence(detection.label) || detection.score >= options.explicitMinScore)) ||
      (weight === 'suggestive' &&
        (ratesOnPresence(detection.label) || detection.score >= options.suggestiveMinScore))

    if (!rated) continue

    sexy = true
    if (weight === 'explicit') nude = true

    // The "top" part is the highest-scoring *rated* detection, so a 0.99 face
    // never wins over a 0.6 exposure. That is what makes it a useful caption.
    if (detection.score > topScore) {
      topScore = detection.score
      topLabel = detection.label
    }
  }

  const rating: Rating = nude ? 'explicit' : sexy ? 'suggestive' : 'sfw'

  return {
    person,
    sexy,
    nude,
    rating,
    topLabel,
    topLabelTitle: topLabel === null ? null : titleOf(topLabel),
    topScore,
    detections: sortDetections(detections),
  }
}

/**
 * Highest score first, label then box as tiebreaks.
 *
 * The detector's NMS output order is not stable, and this array is persisted as
 * JSON in the media row — so without a total order, re-classifying an unchanged
 * file produces a different blob and every row looks dirty. A total order also
 * makes `rateFrame` genuinely order-independent, which is the property the
 * tests pin.
 */
function sortDetections(detections: readonly Detection[]): Detection[] {
  return [...detections].sort(
    (a, b) =>
      b.score - a.score ||
      a.label.localeCompare(b.label) ||
      a.box[0] - b.box[0] ||
      a.box[1] - b.box[1],
  )
}

/**
 * Roll a video's per-frame verdicts up into a single verdict for the video.
 *
 * The product rule, stated once: **if any sampled frame is sexy, the whole
 * video is sexy.** That is intentionally a max and not a vote — a single
 * explicit frame in an hour of footage still makes the video explicit, because
 * the point of the flag is "can this be on screen", not "how much of it".
 *
 * `posterFrameIndex` follows from the same rule: the *first* sexy frame if
 * there is one (so the tile shows what earned the flag), otherwise the middle
 * frame (so an SFW video still gets a representative tile rather than a black
 * opening frame).
 */
export function rollUpVideo(frames: readonly FrameVerdict[]): MediaVerdict {
  if (frames.length === 0) {
    return {
      person: false,
      sexy: false,
      nude: false,
      rating: 'unrated',
      topLabel: null,
      topLabelTitle: null,
      topScore: 0,
      frameCount: 0,
      sexyFrameCount: 0,
      posterFrameIndex: null,
    }
  }

  let person = false
  let sexy = false
  let nude = false
  let rating: Rating = 'sfw'
  let topLabel: string | null = null
  let topScore = 0
  let sexyFrameCount = 0
  let firstSexyIndex: number | null = null

  frames.forEach((frame, index) => {
    person ||= frame.person
    sexy ||= frame.sexy
    nude ||= frame.nude
    rating = maxRating(rating, frame.rating)

    if (frame.sexy) {
      sexyFrameCount += 1
      if (firstSexyIndex === null) firstSexyIndex = index
    }

    if (frame.topLabel !== null && frame.topScore > topScore) {
      topScore = frame.topScore
      topLabel = frame.topLabel
    }
  })

  const posterFrameIndex = firstSexyIndex ?? Math.floor(frames.length / 2)

  return {
    person,
    sexy,
    nude,
    rating,
    topLabel,
    topLabelTitle: topLabel === null ? null : titleOf(topLabel),
    topScore,
    frameCount: frames.length,
    sexyFrameCount,
    posterFrameIndex,
  }
}

/** Promote a single image's frame verdict to a media verdict. */
export function fromSingleFrame(frame: FrameVerdict): MediaVerdict {
  return {
    person: frame.person,
    sexy: frame.sexy,
    nude: frame.nude,
    rating: frame.rating,
    topLabel: frame.topLabel,
    topLabelTitle: frame.topLabelTitle,
    topScore: frame.topScore,
    frameCount: 1,
    sexyFrameCount: frame.sexy ? 1 : 0,
    posterFrameIndex: 0,
  }
}
