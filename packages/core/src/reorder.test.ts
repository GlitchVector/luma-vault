import { describe, expect, it } from 'vitest'
import { moveRows, reverseRows } from './reorder.ts'

const abcde = ['a', 'b', 'c', 'd', 'e'] as const

describe('moveRows', () => {
  it('moves one row down: the gap is measured with the row still in place', () => {
    // Dropping 'a' into the gap before 'd' (gap 3) lands it after 'c'.
    expect(moveRows(abcde, [0], 3)).toEqual(['b', 'c', 'a', 'd', 'e'])
  })

  it('moves one row up', () => {
    expect(moveRows(abcde, [4], 1)).toEqual(['a', 'e', 'b', 'c', 'd'])
  })

  it('moves to the very start and the very end', () => {
    expect(moveRows(abcde, [2], 0)).toEqual(['c', 'a', 'b', 'd', 'e'])
    expect(moveRows(abcde, [2], 5)).toEqual(['a', 'b', 'd', 'e', 'c'])
  })

  // The whole point of the checkboxes: rows picked from anywhere arrive together,
  // in the order they had, wherever the one being dragged is dropped.
  it('moves several rows as one block in their own order', () => {
    expect(moveRows(abcde, [4, 1], 3)).toEqual(['a', 'c', 'b', 'e', 'd'])
    expect(moveRows(abcde, [0, 2, 4], 5)).toEqual(['b', 'd', 'a', 'c', 'e'])
    expect(moveRows(abcde, [3, 4], 0)).toEqual(['d', 'e', 'a', 'b', 'c'])
  })

  // Identity on a no-op lets the panel skip the manifest write.
  it('returns the same list when the drop changes nothing', () => {
    expect(moveRows(abcde, [1], 1)).toBe(abcde)
    expect(moveRows(abcde, [1], 2)).toBe(abcde)
    expect(moveRows(abcde, [1, 2], 3)).toBe(abcde)
    expect(moveRows(abcde, [], 3)).toBe(abcde)
  })

  it('ignores indices outside the list and duplicates', () => {
    expect(moveRows(abcde, [7, -1, 2, 2], 0)).toEqual(['c', 'a', 'b', 'd', 'e'])
    expect(moveRows(abcde, [9], 0)).toBe(abcde)
  })

  it('clamps a target beyond the ends', () => {
    expect(moveRows(abcde, [0], 99)).toEqual(['b', 'c', 'd', 'e', 'a'])
    expect(moveRows(abcde, [4], -3)).toEqual(['e', 'a', 'b', 'c', 'd'])
  })
})

describe('reverseRows', () => {
  it('reverses without touching the input', () => {
    expect(reverseRows(abcde)).toEqual(['e', 'd', 'c', 'b', 'a'])
    expect(abcde).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('returns a list of fewer than two rows as is', () => {
    const one = ['a']
    expect(reverseRows(one)).toBe(one)
  })
})
