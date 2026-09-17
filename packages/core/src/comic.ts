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
  /** A preset name from the pipeline's `layouts.ts`, or an explicit grid template. */
  layout: z.union([z.string().min(1), comicGridSchema]),
  panels: z.array(comicPanelSchema).min(1),
})
export type ComicPageSpec = z.infer<typeof comicPageSchema>

export const comicCharacterSchema = z.object({
  /** `name:weight`, exactly as Forge's `<lora:name:weight>` wants it. */
  lora: z.string().regex(/^[^:<>]+:\d+(\.\d+)?$/, 'lora must be "name:weight"'),
  /** The activation word(s) the LoRA was trained on. Goes first, always. */
  trigger: z.string().min(1),
  /** The full appearance, restated in every panel this character is in. */
  look: z.string().min(1),
  /** `1girl`, `1boy`: the subject tag the checkpoint counts figures with. */
  subject: z.enum(['1girl', '1boy', '1other']).default('1girl'),
  seed_family: z.number().int().min(0),
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
