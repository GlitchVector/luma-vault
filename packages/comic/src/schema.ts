/**
 * The two documents a comic is made of: the config (how to render) and the
 * script (what to render). Both are parsed at the boundary, never cast.
 *
 * `script.json` is the one artefact the owner edits by hand, so its schema is
 * deliberately flat and forgiving: every optional field has a default the
 * assembler and the prompt builder agree on, and a panel can be fixed by
 * editing one line without knowing anything about the other stages.
 */

import { z } from 'zod'
import { comicCharacterSchema } from '@luma/core'

/**
 * The script's schema lives in `@luma/core` (`comic.ts`) so the app's editor
 * and this pipeline parse the same document. Re-exported under the names the
 * stages use.
 */
export {
  COMIC_ANCHORS as ANCHORS,
  COMIC_BALLOON_KINDS as BALLOON_KINDS,
  comicAnchorSchema as anchorSchema,
  comicScriptSchema as scriptSchema,
  comicDraftScriptSchema as draftScriptSchema,
  comicPanelSchema as panelSchema,
  comicPageSchema as pageSchema,
} from '@luma/core'
export type {
  ComicAnchor as Anchor,
  ComicBalloonKind as BalloonKind,
  ComicPoint as Point,
  ComicDialogue as Dialogue,
  ComicSfx as Sfx,
  ComicSpan as Span,
  ComicPanelSpec as Panel,
  ComicGrid as Grid,
  ComicPageSpec as Page,
  ComicCharacter as Character,
  ComicScript as Script,
  ComicDraftScript as DraftScript,
} from '@luma/core'

// ---------------------------------------------------------------------------
// Config

export const forgeConfigSchema = z.object({
  url: z.string().url().default('http://127.0.0.1:7860'),
  /** A substring of the checkpoint's filename; resolved against
   *  `/sdapi/v1/sd-models` and sent as `override_settings`. */
  checkpoint: z.string().min(1),
  sampler: z.string().default('Euler a'),
  scheduler: z.string().default('Automatic'),
  steps: z.number().int().min(1).default(28),
  cfg: z.number().min(0).default(5),
  clip_skip: z.number().int().min(1).optional(),
  /** Forge keeps its own copy in its outputs folder, which is a watched
   *  folder here — that is how a rendered panel reaches the vault. */
  save_to_forge: z.boolean().default(true),
  /** Seconds a single txt2img may take before the run gives up on it. */
  timeout_s: z.number().min(10).default(900),
})

export const promptConfigSchema = z.object({
  /** Quality words the checkpoint's family expects, first in every prompt. */
  quality: z.string().default('masterpiece, best quality'),
  /** A style block appended to every panel. Empty by default: the look of
   *  the book is the checkpoint's, and this is the one place to change it. */
  style: z.string().default(''),
  negative: z.string().min(1),
  /** Lettering words. Added to every negative so the model does not draw
   *  the balloons the assembler is about to add. */
  negative_lettering: z.string().default('speech bubble, english text, multiple views'),
})

export const pageConfigSchema = z.object({
  width: z.number().int().min(100).default(2000),
  height: z.number().int().min(100).default(3000),
})

export const qaConfigSchema = z.object({
  max_attempts: z.number().int().min(1).default(3),
  /** Interpreter for the tagger. Relative to the repo root. */
  python: z.string().default('venv-classifier/Scripts/python.exe'),
  /** The wd tagger folder (`model.onnx` + `selected_tags.csv`), repo-relative. */
  tagger_dir: z.string().default('models/anime-tagger'),
  tag_threshold: z.number().min(0).max(1).default(0.35),
  /** Below this luminance spread (0-255) a panel is blank. */
  blank_std: z.number().default(6),
  /** The reserved region counts as usable when its edge energy is at most
   *  this fraction of the whole picture's, or its luminance spread is low. */
  space_edge_ratio: z.number().default(0.55),
  space_std: z.number().default(18),
})

/**
 * The plate pass: a hosted model draws the place with stand-in figures, and
 * the local model redraws the stand-ins as the cast. `none` renders each
 * panel directly, the way the pipeline started.
 */
export const platesConfigSchema = z.object({
  backend: z.enum(['none', 'openai', 'mock']).default('none'),
  model: z.string().default('gpt-image-1'),
  quality: z.enum(['low', 'medium', 'high', 'auto']).default('medium'),
  /** How closely an edit keeps the master plate it was given. */
  input_fidelity: z.enum(['low', 'high']).default('high'),
  /** Style words for the plate. The local pass has its own in `prompt.style`. */
  style: z.string().default('clean digital illustration, soft natural light, no text'),
  /** How far a stand-in's mask grows past its colour, in pixels.
   *
   *  Not just anti-aliasing slack: the mannequin is bald and smooth, and a
   *  character is not. At 24 the mask was narrower than Ari's bob and the
   *  inpaint sliced her crown flat, because it cannot paint outside the
   *  mask. At 96 it repaints so much background that a dusk sky grew
   *  daylight clouds. 56 clears her hair and leaves the plate alone. A
   *  character with bigger hair or bulky armour needs more. */
  mask_grow: z.number().int().min(0).default(56),
  /** Colour distance (0-441) under which a pixel counts as the stand-in. */
  mask_tolerance: z.number().min(0).default(90),
  /** Inpaint strength on the stand-in. High: the figure is redrawn, not tinted. */
  denoise: z.number().min(0).max(1).default(0.9),
  mask_blur: z.number().int().min(0).default(8),
  inpaint_padding: z.number().int().min(0).default(64),
})
export type PlatesConfig = z.infer<typeof platesConfigSchema>

export const writerConfigSchema = z.object({
  backend: z.enum(['claude-cli', 'anthropic']).default('claude-cli'),
  model: z.string().default('claude-opus-5'),
})

export const configSchema = z.object({
  renderer: z.enum(['forge', 'mock']).default('forge'),
  forge: forgeConfigSchema,
  prompt: promptConfigSchema,
  page: pageConfigSchema.prefault({}),
  qa: qaConfigSchema.prefault({}),
  writer: writerConfigSchema.prefault({}),
  plates: platesConfigSchema.prefault({}),
  /** Chrome channel Playwright launches for the assembler. */
  browser: z.enum(['chrome', 'msedge', 'chromium']).default('chrome'),
  characters: z.record(z.string(), comicCharacterSchema),
})
export type Config = z.infer<typeof configSchema>
export type ForgeConfig = z.infer<typeof forgeConfigSchema>
export type QaConfig = z.infer<typeof qaConfigSchema>
