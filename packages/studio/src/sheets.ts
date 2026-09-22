/**
 * Character sheets: the pictures a character is developed FROM.
 *
 * An adoptable, a commission, a design sheet. They are the one input that is
 * already decided before any writing starts, and until now they lived
 * wherever the owner happened to have them — so `appearance.md` was typed out
 * by hand from a picture nothing in the studio could point at.
 *
 * Filed here they become part of the character, listed in her context like
 * any facet, so whoever is developing her can be told to go and look at them
 * rather than inventing what she wears.
 *
 * A deliberate limitation, stated because it will bite otherwise: the story
 * model is TEXT ONLY. `wizard-vicuna-uncensored` cannot see these. Sheets are
 * read by a person or by a vision-capable assistant, who writes what they see
 * into a proposal; the text model then works from that description. Nothing
 * here silently feeds an image to something that cannot look at it.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { characterDir, type Studio } from './root.ts'

const PICTURES = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export function sheetsDir(studio: Studio, id: string): string {
  return join(characterDir(studio, id), 'sheets')
}

export function listSheets(studio: Studio, id: string): string[] {
  const dir = sheetsDir(studio, id)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => PICTURES.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(dir, name))
}

/**
 * File one or more pictures against a character.
 *
 * Copied rather than referenced: a sheet on the desktop gets tidied away and
 * a character whose canon points at a missing file is worse than one with no
 * sheet at all. A name already taken is kept, not overwritten — two sheets
 * of the same character are normal and losing one to a name clash is not.
 */
export function addSheets(studio: Studio, id: string, paths: string[]): { added: string[]; skipped: string[] } {
  const dir = sheetsDir(studio, id)
  const added: string[] = []
  const skipped: string[] = []
  for (const given of paths) {
    const from = resolve(given)
    if (!existsSync(from) || !statSync(from).isFile()) {
      skipped.push(`${given} — not a file`)
      continue
    }
    if (!PICTURES.has(extname(from).toLowerCase())) {
      skipped.push(`${given} — not a picture`)
      continue
    }
    mkdirSync(dir, { recursive: true })
    let name = basename(from)
    let n = 2
    while (existsSync(join(dir, name))) {
      const stem = basename(from, extname(from))
      name = `${stem}-${n}${extname(from)}`
      n += 1
    }
    copyFileSync(from, join(dir, name))
    added.push(join(dir, name))
  }
  return { added, skipped }
}
