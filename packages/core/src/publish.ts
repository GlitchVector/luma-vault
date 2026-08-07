/**
 * Turning a row of the library into a DeviantArt submission.
 *
 * Pure, and deliberately the *only* place the mapping lives. The Rust side
 * uploads whatever draft it is handed and derives nothing, so there is no
 * second copy of these rules to drift out of sync — unlike the rating rules,
 * which genuinely have to exist in both languages because the scan runs in one
 * and the UI re-derives in the other. Nothing re-derives a draft.
 *
 * Everything here is a *starting point* shown in an editable panel before
 * anything leaves the machine. That is what lets the rules be opinionated: a
 * wrong guess costs a keystroke, not a bad post.
 */

import { LABEL_WEIGHTS, isRatedLabel, type RatedLabel } from './labels.ts'
import type { Generation, MediaItem, Rating } from './schemas.ts'

/**
 * How mature a submission is, in DeviantArt's vocabulary.
 *
 * Two values, not a scale: `moderate` is their 13+ tier and `strict` their 18+
 * one. Our four-value `Rating` collapses onto it rather than mapping across.
 */
export type MatureLevel = 'moderate' | 'strict'

/** Why a submission is mature. DeviantArt accepts several at once. */
export type MatureClassification = 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology'

/**
 * What gets submitted, once a person has looked at it.
 *
 * Mirrors the fields `stash/submit` and `stash/publish` actually take, so the
 * panel edits the request rather than editing a model of the request that
 * something else then has to translate.
 */
export interface DeviantArtDraft {
  mediaId: number
  title: string
  /** `artist_comments` on the wire. DeviantArt renders a little HTML here. */
  description: string
  tags: string[]
  isMature: boolean
  /** Null exactly when `isMature` is false — the API rejects one without the other. */
  matureLevel: MatureLevel | null
  matureClassification: MatureClassification[]
  /**
   * Set from the presence of generation metadata, not guessed.
   *
   * DeviantArt reads the same metadata out of the file and applies the label
   * itself, so sending `false` for a file that carries a parameter block does
   * not hide anything — it just disagrees with what they will conclude.
   */
  isAiGenerated: boolean
  /** Ask that the work be excluded from AI training sets. */
  noai: boolean
  /**
   * How large the picture is *shown* on its deviation page.
   *
   * DeviantArt's own default downscales — a 2627x3840 upload displays at 1280
   * wide unless something says otherwise, which throws away the entire point of
   * uploading a 4K render. See {@link DISPLAY_ORIGINAL}.
   */
  displayResolution: DisplayResolution
}

/**
 * `display_resolution` on the wire: how wide the deviation page draws the image.
 *
 * The API documents the field as an integer 0-8 and does not say what the
 * numbers mean. The mapping below is read off the submission form's own
 * dropdown, which offers exactly nine choices in this order — Original first.
 * Their docs add only that a value "cannot exceed original image size", which
 * is consistent with the rungs being widths and 0 being the un-resized one.
 */
export const DISPLAY_RESOLUTIONS = [
  { value: 0, label: 'Original' },
  { value: 1, label: '400px wide' },
  { value: 2, label: '600px wide' },
  { value: 3, label: '800px wide' },
  { value: 4, label: '900px wide' },
  { value: 5, label: '1024px wide' },
  { value: 6, label: '1280px wide' },
  { value: 7, label: '1600px wide' },
  { value: 8, label: '1920px wide' },
] as const

export type DisplayResolution = (typeof DISPLAY_RESOLUTIONS)[number]['value']

/** Full resolution — what an upload of a 4K render is for. */
export const DISPLAY_ORIGINAL = 0

/**
 * DeviantArt's cap. Exceeding it is rejected outright rather than truncated,
 * so the derivation trims and the panel shows what survived.
 */
export const MAX_TAGS = 30

/** Long titles are truncated by the site; this keeps what we send readable. */
export const MAX_TITLE = 50

/**
 * Tags implied by the strongest detection on a row.
 *
 * Only the top label is consulted, because that is all a `MediaVerdict`
 * carries — the per-detection list lives on frames, and a still has exactly one
 * frame's worth of it that the index does not keep at the media level.
 *
 * Written in the vocabulary DeviantArt's own browse pages use, which is not the
 * detector's: nobody searches `FEMALE_BREAST_EXPOSED`.
 */
