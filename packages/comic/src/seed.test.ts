import { describe, expect, it } from 'vitest'
import { ATTEMPTS_PER_PANEL, familyFor, panelSeed } from './seed.ts'

describe('panel seeds', () => {
  it('is the family plus a position offset, so a retry is the next number', () => {
    expect(panelSeed(8812, 0, 0, 0)).toBe(8812)
    expect(panelSeed(8812, 0, 0, 1)).toBe(8813)
    expect(panelSeed(8812, 0, 1, 0)).toBe(8812 + ATTEMPTS_PER_PANEL)
    expect(panelSeed(8812, 3, 1, 2)).toBe(8812 + 300 + 10 + 2)
  })

  it('two panels never share a seed within the retry budget', () => {
    const seen = new Set<number>()
    for (let page = 0; page < 3; page++) {
      for (let panel = 0; panel < 6; panel++) {
        for (let attempt = 0; attempt < ATTEMPTS_PER_PANEL; attempt++) {
          const seed = panelSeed(100, page, panel, attempt)
          expect(seen.has(seed)).toBe(false)
          seen.add(seed)
        }
      }
    }
  })

  it('refuses an attempt past the family slot', () => {
    expect(() => panelSeed(1, 0, 0, ATTEMPTS_PER_PANEL)).toThrow(/outside/)
  })

  it('takes the first character in the panel, and the first in the cast for an empty shot', () => {
    const cast = { ari: { seed_family: 8812 }, kira: { seed_family: 4400 } }
    expect(familyFor(cast, ['kira', 'ari'])).toBe(4400)
    expect(familyFor(cast, [])).toBe(8812)
    expect(() => familyFor(cast, ['bob'])).toThrow(/"bob"/)
  })
})
