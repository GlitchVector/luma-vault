/**
 * The plate pass: a hosted model draws each location once (the master) and
 * then every panel set there as a view of that master, with a flat-coloured
 * stand-in where each character will go. The local pass paints the
 * characters in afterwards (`panels.ts`).
 *
 * A hosted model has no seed, so a plate is never regenerated unless its
 * request changes: the cache key is the prompt, the size, the quality and
 * the master it was shown. Plates are files in the project and belong in it
 * — they are the part of a comic that cannot be recomputed.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonical } from '../cache.ts'
import { bucketFor, cellAspect, resolveGrid, resolveSpans } from '../layouts.ts'
import { MockPlates } from '../plates/mock.ts'
import { OpenAiPlates } from '../plates/openai.ts'
import { plateSizeFor, type PlateBackend, type PlateRequest, type PlateSize } from '../plates/plate.ts'
import { masterPrompt, platePrompt } from '../plates/prompt.ts'
import { loadScript, writeJson, type Project } from '../project.ts'
import type { Reporter } from '../report.ts'
import type { Page, Panel, Script } from '../schema.ts'
import { selectPanels, type PanelFilter } from './select.ts'

export interface PlateSidecar {
  version: 1
  hash: string
  prompt: string
  size: PlateSize
  quality: string
  /** The master's hash, when the plate was drawn as a view of one. */
  master: string | null
  variation: number
  backend: string
  drawn_at: string
  backend_info?: unknown
}

export function platesEnabled(project: Project): boolean {
  return (process.env['COMIC_PLATES'] ?? project.config.plates.backend) !== 'none'
}

export function plateBackendFor(project: Project): PlateBackend {
  const name = process.env['COMIC_PLATES'] ?? project.config.plates.backend
  if (name === 'mock') return new MockPlates()
  return new OpenAiPlates(project.config.plates.model)
}

export function platePaths(project: Project, id: string): { png: string; sidecar: string } {
  return { png: join(project.dir, 'plates', `${id}.png`), sidecar: join(project.dir, 'plates', `${id}.json`) }
}

export function masterPaths(project: Project, location: string): { png: string; sidecar: string } {
  const safe = location.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'place'
  return platePaths(project, `location-${safe}`)
}

export function readPlateSidecar(path: string): PlateSidecar | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PlateSidecar
  } catch {
    return undefined
  }
}

function plateHash(request: Omit<PlateRequest, 'references'> & { master: string | null; backend: string }): string {
  return createHash('sha256').update(canonical(request)).digest('hex').slice(0, 16)
}

export async function drawCached(
  backend: PlateBackend,
  request: PlateRequest,
  paths: { png: string; sidecar: string },
  master: string | null,
  variation: number,
  force: boolean,
): Promise<{ hash: string; status: 'cached' | 'drawn' }> {
  const { references, ...rest } = request
  const hash = plateHash({ ...rest, master, backend: backend.name })
  const existing = readPlateSidecar(paths.sidecar)
  if (!force && existing?.hash === hash && existsSync(paths.png)) return { hash, status: 'cached' }
  const result = await backend.draw({ ...rest, references })
  mkdirSync(join(paths.png, '..'), { recursive: true })
  writeFileSync(paths.png, result.png)
  const sidecar: PlateSidecar = {
    version: 1,
    hash,
    prompt: request.prompt,
    size: request.size,
    quality: request.quality,
    master,
    variation,
    backend: backend.name,
    drawn_at: new Date().toISOString(),
    backend_info: result.info,
  }
  writeJson(paths.sidecar, sidecar)
  return { hash, status: 'drawn' }
}

/** The master plate of a location: drawn once, reused by every panel there. */
export async function ensureMaster(
  project: Project,
  script: Script,
  backend: PlateBackend,
  location: string,
  report: Reporter,
  force = false,
): Promise<{ png: Buffer; hash: string }> {
  const description = script.locations[location]
  if (!description) throw new Error(`panel names location "${location}", which the script's locations do not define`)
  const paths = masterPaths(project, location)
  const request: PlateRequest = {
    prompt: masterPrompt(project.config.plates.style, description),
    size: '1536x1024',
    quality: project.config.plates.quality,
  }
  const { hash, status } = await drawCached(backend, request, paths, null, 0, force)
  report.emit({ event: 'plate', id: `location-${location}`, status })
  return { png: readFileSync(paths.png), hash }
}

export function plateSizeForPanel(project: Project, page: Page, panelIndex: number): PlateSize {
  const grid = resolveGrid(page)
  const span = resolveSpans(page)[panelIndex]!
  const { width, height } = bucketFor(cellAspect(grid, span, project.config.page.width, project.config.page.height))
  return plateSizeFor(width, height)
}

/** One panel's plate, drawn as a view of its location's master. */
export async function ensurePlate(
  project: Project,
  script: Script,
  backend: PlateBackend,
  where: { pageIndex: number; panelIndex: number },
  report: Reporter,
  options: { force?: boolean; variation?: number } = {},
): Promise<{ png: Buffer; hash: string; status: 'cached' | 'drawn' }> {
  const page = script.pages[where.pageIndex]!
  const panel: Panel = page.panels[where.panelIndex]!
  const paths = platePaths(project, panel.id)
  const master = panel.location ? await ensureMaster(project, script, backend, panel.location, report, options.force) : null
  const figures = panel.figures ?? panel.characters.length
  const request: PlateRequest = {
    prompt: platePrompt({
      style: project.config.plates.style,
      location: panel.location ? script.locations[panel.location] : undefined,
      references: master !== null,
      setting: panel.setting,
      camera: panel.camera,
      poses: panel.pose,
      figures,
      reserve: panel.reserve_space,
      variation: options.variation,
    }),
    size: plateSizeForPanel(project, page, where.panelIndex),
    quality: project.config.plates.quality,
    input_fidelity: master ? project.config.plates.input_fidelity : undefined,
    references: master ? [master.png] : undefined,
  }
  const { hash, status } = await drawCached(backend, request, paths, master?.hash ?? null, options.variation ?? 0, options.force ?? false)
  report.emit({ event: 'plate', id: panel.id, status })
  return { png: readFileSync(paths.png), hash, status }
}

export async function runPlates(
  project: Project,
  report: Reporter,
  filter: PanelFilter = {},
  options: { force?: boolean; backend?: PlateBackend } = {},
): Promise<void> {
  const script = loadScript(project)
  const backend = options.backend ?? plateBackendFor(project)
  await backend.prepare()
  report.emit({ event: 'stage', stage: 'plates', status: 'start', message: `${backend.name}, ${project.config.plates.model}` })
  for (const where of selectPanels(script, filter)) {
    // One hosted call at a time: the calls are paid, and a refusal on one
    // panel should be read before ten more are sent.
    // eslint-disable-next-line no-await-in-loop
    await ensurePlate(project, script, backend, where, report, { force: options.force })
  }
  report.emit({ event: 'stage', stage: 'plates', status: 'done' })
}