const LABEL_TAGS: Partial<Record<RatedLabel, readonly string[]>> = {
  FEMALE_GENITALIA_EXPOSED: ['nude', 'explicit'],
  MALE_GENITALIA_EXPOSED: ['nude', 'explicit'],
  ANUS_EXPOSED: ['nude', 'explicit'],
  FEMALE_BREAST_EXPOSED: ['topless', 'breasts', 'nude'],
  MALE_BREAST_EXPOSED: ['shirtless'],
  BUTTOCKS_EXPOSED: ['butt', 'nude'],

  FEMALE_GENITALIA_COVERED: ['lingerie'],
  FEMALE_BREAST_COVERED: ['cleavage'],
  BUTTOCKS_COVERED: ['butt'],
  BELLY_EXPOSED: ['midriff'],
  ARMPITS_EXPOSED: ['armpits'],

  FEET_EXPOSED: ['feet', 'barefoot'],
  FACE_FEMALE: ['portrait'],
  FACE_MALE: ['portrait'],

  ANIME_EXPLICIT: ['anime', 'hentai'],
  ANIME_QUESTIONABLE: ['anime', 'ecchi'],
}

/**
 * Which way round the picture is.
 *
 * Two sets rather than a scale, because that is the question being asked: is
 * this an ass shot or a front shot. Anything genuinely in between gets whatever
 * its strongest detection says, and the panel lets that be overridden.
 */
export type Pose = 'rear' | 'front'

/**
 * The tags each orientation contributes.
 *
 * **This table is the thing to edit.** Everything else about poses is
 * mechanism; these are the words that end up on the submission, and they are
 * meant to be replaced with whatever vocabulary actually performs on a given
 * gallery. Sanitised on the way out like every other tag, so writing
 * `from behind` here is fine.
 */
export const POSE_TAGS: Record<Pose, readonly string[]> = {
  // The front list minus the four large-breast variants, which describe
  // something a from-behind shot does not show. Everything else is shared:
  // `bigboobs` and the expansion tags stay, because they describe the subject
  // rather than the view.
  rear: [
    'bigass',
    'bigboobs',
    'bigbooty',
    'bootylicious',
    'bubblebutt',
    'buttcheeks',
    'thickgirl',
    'widehips',
    'assexpansion',
    'big_ass',
    'bootyexpansion',
    'pawgbooty',
    'thickthighs',
    'bigassgirl',
    'thickandcurvy',
    'bigassbooty',
    'asswhorshipping',
    'stablediffusion',
  ],

  front: [
    'bigboobs',
    'breastexpansion',
    'breastinflation',
    'hugeboobs',
    'hugebreasts',
    'largeboobs',
    'largebreasts',
    'thickgirl',
    'widehips',
    'thickthighs',
    'thickandcurvy',
    'stablediffusion',
  ],
}

/**
 * Labels that mean the camera is behind the subject.
 *
 * Anus labels are included with the buttocks ones: they are the same view, and
 * a spread pose can score the anus above the buttocks it is surrounded by.
 */
function isRearLabel(label: string): boolean {
  return label.startsWith('BUTTOCKS_') || label.startsWith('ANUS_')
}

/**
 * Whether a label says anything about orientation at all.
 *
 * Two exclusions, both load-bearing:
 *
 * - **`ANIME_*`** is the anime tagger's judgement of the *whole image*, carried
 *   on a frame-filling placeholder box. It has no location, so it cannot mean
 *   "from behind" or "from the front" — and it routinely scores higher than any
 *   located detection, so letting it compete would decide every picture.
 * - **`FACE_*`** appears in both orientations. A face turned back over the
 *   shoulder is one of the most common from-behind poses there is, and NudeNet
 *   scores faces higher than almost anything else — so faces would win the
 *   comparison in most images and call nearly everything front-facing, which is
 *   the one outcome that makes this feature useless.
 */
function carriesOrientation(label: string): boolean {
  return !label.startsWith('ANIME_') && !label.startsWith('FACE_')
}

