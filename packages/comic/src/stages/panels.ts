/**
 * Stage 2: one PNG per panel, through the renderer seam.
 *
 * Planning and rendering are separate so QA can re-plan one panel at the
 * next attempt without re-reading anything. A plan is the exact request the
 * backend will get plus where its result goes; rendering it is the only
 * part that touches the GPU.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { requestHash, type RenderRequest, type Sidecar } from '../cache.ts'
import { bucketFor, sizeForCellBox, targetForCell } from '../layouts.ts'
import { buildPrompt } from '../prompt.ts'
import { DUMMIES, plateSizeFor, type PlateBackend } from '../plates/plate.ts'
import { maskForColour, maskPng } from '../plates/mask.ts'
import { loadScript, writeJson, type Project } from '../project.ts'
import { ForgeRenderer } from '../render/forge.ts'
import { MockRenderer } from '../render/mock.ts'
import type { InpaintRequest, Prepared, Renderer } from '../render/renderer.ts'
import type { Reporter } from '../report.ts'
import type { Page, Panel, Script } from '../schema.ts'
import { familyFor, panelSeed } from '../seed.ts'
import { ensurePlate, plateBackendFor, platesEnabled } from './plates.ts'
import type { PanelFilter } from './select.ts'
import { selectPanels } from './select.ts'

export interface PanelPlan {
  id: string
  /** The plate and one mask per character, once `finalizePlan` has run. */
  plate?: { png: Buffer; masks: Buffer[] }
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
  return new ForgeRenderer(project.config.forge)
}

export function loraNames(script: Script): string[] {
  return [...new Set(Object.values(script.characters).map((c) => c.lora.slice(0, c.lora.lastIndexOf(':'))))]
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
  const { prompt, negative } = buildPrompt(panel, script.characters, project.config)
  // With a plate, each character is painted alone into her own mask, so
  // each gets a prompt naming only her - the panel prompt names them all.
  const characterPrompts = panel.characters.map((id) => buildPrompt({ ...panel, characters: [id] }, script.characters, project.config).prompt)
  const seed = options.seed ?? panelSeed(familyFor(script.characters, panel.characters), where.pageIndex, where.panelIndex, attempt)

  const { forge } = project.config
  const request: RenderRequest = {
    prompt,
    negative,
    seed,
    width,
    height,
    hires: platesEnabled(project) ? undefined : hiresFor(project, page, where.panelIndex, width),
    steps: forge.steps,
    cfg: forge.cfg,
    sampler: forge.sampler,
    scheduler: forge.scheduler,
    checkpoint: prepared.checkpoint,
    clip_skip: forge.clip_skip,
    backend,
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

/** What a run needs besides the plan: the renderer, and the plate backend
 *  when plates are on. Made once per run, handed to every panel. */
export interface RenderContext {
  project: Project
  script: Script
  renderer: Renderer
  plates: PlateBackend | null
  report: Reporter
}

export async function contextFor(project: Project, report: Reporter, renderer?: Renderer, plates?: PlateBackend | null): Promise<RenderContext> {
  const script = loadScript(project)
  const chosen = renderer ?? rendererFor(project)
  const backend = plates === undefined ? (platesEnabled(project) ? plateBackendFor(project) : null) : plates
  if (backend) await backend.prepare()
  return { project, script, renderer: chosen, plates: backend, report }
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
  const result = plan.plate ? await paintCharacters(plan, plan.plate, renderer, onProgress) : await renderer.render(plan.request, onProgress)
  mkdirSync(dirname(plan.pngPath), { recursive: true })
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
  const prepared = await renderer.prepare({ checkpoint: project.config.forge.checkpoint, loras: loraNames(script) })
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
