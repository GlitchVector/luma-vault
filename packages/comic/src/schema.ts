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
  /** Which of Forge's upscalers enlarges a panel. Used by the second pass
   *  below, and by the assembler when a panel is still short of its cell.
   *  The anime models are right for this art; see `/sdapi/v1/upscalers`. */
  upscaler: z.string().default('R-ESRGAN 4x+ Anime6B'),
  /**
   * The second pass that brings a panel up to the size its cell will show
   * it at, inside the same txt2img call.
   *
   * It has to be the sampler and not the extras endpoint, because only the
   * sampler can DRAW at the larger size. An ESRGAN pass can sharpen a face
   * it can already see; it cannot add an eye to a head that was two hundred
   * pixels across, which is why enlarging finished panels made every face
   * worse the bigger the page got.
   */
  /**
   * The face pass: ADetailer finds a face, cuts it out, redraws it at a
   * sane size and pastes it back.
   *
   * It exists because the second pass fixed the big faces and not the small
   * ones. A face that occupies two percent of a wide shot is a hundred
   * pixels of a three megapixel render however well that render is drawn,
   * and a hundred pixels is not enough for eyes.
   *
   * Everything here is a guard against the one failure this house has
   * already had with ADetailer, which is the pass repainting something that
   * is not a face using a prompt written for one. `max_area` keeps it off
   * close-ups that do not need it, `solo_only` keeps it off panels where one
   * prompt would be painted onto two different people, and it never runs on
   * a panel with nobody in it.
   */
  face: z
    .object({
      enabled: z.boolean().default(true),
      /** The detector. The `n` model is the small one and is enough here. */
      model: z.string().default('face_yolov8n.pt'),
      /** How sure the detector has to be. Lower finds more non-faces. */
      confidence: z.number().min(0).max(1).default(0.35),
      /** Only repaint a face SMALLER than this share of the picture. A
       *  close-up's face is already drawn at size and repainting it only
       *  risks changing a face that is right. */
      max_area: z.number().min(0).max(1).default(0.1),
      /** How much of the face may be redrawn. Past about 0.5 it stops being
       *  her face. */
      denoise: z.number().min(0).max(1).default(0.4),
      /** The face is redrawn at this size whatever size it is in the
       *  picture. This is the whole point: the model gets a full canvas for
       *  something that was a hundred pixels. */
      size: z.number().int().min(256).max(2048).default(1024),
      /** Pixels of surrounding picture given to the repaint for context. */
      padding: z.number().int().min(0).default(32),
      /** Softness of the mask edge. His 2023 runs used a hard edge and the
       *  joins do not show, because the repaint is only the face. */
      mask_blur: z.number().int().min(0).default(0),
      /** Steps for the face alone. The face pass gets more than the body
       *  render, which is how a hundred-pixel face gets drawn properly. */
      steps: z.number().int().min(1).default(30),
      /** Guidance for the face alone, higher than the panel uses. */
      cfg: z.number().min(0).default(7),
      /** Off when a panel holds more than one character. One prompt over two
       *  faces paints the wrong person onto one of them. */
      solo_only: z.boolean().default(true),
      /** A different checkpoint for the face alone. Empty reuses the
       *  panel's; this house has painted an SD1.5 face onto an XL body. */
      checkpoint: z.string().default(''),
    })
    .prefault({}),
  hires: z
    .object({
      enabled: z.boolean().default(true),
      /** How much the second pass may redraw. Below about 0.35 it only
       *  sharpens; above about 0.55 it starts changing the picture, which
       *  would break the panel QA already passed. */
      denoise: z.number().min(0).max(1).default(0.45),
      /** Steps for the second pass. 0 means as many as the first pass. */
      steps: z.number().int().min(0).default(14),
      /** Not worth a pass below this: the panel is within a few percent of
       *  its cell already, and the browser's downsample is sharp. */
      min_factor: z.number().min(1).default(1.15),
      /** The ceiling, in megapixels. Past it the panel stays smaller and
       *  the assembler's upscaler makes up the rest — the fallback, not the
       *  plan. */
      max_megapixels: z.number().min(1).default(6),
    })
    .prefault({}),
})

export const promptConfigSchema = z.object({
  /** Quality words the checkpoint's family expects, first in every prompt. */
  quality: z.string().default('masterpiece, best quality'),
  /** A style block appended to every panel. Empty by default: the look of
   *  the book is the checkpoint's, and this is the one place to change it. */
  style: z.string().default(''),
  /**
   * The light the whole book is lit by, as tags.
   *
   * Its own field rather than part of `style`, because it is the setting
   * most likely to be changed and the one most likely to want overriding
   * for a stretch of pages: a book can turn from dawn to night halfway
   * through without its style changing at all.
   *
   * It is the counterweight to what a writer puts in a scene line. Words
   * like "grey morning" and "cold light" go straight into the prompt and
   * the model obeys them, which is how a whole book came back with no
   * colour in it.
   */
  lighting: z.string().default(''),
  negative: z.string().min(1),
  /** Lettering words. Added to every negative so the model does not draw
   *  the balloons the assembler is about to add. */
  negative_lettering: z.string().default('speech bubble, english text, multiple views'),
  /** How hard to push the framing words. 1 disables weighting. See
   *  `prompt.ts` for why the default is not 1. */
  camera_weight: z.number().min(1).max(2).default(1.35),
  /** The angle words are weighted separately and far more gently: pushed as
   *  hard as the framing, `from below` stops meaning "a low camera" and
   *  starts meaning "look up at a giant". */
  angle_weight: z.number().min(1).max(2).default(1.1),
  /** What a character's LoRA weight is multiplied by on a wide shot, so the
   *  scene has room and she reads at human scale. 1 disables it. */
  wide_lora_scale: z.number().min(0.1).max(1).default(0.6),
})

