/**
 * Putting a comic's pictures into the vault as a set.
 *
 * Panels already reach the library, because `forge.save_to_forge` leaves a
 * copy in whatever dated folder Forge was writing to that day. That is worse
 * than useless: eleven pictures land interleaved with unrelated work, named
 * by Forge, with nothing saying they belong together or which panel each one
 * is. The comic knows all of that and should say so.
 *
 * So this copies the panels and pages the pipeline named itself into a dated
 * vault folder and writes a manifest beside them, the same
 * `<folder>/.luma-sets/<run>.json` every other command in this house writes.
 * The scanner reads it on its next pass; nothing has to call the app, which
 * matters because a comic may render while no app is running.
 *
 * The run id is STABLE per comic rather than stamped per render. A comic is
 * re-rendered over and over — a new stamp each time would litter the sidebar
 * with a dozen near-identical sets, which is a lesson already paid for on
 * the boards. Same id, same filenames, so a re-rendered panel replaces the
 * one it supersedes instead of joining it.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '../project.ts'
import type { Reporter } from '../report.ts'
import type { Script } from '../schema.ts'

/** The folder a run writes its manifest into, beside the pictures. */
const MANIFEST_DIR = '.luma-sets'

export interface SetMember {
  file: string
  label?: string
}

export interface SetManifest {
  run: string
  command: string
  character?: string
  title?: string
  createdAt: number
  members: SetMember[]
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function runIdFor(project: Project): string {
  return slug(`comic-${project.name}`)
}

/** `2026-09-21`, the folder Forge would have used, so a comic's pictures sit
 *  with the day's other work rather than in a place only this knows about. */
export function dayFolder(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Merge members into a manifest already on disk.
 *
 * By file name, keeping the first position each name was given, because a
 * set reads in the order it was shot and a re-render must not send a panel
 * to the end of its own book.
 */
export function mergeMembers(existing: SetMember[], incoming: SetMember[]): SetMember[] {
  const out = [...existing]
  for (const member of incoming) {
    const at = out.findIndex((m) => m.file === member.file)
    if (at >= 0) out[at] = member
    else out.push(member)
  }
  return out
}

export interface CollectOptions {
  /** Where the vault watches. Nothing is copied without one. */
  outdir?: string
  now?: Date
}

/**
 * Copy this comic's panels and pages into the vault and record the set.
 *
 * Returns how many files were placed, or 0 when collecting is off or the
 * folder is not reachable — a library that cannot be written to is not a
 * reason to fail a render that already succeeded.
 */
export function collect(project: Project, script: Script, report: Reporter, options: CollectOptions = {}): number {
  const outdir = options.outdir?.trim()
  if (!outdir) return 0
  if (!existsSync(outdir)) {
    report.emit({ event: 'note', message: `not collecting: ${outdir} is not reachable` })
    return 0
  }

  const day = join(outdir, dayFolder(options.now))
  const manifestDir = join(day, MANIFEST_DIR)
  const run = runIdFor(project)
  const manifestPath = join(manifestDir, `${run}.json`)

  const members: SetMember[] = []
  let copied = 0
  const place = (from: string, to: string, label: string) => {
    if (!existsSync(from)) return
    mkdirSync(day, { recursive: true })
    copyFileSync(from, join(day, to))
    members.push({ file: to, label })
    copied += 1
  }

  for (const [pageIndex, page] of script.pages.entries()) {
    for (const panel of page.panels) {
      // The panel's own words are the label: a set read in the sidebar should
      // say "p2-3 · cowboy shot, from side", not repeat the file name.
      place(join(project.panelsDir, `${panel.id}.png`), `${run}-${panel.id}.png`, `${panel.id} · ${panel.camera}`)
    }
    const number = pageIndex + 1
    const name = `page-${String(number).padStart(2, '0')}.png`
    place(join(project.outDir, name), `${run}-${name}`, `page ${number}`)
  }
  if (copied === 0) return 0

  let existing: SetMember[] = []
  let createdAt = Date.now()
  if (existsSync(manifestPath)) {
    try {
      const previous = JSON.parse(readFileSync(manifestPath, 'utf8')) as SetManifest
      existing = previous.members ?? []
      createdAt = previous.createdAt ?? createdAt
    } catch {
      // A manifest nobody can read is replaced, not mourned.
    }
  }

  const cast = Object.keys(script.characters)
  const manifest: SetManifest = {
    run,
    command: 'comic',
    character: cast.length === 1 ? cast[0] : undefined,
    title: script.title,
    createdAt,
    members: mergeMembers(existing, members),
  }
  mkdirSync(manifestDir, { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  report.emit({ event: 'note', message: `collected ${copied} picture(s) into the vault set "${run}"` })
  return copied
}
