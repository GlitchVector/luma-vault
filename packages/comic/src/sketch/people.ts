/**
 * The figures in a first-pass panel, as masks, for the per-character repaint.
 *
 * The detector returns everyone: the cast and the crowd around them. The cast
 * is the biggest figures, so the repaint takes the N largest and then orders
 * them left to right, which is the order the sketch prompt placed the cast in.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PERSON_MODEL, run } from '../assemble/faces.ts'
import { PACKAGE_DIR, REPO_ROOT } from '../project.ts'

export interface Person {
  mask: Buffer
  /** x0, y0, x1, y1 as fractions of the picture. */
  box: [number, number, number, number]
  /** Share of the picture the figure covers. */
  area: number
  /** Per character id: the share of the figure's head in that character's hair colours. */
  match: Record<string, number>
}

/** A head this much in her hair colours is her (0.37-0.41 on a mirror panel, 0 on the guests). */
export const HAIR_MATCH = 0.2

/**
 * Which figure is repainted as which cast member.
 *
 * A character with hair colours gets every figure whose head carries them,
 * so her reflection in a mirror is her as well. The rest of the cast takes
 * the largest figures left, left to right, which is the order the sketch
 * placed them in.
 */
export function assignFigures<T extends Pick<Person, 'box' | 'area' | 'match'>>(
  people: T[],
  cast: Array<{ id: string; hair?: string[] }>,
): Array<{ castIndex: number; person: T }> {
  const taken = new Set<T>()
  const out: Array<{ castIndex: number; person: T }> = []
  const unmatched: number[] = []
  for (const [castIndex, member] of cast.entries()) {
    const mine = member.hair?.length ? people.filter((p) => !taken.has(p) && (p.match[member.id] ?? 0) >= HAIR_MATCH) : []
    if (mine.length === 0) unmatched.push(castIndex)
    for (const person of mine) {
      taken.add(person)
      out.push({ castIndex, person })
    }
  }
  const rest = castFigures(people.filter((p) => !taken.has(p)), unmatched.length)
  for (const [i, person] of rest.entries()) out.push({ castIndex: unmatched[i]!, person })
  return out
}

/** The `count` largest figures, left to right. */
export function castFigures<T extends Pick<Person, 'box' | 'area'>>(people: T[], count: number): T[] {
  const largest = [...people].sort((a, b) => b.area - a.area).slice(0, count)
  return largest.sort((a, b) => a.box[0] + a.box[2] - (b.box[0] + b.box[2]))
}

export async function findPeople(python: string, png: Buffer, options: { grow: number; hair: Record<string, string[]> }): Promise<Person[]> {
  const dir = mkdtempSync(join(tmpdir(), 'comic-people-'))
  try {
    const image = join(dir, 'panel.png')
    writeFileSync(image, png)
    const script = join(PACKAGE_DIR, 'python', 'people.py')
    const hair = Object.entries(options.hair).flatMap(([id, colours]) => ['--hair', `${id}=${colours.join(',')}`])
    const args = [script, resolve(REPO_ROOT, PERSON_MODEL), image, join(dir, 'masks'), '--grow', String(options.grow), ...hair]
    const { stdout, stderr, code } = await run(resolve(REPO_ROOT, python), args)
    if (code !== 0) throw new Error(`the person detector exited with ${code}: ${stderr.trim().slice(-600)}`)
    const line = stdout.split('\n').find((l) => l.trim().startsWith('{'))
    if (!line) return []
    const found = JSON.parse(line) as { people: Array<{ mask: string; box: Person['box']; area: number; match?: Record<string, number> }> }
    return found.people.map((p) => ({ mask: readFileSync(p.mask), box: p.box, area: p.area, match: p.match ?? {} }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
