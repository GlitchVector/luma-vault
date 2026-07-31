/**
 * The NudeNet 3.x detector label set, and the only place in the codebase that
 * decides what each label *means*.
 *
 * Deliberately keyed by the raw label string rather than by the model's class
 * index. An earlier implementation of this idea (corn-dog) remapped labels onto
 * a second numeric id space and then looked them up with `map[label] || -1`,
 * which silently turned id `0` into `-1` because `0` is falsy. Strings have no
 * falsy member, so that whole bug class is gone.
 */

/** Every label the bundled 320n.onnx detector can emit. */
export const NUDENET_LABELS = [
  'FEMALE_GENITALIA_COVERED',
  'FACE_FEMALE',
  'BUTTOCKS_EXPOSED',
  'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED',
  'MALE_BREAST_EXPOSED',
  'ANUS_EXPOSED',
  'FEET_EXPOSED',
  'BELLY_COVERED',
  'FEET_COVERED',
  'ARMPITS_COVERED',
  'ARMPITS_EXPOSED',
  'FACE_MALE',
  'BELLY_EXPOSED',
  'MALE_GENITALIA_EXPOSED',
  'ANUS_COVERED',
  'FEMALE_BREAST_COVERED',
  'BUTTOCKS_COVERED',
] as const

export type NudeNetLabel = (typeof NUDENET_LABELS)[number]

/**
 * Danbooru ratings from the anime tagger, which judges a whole picture rather
 * than locating anatomy in it.
 *
 * A separate list because they are not detector classes: NUDENET_LABELS mirrors
 * what the bundled model can emit and is checked against the worker's announced
 * set, so putting a judgement in it would make that check lie. `general` and
 * `sensitive` are not carried — see the note in classify_worker.py.
 */
export const ANIME_LABELS = ['ANIME_QUESTIONABLE', 'ANIME_EXPLICIT'] as const

export type AnimeLabel = (typeof ANIME_LABELS)[number]

/** Any label that can carry a weight, wherever it came from. */
export type RatedLabel = NudeNetLabel | AnimeLabel

/**
 * How much each label contributes to a verdict.
 *
 * - `explicit`  — primary genitalia/anus/breast exposure. Sets `nude` (and `sexy`).
 * - `suggestive` — partial exposure or covered intimate areas. Sets `sexy`.
 * - `neutral`   — anatomy that carries no rating on its own (faces, feet,
 *                 covered belly/armpits). Sets `person` only.
 *
 * A label is never in two buckets, so a verdict is a pure max over the buckets
 * present, which is what makes `rateFrame` order-independent.
 */
export type LabelWeight = 'explicit' | 'suggestive' | 'neutral'

export const LABEL_WEIGHTS: Record<RatedLabel, LabelWeight> = {
  FEMALE_GENITALIA_EXPOSED: 'explicit',
  MALE_GENITALIA_EXPOSED: 'explicit',
  ANUS_EXPOSED: 'explicit',
  FEMALE_BREAST_EXPOSED: 'explicit',
  // Danbooru's rating, from the anime tagger — whole-image, so threshold-gated
  // rather than presence-rated. Mirrors `weight_of` in rating.rs.
  ANIME_EXPLICIT: 'explicit',

  BUTTOCKS_EXPOSED: 'suggestive',
  BELLY_EXPOSED: 'suggestive',
  ARMPITS_EXPOSED: 'suggestive',
  MALE_BREAST_EXPOSED: 'suggestive',
  FEMALE_GENITALIA_COVERED: 'suggestive',
  FEMALE_BREAST_COVERED: 'suggestive',
  BUTTOCKS_COVERED: 'suggestive',
  ANUS_COVERED: 'suggestive',
  ANIME_QUESTIONABLE: 'suggestive',

  FACE_FEMALE: 'neutral',
  FACE_MALE: 'neutral',
  FEET_EXPOSED: 'neutral',
  FEET_COVERED: 'neutral',
  BELLY_COVERED: 'neutral',
  ARMPITS_COVERED: 'neutral',
}

/** Human-readable label, for tooltips and bounding-box captions. */
export const LABEL_TITLES: Record<RatedLabel, string> = {
  FEMALE_GENITALIA_COVERED: 'covered vagina',
  FEMALE_GENITALIA_EXPOSED: 'exposed vagina',
  MALE_GENITALIA_EXPOSED: 'exposed penis',
  ANUS_COVERED: 'covered anus',
  ANUS_EXPOSED: 'exposed anus',
  FEMALE_BREAST_COVERED: 'covered breast',
  FEMALE_BREAST_EXPOSED: 'exposed breast',
  MALE_BREAST_EXPOSED: 'exposed chest',
  BUTTOCKS_COVERED: 'covered buttocks',
  BUTTOCKS_EXPOSED: 'exposed buttocks',
  BELLY_COVERED: 'covered belly',
  BELLY_EXPOSED: 'exposed belly',
  ARMPITS_COVERED: 'covered armpits',
  ARMPITS_EXPOSED: 'exposed armpits',
  FEET_COVERED: 'covered feet',
  FEET_EXPOSED: 'exposed feet',
  FACE_FEMALE: 'female face',
  FACE_MALE: 'male face',
  ANIME_QUESTIONABLE: 'drawn, suggestive',
  ANIME_EXPLICIT: 'drawn, explicit',
}

const KNOWN = new Set<string>([...NUDENET_LABELS, ...ANIME_LABELS])

/** Narrows an arbitrary detector string to one this codebase has a weight for. */
export function isRatedLabel(value: string): value is RatedLabel {
  return KNOWN.has(value)
}

/**
 * Weight of an arbitrary detector string. An unrecognised label — a newer model
 * revision adding a class we do not know yet — counts as `neutral` rather than
 * throwing, so a model upgrade degrades to "person detected" instead of
 * failing the whole scan.
 */
export function weightOf(label: string): LabelWeight {
  return isRatedLabel(label) ? LABEL_WEIGHTS[label] : 'neutral'
}

/** Display title of an arbitrary detector string, falling back to the raw label. */
export function titleOf(label: string): string {
  return isRatedLabel(label) ? LABEL_TITLES[label] : label.toLowerCase().replace(/_/g, ' ')
}

/**
 * Labels whose *presence* rates, whatever the score.
 *
 * Mirrors `rates_on_presence` in apps/desktop/src/rating.rs — see the note
 * there for why `FEMALE_BREAST_COVERED` and `MALE_BREAST_EXPOSED` are excluded.
 */
export function ratesOnPresence(label: string): boolean {
  return (
    label.includes('GENITALIA') ||
    label.includes('ANUS') ||
    label.includes('BUTTOCKS') ||
    label === 'FEMALE_BREAST_EXPOSED'
  )
}
