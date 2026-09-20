/**
 * What the app needs to know about a project without rendering anything:
 * the settings in force, and which panels on disk are out of date.
 *
 * Staleness cannot be worked out by the host. A panel is current when a
 * freshly planned request hashes to what its sidecar recorded, and building
 * that request means building the prompt, which lives here. So the host asks
 * this, the same way it asks for a render.
 *
 * Nothing here talks to Forge. The checkpoint a request carries is the title
 * Forge resolved at render time, so rather than resolving it again this reuses
 * the one in the sidecar and separately checks that the configured name still
 * points at it. That keeps the check instant, and correct while the GPU is
 * off or busy.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RenderRequest } from '../cache.ts'
import { loadScript, type Project } from '../project.ts'
import type { Script } from '../schema.ts'
import { platesEnabled } from './plates.ts'
import { planPanel, readSidecar } from './panels.ts'

export interface PanelStatus {
  id: string
  /** `current`: the PNG matches what the script and config now ask for.
   *  `stale`: it was drawn from something else. `missing`: never drawn. */
  status: 'current' | 'stale' | 'missing'
  /** Why it is stale, in words, for the card's tooltip. */
  reason?: string
}

/** The handful of settings that change what comes out, for the app to show
 *  and, for the first four, to edit. */
export interface Settings {
  renderer: string
  checkpoint: string
  /** `prompt.style`: the style block appended to every panel. The one place
   *  the look of a book is changed. */
  style: string
  /** `prompt.quality`: the words that lead every prompt. */
  globalTags: string
  pageWidth: number
  pageHeight: number
  pageScale: number
  hiresEnabled: boolean
  hiresDenoise: number
  /** Whether the hosted plate pass is on. The app hides the fields only it
   *  reads when it is off, rather than showing inputs nothing consumes. */
  plates: boolean
}

export interface Inspection {
  settings: Settings
  panels: PanelStatus[]
}

export function settingsFor(project: Project): Settings {
  const { config } = project
  return {
    renderer: config.renderer,
    checkpoint: config.forge.checkpoint,
    style: config.prompt.style,
    globalTags: config.prompt.quality,
    pageWidth: config.page.width,
    pageHeight: config.page.height,
    pageScale: config.page.scale,
    hiresEnabled: config.forge.hires.enabled,
    hiresDenoise: config.forge.hires.denoise,
    plates: platesEnabled(project),
  }
}

/**
 * The first couple of differences between the request that drew a panel and
 * the one that would draw it now, in the person's words rather than field
 * names. Two is enough to act on; a full diff is what the sidecar is for.
 */
export function describeChange(before: RenderRequest, after: RenderRequest): string {
  const said: string[] = []
  const say = (what: string) => {
    if (!said.includes(what)) said.push(what)
  }
  if (before.prompt !== after.prompt) say('the prompt changed')
  if (before.negative !== after.negative) say('the negative changed')
  if (before.seed !== after.seed) say('the seed changed')
  if (before.width !== after.width || before.height !== after.height) say('the panel size changed')
  if (JSON.stringify(before.hires ?? null) !== JSON.stringify(after.hires ?? null)) {
    say(after.hires ? (before.hires ? 'the second pass changed' : 'a second pass was added') : 'the second pass was switched off')
  }
  if (before.checkpoint !== after.checkpoint) say('the checkpoint changed')
  for (const key of ['steps', 'cfg', 'sampler', 'scheduler', 'clip_skip'] as const) {
    if (before[key] !== after[key]) say('the sampler settings changed')
  }
  if (JSON.stringify(before.plate ?? null) !== JSON.stringify(after.plate ?? null)) say('the plate changed')
  if (said.length === 0) say('something in the request changed')
  return said.slice(0, 2).join(', ')
}

function statusFor(project: Project, script: Script, pageIndex: number, panelIndex: number, id: string): PanelStatus {
  const sidecar = readSidecar(join(project.panelsDir, `${id}.json`))
  if (!sidecar || !existsSync(join(project.panelsDir, `${id}.png`))) return { id, status: 'missing' }

  // The configured name is a substring matched against Forge's titles. If it
  // no longer matches the title that drew this panel, the next render loads a
  // different file, and no other field would show it.
  if (!sidecar.request.checkpoint.toLowerCase().includes(project.config.forge.checkpoint.toLowerCase())) {
    return { id, status: 'stale', reason: 'the checkpoint changed' }
  }
  // The CONFIGURED renderer, not the one in the sidecar: a panel the mock
  // drew is a coloured placeholder, and the app showed a folder of those as
  // finished work for two days because nothing compared the two.
  const renderer = process.env['COMIC_RENDERER'] ?? project.config.renderer
  if (sidecar.request.backend !== renderer) {
    return { id, status: 'stale', reason: `drawn by the ${sidecar.request.backend} renderer, not ${renderer}` }
  }
  const plan = planPanel(
    project,
    script,
    { checkpoint: sidecar.request.checkpoint },
    { pageIndex, panelIndex },
    { attempt: sidecar.attempt },
    renderer,
  )
  if (plan.hash === sidecar.hash) return { id, status: 'current' }
  return { id, status: 'stale', reason: describeChange(sidecar.request, plan.request) }
}

export function inspect(project: Project): Inspection {
  const settings = settingsFor(project)
  if (!existsSync(project.scriptPath)) return { settings, panels: [] }
  const script = loadScript(project)
  const panels: PanelStatus[] = []
  for (const [pageIndex, page] of script.pages.entries()) {
    for (const [panelIndex, panel] of page.panels.entries()) {
      // A panel whose plan cannot be built at all — an unknown layout, a
      // character the config dropped — is reported rather than thrown, so one
      // broken page does not cost the person the status of the other five.
      try {
        panels.push(statusFor(project, script, pageIndex, panelIndex, panel.id))
      } catch (error) {
        panels.push({ id: panel.id, status: 'stale', reason: (error as Error).message })
      }
    }
  }
  return { settings, panels }
}
