/**
 * What the hosted model is asked for. Built from the fields the writer was
 * told a hosted model reads — `locations`, `setting`, `pose` — and never
 * from `scene`, which is where the explicit words live.
 */

import type { Anchor } from '../schema.ts'
import { DUMMIES } from './plate.ts'

export interface PlatePromptInput {
  style: string
  /** The location's description, when the panel has one. */
  location?: string
  setting?: string
  camera: string
  /** One entry per stand-in, in character order. Missing entries get a neutral pose. */
  poses: string[]
  figures: number
  reserve: Anchor | 'none'
  /** A retry counter, so a plate can be asked for again without the same picture. */
  variation?: number
  /** The master plate rides along as a reference picture, so the prompt says
   *  "the same place as the reference" instead of restating the location. */
  references?: boolean
}

function dummyClause(index: number, pose: string | undefined): string {
  const dummy = DUMMIES[index] ?? DUMMIES[DUMMIES.length - 1]!
  const doing = pose?.trim() ? pose.trim() : 'standing naturally'
  return `a featureless matte ${dummy.name} (${dummy.hex}) artist's mannequin with no face, no hair and no clothes, ${doing}`
}

/** The master: the place with nobody in it. */
export function masterPrompt(style: string, location: string): string {
  return [style, location, 'no people, no figures, no text, no letters, no speech bubbles'].filter(Boolean).join('. ')
}

export function platePrompt(input: PlatePromptInput): string {
  const parts: string[] = []
  if (input.style) parts.push(input.style)
  if (input.location) parts.push(input.references ? 'The same place as the reference picture' : input.location)
  if (input.setting) parts.push(input.setting)
  parts.push(`Camera: ${input.camera}`)
  if (input.figures > 0) {
    const dummies = Array.from({ length: input.figures }, (_, i) => dummyClause(i, input.poses[i]))
    parts.push(
      `${input.figures === 1 ? 'One stand-in figure' : `${input.figures} stand-in figures`}, each a solid single-colour silhouette: ${dummies.join('; ')}. The mannequins are the only figures and their colour is flat and unlit`,
    )
  } else {
    parts.push('No people')
  }
  if (input.reserve !== 'none') {
    const place = input.reserve === 'center' ? 'middle' : input.reserve.replace('-', ' ')
    parts.push(`Leave the ${place} of the frame plain and empty for lettering`)
  }
  parts.push('No text, no letters, no speech bubbles')
  if (input.variation) parts.push(`Variation ${input.variation + 1}`)
  return parts.join('. ') + '.'
}
