/**
 * The sketch route's first step: a picture of the whole panel, cached in
 * `sketches/` by the hash of what was asked, exactly like a plate. The picture
 * is a composition guide only — the renderer redraws the panel from its
 * lines, so nothing of it reaches the page.
 *
 * Two sources. OpenAI stages from sentences ("a hotel rooftop party, a water
 * tank on the lift housing"); a local tag model cannot say "on a roof" and
 * drew a night market and an endless floor of people instead (2026-09-24).
 * The local one is free, stays on the machine and may sketch anything. With
 * `auto`, the place-and-crowd panels go to OpenAI and everything else stays
 * local.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MockPlates } from '../plates/mock.ts'
import { OpenAiPlates } from '../plates/openai.ts'
import type { PlateBackend, PlateRequest } from '../plates/plate.ts'
import { buildPrompt, isWideShot } from '../prompt.ts'
import type { Project } from '../project.ts'
import { ForgeRenderer } from '../render/forge.ts'
import type { Reporter } from '../report.ts'
import type { Panel, Script } from '../schema.ts'
import { familyFor, panelSeed } from '../seed.ts'
import { ForgeSketches } from '../sketch/forge.ts'
import { describe, isExplicit, sketchPrompt } from '../sketch/prompt.ts'
import { drawCached, plateSizeForPanel } from './plates.ts'

export type SketchSource = 'openai' | 'forge' | 'mock'

function configured(project: Project): string {
  return process.env['COMIC_SKETCH'] ?? project.config.sketch.backend
}

export function sketchEnabled(project: Project): boolean {
  return configured(project) !== 'none'
}

/**
 * Where this panel's sketch comes from. `auto`: OpenAI for a panel whose
 * subject is the place or a crowd — nobody from the cast, a wide shot, or
 * more strangers than cast — and never for an explicit one; local otherwise.
 */
export function sketchSourceFor(project: Project, panel: Panel): SketchSource {
  const name = configured(project)
  if (name === 'mock' || name === 'forge' || name === 'openai') return name
  const explicit = isExplicit(panel.scene, panel.setting, ...panel.pose)
  // A character held by a reference sheet is only consistent when the sketch
  // is drawn FROM her sheet, which only the hosted model can do.
  if (!explicit && panel.characters.some((id) => project.config.characters[id]?.reference)) return 'openai'
  const figures = panel.figures ?? panel.characters.length
  // One stranger is enough: a tag model left out the guest who delivers the
  // compliment, and her "thanks" answered nobody (2026-09-24).
  const staged = panel.characters.length === 0 || isWideShot(panel.camera) || figures > panel.characters.length
  return !explicit && staged ? 'openai' : 'forge'
}

export function sketchBackendFor(project: Project, source: SketchSource): PlateBackend {
  if (source === 'mock') return new MockPlates()
  if (source === 'forge') return new ForgeSketches(new ForgeRenderer(project.config.forge), project.config.sketch.checkpoint, project.config.forge)
  return new OpenAiPlates(project.config.sketch.model)
}

export function sketchPaths(project: Project, id: string): { png: string; sidecar: string } {
  return { png: join(project.dir, 'sketches', `${id}.png`), sidecar: join(project.dir, 'sketches', `${id}.json`) }
}

/** Whether this panel may be sketched: never an explicit one by a hosted model. Locally, any. */
export function sketchable(project: Project, panel: Panel): boolean {
  return sketchSourceFor(project, panel) !== 'openai' || !isExplicit(panel.scene, panel.setting, ...panel.pose)
}

export function sketchRequestFor(project: Project, script: Script, where: { pageIndex: number; panelIndex: number }, variation = 0): PlateRequest {
  const page = script.pages[where.pageIndex]!
  const panel = page.panels[where.panelIndex]!
  const size = plateSizeForPanel(project, page, where.panelIndex)
  if (sketchSourceFor(project, panel) !== 'openai') {
    // A tag model gets the panel's own prompt, minus every LoRA, her body and
    // her look: the composition only. Her body words made NoobAI draw a
    // caricature the ControlNet then pressed onto every render, and her colour
    // words (aqua hair, aqua shirt) painted the whole sketch teal, which the
    // render carried over (2026-09-24). She comes from the render.
    const { prompt, negative } = buildPrompt(panel, script.characters, project.config, page.body, page.lighting, { lora: false, body: false, look: false })
    const seed = panelSeed(familyFor(script.characters, panel.characters), where.pageIndex, where.panelIndex, variation)
    return { prompt, negative, seed, size, quality: project.config.sketch.quality }
  }
  const cast = panel.characters.map((id, index) => ({ description: describe(script.characters[id]!), pose: panel.pose[index] }))
  const figures = panel.figures ?? panel.characters.length
  const sheets = panel.characters.map((id) => script.characters[id]?.reference).filter((p): p is string => !!p && existsSync(p)).map((p) => readFileSync(p))
  return {
    prompt: sketchPrompt({
      style: project.config.sketch.style,
      location: panel.location ? script.locations[panel.location] : undefined,
      setting: panel.setting,
      camera: panel.camera,
      cast,
      extras: Math.max(0, figures - panel.characters.length),
      details: panel.scene,
      variation,
    }),
    size,
    quality: project.config.sketch.quality,
    ...(sheets.length ? { references: sheets } : {}),
  }
}

/** One backend per source, made on first use and prepared once. */
export class SketchBackends {
  private readonly made = new Map<SketchSource, PlateBackend>()
  private readonly project: Project

  constructor(project: Project) {
    this.project = project
  }

  async for(panel: Panel): Promise<PlateBackend> {
    const source = sketchSourceFor(this.project, panel)
    let backend = this.made.get(source)
    if (!backend) {
      backend = sketchBackendFor(this.project, source)
      await backend.prepare()
      this.made.set(source, backend)
    }
    return backend
  }
}

export async function ensureSketch(
  project: Project,
  script: Script,
  backends: SketchBackends,
  where: { pageIndex: number; panelIndex: number },
  report: Reporter,
  force = false,
): Promise<{ png: Buffer; hash: string }> {
  const panel = script.pages[where.pageIndex]!.panels[where.panelIndex]!
  const paths = sketchPaths(project, panel.id)
  const backend = await backends.for(panel)
  const { hash, status } = await drawCached(backend, sketchRequestFor(project, script, where), paths, null, 0, force)
  report.emit({ event: 'plate', id: panel.id, status, message: `sketch by ${backend.name}` })
  return { png: readFileSync(paths.png), hash }
}
