/**
 * The sketch route's first step: a hosted model's picture of the whole panel,
 * cached in `sketches/` by the hash of what was asked, exactly like a plate.
 * The picture is a composition guide only — Forge redraws the panel from its
 * lines, so nothing of it reaches the page.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MockPlates } from '../plates/mock.ts'
import { ForgeRenderer } from '../render/forge.ts'
import { buildPrompt } from '../prompt.ts'
import { familyFor, panelSeed } from '../seed.ts'
import { ForgeSketches } from '../sketch/forge.ts'
import { OpenAiPlates } from '../plates/openai.ts'
import type { PlateBackend, PlateRequest } from '../plates/plate.ts'
import type { Project } from '../project.ts'
import type { Reporter } from '../report.ts'
import type { Panel, Script } from '../schema.ts'
import { describe, isExplicit, sketchPrompt } from '../sketch/prompt.ts'
import { drawCached, plateSizeForPanel } from './plates.ts'

export function sketchEnabled(project: Project): boolean {
  return (process.env['COMIC_SKETCH'] ?? project.config.sketch.backend) !== 'none'
}

export function sketchBackendFor(project: Project): PlateBackend {
  const name = process.env['COMIC_SKETCH'] ?? project.config.sketch.backend
  if (name === 'mock') return new MockPlates()
  if (name === 'forge') return new ForgeSketches(new ForgeRenderer(project.config.forge), project.config.sketch.checkpoint, project.config.forge)
  return new OpenAiPlates(project.config.sketch.model)
}

export function sketchPaths(project: Project, id: string): { png: string; sidecar: string } {
  return { png: join(project.dir, 'sketches', `${id}.png`), sidecar: join(project.dir, 'sketches', `${id}.json`) }
}

/** Whether this panel may be sketched: never an explicit one by a hosted model. Locally, any. */
export function sketchable(project: Project, panel: Panel): boolean {
  const backend = process.env['COMIC_SKETCH'] ?? project.config.sketch.backend
  return backend === 'forge' || !isExplicit(panel.scene, panel.setting, ...panel.pose)
}

export function sketchRequestFor(project: Project, script: Script, where: { pageIndex: number; panelIndex: number }, variation = 0): PlateRequest {
  const page = script.pages[where.pageIndex]!
  const panel = page.panels[where.panelIndex]!
  const size = plateSizeForPanel(project, page, where.panelIndex)
  if ((process.env['COMIC_SKETCH'] ?? project.config.sketch.backend) === 'forge') {
    // A tag model gets the panel's own prompt, minus every LoRA and her body:
    // the composition only. Her body words without her LoRA made NoobAI draw
    // a caricature, and the ControlNet then pressed that outline onto every
    // render of the panel (2026-09-24). Her body comes from the render.
    const { prompt, negative } = buildPrompt(panel, script.characters, project.config, page.body, page.lighting, { lora: false, body: false })
    const seed = panelSeed(familyFor(script.characters, panel.characters), where.pageIndex, where.panelIndex, variation)
    return { prompt, negative, seed, size, quality: project.config.sketch.quality }
  }
  const cast = panel.characters.map((id, index) => ({ description: describe(script.characters[id]!), pose: panel.pose[index] }))
  const figures = panel.figures ?? panel.characters.length
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
  }
}

export async function ensureSketch(
  project: Project,
  script: Script,
  backend: PlateBackend,
  where: { pageIndex: number; panelIndex: number },
  report: Reporter,
  force = false,
): Promise<{ png: Buffer; hash: string }> {
  const panel = script.pages[where.pageIndex]!.panels[where.panelIndex]!
  const paths = sketchPaths(project, panel.id)
  const { hash, status } = await drawCached(backend, sketchRequestFor(project, script, where), paths, null, 0, force)
  report.emit({ event: 'plate', id: panel.id, status, message: 'sketch' })
  return { png: readFileSync(paths.png), hash }
}
