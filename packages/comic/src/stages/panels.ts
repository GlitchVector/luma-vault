/**
 * Stage 2: one PNG per panel, through the renderer seam.
 *
 * Planning and rendering are separate so QA can re-plan one panel at the
 * next attempt without re-reading anything. A plan is the exact request the
 * backend will get plus where its result goes; rendering it is the only
 * part that touches the GPU.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { run } from '../assemble/faces.ts'
import { requestHash, type RenderRequest, type Sidecar } from '../cache.ts'
import { bucketFor, sizeForCellBox, targetForCell } from '../layouts.ts'
import { buildPrompt, facePrompt, regionPrompt, scaleLora } from '../prompt.ts'
import { DUMMIES, plateSizeFor, type PlateBackend } from '../plates/plate.ts'
import { maskForColour, maskPng } from '../plates/mask.ts'
import { PNG } from 'pngjs'
import { loadScript, PACKAGE_DIR, REPO_ROOT, writeJson, type Project } from '../project.ts'
import { ComfyRenderer } from '../render/comfy.ts'
import { ForgeRenderer } from '../render/forge.ts'
import { MockRenderer } from '../render/mock.ts'
import type { InpaintRequest, Prepared, Renderer } from '../render/renderer.ts'
import type { Reporter } from '../report.ts'
import type { Page, Panel, Script } from '../schema.ts'
import { familyFor, panelSeed } from '../seed.ts'
import { assignFigures, findPeople } from '../sketch/people.ts'
import { isExplicit } from '../sketch/prompt.ts'
import { ensurePlate, plateBackendFor, platesEnabled } from './plates.ts'
import { ensureSketch, SketchBackends, sketchable, sketchEnabled } from './sketch.ts'
import type { PanelFilter } from './select.ts'
import { selectPanels } from './select.ts'

export interface PanelPlan {
  id: string
  /** The plate and one mask per character, once `finalizePlan` has run. */
  plate?: { png: Buffer; masks: Buffer[] }
  /** The sketch route: the hosted sketch the ControlNet reads, once `finalizePlan` has run. */
  sketch?: { png: Buffer; python: string }
  /** One prompt per character in the panel, for painting each alone. */
  characterPrompts?: string[]
  pageIndex: number
  panelIndex: number
  page: Page
  panel: Panel
  attempt: number
  seed: number
  request: RenderRequest
  hash: string
  pngPath: string
  sidecarPath: string
}

export { selectPanels, type PanelFilter } from './select.ts'

export interface PlanOptions {
  /** A seed to use instead of the family arithmetic. Only with one panel. */
  seed?: number
  /** Attempt to plan at; otherwise the sidecar's, otherwise 0. */
  attempt?: number
}

export function rendererFor(project: Project): Renderer {
  const name = process.env['COMIC_RENDERER'] ?? project.config.renderer
  if (name === 'mock') return new MockRenderer()
  if (name === 'comfy') return new ComfyRenderer(project.config.comfy)
  return new ForgeRenderer(project.config.forge)
}

export function loraNames(script: Script): string[] {
  return [...new Set(Object.values(script.characters).filter((c) => c.lora).map((c) => c.lora.slice(0, c.lora.lastIndexOf(':'))))]
}

export function readSidecar(path: string): Sidecar | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Sidecar
  } catch {
    return undefined
  }
}

