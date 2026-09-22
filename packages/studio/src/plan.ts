/**
 * What to develop next about a character, and what to ask.
 *
 * The facet files say what a character IS; this says what is still missing
 * and in which order to fill it, reading `facets.ts` for both. It is the
 * spine of the development loop: something else drives the conversation, and
 * this answers "where are we" between every step.
 *
 * Deliberately a report rather than a prompt loop. The interactive part is a
 * conversation with the person, and a conversation is not the studio's job —
 * the studio's job is to know the state of the folder and never to let an
 * approval happen without him.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { STEPS, isEmpty, type Step } from './facets.ts'
import { characterDir, type CharacterFile, type Studio } from './root.ts'
import { listSheets } from './sheets.ts'

export interface FacetState {
  facet: CharacterFile
  /** Nothing but the stub. */
  empty: boolean
  /** Lines of real content, so a thin facet is visible as well as an empty one. */
  lines: number
  because: string
  asks: string[]
  /** Needs a model that does not refuse adult material. */
  explicit: boolean
}

export interface Plan {
  character: string
  /** Pictures filed against her. The text model cannot see them; they are
   *  here so whoever develops her is told to go and look. */
  sheets: string[]
  facets: FacetState[]
  /** The first facet with nothing in it, which is where to work. */
  next: FacetState | null
  /** Proposals written but not yet approved or passed, oldest first. */
  waiting: string[]
}

function read(studio: Studio, id: string, facet: CharacterFile): string {
  const path = join(characterDir(studio, id), `${facet}.md`)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Proposal files with at least one item still unticked. */
export function openProposals(studio: Studio, id: string): string[] {
  const dir = join(characterDir(studio, id), 'proposals')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => readFileSync(join(dir, name), 'utf8').includes('- [ ]'))
    .sort()
}

export function plan(studio: Studio, id: string): Plan {
  const facets: FacetState[] = STEPS.map((step: Step) => {
    const text = read(studio, id, step.facet)
    return {
      facet: step.facet,
      empty: isEmpty(text),
      lines: text.split('\n').filter((line) => line.trim() && !line.startsWith('#') && !line.trim().startsWith('_')).length,
      because: step.because,
      asks: step.asks,
      explicit: step.explicit === true,
    }
  })
  return {
    character: id,
    sheets: listSheets(studio, id),
    facets,
    next: facets.find((facet) => facet.empty) ?? null,
    waiting: openProposals(studio, id),
  }
}

/**
 * The next question to actually ask, or null when the character is done.
 *
 * An ask that already has a proposals file is skipped even if nothing from
 * it was approved: he has seen those four options and either has not chosen
 * yet or chose none, and asking the identical question again would bury the
 * file he still owes an answer to. The slug is how they are matched, which
 * is the same slug `writeProposals` names the file with.
 */
export function nextAsk(
  studio: Studio,
  id: string,
): { facet: CharacterFile; ask: string; asked: number; explicit: boolean } | null {
  const dir = join(characterDir(studio, id), 'proposals')
  const existing = existsSync(dir) ? readdirSync(dir) : []
  const alreadyAsked = (ask: string) => {
    const slug = ask.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    return existing.some((name) => name.includes(slug))
  }
  for (const facet of plan(studio, id).facets) {
    if (!facet.empty) continue
    const fresh = facet.asks.filter((ask) => !alreadyAsked(ask))
    if (fresh.length > 0) {
      return { facet: facet.facet, ask: fresh[0]!, asked: facet.asks.length - fresh.length, explicit: facet.explicit }
    }
  }
  return null
}

export function formatPlan(found: Plan): string {
  const lines: string[] = [`${found.character} — what is still to develop`, '']
  for (const facet of found.facets) {
    const mark = facet.empty ? ' ' : 'x'
    const note = facet.empty ? '' : `  (${facet.lines} lines)`
    lines.push(`  [${mark}] ${facet.facet}${note}`)
  }
  if (found.sheets.length > 0) {
    lines.push('', `${found.sheets.length} sheet(s) to look at:`)
    for (const path of found.sheets) lines.push(`  ${path}`)
  }
  if (found.waiting.length > 0) {
    lines.push('', 'proposals waiting on you:')
    for (const name of found.waiting) lines.push(`  ${name}`)
  }
  if (found.next) {
    lines.push('', `next: ${found.next.facet} — ${found.next.because}`)
    if (found.next.explicit) {
      lines.push('  (needs a model that does not refuse adult material — see `studio model`)')
    }
    lines.push('', 'ask one of these, one brainstorm each:')
    for (const ask of found.next.asks) lines.push(`  studio character brainstorm ${found.character} "${ask}"`)
  } else {
    lines.push('', 'every facet has something in it. Deepen one, or move to the comic.')
  }
  return lines.join('\n')
}
