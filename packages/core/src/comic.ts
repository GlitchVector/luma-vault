/**
 * The comic script — the one document the owner edits by hand, and the
 * contract between the pipeline's stages (`packages/comic`) and the panel in
 * the app that edits it. Lives here so both parse it with the same schema.
 *
 * Deliberately flat and forgiving: every optional field has a default the
 * assembler and the prompt builder agree on, so a panel can be fixed by
 * editing one line without knowing anything about the other stages.
 */

import { z } from 'zod'

/** Where lettering sits inside a panel — and, for `reserve_space`, which part
 *  of the frame the prompt asks the model to leave empty. */
export const COMIC_ANCHORS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const
export const comicAnchorSchema = z.enum(COMIC_ANCHORS)
export type ComicAnchor = z.infer<typeof comicAnchorSchema>

export const COMIC_BALLOON_KINDS = ['speech', 'thought', 'shout', 'caption'] as const
export const comicBalloonKindSchema = z.enum(COMIC_BALLOON_KINDS)
export type ComicBalloonKind = z.infer<typeof comicBalloonKindSchema>

/** A point inside a panel, in percent of its width and height. */
export const comicPointSchema = z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) })
export type ComicPoint = z.infer<typeof comicPointSchema>

export const comicDialogueSchema = z.object({
  speaker: z.string().min(1),
  text: z.string().min(1),
  anchor: comicAnchorSchema,
  kind: comicBalloonKindSchema.default('speech'),
  /** Where the tail points. Defaults toward the panel's middle, which is
   *  where a single figure framed by the camera words ends up. */
  tail_to: comicPointSchema.optional(),
})
export type ComicDialogue = z.infer<typeof comicDialogueSchema>

export const comicSfxSchema = z.object({
  text: z.string().min(1),
  anchor: comicAnchorSchema,
  /** Degrees. Negative tilts the word up to the right. */
  rotate: z.number().default(-8),
})
export type ComicSfx = z.infer<typeof comicSfxSchema>

export const comicSpanSchema = z.object({
  col: z.string().min(1),
  row: z.string().min(1),
})
export type ComicSpan = z.infer<typeof comicSpanSchema>

export const comicPanelSchema = z.object({
  id: z.string().min(1),
  span: comicSpanSchema.optional(),
  /** Framing words, in the tag vocabulary the checkpoint knows (`close-up`,
   *  `cowboy shot`, `from below`, ...). Never a sentence. */
  camera: z.string().min(1),
  /** The prompt body: setting, action, light. No dialogue, no names. Only
   *  the local model ever sees this, so it may say anything. */
  scene: z.string().min(1),
  /** A key into the script's `locations`, for a plate that stays consistent
   *  across every panel set there. */
  location: z.string().optional(),
  /** The place and light only, with nobody in it, for the plate. Goes to a
   *  hosted model: keep it free of nudity and sexual content. */
  setting: z.string().optional(),
  /** What each stand-in figure does, in order of `characters`, for the
   *  plate. Same rule: a hosted model reads it. */
  pose: z.array(z.string()).default([]),
  characters: z.array(z.string()).default([]),
  /**
   * The light for THIS panel only, replacing the book's and the page's.
   * Bottom rung: book, then page, then panel, most specific wins.
   */
  lighting: z.string().optional(),
  /**
   * Turn the face pass off for this panel alone.
   *
   * Unset means whatever `forge.face.enabled` says. It is here because the
   * pass is a judgement call at the edges: it is right almost always and
   * wrong on the odd panel, and the person looking at the panel is the one
   * who can tell.
   */
  face: z.boolean().optional(),
  /**
   * Her build for THIS panel only, replacing the character's own and the
   * page's. The bottom rung of the ladder: character, then page, then
   * panel, and the most specific one that is set wins.
   */
  body: z.string().optional(),
  /** How many people the picture should contain, when it is not simply the
   *  number of characters in it (a crowd, an empty room). */
  figures: z.number().int().min(0).optional(),
  reserve_space: z.union([comicAnchorSchema, z.literal('none')]).default('none'),
  dialogue: z.array(comicDialogueSchema).default([]),
  sfx: z.array(comicSfxSchema).default([]),
  /** A CSS `clip-path` polygon for a diagonal gutter. Percent coordinates. */
  clip: z.string().optional(),
})
export type ComicPanelSpec = z.infer<typeof comicPanelSchema>