export function planPanel(
  project: Project,
  script: Script,
  prepared: Prepared,
  where: { pageIndex: number; panelIndex: number },
  options: PlanOptions = {},
  backend = 'forge',
): PanelPlan {
  const page = script.pages[where.pageIndex]!
  const panel = page.panels[where.panelIndex]!
  // Hard rules for a character under 18, checked on every plan, never configurable.
  const minors = panel.characters.filter((id) => script.characters[id]?.minor)
  if (minors.length > 0) {
    if (isExplicit(panel.scene, panel.setting, ...panel.pose)) throw new Error(`${panel.id}: ${minors.join(', ')} is under 18 and the panel is explicit; this pipeline never renders that`)
    const withLora = minors.filter((id) => script.characters[id]!.lora)
    if (withLora.length > 0) throw new Error(`${panel.id}: ${withLora.join(', ')} is under 18 and has a LoRA; a minor is drawn without one`)
  }
  const pngPath = join(project.panelsDir, `${panel.id}.png`)
  const sidecarPath = join(project.panelsDir, `${panel.id}.json`)
  const attempt = options.attempt ?? readSidecar(sidecarPath)?.attempt ?? 0

  // The cell's TRUE aspect — page minus margins, minus the gutters between
  // tracks — so `object-fit: cover` has nothing to crop. Measuring it off
  // the raw grid instead leaves a couple of percent, which is small and is
  // still a face getting shaved on a wide panel.
  let { width, height } = sizeForCellBox(page, where.panelIndex, project.config.page)
  const aspect = width / height
  if (platesEnabled(project)) {
    // The plate is the init image, so the request is the plate's size - one
    // of the three the hosted model draws - not the SDXL bucket.
    const bucket = bucketFor(aspect)
    const [w, h] = plateSizeFor(bucket.width, bucket.height).split('x').map(Number) as [number, number]
    width = w
    height = h
  }
  // The sketch route draws the first pass with nobody's LoRA: the LoRA is what
  // pulled every panel onto her, and each character gets hers in the repaint.
  const sketched = sketchEnabled(project) && !!prepared.control && sketchable(project, panel)
  // One pass whenever at most one cast member is in the panel: her LoRA over
  // the whole panel, the sketch only guiding the layout, so she and the place
  // are one render with one light (the repaint route read as pasted-in). Two
  // or more cast members still need the multi-pass route, or their LoRAs
  // would share a prompt.
  // ComfyUI can confine each LoRA to its character's figure in ONE render, so
  // there every panel with a cast is regional: the place drawn with no LoRA
  // and none of her colours, each character with hers, lit like the place.
  const regional = sketched && backend === 'comfy' && panel.characters.length > 0
  const multi = sketched && !regional && panel.characters.length > 1
  const built = buildPrompt(panel, script.characters, project.config, page.body, page.lighting, { lora: !multi })
  const background = regional ? buildPrompt(panel, script.characters, project.config, page.body, page.lighting, { lora: false, body: false, look: false }).prompt : ''
  const prompt = regional ? background : built.prompt
  const negative = built.negative
  // With a plate, each character is painted alone into her own mask, so
  // each gets a prompt naming only her - the panel prompt names them all.
  // No `figures` here: a mask holds one character, never the crowd around her.
  const characterPrompts = panel.characters.map((id) => buildPrompt({ ...panel, characters: [id], figures: undefined }, script.characters, project.config, page.body, page.lighting).prompt)
  const seed = options.seed ?? panelSeed(familyFor(script.characters, panel.characters), where.pageIndex, where.panelIndex, attempt)

  const { forge } = project.config
  const request: RenderRequest = {
    prompt,
    negative,
    seed,
    width,
    height,
    hires: platesEnabled(project) ? undefined : hiresFor(project, page, where.panelIndex, width),
    // On the sketch route the face pass is a plain one, no LoRA: it only
    // cleans up small faces in the crowd (a guest's face came back as a teal
    // block). The cast's faces are redrawn by the repaint with their LoRAs.
    face: regional ? undefined : multi ? plainFaceFor(project, negative) : faceFor(project, panel, script),
    steps: forge.steps,
    cfg: forge.cfg,
    sampler: forge.sampler,
    scheduler: forge.scheduler,
    checkpoint: prepared.checkpoint,
    clip_skip: forge.clip_skip,
    backend,
    ...(sketched
      ? {
          control: { sketch: '', ...project.config.sketch.control, model: prepared.control! },
          repaint: multi
            ? {
                denoise: project.config.sketch.character_denoise,
                mask_blur: project.config.sketch.mask_blur,
                padding: project.config.sketch.inpaint_padding,
                grow: project.config.sketch.mask_grow,
                cast: panel.characters.map((id, index) => {
                  const character = script.characters[id]!
                  return {
                    id,
                    prompt: characterPrompts[index]!,
                    negative: [negative, character.negative].filter(Boolean).join(', '),
                    ...(character.hair?.length ? { hair: character.hair } : {}),
                  }
                }),
              }
            : undefined,
          regional: regional
            ? {
                background,
                grow: project.config.sketch.mask_grow,
                fade: project.config.sketch.lora_fade,
                ...(project.config.sketch.grade.enabled ? { grade: { lightness: project.config.sketch.grade.lightness, colour: project.config.sketch.grade.colour } } : {}),
                cast: panel.characters.map((id, index) => {
                  const character = script.characters[id]!
                  return {
                    id,
                    prompt: regionPrompt(character, panel, project.config, page.body, page.lighting, [panel.pose[index], ...actionTags(panel.scene)].filter(Boolean).join(', ')),
                    ...(character.hair?.length ? { hair: character.hair } : {}),
                  }
                }),
              }
            : undefined,
          unify:
            multi && project.config.sketch.unify.enabled
              ? {
                  prompt:
                    project.config.sketch.unify.lora_scale === 0
                      ? buildPrompt(panel, script.characters, project.config, page.body, page.lighting, { lora: false }).prompt
                      : buildPrompt(panel, withLoraScaled(script.characters, project.config.sketch.unify.lora_scale), project.config, page.body, page.lighting).prompt,
                  denoise: project.config.sketch.unify.denoise,
                  control_weight: project.config.sketch.unify.control_weight,
                  face: project.config.sketch.unify.face && panel.characters.length === 1 ? faceFor(project, panel, script) : undefined,
                }
              : undefined,
        }
      : {}),
  }
  return {
    id: panel.id,
    pageIndex: where.pageIndex,
    panelIndex: where.panelIndex,
    page,
    panel,
    attempt,
    seed,
    request,
    characterPrompts,
    hash: requestHash(request),
    pngPath,
    sidecarPath,
  }
}

