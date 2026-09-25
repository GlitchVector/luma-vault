/**
 * What the hosted model is asked to sketch: the whole panel, the people in it
 * included, left to right in the order the cast is listed — the order the
 * repaint pass assigns LoRAs in.
 *
 * Unlike a plate, the sketch shows real people, because the point is the
 * composition: who stands where, the crowd, a stranger's gesture — everything
 * the local model got wrong on its own. It never reaches the page; Forge
 * redraws the panel from its lines.
 */

import type { Character } from '../schema.ts'

/**
 * Words that make a panel explicit. Such a panel is never sent to a hosted
 * model: it is rendered the plain way. A list, not a judgement, and it errs
 * wide: a false positive costs one panel its sketch, a false negative sends
 * explicit material to someone else's server.
 */
const EXPLICIT = /\b(nsfw|nude|nudity|naked|topless|bottomless|nipples?|areolae?|breasts? out|pussy|vagina|penis|cock|dick|erection|sex|sexual|intercourse|penetration|doggystyle|missionary|cowgirl position|fellatio|blowjob|cunnilingus|oral|cum|orgasm|masturbat\w*|fingering|handjob|ass grab|spread ass|spread legs|panties aside|undressing|lingerie|underwear only|bdsm|bondage|spanking|slap\w* ass)\b/i

export function isExplicit(...texts: Array<string | undefined>): boolean {
  return texts.some((text) => !!text && EXPLICIT.test(text))
}

/** A character as the hosted model should draw her: who, and her look tags. Never her body words. */
export function describe(character: Pick<Character, 'subject' | 'look' | 'minor' | 'reference'>): string {
  const who = character.minor
    ? character.subject === '1boy' ? 'a boy, a child, fully clothed' : 'a girl, a child, fully clothed'
    : character.subject === '1boy' ? 'a man' : character.subject === '1girl' ? 'a young woman' : 'a person'
  const sheet = character.reference ? ', exactly as drawn in the attached character sheet' : ''
  return `${who} (${character.look})${sheet}`
}

export interface SketchPromptInput {
  style: string
  location?: string
  setting?: string
  camera: string
  /** The cast in panel order, each with the pose the script gave her. */
  cast: Array<{ description: string; pose?: string }>
  /** People in the picture beyond the cast. */
  extras: number
  /** The scene tags, only when the panel is not explicit. */
  details?: string
  variation?: number
}

export function sketchPrompt(input: SketchPromptInput): string {
  const parts: string[] = []
  if (input.style) parts.push(input.style)
  parts.push('One single comic panel')
  if (input.location) parts.push(input.location)
  if (input.setting) parts.push(input.setting)
  parts.push(`Camera: ${input.camera}`)
  if (input.cast.length === 1) {
    const [one] = input.cast
    parts.push(`The main figure: ${one!.description}, ${one!.pose?.trim() || 'standing naturally'}`)
  } else if (input.cast.length > 1) {
    const listed = input.cast.map((c, i) => `${i + 1}. ${c.description}, ${c.pose?.trim() || 'standing naturally'}`)
    parts.push(`The main figures, from left to right in the picture: ${listed.join('; ')}`)
  }
  if (input.extras > 0) parts.push(input.cast.length > 0 ? `${input.extras} other people around them` : `${input.extras} people`)
  if (input.cast.length === 0 && input.extras === 0) parts.push('No people')
  if (input.details) parts.push(`Details: ${input.details}`)
  parts.push('Everyone fully clothed. No text, no letters, no speech bubbles')
  if (input.variation) parts.push(`Variation ${input.variation + 1}`)
  return parts.join('. ') + '.'
}
