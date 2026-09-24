import { describe, expect, it } from 'vitest'

import {
  CUSTOM_LORAS,
  fillShowcase,
  loraLineBase,
  loraCards,
  loraGroupsByStatus,
  outfitLoraNames,
  outfitRequestPrompt,
  outfitSlug,
  pickShowcase,
  SHOWCASE_SIZE,
} from './loras.ts'

const render = (id: string, prompt: string) => ({ id, prompt })
const promptOf = (item: { prompt: string }) => item.prompt
/** Always the first spare, so a test can say which render a random fill lands on. */
const first = () => 0

describe('the catalogue datasets', () => {
  it('names each dataset as one folder under datasets/, or nothing', () => {
    for (const entry of CUSTOM_LORAS) {
      if (entry.dataset === null) continue
      expect(entry.dataset, entry.name).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    }
  })
})

describe('pickShowcase', () => {
  it('fills the three slots by what the prompt asked for, not by rank', () => {
    const items = [
      render('nude-front', 'ari, 1girl, solo, (completely nude:1.4), full body, standing'),
      render('cowboy-back', 'ari, 1girl, solo, (cowboy shot:1.4), (from behind:1.3), looking back'),
      render('portrait', 'ari, 1girl, solo, (portrait:1.4), face focus'),
      render('cowboy-front', 'ari, 1girl, solo, (cowboy shot:1.4), looking at viewer'),
      render('nude-back', 'ari, 1girl, solo, topless, breasts out, (from behind:1.3)'),
    ]
    expect(pickShowcase(items, promptOf).map((item) => item.id)).toEqual(['cowboy-front', 'cowboy-back', 'nude-back'])
  })

  it('has a size the card can lay out for', () => {
    expect(SHOWCASE_SIZE).toBe(3)
  })

  it('falls back to any dressed front, any dressed rear and any undressed frame', () => {
    const items = [
      render('full-back', 'ari, 1girl, solo, full body, (from behind:1.3)'),
      render('nude-front', 'ari, 1girl, solo, (completely nude:1.4), full body'),
      render('upper-front', 'ari, 1girl, solo, (upper body:1.4), looking at viewer'),
    ]
    expect(pickShowcase(items, promptOf).map((item) => item.id)).toEqual(['upper-front', 'full-back', 'nude-front'])
  })

  it('fills an empty slot with a random starred render rather than leaving a gap', () => {
    const items = [
      render('a', 'ari, 1girl, solo, (portrait:1.4)'),
      render('b', 'ari, 1girl, solo, (portrait:1.2), smile'),
      render('c', 'ari, 1girl, solo, (upper body:1.4)'),
      render('d', 'ari, 1girl, solo, sitting'),
    ]
    // Four dressed fronts and nothing else: slot one takes the best; the rear and nude slots have
    // nothing to match and take a random spare each.
    expect(pickShowcase(items, promptOf, first).map((item) => item.id)).toEqual(['a', 'b', 'c'])
    const last = () => 0.999
    expect(pickShowcase(items, promptOf, last).map((item) => item.id)).toEqual(['a', 'd', 'c'])
  })

  it('tops up from another pool without repeating a render it already holds', () => {
    const picked = [render('kept', 'ari, (cowboy shot:1.4)')]
    const pool = [render('kept', 'same row, other query'), render('x', ''), render('y', ''), render('z', '')]
    const out = fillShowcase(picked, pool, (item) => item.id, first)
    expect(out.map((item) => item.id)).toEqual(['kept', 'x', 'y'])
    expect(fillShowcase(out, pool, (item) => item.id, first)).toHaveLength(SHOWCASE_SIZE)
  })

  it('returns fewer than three when fewer exist, and none for none', () => {
    expect(pickShowcase([render('only', 'ari, 1girl, solo')], promptOf)).toHaveLength(1)
    expect(pickShowcase([], promptOf)).toEqual([])
  })

  it('reads a missing prompt as dressed and front-facing rather than throwing', () => {
    const items = [{ id: 'no-prompt', prompt: null as string | null }]
    expect(pickShowcase(items, (item) => item.prompt).map((item) => item.id)).toEqual(['no-prompt'])
  })

  it('does not count an act-stage frame as dressed, even with the top still on', () => {
    const items = [
      render('undressing', 'ari, (cowboy shot:1.3), standing, looking at viewer, undressing'),
      render('shirt-lift', 'ari, (cowboy shot:1.3), shirt lift, looking at viewer'),
      render('dressed', 'ari, (cowboy shot:1.3), standing, looking at viewer, bracelet'),
    ]
    expect(pickShowcase(items, promptOf, first)[0]!.id).toBe('dressed')
  })

  it('does not let a weighted or bracketed word hide the framing', () => {
    const items = [
      render('front', 'ari, (cowboy shot:1.4), (looking at viewer:1.1)'),
      render('back', 'ari, (cowboy shot:1.4), (from behind:1.4)'),
      render('nude', 'ari, (from behind:1.4), (completely nude:1.4)'),
    ]
    expect(pickShowcase(items, promptOf).map((item) => item.id)).toEqual(['front', 'back', 'nude'])
  })
})