/**
 * The second pass, when the cell is meaningfully bigger than the composed
 * panel — which on any retina page it is.
 *
 * Skipped with plates on: that path inpaints into a hosted picture at the
 * hosted picture's size, and a hires pass would fight it.
 */
function hiresFor(project: Project, page: Page, index: number, width: number): RenderRequest['hires'] {
  const { hires, upscaler } = project.config.forge
  if (!hires.enabled) return undefined
  const target = targetForCell(page, index, project.config.page, project.config.page.scale, hires.max_megapixels)
  if (target.width <= width * hires.min_factor) return undefined
  return { width: target.width, height: target.height, upscaler, denoise: hires.denoise, steps: hires.steps }
}

/**
 * The sketch route's face pass: every small face, with no LoRA and no
 * character in the prompt. Not `solo_only`: it is for the crowd.
 */
function plainFaceFor(project: Project, negative: string): RenderRequest['face'] {
  const { face } = project.config.forge
  if (!face.enabled) return undefined
  return {
    prompt: `${project.config.prompt.quality}, face, detailed eyes`,
    negative,
    model: face.model,
    confidence: face.confidence,
    max_area: face.max_area,
    denoise: face.denoise,
    size: face.size,
    padding: face.padding,
    mask_blur: face.mask_blur,
    steps: face.steps,
    cfg: face.cfg,
    checkpoint: face.checkpoint,
  }
}

/**
 * The face pass for this panel, or nothing.
 *
 * Nobody in the panel means no face to fix and a detector left free to find
 * one in the scenery, which this house has watched it do. More than one
 * character means one prompt would be painted onto two faces.
 */
function faceFor(project: Project, panel: Panel, script: Script): RenderRequest['face'] {
  const { face } = project.config.forge
  // The panel's own answer wins over the config's, either way round.
  if (!(panel.face ?? face.enabled)) return undefined
  if (panel.characters.length === 0) return undefined
  if (face.solo_only && panel.characters.length > 1) return undefined
  const character = script.characters[panel.characters[0]!]
  if (!character) return undefined
  return {
    prompt: facePrompt(character, project.config),
    negative: project.config.prompt.negative,
    model: face.model,
    confidence: face.confidence,
    max_area: face.max_area,
    denoise: face.denoise,
    size: face.size,
    padding: face.padding,
    mask_blur: face.mask_blur,
    steps: face.steps,
    cfg: face.cfg,
    checkpoint: face.checkpoint,
  }
}

/** What a run needs besides the plan: the renderer, and the plate backend
 *  when plates are on. Made once per run, handed to every panel. */
export interface RenderContext {
  project: Project
  script: Script
  renderer: Renderer
  plates: PlateBackend | null
  /** The sketch backends, one per source, when the sketch route is on. */
  sketch: SketchBackends | null
  report: Reporter
}

