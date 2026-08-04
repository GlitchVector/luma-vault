import { describe, expect, it } from 'vitest'
import { rangeBetween, retainVisible, toggleSelected } from './selection.ts'

const IDS = [10, 20, 30, 40, 50]

describe('rangeBetween', () => {
  it('takes everything between the two, inclusive', () => {
    expect(rangeBetween(IDS, 20, 40)).toEqual([20, 30, 40])
  })

  it('reads the same upwards', () => {
    // Shift-clicking backwards is as ordinary as forwards, and nobody doing it
    // thinks of themselves as selecting in reverse.
    expect(rangeBetween(IDS, 40, 20)).toEqual([20, 30, 40])
  })

  it('is one id when both ends are the same', () => {
    expect(rangeBetween(IDS, 30, 30)).toEqual([30])
  })

  it('spans the whole list from end to end', () => {
    expect(rangeBetween(IDS, 10, 50)).toEqual(IDS)
  })

  it('selects nothing from a stale anchor', () => {
    // The anchor survives a filter change that removes the row it named. A
    // range measured from a guess would select an arbitrary run.
    expect(rangeBetween(IDS, 99, 30)).toEqual([])
    expect(rangeBetween(IDS, 30, 99)).toEqual([])
  })

  it('follows the order it is given, not the numbers', () => {
    // The grid can be sorted by name, size or shuffled. "Between" means between
    // on screen — the only ordering the person clicking can see.
    expect(rangeBetween([50, 10, 40, 20], 50, 40)).toEqual([50, 10, 40])
  })
})

describe('toggleSelected', () => {
  it('adds then removes', () => {
    const once = toggleSelected(new Set<number>(), 7)
    expect([...once]).toEqual([7])
    expect([...toggleSelected(once, 7)]).toEqual([])
  })

  it('returns a new set every time', () => {
    // React compares by identity: mutating in place gives a grid that is
    // correct in memory and never redraws.
    const before = new Set([1])
    expect(toggleSelected(before, 2)).not.toBe(before)
    expect([...before]).toEqual([1])
  })
})

describe('retainVisible', () => {
  it('drops what the current query no longer contains', () => {
    // Select under one filter, widen, act — without this the action would run
    // over rows that left the screen some time ago.
    expect([...retainVisible(new Set([10, 30, 99]), IDS)]).toEqual([10, 30])
  })

  it('keeps everything when everything is still there', () => {
    expect([...retainVisible(new Set([10, 50]), IDS)]).toEqual([10, 50])
  })
})
