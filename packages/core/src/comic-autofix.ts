/**
 * Reconciling a comic's cast with the LoRA catalogue.
 *
 * A comic names each character the way a prompt wants her: a LoRA at a
 * weight, a trigger, and words for how she looks. All three drift. The LoRA
 * gets a new version and the comic keeps rendering the old one; the weight
 * is a guess; and the look restates an outfit the LoRA already knows.
 *
 * That last one is the surprising one, and it goes BOTH ways depending on
 * how the LoRA was captioned. `.ai/lora-training.md` § 5 is the authority:
 *
 * - A `final` LoRA is trigger-only trained: captions carry only what varies
 *   inside its own dataset, so the trigger alone renders hair, eyes and the
 *   default outfit. Measured on `ari_adopt_v4`, whose 235 captions contain
 *   `aqua shirt`, `off-shoulder shirt`, `black collar` and `sneakers` exactly
 *   zero times. Restating them does not reinforce the outfit, it COMPETES
 *   with it: generic tags pull toward a generic tube top and a choker
 *   instead of her yoke and cut-outs.
 * - A `wip` LoRA is one of the older sheet-crop line, captioned the other
 *   way round with the identity dropped and the outfit kept. Those NEED
 *   their outfit named at render time, and stripping it would undress them.
 *
 * So autofix is not "add words" or "remove words". It reads which kind of
 * LoRA this is and makes the prompt match how that one was taught.
 */

import { CUSTOM_LORAS, type LoraEntry } from './loras.ts'
import type { ComicCharacter } from './comic.ts'

export interface Autofix {
  character: ComicCharacter
  /** What changed, in the person's words. Empty when nothing did. */
  changes: string[]
  /** Why nothing could be done, when the catalogue has no entry for her. */
  problem?: string
}

/** `name:weight`, as `<lora:name:weight>` wants it. */
export function loraRef(name: string, weight: number | null): string {
  return `${name}:${weight ?? 1}`
}

export function loraNameOf(lora: string): string {
  const at = lora.lastIndexOf(':')
  return at > 0 ? lora.slice(0, at) : lora
}

/**
 * The catalogue entry for a character, by the LoRA she is using.
 *
 * By LoRA rather than by id, because a comic's character id is the writer's
 * word (`ari`) and the catalogue's is a display name (`Ari`), and because
 * this has to recognise a character who is on a SUPERSEDED version — which
 * is the main thing it is for.
 */
export function entryFor(character: ComicCharacter, entries: readonly LoraEntry[] = CUSTOM_LORAS): LoraEntry | null {
  const using = loraNameOf(character.lora)
  const exact = entries.find((entry) => entry.name === using)
  if (exact) return exact
  const superseded = entries.find((entry) => entry.olderVersions.includes(using))
  if (superseded) return superseded
  // Last resort: the trigger. A comic written before the LoRA was catalogued
  // still names her the same word.
  return entries.find((entry) => entry.trigger === character.trigger && entry.kind === 'full') ?? null
}

/** Whether this LoRA's trigger carries the outfit on its own.
 *
 *  `status` is the tell, not `kind`: an outfit variant is its own LoRA with
 *  its own trigger trained the same trigger-only way, and a `wip` full
 *  character LoRA from the old sheet-crop line is the one that needs words. */
export function carriesItsOutfit(entry: LoraEntry): boolean {
  return entry.status === 'final'
}

/**
 * Put a character back in step with the catalogue.
 *
 * Whether the look is dropped or demanded depends on how the LoRA was
 * taught. See the note at the top of this file.
 */
export function autofix(character: ComicCharacter, entries: readonly LoraEntry[] = CUSTOM_LORAS): Autofix {
  const entry = entryFor(character, entries)
  if (!entry) {
    return { character, changes: [], problem: `no LoRA in the catalogue matches "${character.lora}"` }
  }

  const changes: string[] = []
  const next: ComicCharacter = { ...character }

  const wanted = loraRef(entry.name, entry.weight)
  if (next.lora !== wanted) {
    const was = loraNameOf(next.lora)
    changes.push(was === entry.name ? `weight ${next.lora} → ${wanted}` : `${was} is superseded, moved to ${entry.name}`)
    next.lora = wanted
  }

  if (next.trigger !== entry.trigger) {
    changes.push(`trigger "${next.trigger}" → "${entry.trigger}"`)
    next.trigger = entry.trigger
  }

  if (carriesItsOutfit(entry)) {
    if (next.look.trim()) {
      changes.push(`dropped the look: "${entry.trigger}" already carries it, and restating it competes with the LoRA`)
      next.look = ''
    }
  } else if (!next.look.trim()) {
    // The old sheet-crop line dropped the identity and kept the outfit, so
    // the words are load-bearing and there is nothing measured to put here.
    return {
      character: next,
      changes,
      problem: `${entry.name} was captioned with the outfit kept, so its outfit has to be named in the look — leaving it empty renders her undressed`,
    }
  }

  return { character: next, changes }
}

/** Every character in a cast, in one go. */
export function autofixCast(
  characters: Record<string, ComicCharacter>,
  entries: readonly LoraEntry[] = CUSTOM_LORAS,
): { characters: Record<string, ComicCharacter>; changes: string[]; problems: string[] } {
  const out: Record<string, ComicCharacter> = {}
  const changes: string[] = []
  const problems: string[] = []
  for (const [id, character] of Object.entries(characters)) {
    const fixed = autofix(character, entries)
    out[id] = fixed.character
    for (const change of fixed.changes) changes.push(`${id}: ${change}`)
    if (fixed.problem) problems.push(`${id}: ${fixed.problem}`)
  }
  return { characters: out, changes, problems }
}
