/**
 * Who can be in a comic. A character is castable when two things are true
 * at once: the studio holds a developed canon for her, and Forge holds a
 * LoRA that draws her. Either alone is not a character the pipeline can use
 * — a canon without a LoRA cannot be rendered, a LoRA without a canon has
 * no voice — so `/story` offers only the ones that have both, and says why
 * the others are missing.
 *
 * The LoRA catalogue names characters by display name ("Celestial Oracle")
 * and the studio by id ("ari"); the trigger is the bridge when the names
 * disagree, since the trigger is the id in every LoRA built here.
 */

import { CUSTOM_LORAS, type LoraEntry } from '@luma/core'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { STEPS } from './facets.ts'
import { plan } from './plan.ts'
import { characterDir, type Studio } from './root.ts'

export interface Castable {
  id: string
  name: string
  /** Developed facets out of the ones the wizard develops. */
  facets: { done: number; total: number; missing: string[] }
  loras: { name: string; status: LoraEntry['status'] }[]
  /** Canon complete and at least one LoRA. */
  ready: boolean
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function lorasFor(id: string, entries: readonly LoraEntry[] = CUSTOM_LORAS): LoraEntry[] {
  return entries.filter((entry) => entry.trigger === id || slug(entry.character) === id)
}

function nameOf(studio: Studio, id: string): string {
  const core = join(characterDir(studio, id), 'core.md')
  if (!existsSync(core)) return id
  const text = readFileSync(core, 'utf8')
  // The seeded core has a "- Name:" line; a scaffolded one only its title.
  const name = text.match(/^- Name: ([^(\n]+)/m)?.[1] ?? text.match(/^# (.+?) — core/m)?.[1]
  return name?.trim() ?? id
}

export function listCharacters(studio: Studio, entries: readonly LoraEntry[] = CUSTOM_LORAS): Castable[] {
  const dir = join(studio.root, 'characters')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const facets = plan(studio, id).facets
      const missing = facets.filter((f) => f.empty).map((f) => f.facet)
      const loras = lorasFor(id, entries).map((l) => ({ name: l.name, status: l.status }))
      return {
        id,
        name: nameOf(studio, id),
        facets: { done: STEPS.length - missing.length, total: STEPS.length, missing },
        loras,
        ready: missing.length === 0 && loras.length > 0,
      }
    })
}

export function formatCharacters(list: Castable[]): string {
  if (list.length === 0) return 'No characters yet. `pnpm studio character new <id> --name "…"`'
  return list
    .map((c) => {
      const canon = c.facets.missing.length === 0 ? `canon ${c.facets.done}/${c.facets.total}` : `canon ${c.facets.done}/${c.facets.total} (missing ${c.facets.missing.join(', ')})`
      const loras = c.loras.length ? c.loras.map((l) => `${l.name} [${l.status}]`).join(', ') : 'no LoRA'
      return `${c.ready ? '[x]' : '[ ]'} ${c.id} — ${c.name}: ${canon}; ${loras}`
    })
    .join('\n')
}