export const pageConfigSchema = z.object({
  /** The page in CSS pixels. 2000x3000 is 6.67 x 10 inches at 300 DPI,
   *  which is a standard comic trim, so the PDF prints correctly. */
  width: z.number().int().min(100).default(2000),
  height: z.number().int().min(100).default(3000),
  /**
   * Device pixels per CSS pixel. 2 is a retina page: the same layout at
   * twice the resolution, so the lettering is redrawn sharp rather than
   * enlarged, and the panels are upscaled by `forge.upscaler` first so they
   * are native at that size instead of stretched by the browser.
   */
  scale: z.number().min(1).max(4).default(1),
  /** The paper edge and the space between panels, in CSS pixels. Here as
   *  well as in `theme.css` because the upscaler has to know how big a cell
   *  really is; `page.ts` injects these so the two cannot drift. */
  margin: z.number().int().min(0).default(60),
  gutter: z.number().int().min(0).default(28),
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

/**
 * The sketch route (2026-09-24): a hosted model sketches the whole panel,
 * people and gestures included; Forge redraws it from scratch with
 * ControlNet reading the sketch, with NO character LoRA, so the crowd, a
 * stranger's gesture and the place come out as written; then each cast
 * character is repainted inside her own figure with her own LoRA. The
 * sketch never reaches the page, only its lines do. Replaces plates, which
 * failed on the stand-in mannequins; the two are not used together.
 */
export const sketchConfigSchema = z.object({
  /** `forge` sketches locally on `checkpoint` from the panel's own tags, no LoRA,
   *  nothing leaving the machine; `openai` stages from sentences, which a
   *  tag model cannot, at a price and never for an explicit panel. */
  backend: z.enum(['none', 'openai', 'forge', 'mock']).default('none'),
  model: z.string().default('gpt-image-2.5-sunburst'),
  /** The composing checkpoint for the `forge` backend. The house pair: NoobAI composes, delburry75 refines. */
  checkpoint: z.string().default('noobaiXLNAIXL_epsilonPred11Version'),
  quality: z.enum(['low', 'medium', 'high', 'auto']).default('medium'),
  style: z.string().default('clean comic illustration, clear readable poses, no text, no speech bubbles'),
  /** The ControlNet that reads the sketch. `model` is matched by substring against Forge's list. */
  control: z
    .object({
      module: z.string().default('lineart_anime'),
      model: z.string().default('noob-sdxl-controlnet-lineart_anime'),
      weight: z.number().min(0).max(2).default(0.85),
      end: z.number().min(0).max(1).default(0.8),
    })
    .prefault({}),
  /** Strength of the per-character repaint. Enough for the LoRA to take the face, body and outfit; low enough to keep the pose.
   *  0.6 left the first pass's outfit on her (a strap top, a button shirt), so 0.7. */
  character_denoise: z.number().min(0).max(1).default(0.7),
  /** How far a figure's mask grows, as a share of the figure's own height. Her
   *  LoRA body is curvier than the first pass's figure and an inpaint cannot
   *  paint outside its mask: a tight one flattens her hips and clips her hair. */
  mask_grow: z.number().min(0).max(0.5).default(0.08),
  mask_blur: z.number().int().min(0).default(16),
  inpaint_padding: z.number().int().min(0).default(96),
  /**
   * The third pass: a light img2img over the finished panel, so the light is
   * computed once for everything in it. The repaint draws her in a crop of
   * her own and never sees the scene's light, and she came out studio-lit on
   * an evening rooftop (2026-09-24). A ControlNet reading the panel itself
   * keeps every shape; her LoRA rides at a reduced weight so her face does
   * not drift back to a generic one.
   */
  unify: z
    .object({
      enabled: z.boolean().default(true),
      denoise: z.number().min(0).max(1).default(0.45),
      /** 0 draws the light pass with no LoRA at all: her LoRA carries the glossy
       *  studio light of her reference sheets and re-applied exactly the
       *  pasted-in look this pass exists to remove (2026-09-24). Her face is
       *  then restored by `face`. */
      lora_scale: z.number().min(0).max(2).default(0),
      /** A face pass with her LoRA on top of the light pass, for a panel with one cast member. */
      face: z.boolean().default(true),
      control_weight: z.number().min(0).max(2).default(0.6),
    })
    .prefault({}),
})
export type SketchConfig = z.infer<typeof sketchConfigSchema>

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
  sketch: sketchConfigSchema.prefault({}),
  /**
   * Where a finished comic is copied so the vault can see it as a set.
   *
   * Forge already leaves a copy of every panel in whatever dated folder it
   * was writing to, which is worse than useless: eleven pictures among the
   * day's other work, named by Forge, with nothing saying they belong
   * together. Collecting deliberately replaces that, so 
   * should be off wherever this is on.
   */
  vault: z
    .object({
      /** The watched folder to copy into. Empty means do not collect. */
      outdir: z.string().default(''),
    })
    .prefault({}),
  /** Chrome channel Playwright launches for the assembler. */
  browser: z.enum(['chrome', 'msedge', 'chromium']).default('chrome'),
  characters: z.record(z.string(), comicCharacterSchema),
})
export type Config = z.infer<typeof configSchema>
export type ForgeConfig = z.infer<typeof forgeConfigSchema>
export type QaConfig = z.infer<typeof qaConfigSchema>
