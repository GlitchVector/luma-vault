/**
 * What the project can always answer: which comics exist, where each is,
 * which scenes and panels are in which state, and what is blocking. Read
 * off the files, never off a cache, so it is right after a hand edit.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { comicDir, type Studio } from './root.ts'
import { listComics, listIds, readComic, readPanel, readScene, type PanelState } from './spec.ts'

export interface ComicStatus {
  id: string
  title: string
  concept: string
  outline: string
  scenes: Array<{ id: string; title: string; status: string; panels: number }>
  panels: Record<PanelState, number>
  blockers: string[]
}

export function comicStatus(studio: Studio, id: string): ComicStatus {
  const comic = readComic(studio, id)
  const panels = listIds(studio, id, 'panels').map((p) => readPanel(studio, id, p))
  const counts = Object.fromEntries(
    ['IDEA', 'PLANNED', 'GENERATING', 'REVIEW', 'CORRECTION', 'APPROVED', 'LETTERED', 'FINAL'].map((s) => [s, 0]),
  ) as Record<PanelState, number>
  for (const panel of panels) counts[panel.status] += 1
  const scenes = listIds(studio, id, 'scenes').map((s) => {
    const scene = readScene(studio, id, s)
    return { id: s, title: scene.title, status: scene.status, panels: panels.filter((p) => p.scene === s).length }
  })
  // A panel that has been directed three or more times and is still not
  // approved is where the time is going.
  const blockers = panels
    .filter((p) => p.history.length >= 3 && !['APPROVED', 'LETTERED', 'FINAL'].includes(p.status))
    .map((p) => `${p.id} — ${p.history.length} directions, still ${p.status}: last "${p.history.at(-1)?.instruction ?? ''}"`)
  const notes = join(comicDir(studio, id), 'blockers.md')
  if (existsSync(notes)) {
    for (const line of readFileSync(notes, 'utf8').split('\n')) if (line.trim().startsWith('- ')) blockers.push(line.trim().slice(2))
  }
  return { id, title: comic.title, concept: comic.concept, outline: comic.outline, scenes, panels: counts, blockers }
}

export function formatStatus(status: ComicStatus): string {
  const lines = [`COMIC ${status.id}${status.title ? ` — ${status.title}` : ''}`, '', `Concept: ${status.concept}`, `Outline: ${status.outline}`, '', 'Scenes:']
  if (status.scenes.length === 0) lines.push('  (none yet)')
  for (const s of status.scenes) lines.push(`  ${s.id}${s.title ? ` ${s.title}` : ''}: ${s.status} (${s.panels} panels)`)
  lines.push('', 'Panels:')
  const shown = Object.entries(status.panels).filter(([, n]) => n > 0)
  if (shown.length === 0) lines.push('  (none yet)')
  for (const [state, n] of shown) lines.push(`  ${state}: ${n}`)
  lines.push('', status.blockers.length ? 'Blockers:' : 'No blockers.')
  for (const b of status.blockers) lines.push(`  ${b}`)
  return lines.join('\n')
}

export function overview(studio: Studio): string {
  const comics = listComics(studio)
  if (comics.length === 0) return 'No comics yet. `pnpm studio comic new <id> --title "…" --characters ari`'
  return comics
    .map((id) => {
      const s = comicStatus(studio, id)
      const done = s.panels.APPROVED + s.panels.LETTERED + s.panels.FINAL
      const total = Object.values(s.panels).reduce((a, b) => a + b, 0)
      return `${id}${s.title ? ` — ${s.title}` : ''}: concept ${s.concept}, outline ${s.outline}, ${s.scenes.length} scenes, ${done}/${total} panels approved${s.blockers.length ? `, ${s.blockers.length} blocker(s)` : ''}`
    })
    .join('\n')
}
