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
}

/** The `count` largest figures, left to right. */
export function castFigures<T extends Pick<Person, 'box' | 'area'>>(people: T[], count: number): T[] {
  const largest = [...people].sort((a, b) => b.area - a.area).slice(0, count)
  return largest.sort((a, b) => a.box[0] + a.box[2] - (b.box[0] + b.box[2]))
}

export async function findPeople(python: string, png: Buffer): Promise<Person[]> {
  const dir = mkdtempSync(join(tmpdir(), 'comic-people-'))
  try {
    const image = join(dir, 'panel.png')
    writeFileSync(image, png)
    const script = join(PACKAGE_DIR, 'python', 'people.py')
    const { stdout, stderr, code } = await run(resolve(REPO_ROOT, python), [script, resolve(REPO_ROOT, PERSON_MODEL), image, join(dir, 'masks')])
    if (code !== 0) throw new Error(`the person detector exited with ${code}: ${stderr.trim().slice(-600)}`)
    const line = stdout.split('\n').find((l) => l.trim().startsWith('{'))
    if (!line) return []
    const found = JSON.parse(line) as { people: Array<{ mask: string; box: Person['box']; area: number }> }
    return found.people.map((p) => ({ mask: readFileSync(p.mask), box: p.box, area: p.area }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
