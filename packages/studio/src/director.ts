/**
 * The natural-language director.
 *
 * "Put Ari farther left and bring the camera down slightly" becomes a patch
 * over the panel YAML: dot paths to new values. The model proposes the
 * patch; this module enforces the locks, applies what is allowed, prints
 * the diff, and keeps the instruction in the panel's history. A locked
 * field is never changed by an instruction that did not unlock it first.
 */

import { z } from 'zod'
import type { Panel } from './spec.ts'

export const patchReplySchema = z.object({
  /** Dot path → new value; `null` removes the field. */
  patch: z.record(z.string(), z.unknown()).default({}),
  /** Paths the instruction asked to lock or unlock, in the short or dot form. */
  lock: z.array(z.string()).default([]),
  unlock: z.array(z.string()).default([]),
  /** What the model could not map, in its own words. */
  note: z.string().default(''),
})
export type PatchReply = z.infer<typeof patchReplySchema>

/** The JSON Schema handed to the model for a director reply. */
export const PATCH_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    patch: { type: 'object', additionalProperties: true, description: 'dot path -> new value; null removes' },
    lock: { type: 'array', items: { type: 'string' } },
    unlock: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['patch'],
  additionalProperties: false,
}

/**
 * A lock as a dot path. The plan's short names are accepted: `location`,
 * `lighting`, `background` (the environment), `camera`, `<character>` (all
 * of her), `<character>_outfit`, `<character>_pose`, and so on.
 */
export function lockPath(name: string, characters: string[]): string {
  if (name.includes('.')) return name
  if (name === 'location' || name === 'lighting') return `environment.${name}`
  if (name === 'background' || name === 'environment') return 'environment'
  if (name === 'camera' || name === 'dialogue') return name
  for (const id of characters) {
    if (name === id) return `characters.${id}`
    if (name.startsWith(`${id}_`)) return `characters.${id}.${name.slice(id.length + 1)}`
  }
  return name
}

function covered(path: string, lock: string): boolean {
  return path === lock || path.startsWith(`${lock}.`) || lock.startsWith(`${path}.`)
}

export interface Applied {
  panel: Panel
  changes: Array<{ path: string; before: unknown; after: unknown }>
  refused: Array<{ path: string; lock: string }>
  locked: string[]
}

function get(target: Record<string, unknown>, path: string): unknown {
  let current: unknown = target
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function set(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let current: Record<string, unknown> = target
  for (const key of keys.slice(0, -1)) {
    const next = current[key]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) current[key] = {}
    current = current[key] as Record<string, unknown>
  }
  const last = keys.at(-1)!
  if (value === null || value === undefined) delete current[last]
  else current[last] = value
}

const NEVER_BY_INSTRUCTION = ['id', 'status', 'history', 'locked']

/** Apply a reply to a panel, honouring its locks. Pure: returns a new panel. */
export function applyPatch(panel: Panel, reply: PatchReply, instruction: string, now = new Date()): Applied {
  const characters = Object.keys(panel.characters)
  const next = structuredClone(panel) as Panel & Record<string, unknown>
  let locks = panel.locked.map((l) => lockPath(l, characters))

  // Unlocks first: "unlock the background and move the lamp" is one instruction.
  for (const name of reply.unlock) {
    const path = lockPath(name, characters)
    locks = locks.filter((l) => l !== path)
  }

  const changes: Applied['changes'] = []
  const refused: Applied['refused'] = []
  for (const [path, value] of Object.entries(reply.patch)) {
    if (NEVER_BY_INSTRUCTION.some((n) => path === n || path.startsWith(`${n}.`))) {
      refused.push({ path, lock: 'not a directable field' })
      continue
    }
    const lock = locks.find((l) => covered(path, l))
    if (lock) {
      refused.push({ path, lock })
      continue
    }
    const before = get(next, path)
    if (JSON.stringify(before) === JSON.stringify(value)) continue
    set(next, path, value)
    changes.push({ path, before, after: value })
  }
  for (const name of reply.lock) {
    const path = lockPath(name, characters)
    if (!locks.includes(path)) locks.push(path)
  }
  next.locked = locks
  next.history = [
    ...panel.history,
    {
      at: now.toISOString(),
      instruction,
      patch: Object.fromEntries(changes.map((c) => [c.path, c.after])),
      refused: refused.map((r) => r.path),
    },
  ]
  return { panel: next, changes, refused, locked: locks }
}

export function describe(applied: Applied): string {
  const lines: string[] = []
  for (const change of applied.changes) {
    if (change.before !== undefined) lines.push(`- ${change.path}: ${JSON.stringify(change.before)}`)
    lines.push(`+ ${change.path}: ${JSON.stringify(change.after)}`)
  }
  for (const r of applied.refused) lines.push(`! ${r.path} refused — locked by ${r.lock}`)
  if (applied.changes.length === 0 && applied.refused.length === 0) lines.push('(nothing changed)')
  lines.push(`locked: ${applied.locked.length ? applied.locked.join(', ') : 'nothing'}`)
  return lines.join('\n')
}

export const DIRECTOR_BRIEF = `You translate a comic director's instruction into edits of a panel specification (YAML shown as context). Answer only with the JSON object.

- "patch": dot paths into the panel to their new values. Use the panel's existing fields: camera.framing, camera.angle, camera.focal_feel, environment.location, environment.lighting, characters.<id>.screen_position, characters.<id>.pose, characters.<id>.body_orientation, characters.<id>.head_orientation, characters.<id>.gaze_target, characters.<id>.expression, characters.<id>.outfit, story_function, notes. Add a field under a character or the environment when the instruction needs one that does not exist. Values are short descriptive phrases, the director's own vocabulary, never prompt syntax.
- Change only what the instruction asks. "Keep everything else exactly the same" means an empty patch for the rest.
- Never touch id, status, history or locked. Never change a locked path; if the instruction wants to, leave it out of the patch and say so in "note".
- "Lock the background" / "background is perfect, lock it" → "lock": ["environment"]. "Unlock …" → "unlock".
- An expression note like "annoyed but trying not to laugh" is the value verbatim: the director's words are the specification.
- "note": one sentence on anything you could not map, or empty.`
