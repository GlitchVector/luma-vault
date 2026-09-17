/**
 * Stage 4: look at every rendered panel and retry the ones that failed.
 *
 * Hard failures only — a blank picture, the wrong number of people, an
 * anatomy tag, or nowhere to put the balloon. Nothing here has an opinion
 * about whether a panel is good; that is the difference between a gate the
 * owner can leave unattended and one that argues with him.
 *
 * A failed panel is re-rendered at the next attempt in its seed family and
 * inspected again, up to `qa.max_attempts`. The verdicts are written beside
 * the panels so the app and the next run can read them.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJson, type Project } from '../project.ts'
import type { Renderer } from '../render/renderer.ts'
import type { Reporter } from '../report.ts'
import { inspectPixels, type PixelVerdict } from '../qa/pixels.ts'
import { PythonTagger, judgeFigures, type Tagger, type Tags } from '../qa/tagger.ts'
import { contextFor, finalizePlan, isCached, loraNames, planPanel, renderPlan, selectPanels, type PanelFilter, type PanelPlan } from './panels.ts'
import type { PlateBackend } from '../plates/plate.ts'

export interface Verdict {
  panel: string
  attempt: number
  seed: number
  hash: string
  ok: boolean
  failures: string[]
  pixels: PixelVerdict
  tags?: Tags
  inspected_at: string
}

export interface QaOptions {
  retry?: boolean
  tagger?: Tagger | null
  renderer?: Renderer
  plates?: PlateBackend | null
}

export function verdictPath(project: Project, id: string): string {
  return join(project.qaDir, `${id}.json`)
}

export function readVerdict(project: Project, id: string): Verdict | undefined {
  const path = verdictPath(project, id)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Verdict
  } catch {
    return undefined
  }
}

export async function inspect(plan: PanelPlan, project: Project, tagger: Tagger | null): Promise<Verdict> {
  const png = readFileSync(plan.pngPath)
  const pixels = inspectPixels(png, plan.panel.reserve_space, project.config.qa)
  const failures: string[] = []
  if (pixels.blank) failures.push('blank: no picture')
  if (pixels.space_usable === false) failures.push(`space: nothing usable at ${plan.panel.reserve_space}`)

  let tags: Tags | undefined
  if (tagger && !pixels.blank) {
    tags = (await tagger.tag([plan.pngPath])).get(plan.pngPath) ?? {}
    const expected = plan.panel.figures ?? plan.panel.characters.length
    failures.push(...judgeFigures(tags, expected, project.config.qa.tag_threshold))
  }
  return {
    panel: plan.id,
    attempt: plan.attempt,
    seed: plan.seed,
    hash: plan.hash,
    ok: failures.length === 0,
    failures,
    pixels,
    tags,
    inspected_at: new Date().toISOString(),
  }
}

export async function runQa(project: Project, report: Reporter, filter: PanelFilter = {}, options: QaOptions = {}): Promise<Verdict[]> {
  const context = await contextFor(project, report, options.renderer, options.plates)
  const { script, renderer } = context
  const retry = options.retry ?? true
  let tagger: Tagger | null
  if (options.tagger !== undefined) {
    tagger = options.tagger
  } else {
    const python = new PythonTagger(project.config.qa)
    const why = python.available()
    if (why) throw new Error(`QA needs the tagger to count figures: ${why}. Pass --no-tagger to inspect pixels only.`)
    tagger = python
  }
  report.emit({ event: 'stage', stage: 'qa', status: 'start', message: tagger ? 'pixels + tagger' : 'pixels only' })

  const prepared = await renderer.prepare({ checkpoint: project.config.forge.checkpoint, loras: loraNames(script) })
  const verdicts: Verdict[] = []
  for (const where of selectPanels(script, filter)) {
    // Panel by panel, attempt by attempt: each render decides the next.
    // eslint-disable-next-line no-await-in-loop
    let plan = await finalizePlan(planPanel(project, script, prepared, where, {}, renderer.name), context)
    // eslint-disable-next-line no-await-in-loop
    if (!isCached(plan)) await renderPlan(plan, renderer, report)
    // eslint-disable-next-line no-await-in-loop
    let verdict = await inspect(plan, project, tagger)
    const lastAttempt = retry ? project.config.qa.max_attempts - 1 : plan.attempt
    while (!verdict.ok && plan.attempt < lastAttempt) {
      report.emit({ event: 'qa', id: plan.id, status: 'retry', failures: verdict.failures, attempt: plan.attempt })
      // eslint-disable-next-line no-await-in-loop
      plan = await finalizePlan(planPanel(project, script, prepared, where, { attempt: plan.attempt + 1 }, renderer.name), context)
      // eslint-disable-next-line no-await-in-loop
      await renderPlan(plan, renderer, report)
      // eslint-disable-next-line no-await-in-loop
      verdict = await inspect(plan, project, tagger)
    }
    writeJson(verdictPath(project, plan.id), verdict)
    report.emit({ event: 'qa', id: plan.id, status: verdict.ok ? 'ok' : 'failed', failures: verdict.failures, attempt: plan.attempt })
    verdicts.push(verdict)
  }
  const failed = verdicts.filter((v) => !v.ok)
  report.emit({
    event: 'stage',
    stage: 'qa',
    status: failed.length ? 'failed' : 'done',
    message: failed.length ? `${failed.length} panel(s) still failing after ${project.config.qa.max_attempts} attempts` : undefined,
  })
  return verdicts
}