/**
 * Which way round a picture is.
 *
 * The rule is deliberately blunt: **whichever anatomy the detector was most
 * confident about decides.** If that is buttocks, it is a from-behind shot; if
 * it is anything else, it is a front one. No weighted totals and no "mixed"
 * verdict — a weighted model sounds better and is far harder to predict, and
 * being able to guess what this will say from looking at the picture is worth
 * more than being right slightly more often.
 *
 * Read from a verdict's `topLabel` rather than from a frame's raw detections,
 * which is not a shortcut but the more correct source:
 *
 * - `rateFrame` already defines `topLabel` as *the highest-scoring **rated**
 *   detection*, which is precisely the question being asked here — and it
 *   already drops faces, since a 0.99 face never beats a 0.6 exposure there.
 * - It lives on the row, so this needs no round trip and no loading state.
 * - **Upscaled variants have no frame rows.** They inherit a verdict from the
 *   original but never go through classification, so nothing ever wrote frames
 *   for them. Reading detections would therefore find nothing for exactly the
 *   rows the grid actually shows — it hides an original once a variant of it
 *   exists — and the pose would come back empty for almost every real
 *   selection.
 *
 * `null` when the row is unclassified, or when the strongest finding was the
 * whole-image anime rating, which carries no orientation. That contributes no
 * pose tags rather than inventing one.
 */
export function poseFromLabel(label: string | null | undefined): Pose | null {
  if (!label || !carriesOrientation(label)) return null
  return isRearLabel(label) ? 'rear' : 'front'
}

/** The pose of a row, from the verdict the index already holds. */
export function poseOf(item: MediaItem): Pose | null {
  return poseFromLabel(item.verdict?.topLabel)
}

/** Tags implied by the verdict as a whole, whatever the top label was. */
const RATING_TAGS: Record<Rating, readonly string[]> = {
  explicit: ['nsfw', 'mature'],
  suggestive: ['suggestive'],
  sfw: [],
  unrated: [],
}

/**
 * Prompt fragments that describe the *render* rather than the picture.
 *
 * Every one of these appears in a large share of SDXL and Pony prompts and none
 * of them says anything about what was drawn, so they make terrible titles and
 * worse tags. Matched after normalisation, so `score_9` and `(masterpiece:1.2)`
 * both land here.
 */
const BOILERPLATE = new Set([
  'masterpiece',
  'best quality',
  'high quality',
  'highest quality',
  'normal quality',
  'worst quality',
  'bad quality',
  'low quality',
  'highres',
  'lowres',
  'absurdres',
  'ultra detailed',
  'ultra-detailed',
  'extremely detailed',
  'highly detailed',
  'very detailed',
  'detailed',
  'intricate details',
  'sharp focus',
  'professional',
  'award winning',
  '8k',
  '4k',
  'uhd',
  'hdr',
  'raw photo',
  'source anime',
  'source pony',
  'source cartoon',
  'source furry',
  'very awa',
  'newest',
  'oldest',
  'safe',
  'break',
])

/** `score_9`, `score_8_up`, … — Pony's aesthetic ladder, in every prompt. */
const SCORE_TAG = /^score[_ ]\d(?:[_ ]up)?$/

/**
 * Split a generation prompt into the things it actually depicts.
 *
 * Strips the weight and emphasis syntax rather than trying to parse it — a
 * weight is a instruction to the sampler and carries no meaning for a reader —
 * then drops the render boilerplate. What is left is roughly the subject, in
 * the order the prompt named it, which is usually the order of importance.
 */
