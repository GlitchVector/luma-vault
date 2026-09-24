/**
 * The sketch route's first step: a hosted model's picture of the whole panel,
 * cached in `sketches/` by the hash of what was asked, exactly like a plate.
 * The picture is a composition guide only — Forge redraws the panel from its
 * lines, so nothing of it reaches the page.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MockPlates } from '../plates/mock.ts'
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
  return new OpenAiPlates(project.config.sketch.model)
}

export function sketchPaths(project: Project, id: string): { png: string; sidecar: string } {
  return { png: join(project.dir, 'sketches', `${id}.png`), sidecar: join(project.dir, 'sketches', `${id}.json`) }
}

/** Whether this panel may be sketched at all: never an explicit one. */
export function sketchable(panel: Panel): boolean {
  return !isExplicit(panel.scene, panel.setting, ...panel.pose)
}

export function sketchRequestFor(project: Project, script: Script, where: { pageIndex: number; panelIndex: number }, variation = 0): PlateRequest {
  const page = script.pages[where.pageIndex]!
  const panel = page.panels[where.panelIndex]!
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
    size: plateSizeForPanel(project, page, where.panelIndex),
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
