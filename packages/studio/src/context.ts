/**
 * What the model is shown for a task — and only that.
 *
 * A table per task, not a dump of the project: a dialogue pass needs the two
 * speakers' voices and the last few panels, not Ari's childhood. Every
 * block names the file it came from, so a person can read the same context
 * (`pnpm studio context …`) and see why the model said what it said.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { characterDir, comicDir, type CharacterFile, type Studio } from './root.ts'
import { listIds, readComic, readPanel, readScene, type Panel, type Scene } from './spec.ts'
import { stringify } from 'yaml'

export interface Block {
  /** Where it came from, relative to the root. */
  source: string
  text: string
}

function file(studio: Studio, relative: string): Block | null {
  // Sources are shown to the model and compared in tests: one spelling,
  // whatever the platform's separator.
  relative = relative.replace(/\\/g, '/')
  const path = join(studio.root, relative)
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8').trim()
  // A stub is not context; showing the model "nothing established yet"
  // invites it to establish something.
  if (!text || /_Nothing established yet\./.test(text)) return null
  return { source: relative, text }
}

function characterFiles(studio: Studio, id: string, files: CharacterFile[]): Block[] {
  return files.map((name) => file(studio, `characters/${id}/${name}.md`)).filter((b): b is Block => b !== null)
}

function characterOutfits(studio: Studio, id: string): Block[] {
  const dir = join(characterDir(studio, id), 'outfits')
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => file(studio, `characters/${id}/outfits/${name}`))
    .filter((b): b is Block => b !== null)
}

function world(studio: Studio): Block[] {
  return ['world/canon.md', 'world/rules.md'].map((r) => file(studio, r)).filter((b): b is Block => b !== null)
}

function location(studio: Studio, id: string | undefined): Block[] {
  if (!id) return []
  const block = file(studio, `locations/${id}.md`)
  return block ? [block] : []
}

function comicDocs(studio: Studio, comic: string, names: string[]): Block[] {
  return names.map((n) => file(studio, `comics/${comic}/${n}`)).filter((b): b is Block => b !== null)
}

function yamlBlock(source: string, value: unknown): Block {
  return { source, text: stringify(value).trim() }
}

/** The character files that carry a voice and a way of behaving. */
const VOICE: CharacterFile[] = ['core', 'personality', 'humor', 'speech', 'relationships', 'current_state']
/** The character files a picture depends on. */
const LOOK: CharacterFile[] = ['core', 'appearance', 'outfits']
/** The files a continuity check reads against. */
const CANON: CharacterFile[] = ['core', 'personality', 'relationships', 'sexuality', 'boundaries', 'current_state', 'history']

export type Task =
  | { kind: 'character.brainstorm'; character: string }
  | { kind: 'story.brainstorm'; comic: string }
  | { kind: 'scene.draft'; comic: string }
  | { kind: 'panels.plan'; comic: string; scene: string }
  | { kind: 'direct'; comic: string; panel: string }
  | { kind: 'continuity'; comic: string; scene?: string; panel?: string }
  | { kind: 'dialogue'; comic: string; panel: string }

export function assemble(studio: Studio, task: Task): Block[] {
  switch (task.kind) {
    case 'character.brainstorm':
      return [...world(studio), ...characterFiles(studio, task.character, [...CANON, 'interests', 'humor', 'speech', 'appearance'])]
    case 'story.brainstorm':
    case 'scene.draft': {
      const comic = readComic(studio, task.comic)
      return [
        ...world(studio),
        ...comic.characters.flatMap((id) => characterFiles(studio, id, VOICE)),
        ...comicDocs(studio, task.comic, ['concept.md', 'outline.md', 'story.md', 'continuity.md']),
        ...listIds(studio, task.comic, 'scenes').map((id) => yamlBlock(`comics/${task.comic}/scenes/${id}.yaml`, readScene(studio, task.comic, id))),
      ]
    }
    case 'panels.plan': {
      const scene = readScene(studio, task.comic, task.scene)
      return [
        ...scene.characters.flatMap((id) => characterFiles(studio, id, LOOK).concat(characterOutfits(studio, id))),
        ...location(studio, scene.location),
        yamlBlock(`comics/${task.comic}/scenes/${task.scene}.yaml`, scene),
        ...previousPanels(studio, task.comic, task.scene),
      ]
    }
    case 'direct': {
      const panel = readPanel(studio, task.comic, task.panel)
      const scene = panel.scene ? safeScene(studio, task.comic, panel.scene) : null
      return [
        ...Object.keys(panel.characters).flatMap((id) => characterFiles(studio, id, ['appearance']).concat(characterOutfits(studio, id))),
        ...(scene ? [yamlBlock(`comics/${task.comic}/scenes/${scene.id}.yaml`, scene)] : []),
        yamlBlock(`comics/${task.comic}/panels/${task.panel}.yaml`, panel),
      ]
    }
    case 'continuity': {
      const comic = readComic(studio, task.comic)
      const doc: Block[] = []
      if (task.scene) doc.push(yamlBlock(`comics/${task.comic}/scenes/${task.scene}.yaml`, readScene(studio, task.comic, task.scene)))
      if (task.panel) doc.push(yamlBlock(`comics/${task.comic}/panels/${task.panel}.yaml`, readPanel(studio, task.comic, task.panel)))
      return [
        ...world(studio),
        ...comic.characters.flatMap((id) => characterFiles(studio, id, CANON)),
        ...comicDocs(studio, task.comic, ['continuity.md']),
        ...doc,
      ]
    }
    case 'dialogue': {
      const panel = readPanel(studio, task.comic, task.panel)
      const scene = panel.scene ? safeScene(studio, task.comic, panel.scene) : null
      const speakers = Object.keys(panel.characters)
      return [
        ...speakers.flatMap((id) => characterFiles(studio, id, ['core', 'personality', 'humor', 'speech', 'relationships'])),
        ...comicDocs(studio, task.comic, ['story.md']),
        ...(scene ? [yamlBlock(`comics/${task.comic}/scenes/${scene.id}.yaml`, scene)] : []),
        ...previousPanels(studio, task.comic, panel.scene, task.panel),
        yamlBlock(`comics/${task.comic}/panels/${task.panel}.yaml`, panel),
      ]
    }
  }
}

function safeScene(studio: Studio, comic: string, id: string): Scene | null {
  try {
    return readScene(studio, comic, id)
  } catch {
    return null
  }
}

/** The last three panels of the scene before `before` (or the scene's last three). */
function previousPanels(studio: Studio, comic: string, scene: string, before?: string): Block[] {
  const ids = listIds(studio, comic, 'panels')
  const ofScene: Array<[string, Panel]> = []
  for (const id of ids) {
    if (before && id >= before) break
    const panel = readPanel(studio, comic, id)
    if (panel.scene === scene) ofScene.push([id, panel])
  }
  return ofScene.slice(-3).map(([id, panel]) => yamlBlock(`comics/${comic}/panels/${id}.yaml`, panel))
}

export function render(blocks: Block[]): string {
  return blocks.map((b) => `### ${b.source}\n${b.text}`).join('\n\n')
}

export function comicExists(studio: Studio, comic: string): boolean {
  return existsSync(join(comicDir(studio, comic), 'comic.yaml'))
}