export function promptSubjects(prompt: string): string[] {
  return prompt
    // LoRA and textual-inversion invocations name a file, never a subject.
    .replace(/<[^>]*>/g, ' ')
    // `(blue hair:1.3)` and `[detail]` — keep the word, drop the arithmetic.
    .replace(/[()[\]{}]/g, ' ')
    .replace(/:\s*-?\d+(?:\.\d+)?/g, ' ')
    .split(/[,\n]/)
    .map((part) => part.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter((part) => {
      if (part.length === 0) return false
      if (BOILERPLATE.has(part)) return false
      if (SCORE_TAG.test(part)) return false
      // A bare number is a step count or a stray weight, never a subject.
      return !/^\d+$/.test(part)
    })
}

/**
 * A tag DeviantArt will accept.
 *
 * Their rule is letters, digits and underscores only — so this is not cosmetic
 * tidying, it is the difference between a submission and a 400. Accents are
 * folded rather than stripped so `café` becomes `cafe` and not `caf`.
 */
export function toTag(value: string): string {
  return value
    .normalize('NFKD')
    // The combining marks NFKD just split off. Everything else non-alphanumeric
    // becomes a separator.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Title Case, for a title built out of lowercase prompt fragments. */
function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

/**
 * What the upscaler appends to a variant's filename.
 *
 * The same string as `UPSCALE_SUFFIX` in `apps/desktop/src/upscales.rs`, which
 * owns the convention — this end only has to *recognise* it, so the two are not
 * a rule implemented twice. Nothing derives from it except the title below.
 */
const UPSCALE_SUFFIX = '_upscaled_4k'

/**
 * A filename worth showing, or null.
 *
 * Generated output is overwhelmingly named `00042-3746152819.png`, which is a
 * counter and a seed. That is a worse title than anything derivable from the
 * prompt, so it is rejected here and the caller falls through — a name has to
 * carry letters, and not just the extension's worth.
 *
 * The upscale suffix comes off first, and that is the whole reason this is not
 * a one-liner. `00242-3753124055_upscaled_4k.png` is a counter and a seed too,
 * but the suffix survives the digit strip and the file gets titled **"Upscaled
 * 4k"** — which is not a title, and worse, is the *same* title for every
 * variant in a batch. Since the grid shows variants in place of their
 * originals, that was the normal case rather than an edge one.
 */
function titleFromName(name: string): string | null {
  const bare = name.replace(/\.[^.]+$/, '')
  const stem = bare.endsWith(UPSCALE_SUFFIX) ? bare.slice(0, -UPSCALE_SUFFIX.length) : bare
  const words = stem
    .replace(/[_-]+/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!/[a-z]{3}/i.test(words)) return null
  return titleCase(words).slice(0, MAX_TITLE).trim()
}

/** Up to four leading subjects, as a title. */
function titleFromPrompt(prompt: string): string | null {
  const [first, ...rest] = promptSubjects(prompt)
  if (first === undefined) return null

  const parts: string[] = []
  for (const subject of [first, ...rest]) {
    const next = [...parts, subject].join(', ')
    if (next.length > MAX_TITLE) break
    parts.push(subject)
    if (parts.length === 4) break
  }
  // Even the first fragment was over the cap on its own; cut it short rather
  // than returning nothing, which would fall through to "Untitled".
  if (parts.length === 0) parts.push(first.slice(0, MAX_TITLE).trim())
  return titleCase(parts.join(', '))
}

/**
 * The checkpoint, as one tag.
 *
 * `ponyDiffusionV6XL_v6StartWithThisOne.safetensors` is a filename, and all of
 * it after the first underscore is the uploader's versioning note rather than
 * the model's name. Keeping the leading segment gives something a person would
 * recognise and might search for.
 */
function modelTag(model: string): string | null {
  const stem = model.replace(/\.(safetensors|ckpt|pt|pth)$/i, '')
  const leading = stem.split(/[_\\/]/)[0] ?? stem
  const tag = toTag(leading)
  return tag.length >= 3 ? tag : null
}

/**
 * How a tool's name is spelled as a tag.
 *
 * Not `toTag(tool)`, which would give `stable_diffusion`. DeviantArt treats that
 * as a different tag from `stablediffusion` — separate pages, separate search
 * results — and the unpunctuated one is the one with the traffic. Getting this
 * wrong does not fail, it just spends one of thirty slots on a tag nobody
 * browses.
 */
const TOOL_TAGS: Record<string, string> = {
  'Stable Diffusion': 'stablediffusion',
  ComfyUI: 'comfyui',
  InvokeAI: 'invokeai',
  NovelAI: 'novelai',
}

function generationTags(generation: Generation | null): string[] {
  if (!generation) return []
  const tags = ['aiart', 'aigenerated']
  const tool = TOOL_TAGS[generation.tool] ?? toTag(generation.tool)
  if (tool.length >= 3) tags.push(tool)
  if (generation.model) {
    const model = modelTag(generation.model)
    if (model) tags.push(model)
  }
  return tags
}

/**
 * Why a submission counts as mature.
 *
 * Derived from the label rather than the rating, because the two answer
 * different questions. `BELLY_EXPOSED` and `FEMALE_BREAST_EXPOSED` are both
 * "sexy" to the rating rules and only one of them is nudity — labelling a
 * midriff as sexual content is the kind of over-flagging that gets a gallery
 * filtered out of everyone's browse page for no reason.
 */
function classify(rating: Rating, topLabel: string | null): MatureClassification[] {
  if (rating !== 'explicit' && rating !== 'suggestive') return []

  const label = topLabel && isRatedLabel(topLabel) ? topLabel : null
  const weight = label ? LABEL_WEIGHTS[label] : null

  if (weight === 'explicit') {
    // Genitalia, anus and exposed breasts. Anime `explicit` is Danbooru's
    // whole-image judgement, which is a sex-act rating rather than an anatomy
    // one, so it earns both here too.
    return ['nudity', 'sexual']
  }
  if (label === 'BUTTOCKS_EXPOSED') return ['nudity']
  if (weight === 'suggestive') return ['sexual']

  // Rated without a label that explains it — a video rolled up from frames the
  // media row does not carry, or an unrecognised class from a newer model.
  // `nudity` is the safer of the two to be wrong about.
  return rating === 'explicit' ? ['nudity', 'sexual'] : ['nudity']
}

export interface DraftOptions {
  /**
   * Tags added to every draft — a signature, a series, a gallery name.
   *
   * First in the list, because DeviantArt shows tags in the order given and the
   * ones a person chose deliberately should not be buried under derived ones.
   */
  baseTags?: readonly string[]
  /**
   * Ask that the work be excluded from AI training sets.
   *
   * **Off unless asked for.** The flag is for someone protecting work they drew;
   * asserting it over a library that is itself generated is a claim its owner
   * has to actually want to make, so it is not made on their behalf.
   */
  noai?: boolean
  /** Put the positive prompt in the description. */
  includePrompt?: boolean
  /** Title every draft this instead of deriving one per picture. */
  title?: string
}

/**
 * Everything this app can work out about how a picture should be posted.
 *
 * Never final: the panel this feeds is editable and nothing is uploaded until
 * someone has looked at it. An `unrated` row — one the classifier has not
 * reached — comes back not-mature, which is exactly the case a person has to
 * correct, so the panel says so rather than hiding it.
 */
export function describeForDeviantArt(item: MediaItem, options: DraftOptions = {}): DeviantArtDraft {
  const rating: Rating = item.verdict?.rating ?? 'unrated'
  const topLabel = item.verdict?.topLabel ?? null

  const title =
    options.title?.trim() ||
    titleFromName(item.name) ||
    (item.generation?.prompt ? titleFromPrompt(item.generation.prompt) : null) ||
    'Untitled'

  const derived = [
    ...(options.baseTags ?? []),
    ...(topLabel && isRatedLabel(topLabel) ? (LABEL_TAGS[topLabel] ?? []) : []),
    ...RATING_TAGS[rating],
    ...generationTags(item.generation),
  ]

  const tags: string[] = []
  for (const candidate of derived) {
    const tag = toTag(candidate)
    if (tag.length === 0 || tags.includes(tag)) continue
    tags.push(tag)
    if (tags.length === MAX_TAGS) break
  }

  const matureClassification = classify(rating, topLabel)
  const isMature = matureClassification.length > 0

  // Empty unless the prompt is explicitly asked for.
  //
  // This used to append "Made with <checkpoint>." to every submission, which
  // names the model on a public page for no benefit the poster asked for. The
  // checkpoint already goes out as a *tag*, where it is a thing people browse
  // by rather than a disclosure — and a tag can be removed in the panel before
  // sending, which a derived sentence in the description was too easy to miss.
  const description: string[] = []
  if (options.includePrompt && item.generation?.prompt) {
    description.push(item.generation.prompt)
  }

  return {
    mediaId: item.id,
    title,
    description: description.join('\n\n'),
    tags,
    isMature,
    // Their 18+ tier for anything the detector called explicit, their 13+ tier
    // for the rest. Erring upward: an over-labelled picture is filtered from
    // some people's browse page, an under-labelled one is a policy violation.
    matureLevel: isMature ? (rating === 'explicit' ? 'strict' : 'moderate') : null,
    matureClassification,
    isAiGenerated: item.generation !== null,
    noai: options.noai ?? false,
    displayResolution: DISPLAY_ORIGINAL,
  }
}