describe('one card per LoRA line', () => {
  it('lists variants under their parent, and gives a new line of the same character its own card', () => {
    const cards = loraCards()
    // Ari twice: the adopt line (final) and the gen line still training (wip) - a new LoRA, not a variant.
    const ari = cards.filter((card) => card.character === 'Ari')
    expect(ari.map((card) => card.main.name)).toEqual(['ari_adopt_v4', 'ari_gen_v6'])
    expect(ari.map((card) => card.line)).toEqual(['ari_adopt', 'ari_gen'])
    // The adopt line has no variants; the gen line carries her outfit variants (2026-09-23/24), in catalogue order.
    expect(ari[0]!.variants).toHaveLength(0)
    expect(ari[1]!.variants.map((entry) => entry.name)).toEqual(['ari_gen_space_leotard_s1', 'ari_gen_space_dress_s1', 'ari_gen_alt_cleavage_s1'])
    const byStatus = loraGroupsByStatus(cards)
    expect(byStatus.final.map((card) => card.main.name)).toEqual(['ari_adopt_v4'])
    expect(byStatus.wip.map((card) => card.main.name)).toContain('ari_gen_v6')

    const mira = cards.filter((card) => card.character === 'Mira Solen')
    expect(mira).toHaveLength(1)
    expect(mira[0]!.main.name).toBe('mirasolen_v2')
    // Every outfit of hers is listed under her, none is a card of its own.
    expect(mira[0]!.variants.filter((entry) => entry.kind === 'outfit').length).toBeGreaterThanOrEqual(7)
    // Nothing is lost in the grouping.
    expect(cards.reduce((sum, card) => sum + 1 + card.variants.length, 0)).toBe(CUSTOM_LORAS.length)
  })

  it('every parent named in the catalogue is a full-character LoRA, current or superseded', () => {
    const byName = new Map<string, (typeof CUSTOM_LORAS)[number]>()
    for (const entry of CUSTOM_LORAS) for (const name of [entry.name, ...entry.olderVersions]) byName.set(name, entry)
    for (const entry of CUSTOM_LORAS) {
      if (entry.parent === null) continue
      const parent = byName.get(entry.parent)
      expect(parent, `${entry.name} names a parent that is not in the catalogue`).toBeTruthy()
      expect(parent!.kind).toBe('full')
      expect(parent!.character).toBe(entry.character)
    }
  })

  it('every outfit in the catalogue lists under a card, never as a card of its own', () => {
    const variants = new Set(loraCards().flatMap((card) => card.variants.map((entry) => entry.name)))
    for (const entry of CUSTOM_LORAS) {
      if (entry.kind === 'outfit') expect(variants.has(entry.name), `${entry.name} has no card to list under`).toBe(true)
    }
  })

  it('keeps an outfit under its card when the main LoRA moves on a version', () => {
    // The outfit was added at v4; v5 replaced v4 and v4 went to olderVersions. Nobody edits the outfit.
    const main = { ...CUSTOM_LORAS.find((entry) => entry.name === 'ari_gen_v6')!, name: 'ari_gen_v7', olderVersions: ['ari_gen_v6', 'ari_gen_v4'] }
    const outfit = { ...CUSTOM_LORAS.find((entry) => entry.name === 'ari_gen_space_dress_s1')!, parent: 'ari_gen_v4' }
    const cards = loraCards([main, outfit])
    expect(cards).toHaveLength(1)
    expect(cards[0]!.variants.map((entry) => entry.name)).toEqual(['ari_gen_space_dress_s1'])
  })

  it('an outfit entry always says which outfit', () => {
    for (const entry of CUSTOM_LORAS) {
      if (entry.kind === 'outfit') expect(entry.outfit, entry.name).toBeTruthy()
    }
  })
})

describe('adding an outfit', () => {
  const ari = CUSTOM_LORAS.find((entry) => entry.name === 'ari_gen_v6')!

  it('strips the version to find the line', () => {
    expect(loraLineBase('ari_gen_v5')).toBe('ari_gen')
    expect(loraLineBase('ari_adopt_v4')).toBe('ari_adopt')
    expect(loraLineBase('msbs_v2e6')).toBe('msbs')
    expect(loraLineBase('celoback_v1')).toBe('celoback')
  })

  it('names the LoRA after the line, the trigger after the character, the folders after both', () => {
    expect(outfitSlug('Space Suit!')).toBe('space-suit')
    const names = outfitLoraNames(ari, 'Space Suit')
    expect(names).toEqual({
      slug: 'space-suit',
      base: 'ari_gen_space_suit',
      stage1: 'ari_gen_space_suit_s1',
      final: 'ari_gen_space_suit_v1',
      trigger: 'arispacesuit',
      refs: 'ari-space-suit',
      dataset: 'ari-space-suit',
    })
  })

  it('writes a message that starts the refs command and carries the names, the rules and the image', () => {
    const prompt = outfitRequestPrompt(ari, 'Space Suit', 'D:/refs/ari-space.png')
    expect(prompt.startsWith('/character-refs ari-space-suit - outfit variant')).toBe(true)
    expect(prompt).toContain('`ari_gen_space_suit`')
    expect(prompt).toContain('trigger `arispacesuit`')
    expect(prompt).toContain('D:/refs/ari-space.png')
    expect(prompt).toContain('sheets/ari-face-refs-gen')
    expect(prompt).toContain("kind 'outfit', outfit 'Space Suit', parent 'ari_gen_v6'")
    expect(prompt).toContain('.ai/lora-training.md')
    // Without a path the message points at the attachment instead.
    expect(outfitRequestPrompt(ari, 'Space Suit')).toContain('attached to this message')
  })
})