/**
 * The layout presets: a CSS grid plus one cell per panel. Here rather than in
 * the pipeline because the editor offers them by name, and a name the editor
 * offers that the assembler does not know would be a page that never renders.
 */
export interface ComicLayout {
  columns: string
  rows: string
  cells: ComicSpan[]
}

const fr = (n: number) => `repeat(${n}, 1fr)`

export const COMIC_LAYOUTS: Record<string, ComicLayout> = {
  splash: { columns: fr(1), rows: fr(1), cells: [{ col: '1', row: '1' }] },
  'two-stack': { columns: fr(1), rows: fr(2), cells: [{ col: '1', row: '1' }, { col: '1', row: '2' }] },
  'two-wide': { columns: fr(2), rows: fr(1), cells: [{ col: '1', row: '1' }, { col: '2', row: '1' }] },
  'three-stack': {
    columns: fr(1),
    rows: fr(3),
    cells: [{ col: '1', row: '1' }, { col: '1', row: '2' }, { col: '1', row: '3' }],
  },
  /** One wide panel on top of two. */
  'hero-top': {
    columns: fr(2),
    rows: fr(2),
    cells: [{ col: '1 / 3', row: '1' }, { col: '1', row: '2' }, { col: '2', row: '2' }],
  },
  /** Two panels on top of one wide. */
  'hero-bottom': {
    columns: fr(2),
    rows: fr(2),
    cells: [{ col: '1', row: '1' }, { col: '2', row: '1' }, { col: '1 / 3', row: '2' }],
  },
  /** A tall panel down the left, two stacked on the right. */
  'tall-left': {
    columns: fr(2),
    rows: fr(2),
    cells: [{ col: '1', row: '1 / 3' }, { col: '2', row: '1' }, { col: '2', row: '2' }],
  },
  'grid-2x2': {
    columns: fr(2),
    rows: fr(2),
    cells: [{ col: '1', row: '1' }, { col: '2', row: '1' }, { col: '1', row: '2' }, { col: '2', row: '2' }],
  },
  /** A wide establishing panel, then two rows of two. */
  'wide-2-2': {
    columns: fr(2),
    rows: fr(3),
    cells: [
      { col: '1 / 3', row: '1' },
      { col: '1', row: '2' },
      { col: '2', row: '2' },
      { col: '1', row: '3' },
      { col: '2', row: '3' },
    ],
  },
  /** Two on top, three below. */
  '2-3': {
    columns: fr(6),
    rows: fr(2),
    cells: [
      { col: '1 / 4', row: '1' },
      { col: '4 / 7', row: '1' },
      { col: '1 / 3', row: '2' },
      { col: '3 / 5', row: '2' },
      { col: '5 / 7', row: '2' },
    ],
  },
  'grid-2x3': {
    columns: fr(2),
    rows: fr(3),
    cells: [
      { col: '1', row: '1' },
      { col: '2', row: '1' },
      { col: '1', row: '2' },
      { col: '2', row: '2' },
      { col: '1', row: '3' },
      { col: '2', row: '3' },
    ],
  },
  'grid-3x3': {
    columns: fr(3),
    rows: fr(3),
    cells: Array.from({ length: 9 }, (_, i) => ({ col: String((i % 3) + 1), row: String(Math.floor(i / 3) + 1) })),
  },
}

export const comicGridSchema = z.object({
  columns: z.string().min(1),
  rows: z.string().min(1),
})
export type ComicGrid = z.infer<typeof comicGridSchema>

export const comicPageSchema = z.object({
  /** Her build for every panel on this page, replacing the character's own
   *  and replaced in turn by any panel that sets its own. */
  body: z.string().optional(),
  /** The light for every panel on this page, replacing the book's and
   *  replaced in turn by any panel that sets its own. */
  lighting: z.string().optional(),
  /** A preset name from the pipeline's `layouts.ts`, or an explicit grid template. */
  layout: z.union([z.string().min(1), comicGridSchema]),
  panels: z.array(comicPanelSchema).min(1),
})
export type ComicPageSpec = z.infer<typeof comicPageSchema>

