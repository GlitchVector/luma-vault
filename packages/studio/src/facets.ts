/**
 * The order a character gets developed in, and the questions to ask at each
 * step.
 *
 * The twelve facet files already exist and each carries its own prompt in
 * its stub ("Strengths, flaws, contradictions…"). Two things were missing.
 *
 * ORDER, because the facets depend on each other. Speech falls out of
 * personality; relationships need a history to have happened in; current
 * state is the only facet that changes per story, so it comes last. Nothing
 * stopped a person filling relationships before she had a past.
 *
 * SIZE, because a facet is too big to ask about in one go. The one
 * brainstorm that worked asked "how she behaves when embarrassed" and got
 * four genuinely different answers; "tell me about her personality" gets
 * mush. So each facet is a handful of small asks, and each ask is one
 * brainstorm.
 *
 * This is data rather than a script on purpose: the command drives it today
 * and the app's character page will drive the same list later, so the two
 * cannot disagree about what to ask next.
 */

import type { CharacterFile } from './root.ts'

export interface Step {
  facet: CharacterFile
  /** Why this facet waits for the ones before it. */
  because: string
  /** One brainstorm each, narrow enough to give different answers. */
  asks: string[]
  /**
   * This facet cannot be developed by a model that refuses adult material.
   *
   * Not a warning label — a routing fact. Asked of the claude fallback, the
   * refusal comes back shaped like an answer and lands in a proposals file
   * as though the model had nothing to say about her, which is worse than an
   * error because it looks like a result.
   */
  explicit?: boolean
}

/**
 * Appearance and core are not here: they come from the design sheet and the
 * owner writes them himself. Everything below appearance is what this
 * develops.
 */
export const STEPS: readonly Step[] = [
  {
    facet: 'personality',
    because: 'everything else is a consequence of it',
    asks: [
      'the contradiction at the centre of her: two things that are both true and pull against each other',
      'how she behaves when embarrassed, and what she does to hide it',
      'what she is like under real pressure, when the stakes are not social',
      'her worst habit, the one her friends have stopped mentioning',
    ],
  },
  {
    facet: 'speech',
    because: 'how she talks is personality made audible',
    asks: [
      'her rhythm and register: sentence length, what she never says, what she says too often',
      'three lines of hers that could not be anyone else, in three different moods',
      'how she says no, and how that differs from how she deflects',
    ],
  },
  {
    facet: 'humor',
    because: 'it is the part of her voice that shows what she forgives',
    asks: [
      'what she finds funny that other people do not, and what she never jokes about',
      'how she teases someone she likes, and how it lands',
    ],
  },
  {
    facet: 'history',
    because: 'her present behaviour needs somewhere to have come from',
    asks: [
      'where she grew up and the one detail of it she still carries',
      'the thing that happened to her that she has never explained to anyone',
      'what she was doing two years before the story starts, and why she stopped',
    ],
  },
  {
    facet: 'relationships',
    because: 'they need a history to have happened in',
    asks: [
      'the person she is closest to, and the specific way that closeness is unequal',
      'someone she has lost touch with on purpose, and the reason she gives versus the real one',
      'how she is with strangers in the first ten minutes',
    ],
  },
  {
    facet: 'interests',
    because: 'what she does with an empty afternoon is characterisation, and it is panel material',
    asks: [
      'the thing she is good at that has nothing to do with the plot',
      'what she collects, keeps, or refuses to throw away',
    ],
  },
  {
    facet: 'sexuality',
    explicit: true,
    because: 'it reads as hers once the rest of her exists, and as a checklist before',
    asks: [
      'what she wants in bed, in her own terms, and how directly she is able to say it',
      'what she is like in bed in the first five minutes with someone new, versus with someone she trusts',
      'in sex, the gap between what she initiates and what she waits to be offered',
    ],
  },
  {
    facet: 'boundaries',
    explicit: true,
    because: 'it is the fence around everything above, and it belongs to the author, not the model',
    asks: [
      'what this character is never shown doing, and what is never done to her',
      'the tone the book keeps even in its most explicit pages',
    ],
  },
  {
    facet: 'outfits',
    because: 'a second outfit is a second LoRA, so it waits until she is someone',
    asks: [
      'what she wears when she is not being looked at',
      'one outfit worth its own LoRA, and the scene that earns it',
    ],
  },
  {
    facet: 'current_state',
    because: 'the only facet that is per-story rather than per-character',
    asks: ['where she is, what she wants and what is in her way as this comic opens'],
  },
]

/** A facet is developed when its file holds more than its stub. */
export function isEmpty(text: string): boolean {
  const body = text
    .split('\n')
    .filter((line) => !line.startsWith('#') && !line.trim().startsWith('_') && line.trim())
    .join('')
  return body.trim().length === 0
}

export function stepFor(facet: CharacterFile): Step | undefined {
  return STEPS.find((step) => step.facet === facet)
}
