import { describe, expect, it } from 'vitest'
import { actKeyOf, actLabelOf, mergeSetOrder, type SetMember } from './setorder.ts'

/** Labels taken verbatim from the library, including the arrow the runs use. */
const REAL = {
  stage: 'stage 1 — cowboy shot',
  stageLater: 'stage 3 — full body from behind',
  bridge: 'bridge 1→2 — taking the jacket off',
  bridgeArrow: 'bridge 2->3 — from behind',
  act: 'act 7 — spitroast',
  actLater: 'act 8 — reverse cowgirl',
  lora: '4-6-susp-assgrab-02',
}

const member = (label: string | null, setOrdinal: number, position: number): SetMember<string> => ({
  item: `${setOrdinal}:${position}:${label ?? '-'}`,
  setOrdinal,
  position,
  label,
})

describe('actKeyOf', () => {
  it('reads the three shapes the runs actually write', () => {
    expect(actKeyOf(REAL.stage)).toEqual({ phase: 0, index: 1, sub: 0 })
    expect(actKeyOf(REAL.act)).toEqual({ phase: 1, index: 7, sub: 0 })
    expect(actKeyOf(REAL.lora)).toEqual({ phase: 2, index: 0, sub: 0 })
  })

  // A bridge starts with a number too, so an over-eager stage pattern would
  // miss it entirely and throw every transition to the end of the post.
  it('puts a bridge after the stage it leaves and before the next', () => {
    expect(actKeyOf(REAL.bridge)).toEqual({ phase: 0, index: 1, sub: 1 })
    expect(actKeyOf(REAL.bridgeArrow)).toEqual({ phase: 0, index: 2, sub: 1 })
  })

  it('treats a missing label as unlabelled rather than stage zero', () => {
    expect(actKeyOf(null).phase).toBe(2)
    expect(actKeyOf(undefined).phase).toBe(2)
  })
})

describe('mergeSetOrder', () => {
  // The point of the whole file: appending one set to the other would run the
  // dressed-to-undressed progression twice.
  it('collates two sets by stage rather than appending one to the other', () => {
    const merged = mergeSetOrder([
      member('stage 1 — a', 0, 0),
      member('stage 2 — a', 0, 1),
      member('stage 1 — b', 1, 0),
      member('stage 2 — b', 1, 1),
    ])
    expect(merged).toEqual(['0:0:stage 1 — a', '1:0:stage 1 — b', '0:1:stage 2 — a', '1:1:stage 2 — b'])
  })

  it('keeps every stage before any act, across sets', () => {
    const merged = mergeSetOrder([
      member('act 1 — a', 0, 0),
      member('stage 9 — b', 1, 0),
    ])
    expect(merged[0]).toContain('stage 9')
  })

  it('threads bridges between the stages they name', () => {
    const merged = mergeSetOrder([
      member('stage 2 — x', 0, 2),
      member('bridge 1→2 — jacket', 0, 1),
      member('stage 1 — x', 0, 0),
    ])
    expect(merged).toEqual(['0:0:stage 1 — x', '0:1:bridge 1→2 — jacket', '0:2:stage 2 — x'])
  })

  // Interleaved by stage, not shuffled frame by frame — a reader should still
  // be able to tell two shoots apart.
  it('keeps a set contiguous within one stage', () => {
    const merged = mergeSetOrder([
      member('stage 1 — a1', 0, 0),
      member('stage 1 — a2', 0, 1),
      member('stage 1 — b1', 1, 0),
      member('stage 1 — b2', 1, 1),
    ])
    expect(merged).toEqual(['0:0:stage 1 — a1', '0:1:stage 1 — a2', '1:0:stage 1 — b1', '1:1:stage 1 — b2'])
  })

  // More than half this library's labelled members are lora crops with no
  // narrative. Dropping or reshuffling them would be the worst outcome.
  it('leaves an unlabelled selection exactly as it arrived', () => {
    const merged = mergeSetOrder([
      member(REAL.lora, 0, 0),
      member(null, 0, 1),
      member('4-6-susp-03', 1, 0),
    ])
    expect(merged).toEqual(['0:0:4-6-susp-assgrab-02', '0:1:-', '1:0:4-6-susp-03'])
  })

  it('sorts the unlabelled after everything that has a place', () => {
    const merged = mergeSetOrder([member(REAL.lora, 0, 0), member('act 1 — x', 0, 1)])
    expect(merged[0]).toContain('act 1')
  })

  // Two manifests for one run, each enumerating from zero, is a real state in
  // this index. Without a final tie-break the result depends on sort internals.
  it('is stable when two members collide on set and position', () => {
    const once = mergeSetOrder([member('stage 1 — a', 0, 0), member('stage 1 — b', 0, 0)])
    const twice = mergeSetOrder([member('stage 1 — a', 0, 0), member('stage 1 — b', 0, 0)])
    expect(once).toEqual(twice)
    expect(once[0]).toContain('stage 1 — a')
  })
})

describe('actLabelOf', () => {
  it('names a group the way the run does', () => {
    expect(actLabelOf(REAL.stageLater)).toBe('stage 3')
    expect(actLabelOf(REAL.actLater)).toBe('act 8')
    expect(actLabelOf(REAL.bridge)).toBe('bridge 1→2')
  })

  it('refuses to invent a heading for something with no narrative', () => {
    expect(actLabelOf(REAL.lora)).toBeNull()
    expect(actLabelOf(null)).toBeNull()
  })
})
