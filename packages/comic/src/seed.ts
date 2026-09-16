/**
 * Seeds are arithmetic, not state.
 *
 * A panel's seed is its character's family plus an offset that only depends
 * on where the panel sits and how many times it has been retried. Nothing is
 * stored to get back to it: `comic render --page 4 --panel 2` a month from
 * now computes the same number, and a retry moves one step within the family
 * instead of anywhere in the seed space, which is what keeps the character
 * looking like herself across attempts.
 */

/** Room for retries before two panels on one page could share a seed. */
export const ATTEMPTS_PER_PANEL = 10
/** Room for panels before two pages could share a seed. */
export const PANELS_PER_PAGE = 10

export function panelSeed(family: number, pageIndex: number, panelIndex: number, attempt: number): number {
  if (attempt < 0 || attempt >= ATTEMPTS_PER_PANEL) {
    throw new Error(`attempt ${attempt} is outside the ${ATTEMPTS_PER_PANEL} slots a panel has in its family`)
  }
  if (panelIndex < 0 || panelIndex >= PANELS_PER_PAGE) {
    throw new Error(`panel index ${panelIndex} is outside the ${PANELS_PER_PAGE} slots a page has`)
  }
  return family + pageIndex * PANELS_PER_PAGE * ATTEMPTS_PER_PANEL + panelIndex * ATTEMPTS_PER_PANEL + attempt
}

/**
 * Which family a panel draws from: its first character's. A panel with two
 * characters cannot serve both families, and the first-listed one is the
 * writer's choice of who the panel is about.
 *
 * A panel with nobody in it still needs a seed; it takes the family of the
 * first character in the cast so an empty establishing shot is stable too.
 */
export function familyFor(
  characters: Record<string, { seed_family: number }>,
  ids: string[],
): number {
  const first = ids[0] ?? Object.keys(characters)[0]
  if (first === undefined) throw new Error('the script has no characters, so no panel has a seed family')
  const character = characters[first]
  if (!character) throw new Error(`panel names character "${first}", which the script does not define`)
  return character.seed_family
}
