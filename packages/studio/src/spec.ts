/**
 * The structured documents: a comic, a scene, a panel. YAML on disk, parsed
 * at the boundary. Panel and scene bodies are loose on purpose — the plan's
 * fields are named, anything the director adds is kept — and only the
 * states are enumerated, because a state is something the tooling acts on.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { comicDir, writeText, type Studio } from './root.ts'

export const PANEL_STATES = ['IDEA', 'PLANNED', 'GENERATING', 'REVIEW', 'CORRECTION', 'APPROVED', 'LETTERED', 'FINAL'] as const
export const panelStateSchema = z.enum(PANEL_STATES)
export type PanelState = z.infer<typeof panelStateSchema>

export const comicSchema = z.object({
  id: z.string(),
  title: z.string().default(''),
  characters: z.array(z.string()).default([]),
  concept: z.enum(['draft', 'approved']).default('draft'),
  outline: z.enum(['draft', 'approved']).default('draft'),
  notes: z.string().optional(),
})
export type Comic = z.infer<typeof comicSchema>

const moods = z.record(z.string(), z.looseObject({ mood: z.string().optional() }))

export const sceneSchema = z.looseObject({
  id: z.string(),
  title: z.string().default(''),
  purpose: z.string().default(''),
  characters: z.array(z.string()).default([]),
  location: z.string().default(''),
  start_state: moods.default({}),
  beats: z.array(z.string()).default([]),
  end_state: moods.default({}),
  continuity_changes: z.array(z.string()).default([]),
  status: z.enum(['planned', 'production', 'complete']).default('planned'),
  notes: z.string().optional(),
})
export type Scene = z.infer<typeof sceneSchema>

export const panelCharacterSchema = z.looseObject({
  screen_position: z.string().optional(),
  pose: z.string().optional(),
  body_orientation: z.string().optional(),
  head_orientation: z.string().optional(),
  gaze_target: z.string().optional(),
  expression: z.string().optional(),
  outfit: z.string().optional(),
})

export const dialogueLineSchema = z.looseObject({
  speaker: z.string(),
  text: z.string(),
  emotion: z.string().optional(),
  bubble_type: z.string().default('speech'),
})

export const historyEntrySchema = z.object({
  at: z.string(),
  instruction: z.string(),
  patch: z.record(z.string(), z.unknown()).default({}),
  refused: z.array(z.string()).default([]),
})

export const panelSchema = z.looseObject({
  id: z.string(),
  scene: z.string().default(''),
  story_function: z.string().default(''),
  camera: z.looseObject({ framing: z.string().optional(), angle: z.string().optional(), focal_feel: z.string().optional() }).default({}),
  environment: z.looseObject({ location: z.string().optional(), lighting: z.string().optional() }).default({}),
  characters: z.record(z.string(), panelCharacterSchema).default({}),
  dialogue: z.looseObject({ status: z.enum(['draft', 'approved']).default('draft'), lines: z.array(dialogueLineSchema).default([]) }).prefault({}),
  /** Dot paths (`environment.location`, `characters.ari.outfit`) or the
   *  plan's short names (`location`, `lighting`, `ari_outfit`, `ari`). */
  locked: z.array(z.string()).default([]),
  status: panelStateSchema.default('PLANNED'),
  history: z.array(historyEntrySchema).default([]),
  notes: z.string().optional(),
})
export type Panel = z.infer<typeof panelSchema>

function readYaml(path: string): unknown {
  if (!existsSync(path)) throw new Error(`${path} does not exist`)
  return parse(readFileSync(path, 'utf8'))
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(`${what} is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return parsed.data
}

export function comicPath(studio: Studio, comic: string): string {
  return join(comicDir(studio, comic), 'comic.yaml')
}

export function readComic(studio: Studio, comic: string): Comic {
  const path = comicPath(studio, comic)
  if (!existsSync(path)) throw new Error(`there is no comic "${comic}" (${path})`)
  return parseWith(comicSchema, readYaml(path), path)
}

export function writeComic(studio: Studio, comic: Comic): void {
  writeText(comicPath(studio, comic.id), stringify(comic))
}

export function scenePath(studio: Studio, comic: string, id: string): string {
  return join(comicDir(studio, comic), 'scenes', `${id}.yaml`)
}

export function readScene(studio: Studio, comic: string, id: string): Scene {
  return parseWith(sceneSchema, readYaml(scenePath(studio, comic, id)), scenePath(studio, comic, id))
}

export function writeScene(studio: Studio, comic: string, scene: Scene): void {
  writeText(scenePath(studio, comic, scene.id), stringify(scene))
}

export function panelPath(studio: Studio, comic: string, id: string): string {
  return join(comicDir(studio, comic), 'panels', `${id}.yaml`)
}

export function readPanel(studio: Studio, comic: string, id: string): Panel {
  return parseWith(panelSchema, readYaml(panelPath(studio, comic, id)), panelPath(studio, comic, id))
}

export function writePanel(studio: Studio, comic: string, panel: Panel): void {
  writeText(panelPath(studio, comic, panel.id), stringify(panel))
}

/** `scene_004`, `panel_017`: ids in the order they were made. */
export function listIds(studio: Studio, comic: string, kind: 'scenes' | 'panels'): string[] {
  const dir = join(comicDir(studio, comic), kind)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.slice(0, -5))
    .sort()
}

export function nextId(existing: string[], prefix: 'scene' | 'panel'): string {
  const numbers = existing.map((id) => Number(id.replace(`${prefix}_`, ''))).filter((n) => Number.isInteger(n))
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1
  return `${prefix}_${String(next).padStart(3, '0')}`
}

export function listComics(studio: Studio): string[] {
  const dir = join(studio.root, 'comics')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'comic.yaml')))
    .sort()
}