export async function contextFor(project: Project, report: Reporter, renderer?: Renderer, plates?: PlateBackend | null): Promise<RenderContext> {
  const script = loadScript(project)
  const chosen = renderer ?? rendererFor(project)
  const backend = plates === undefined ? (platesEnabled(project) ? plateBackendFor(project) : null) : plates
  if (backend) await backend.prepare()
  const sketch = sketchEnabled(project) ? new SketchBackends(project) : null
  return { project, script, renderer: chosen, plates: backend, sketch, report }
}

/** How many stand-in retries a panel gets when the hosted model drew none. */
const PLATE_VARIATIONS = 2

/**
 * With plates on, draw (or reuse) the panel's plate, find each character's
 * stand-in, and fold the plate into the request so the cache key changes
 * with it. Without plates this is the identity.
 *
 * A plate with no stand-in where one was asked for is asked for again as a
 * variation, twice; after that the panel fails and says so, rather than
 * painting a character over nothing.
 */
export async function finalizePlan(plan: PanelPlan, context: RenderContext): Promise<PanelPlan> {
  if (context.sketch && plan.request.control) {
    const sketch = await ensureSketch(context.project, context.script, context.sketch, plan, context.report)
    const request: RenderRequest = { ...plan.request, control: { ...plan.request.control, sketch: sketch.hash } }
    return { ...plan, request, hash: requestHash(request), sketch: { png: sketch.png, python: context.project.config.qa.python } }
  }
  if (!context.plates) return plan
  const { plates: config } = context.project.config
  const figures = plan.panel.figures ?? plan.panel.characters.length
  const wanted = Math.min(plan.panel.characters.length, figures)
  for (let variation = 0; variation <= PLATE_VARIATIONS; variation++) {
    // eslint-disable-next-line no-await-in-loop
    const plate = await ensurePlate(context.project, context.script, context.plates, plan, context.report, {
      variation,
      force: variation > 0,
    })
    const masks: Buffer[] = []
    const missing: string[] = []
    for (let index = 0; index < wanted; index++) {
      const dummy = DUMMIES[index] ?? DUMMIES[DUMMIES.length - 1]!
      const mask = maskForColour(plate.png, dummy.rgb, config.mask_tolerance, config.mask_grow)
      if (mask.found === 0) missing.push(dummy.name)
      masks.push(maskPng(mask))
    }
    if (missing.length === 0) {
      const request: RenderRequest = {
        ...plan.request,
        plate: {
          hash: plate.hash,
          denoise: config.denoise,
          mask_grow: config.mask_grow,
          mask_tolerance: config.mask_tolerance,
          mask_blur: config.mask_blur,
          padding: config.inpaint_padding,
        },
      }
      return { ...plan, request, hash: requestHash(request), plate: { png: plate.png, masks } }
    }
    context.report.emit({ event: 'plate', id: plan.id, status: 'failed', message: `no ${missing.join(' or ')} stand-in in the plate${variation < PLATE_VARIATIONS ? ', asking for a variation' : ''}` })
  }
  throw new Error(`${plan.id}: the plate never contained the stand-in figure(s) - reword setting/pose, or lower plates.mask_tolerance`)
}

export function isCached(plan: PanelPlan): boolean {
  const sidecar = readSidecar(plan.sidecarPath)
  return sidecar?.hash === plan.hash && existsSync(plan.pngPath)
}

