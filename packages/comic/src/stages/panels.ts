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
import { bucketFor, cellAspect, resolveGrid, resolveSpans } from '../layouts.ts'
import { buildPrompt } from '../prompt.ts'
import { loadScript, writeJson, type Project } from '../project.ts'
import { ForgeRenderer } from '../render/forge.ts'
import { MockRenderer } from '../render/mock.ts'
import type { Prepared, Renderer } from '../render/renderer.ts'
import type { Reporter } from '../report.ts'
import type { Page, Panel, Script } from '../schema.ts'
import { familyFor, panelSeed } from '../seed.ts'

export interface PanelPlan {
  id: string
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

export interface PanelFilter {
  /** 1-based page number. */
  page?: number
  /** A panel id (`p2-3`) or its 1-based number within `--page`. */
  panel?: string
}

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

export function selectPanels(script: Script, filter: PanelFilter): Array<{ pageIndex: number; panelIndex: number }> {
  const picked: Array<{ pageIndex: number; panelIndex: number }> = []
  script.pages.forEach((page, pageIndex) => {
    if (filter.page !== undefined && filter.page !== pageIndex + 1) return
    page.panels.forEach((panel, panelIndex) => {
      if (filter.panel !== undefined) {
        const byNumber = /^\d+$/.test(filter.panel) && Number(filter.panel) === panelIndex + 1
        if (!byNumber && panel.id !== filter.panel) return
        if (byNumber && filter.page === undefined) throw new Error('--panel <number> needs --page; or give the panel id')
      }
      picked.push({ pageIndex, panelIndex })
    })
  })
  if (picked.length === 0) throw new Error('no panel matches the filter')
  return picked
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

  const grid = resolveGrid(page)
  const span = resolveSpans(page)[where.panelIndex]!
  const { width, height } = bucketFor(cellAspect(grid, span, project.config.page.width, project.config.page.height))
  const { prompt, negative } = buildPrompt(panel, script.characters, project.config)
  const seed = options.seed ?? panelSeed(familyFor(script.characters, panel.characters), where.pageIndex, where.panelIndex, attempt)

  const { forge } = project.config
  const request: RenderRequest = {
    prompt,
    negative,
    seed,
    width,
    height,
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
    hash: requestHash(request),
    pngPath,
    sidecarPath,
  }
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
  const result = await renderer.render(plan.request, (progress, eta) =>
    report.tick({ event: 'panel', id: plan.id, status: 'rendering', progress, eta, seed: plan.seed, attempt: plan.attempt }),
  )
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

export async function runPanels(
  project: Project,
  report: Reporter,
  filter: PanelFilter = {},
  options: PlanOptions & { force?: boolean; dryRun?: boolean; renderer?: Renderer } = {},
): Promise<PanelPlan[]> {
  const script = loadScript(project)
  const renderer = options.renderer ?? rendererFor(project)
  report.emit({ event: 'stage', stage: 'panels', status: 'start', message: `${renderer.name}, ${project.config.forge.checkpoint}` })
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
        message: `${plan.request.width}x${plan.request.height} — ${plan.request.prompt}`,
      })
    }
    return plans
  }
  // Sequential on purpose: there is one GPU, and Forge queues anyway.
  for (const plan of plans) {
    // eslint-disable-next-line no-await-in-loop
    await renderPlan(plan, renderer, report, options.force)
  }
  report.emit({ event: 'stage', stage: 'panels', status: 'done' })
  return plans
}
