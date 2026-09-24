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

/**
 * How the checkpoint counts people: `1girl, solo`, `2girls`, `1girl, 1boy`.
 *
 * `figures` is the script's head count when it is more than the cast: guests,
 * a crowd, a stranger with no LoRA. Without it every one-character panel said
 * `solo`, which forbids anyone else in the picture: the Beanpole rooftop party
 * rendered as Ari alone on an empty roof, and the bully's gesture went to her
 * (2026-09-24). `solo focus` is the tag for "one main figure, others around".
 */
export function subjectTags(subjects: Character['subject'][], figures?: number): string {
  const girls = subjects.filter((s) => s === '1girl').length
  const boys = subjects.filter((s) => s === '1boy').length
  const others = subjects.length - girls - boys
  const extras = figures !== undefined && figures > subjects.length ? figures - subjects.length : 0
  if (subjects.length === 0) return extras > 0 ? (extras >= 3 ? 'crowd, multiple others' : 'multiple others') : 'no humans, scenery'
  if (extras > 0) {
    const around = extras >= 3 ? 'crowd, multiple others' : 'multiple others'
    if (subjects.length === 1) return `${subjects[0]}, solo focus, ${around}`
    return `${subjectTags(subjects)}, ${around}`
  }
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

/**
 * Angle words, which must never be weighted as hard as framing words.
 *
 * `from below` at 1.35 does not mean "put the camera low", it means "look up
 * at something enormous": the owner's first studio page came back with a
 * forty-metre Ari, and dropping this one number to 1.1 was most of the fix.
 */
const ANGLE_TERMS = new Set([
  'from below',
  'from above',
  'from side',
  'from behind',
  'over the shoulder',
  'dutch angle',
  'looking up',
  'looking down',
  'profile',
])

/** Framings where the scene is meant to dominate the figure. */
const WIDE_TERMS = ['wide shot', 'scenery', 'establishing']

/**
 * How far down a panel a person's head reaches, as a fraction of its height.
 *
 * The energy map cannot answer this. A head against a bright sky is FLAT, so
 * the map calls the top of the panel quiet and the letterer puts a caption
 * straight over her face — which is exactly what happened on the owner's
 * first three pages. Framing can answer it: the tighter the shot, the
 * further down the head comes.
 *
 * Returns 0 for a panel with nobody in it, where there is no head to miss.
 */
export function headBand(camera: string, hasPeople: boolean): number {
  if (!hasPeople) return 0
  const plain = camera.toLowerCase()
  if (plain.includes('close-up') || plain.includes('portrait') || plain.includes('face')) return 0.75
  if (plain.includes('upper body') || plain.includes('bust')) return 0.5
  if (plain.includes('cowboy')) return 0.36
  // Everything wider: full body, wide shot, establishing. She is small in
  // frame and her head is near the top of it.
  return 0.3
}

export function isWideShot(camera: string): boolean {
  const plain = camera.toLowerCase()
  return WIDE_TERMS.some((term) => plain.includes(term))
}

/**
 * A character LoRA at full strength fills whatever frame it is given, so a
 * wide shot comes back as a close-up of a giant. This is the house rule
 * already written down for boards — "try a lower LoRA weight, not
 * negatives" — applied where the panel says the scene is the subject.
 */
export function scaleLora(lora: string, scale: number): string {
  if (scale === 1) return lora
  const cut = lora.lastIndexOf(':')
  const weight = Number(lora.slice(cut + 1))
  if (cut < 0 || !Number.isFinite(weight)) return lora
  return `${lora.slice(0, cut)}:${Number((weight * scale).toFixed(2))}`
}

/**
 * Each comma-separated term at the given weight. A term that already carries
 * one is left alone, so a script can overrule this per panel.
 */
export function weighted(text: string, weight: number, angleWeight = weight): string {
  return text
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => {
      if (/^\(.*:[\d.]+\)$/.test(term)) return term
      const applied = ANGLE_TERMS.has(term) ? angleWeight : weight
      return applied === 1 ? term : `(${term}:${applied})`
    })
    .join(', ')
}

/**
 * Whose body words win: the panel's, else the page's, else the character's.
 *
 * Three rungs because a book needs all three. The character carries what she
 * is, a page gets an override when a whole sequence should read differently,
 * and a panel gets the last word. A blank at any rung is silence rather than
 * an override, so a page left empty does not wipe what the character says.
 */
export function bodyFor(character: Character, page?: string, panel?: string): string {
  return panel?.trim() || page?.trim() || character.body
}

/**
 * Which light wins: the panel's, else the page's, else the book's.
 *
 * The same three rungs as the body, and for the same reason — a book has a
 * light, a sequence may break from it, and one panel may break from that.
 * A blank rung is silence rather than an override.
 */
export function lightingFor(book: string, page?: string, panel?: string): string {
  return panel?.trim() || page?.trim() || book
}

/**
 * The prompt the face pass paints with: her, and nothing about the scene.
 *
 * Deliberately not the panel's prompt. ADetailer applies whatever it is
 * given to whatever it detected, so handing it a full scene description is
 * how a false positive becomes a rooftop painted inside someone's cheek.
 *
 * `head` rather than `look` for the same reason one rung down: the crop
 * stops at her neck, so her shirt, collar, shorts and shoes have no business
 * in it. Measured on the 2026-09-21 run, where the outfit was a third of the
 * face prompt and the repainted faces came back off.
 */
export function facePrompt(character: Character, config: Pick<Config, 'prompt'>): string {
  return [config.prompt.quality, loraTag(character.lora), character.trigger, character.head || character.look]
    .map((part) => part.trim().replace(/,\s*$/, ''))
    .filter(Boolean)
    .join(', ')
}

export function buildPrompt(
  panel: Pick<Panel, 'camera' | 'scene' | 'characters' | 'reserve_space' | 'body' | 'lighting' | 'figures'>,
  characters: Record<string, Character>,
  config: Pick<Config, 'prompt'>,
  pageBody?: string,
  pageLighting?: string,
): BuiltPrompt {
  const cast = panel.characters.map((id) => {
    const character = characters[id]
    if (!character) throw new Error(`panel names character "${id}", which the script does not define`)
    return character
  })

  const wide = isWideShot(panel.camera)
  const parts: string[] = [config.prompt.quality]
  parts.push(subjectTags(cast.map((c) => c.subject), panel.figures))
  for (const character of cast) {
    const lora = wide ? scaleLora(character.lora, config.prompt.wide_lora_scale) : character.lora
    // Unweighted on purpose. A weighted body block drags every shot toward
    // the hips, which is the very thing the framing weight below exists to
    // fight, and two weights pulling against each other is how `wide shot`
    // became a cowboy shot on the boards.
    parts.push(loraTag(lora), character.trigger, character.look, bodyFor(character, pageBody, panel.body))
  }
  // Framing words are weighted, because unweighted they lose.
  //
  // Measured on this house's own LoRAs long before the comic pipeline
  // existed ("weight every framing word"): a character LoRA plus a body
  // block drags every shot toward the hips, so `wide shot` renders as a
  // cowboy shot and `full body` as a crop. Weighting is the difference
  // between the camera being a request and being an instruction.
  parts.push(weighted(panel.camera, config.prompt.camera_weight, config.prompt.angle_weight), panel.scene)
  // After the scene, so it reads as how the scene is lit rather than as
  // another thing in it.
  const light = lightingFor(config.prompt.lighting, pageLighting, panel.lighting)
  if (light) parts.push(light)
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