export async function renderPlan(plan: PanelPlan, renderer: Renderer, report: Reporter, force = false): Promise<'cached' | 'rendered'> {
  if (!force && isCached(plan)) {
    report.emit({ event: 'panel', id: plan.id, status: 'cached', seed: plan.seed, attempt: plan.attempt })
    return 'cached'
  }
  report.emit({ event: 'panel', id: plan.id, status: 'rendering', seed: plan.seed, attempt: plan.attempt })
  const onProgress = (progress: number, eta: number | undefined) =>
    report.tick({ event: 'panel', id: plan.id, status: 'rendering', progress, eta, seed: plan.seed, attempt: plan.attempt })
  const result = plan.sketch
    ? await paintFromSketch(plan, plan.sketch, renderer, report, onProgress)
    : plan.plate
      ? await paintCharacters(plan, plan.plate, renderer, onProgress)
      : await renderer.render(plan.request, onProgress)
  mkdirSync(dirname(plan.pngPath), { recursive: true })
  archive(plan)
  writeFileSync(plan.pngPath, result.png)
  const sidecar: Sidecar = {
    version: 1,
    panel: plan.id,
    page: plan.pageIndex + 1,
    attempt: plan.attempt,
    seed: plan.seed,
    hash: plan.hash,
    request: plan.request,
    rendered_at: new Date().toISOString(),
    backend_info: result.info,
  }
  writeJson(plan.sidecarPath, sidecar)
  report.emit({ event: 'panel', id: plan.id, status: 'rendered', seed: plan.seed, attempt: plan.attempt })
  return 'rendered'
}

/**
 * Put the panel that is about to be replaced somewhere it can be found again.
 *
 * Getting an outfit right is a matter of rolling the seed until it is, and
 * the roll after the good one used to destroy it. The kept copy carries the
 * hash of the request that drew it, so two attempts at one seed are two
 * files and re-rendering the same thing twice is one.
 */
export function archive(plan: PanelPlan): void {
  if (!existsSync(plan.pngPath)) return
  const sidecar = readSidecar(plan.sidecarPath)
  const dir = join(dirname(plan.pngPath), 'history')
  mkdirSync(dir, { recursive: true })
  const stamp = `${plan.id}-${sidecar?.seed ?? 'noseed'}-${sidecar?.hash ?? 'nohash'}`
  const kept = join(dir, `${stamp}.png`)
  if (existsSync(kept)) return
  copyFileSync(plan.pngPath, kept)
  if (sidecar) writeJson(join(dir, `${stamp}.json`), sidecar)
}

/**
 * The sketch route, after the sketch exists: the whole panel from the sketch's
 * lines with nobody's LoRA, then each cast character repainted inside her own
 * figure with her own prompt and LoRA — the N largest figures, left to right,
 * which is the order the sketch placed the cast in. A two-character panel is
 * two solo repaints, so the LoRAs never share a prompt.
 */