export const comicCharacterSchema = z.object({
  /**
   * `name:weight`, exactly as Forge's `<lora:name:weight>` wants it. Empty
   * for a character drawn without one - a child, or anyone who has no LoRA
   * yet - who is held by `reference` and `look` instead.
   */
  lora: z.union([z.literal(''), z.string().regex(/^[^:<>]+:\d+(\.\d+)?$/, 'lora must be "name:weight"')]).default(''),
  /** The activation word(s) the LoRA was trained on. Goes first, always. Empty without a LoRA. */
  trigger: z.string().default(''),
  /**
   * The appearance, restated in every panel this character is in.
   *
   * EMPTY IS CORRECT for a full-character LoRA. The owner's caption recipe
   * is that a LoRA is taught only what varies inside its dataset, so the
   * trigger alone carries hair, eyes and the default outfit — measured on
   * ari_adopt_v4, whose 235 captions contain the outfit exactly zero times.
   * Restating it here does not reinforce it, it competes with it: generic
   * tags like 'off-shoulder shirt' and 'black collar' pull toward a
   * generic tube top and choker instead of her yoke and cut-outs.
   */
  look: z.string().default(''),
  /**
   * Her head alone: hair, eyes, and what she wears on them.
   *
   * Only the face pass reads this, and it reads it INSTEAD of `look`. The
   * pass repaints a crop that stops at her neck, so handing it the full look
   * spends a third of the prompt on a shirt, a collar, shorts and shoes that
   * are not in the crop, and a face repainted against words for clothes
   * comes back worse than the one it replaced.
   *
   * Empty falls back to `look`, so a character without one behaves as before.
   */
  head: z.string().default(''),
  /**
   * Her build, as tags, restated in every panel.
   *
   * Separate from `look` because it is answering a different question. With
   * no body words at all the checkpoint picks a body per panel, and picks a
   * bustier one than the references; naming it is what holds it still. Keep
   * it unweighted: a weighted body block drags every shot toward the hips,
   * which is the whole reason the framing words carry weight here.
   */
  body: z.string().default(''),
  /** Her body for back views (`from behind`, `back turned`, `facing away`): the
   *  heavier rear with the same front. Unset, back views use `body`. */
  body_rear: z.string().optional(),
  /** `1girl`, `1boy`: the subject tag the checkpoint counts figures with. */
  subject: z.enum(['1girl', '1boy', '1other']).default('1girl'),
  seed_family: z.number().int().min(0),
  /**
   * Negative words for THIS character only (`bracelet` for Ari, whose canon
   * bans one), used when she is painted alone. In the book's negative they
   * would also strip another character's (Tom's bearing-ring cuff).
   */
  negative: z.string().optional(),
  /**
   * Her hair colours, as hex, for finding her among the figures on the
   * sketch route: every figure whose head carries them is repainted as her,
   * a mirror image included. Unset, she is the largest figure left.
   */
  hair: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
  /**
   * A character sheet (absolute path) the hosted sketch is drawn from, so a
   * character with no LoRA still looks the same in every panel.
   */
  reference: z.string().optional(),
  /**
   * Under 18. Hard rules follow, not preferences: never a LoRA (any LoRA of
   * this character carries an adult body), never an explicit panel (the
   * pipeline refuses one), and a safety negative on every render she is in.
   */
  minor: z.boolean().default(false),
})
export type ComicCharacter = z.infer<typeof comicCharacterSchema>

export const comicScriptSchema = z.object({
  title: z.string().min(1),
  characters: z.record(z.string(), comicCharacterSchema),
  /** Recurring places, described once, with nobody in them. A panel names
   *  one in `location`; the plates stage draws each once and keeps every
   *  panel set there on the same picture. */
  locations: z.record(z.string(), z.string()).default({}),
  pages: z.array(comicPageSchema).min(1),
})
export type ComicScript = z.infer<typeof comicScriptSchema>

/** What the writer produces before the cast is merged in: the same document
 *  minus everything only the config knows (LoRA names, seed families), with
 *  ids and layouts optional — position and panel count fill them in. */
export const comicDraftPanelSchema = comicPanelSchema.extend({ id: z.string().optional() })
export const comicDraftPageSchema = comicPageSchema.extend({
  layout: comicPageSchema.shape.layout.optional(),
  panels: z.array(comicDraftPanelSchema).min(1),
})
export const comicDraftScriptSchema = z.object({
  title: z.string().min(1),
  locations: z.record(z.string(), z.string()).default({}),
  pages: z.array(comicDraftPageSchema).min(1),
})
export type ComicDraftScript = z.infer<typeof comicDraftScriptSchema>
