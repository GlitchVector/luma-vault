/**
 * A panel's prompt, from the script and nothing else.
 *
 * Three rules live here and each has a test:
 *
 * 1. Every character in the panel is restated in full — LoRA tag, trigger,
 *    look — every time. The writer never gets to say "same as before".
 * 2. Dialogue never enters the prompt. This function does not receive it.
 * 3. When space is reserved for lettering, the prompt ends by asking for it.
 */

import type { Anchor, Character, Config, Panel } from './schema.ts'

export interface BuiltPrompt {
  prompt: string
  negative: string
}

/** The words for a reserved region, in a form the model acts on: a real tag
 *  (`negative space`), then plain English placing it. */
export function reserveClause(anchor: Anchor): string {
  const place = anchor === 'center' ? 'middle' : anchor.replace('-', ' ')
  return `negative space, empty ${place} of the frame, plain uncluttered ${place}, nothing in the ${place}`
}

/** How the checkpoint counts people: `1girl, solo`, `2girls`, `1girl, 1boy`. */
export function subjectTags(subjects: Character['subject'][]): string {
  const girls = subjects.filter((s) => s === '1girl').length
  const boys = subjects.filter((s) => s === '1boy').length
  const others = subjects.length - girls - boys
  if (subjects.length === 0) return 'no humans, scenery'
  if (subjects.length === 1) return `${subjects[0]}, solo`
  const parts: string[] = []
  if (girls === 1) parts.push('1girl')
  if (girls === 2) parts.push('2girls')
  if (girls > 2) parts.push('multiple girls')
  if (boys === 1) parts.push('1boy')
  if (boys === 2) parts.push('2boys')
  if (boys > 2) parts.push('multiple boys')
  if (others > 0) parts.push(`${others}others`)
  return parts.join(', ')
}

export function loraTag(lora: string): string {
  return `<lora:${lora}>`
}

export function buildPrompt(
  panel: Pick<Panel, 'camera' | 'scene' | 'characters' | 'reserve_space'>,
  characters: Record<string, Character>,
  config: Pick<Config, 'prompt'>,
): BuiltPrompt {
  const cast = panel.characters.map((id) => {
    const character = characters[id]
    if (!character) throw new Error(`panel names character "${id}", which the script does not define`)
    return character
  })

  const parts: string[] = [config.prompt.quality]
  parts.push(subjectTags(cast.map((c) => c.subject)))
  for (const character of cast) {
    parts.push(loraTag(character.lora), character.trigger, character.look)
  }
  parts.push(panel.camera, panel.scene)
  if (config.prompt.style) parts.push(config.prompt.style)
  if (panel.reserve_space !== 'none') parts.push(reserveClause(panel.reserve_space))

  const prompt = parts
    .map((part) => part.trim().replace(/,\s*$/, ''))
    .filter(Boolean)
    .join(', ')
  const negative = [config.prompt.negative, config.prompt.negative_lettering]
    .map((part) => part.trim().replace(/,\s*$/, ''))
    .filter(Boolean)
    .join(', ')
  return { prompt, negative }
}