async function paintFromSketch(
  plan: PanelPlan,
  sketch: { png: Buffer; python: string },
  renderer: Renderer,
  report: Reporter,
  onProgress: (progress: number, eta: number | undefined) => void,
): Promise<{ png: Buffer; info?: unknown }> {
  const regional = plan.request.regional
  if (regional && renderer.renderRegional) {
    // Her figure is found in the SKETCH, before anything is drawn: the render
    // follows the sketch's layout, so her mask there is where she will be.
    const hair = Object.fromEntries(regional.cast.filter((c) => c.hair?.length).map((c) => [c.id, c.hair!]))
    const people = await findPeople(sketch.python, sketch.png, { grow: regional.grow, hair })
    const assigned = assignFigures(people, regional.cast)
    const { width, height } = PNG.sync.read(sketch.png)
    const regions = regional.cast.map((member, index) => {
      const mine = assigned.filter((a) => a.castIndex === index).map((a) => a.person.mask)
      if (mine.length === 0) report.emit({ event: 'note', message: `${plan.id}: no figure found for ${member.id} in the sketch; masked by the framing instead` })
      return { prompt: member.prompt, mask: mine.length ? unionMask(mine) : framingMask(width, height, plan.panel.camera) }
    })
    const rendered = await renderer.renderRegional(plan.request, regional.background, regions, sketch.png, onProgress, plan.request.regional?.fade)
    const grade = plan.request.regional?.grade
    if (!grade) return rendered
    return { png: await gradeFigures(sketch.python, rendered.png, regions.map((r) => r.mask), grade), info: rendered.info }
  }
  const first = await renderer.render(plan.request, onProgress, sketch.png)
  const repaint = plan.request.repaint
  if (!repaint || repaint.cast.length === 0) return first
  const hair = Object.fromEntries(repaint.cast.filter((c) => c.hair?.length).map((c) => [c.id, c.hair!]))
  const people = await findPeople(sketch.python, first.png, { grow: repaint.grow, hair })
  const assigned = assignFigures(people, repaint.cast)
  const missing = repaint.cast.filter((_, index) => !assigned.some((a) => a.castIndex === index)).map((c) => c.id)
  if (missing.length > 0) {
    report.emit({ event: 'note', message: `${plan.id}: no figure found for ${missing.join(', ')}; that part keeps the first pass` })
  }
  let current = first.png
  const infos: unknown[] = [first.info]
  for (const { castIndex, person } of assigned) {
    const member = repaint.cast[castIndex]!
    const request: InpaintRequest = {
      ...plan.request,
      // The face pass belongs to the first pass; the repaint draws her face itself.
      face: undefined,
      prompt: member.prompt,
      negative: member.negative,
      init: current,
      mask: person.mask,
      denoise: repaint.denoise,
      mask_blur: repaint.mask_blur,
      padding: repaint.padding,
      controlImage: sketch.png,
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await renderer.inpaint(request, onProgress)
    current = result.png
    infos.push(result.info)
  }
  const unify = plan.request.unify
  if (unify && assigned.length > 0) {
    // The whole panel under a white mask at its own full size: one light for
    // everything, the ControlNet reading the panel itself so no shape moves.
    const { width, height } = PNG.sync.read(current)
    const result = await renderer.inpaint(
      {
        ...plan.request,
        // Her face back with her LoRA, after the light pass drew it without one.
        face: unify.face,
        prompt: unify.prompt,
        width,
        height,
        init: current,
        mask: maskPng({ width, height, data: new Uint8Array(width * height).fill(255), found: width * height }),
        denoise: unify.denoise,
        mask_blur: 0,
        padding: 0,
        control: plan.request.control ? { ...plan.request.control, weight: unify.control_weight } : undefined,
        controlImage: current,
      },
      onProgress,
    )
    current = result.png
    infos.push(result.info)
  }
  return { png: current, info: infos }
}

/**
 * Where she probably is when the detector found nobody: it misses tight crops
 * (a face, a hand on a wrist), and a whole-panel mask put her LoRA and colours
 * back over the room (2026-09-24). The framing says how much of the panel she
 * fills: a centred box, bottom-anchored, wider the closer the shot, leaving
 * the edges to the place.
 */
export function framingMask(width: number, height: number, camera: string): Buffer {
  const plain = camera.toLowerCase()
  const share = /close-up|portrait|face/.test(plain) ? 0.7 : /upper body|bust/.test(plain) ? 0.62 : /cowboy/.test(plain) ? 0.5 : 0.4
  const top = /close-up|portrait|face|upper body|bust/.test(plain) ? 0.06 : 0.1
  const data = new Uint8Array(width * height)
  const x0 = Math.round((width * (1 - share)) / 2)
  const x1 = width - x0
  for (let y = Math.round(height * top); y < height; y++) data.fill(255, y * width + x0, y * width + x1)
  return maskPng({ width, height, data, found: 1 })
}

/** The grade.py pass over a finished regional render. */
async function gradeFigures(python: string, png: Buffer, masks: Buffer[], grade: { lightness: number; colour: number }): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'comic-grade-'))
  try {
    const input = join(dir, 'in.png')
    const output = join(dir, 'out.png')
    writeFileSync(input, png)
    const maskPaths = masks.map((mask, i) => {
      const path = join(dir, `mask-${i}.png`)
      writeFileSync(path, mask)
      return path
    })
    const { code, stderr } = await run(resolve(REPO_ROOT, python), [join(PACKAGE_DIR, 'python', 'grade.py'), input, output, ...maskPaths, '--l', String(grade.lightness), '--ab', String(grade.colour)])
    if (code !== 0) throw new Error(`grade.py exited with ${code}: ${stderr.trim().slice(-400)}`)
    return readFileSync(output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Expression and hand words from the scene tags: what her face and hands do in this panel. */
function actionTags(scene: string): string[] {
  const ACTION = /\b(smile|smiling|grin|frown|closed mouth|open mouth|wide-eyed|surprised|shocked|frozen|blush|crying|tears|angry|laughing|smirk|holding own wrist|hand on own wrist|holding|pointing|waving|arms crossed|looking back|looking at viewer|looking away|talking|biting lip)\b/i
  return scene.split(',').map((t) => t.trim()).filter((t) => t && ACTION.test(t))
}

/** Several figure masks as one: her and her reflection are one region. */
function unionMask(masks: Buffer[]): Buffer {
  const images = masks.map((m) => PNG.sync.read(m))
  const { width, height } = images[0]!
  const data = new Uint8Array(width * height)
  for (const image of images) for (let i = 0; i < data.length; i++) if (image.data[i * 4]! > 127) data[i] = 255
  return maskPng({ width, height, data, found: 1 })
}

/** The cast with every LoRA weight scaled, for the unify pass. */
function withLoraScaled(characters: Script['characters'], scale: number): Script['characters'] {
  return Object.fromEntries(Object.entries(characters).map(([id, c]) => [id, { ...c, lora: scaleLora(c.lora, scale) }]))
}

/**
 * The local pass over a plate: each character painted into her stand-in's
 * mask in turn, the output of one the input of the next. The prompt for each
 * names only that character, so a two-figure panel is two solo inpaints and
 * the LoRAs never share a prompt.
 */
async function paintCharacters(
  plan: PanelPlan,
  plate: { png: Buffer; masks: Buffer[] },
  renderer: Renderer,
  onProgress: (progress: number, eta: number | undefined) => void,
): Promise<{ png: Buffer; info?: unknown }> {
  const settings = plan.request.plate!
  let current = plate.png
  const infos: unknown[] = []
  for (const [index, mask] of plate.masks.entries()) {
    const request: InpaintRequest = {
      ...plan.request,
      face: undefined,
      prompt: plan.characterPrompts?.[index] ?? plan.request.prompt,
      init: current,
      mask,
      denoise: settings.denoise,
      mask_blur: settings.mask_blur,
      padding: settings.padding,
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await renderer.inpaint(request, onProgress)
    current = result.png
    infos.push(result.info)
  }
  return { png: current, info: infos }
}

/** What a panel will actually come out at, and how it gets there. */
function sizeOf(request: RenderRequest): string {
  const composed = `${request.width}x${request.height}`
  return request.hires ? `${composed} then ${request.hires.width}x${request.hires.height}` : composed
}

export async function runPanels(
  project: Project,
  report: Reporter,
  filter: PanelFilter = {},
  options: PlanOptions & { force?: boolean; dryRun?: boolean; renderer?: Renderer; plates?: PlateBackend | null } = {},
): Promise<PanelPlan[]> {
  const context = await contextFor(project, report, options.renderer, options.plates)
  const { script, renderer } = context
  report.emit({
    event: 'stage',
    stage: 'panels',
    status: 'start',
    message: `${renderer.name}, ${project.config.forge.checkpoint}${context.plates ? `, plates by ${context.plates.name}` : ''}`,
  })
  const where = selectPanels(script, filter)
  if (options.seed !== undefined && where.length !== 1) {
    throw new Error('--seed applies to exactly one panel; give --page and --panel')
  }
  const prepared = await renderer.prepare({
    checkpoint: project.config.forge.checkpoint,
    loras: loraNames(script),
    control: sketchEnabled(project) ? project.config.sketch.control.model : undefined,
  })
  const plans = where.map((w) => planPanel(project, script, prepared, w, options, renderer.name))
  if (options.dryRun) {
    for (const plan of plans) {
      report.emit({
        event: 'panel',
        id: plan.id,
        status: isCached(plan) ? 'cached' : 'planned',
        seed: plan.seed,
        attempt: plan.attempt,
        message: `${sizeOf(plan.request)} — ${plan.request.prompt}`,
      })
    }
    return plans
  }
  // Sequential on purpose: there is one GPU, and Forge queues anyway. A
  // panel whose plate has no stand-in is reported and skipped, never the
  // reason the other nine do not render.
  const done: PanelPlan[] = []
  let failed = 0
  for (const plan of plans) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const final = await finalizePlan(plan, context)
      // eslint-disable-next-line no-await-in-loop
      await renderPlan(final, renderer, report, options.force)
      done.push(final)
    } catch (error) {
      failed += 1
      report.emit({ event: 'panel', id: plan.id, status: 'failed', message: (error as Error).message })
    }
  }
  report.emit({ event: 'stage', stage: 'panels', status: failed ? 'failed' : 'done', message: failed ? `${failed} panel(s) did not render` : undefined })
  if (failed) process.exitCode = 1
  return done
}
