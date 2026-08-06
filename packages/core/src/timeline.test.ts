import { describe, expect, it } from 'vitest'
import {
  WEEK_MS,
  barAt,
  barHeights,
  dragEdge,
  fillWeeks,
  mergeWeeks,
  moveSelection,
  overlayCounts,
  selectionFromRange,
  selectionRange,
  trimIslands,
  weekRange,
} from './timeline.ts'

/** Monday 2024-07-01 00:00 UTC. */
const MONDAY = 1_719_792_000_000

describe('fillWeeks', () => {
  it('rebuilds the quiet weeks the backend left out', () => {
    // A gap in activity is information — a timeline that skips its quiet
    // months misrepresents time itself, and a bar has to exist to be clicked.
    const weeks = fillWeeks([
      { start: MONDAY, count: 5 },
      { start: MONDAY + 3 * WEEK_MS, count: 2 },
    ])
    expect(weeks).toEqual([
      { start: MONDAY, count: 5 },
      { start: MONDAY + WEEK_MS, count: 0 },
      { start: MONDAY + 2 * WEEK_MS, count: 0 },
      { start: MONDAY + 3 * WEEK_MS, count: 2 },
    ])
  })

  it('handles an empty library and a single week', () => {
    expect(fillWeeks([])).toEqual([])
    expect(fillWeeks([{ start: MONDAY, count: 7 }])).toEqual([{ start: MONDAY, count: 7 }])
  })
})

describe('weekRange', () => {
  it('is half-open, so adjacent weeks share a boundary without overlap', () => {
    const { after, before } = weekRange({ start: MONDAY, count: 1 })
    expect(after).toBe(MONDAY)
    expect(before).toBe(MONDAY + WEEK_MS)
    // The next week begins exactly where this one ends.
    expect(weekRange({ start: before, count: 1 }).after).toBe(before)
  })
})

describe('barAt', () => {
  it('maps a pixel to its bar', () => {
    // Ten bars across 100px: x=45 is in the fifth bar (index 4).
    expect(barAt(45, 100, 10)).toBe(4)
  })

  it('clamps past the edges, which is how a drag says "all the way"', () => {
    expect(barAt(-30, 100, 10)).toBe(0)
    expect(barAt(140, 100, 10)).toBe(9)
    // The exact right edge belongs to the last bar, not one past it.
    expect(barAt(100, 100, 10)).toBe(9)
  })

  it('survives degenerate geometry', () => {
    expect(barAt(50, 0, 10)).toBe(0)
    expect(barAt(50, 100, 0)).toBe(0)
  })

  it('treats a coordinate-less event as the first bar, never NaN', () => {
    // NaN slides through Math.min/Math.max untouched, indexes nothing, and
    // silently cleared a drag's whole selection before this guard existed.
    expect(barAt(Number.NaN, 100, 10)).toBe(0)
  })
})

describe('dragEdge', () => {
  it('moves one edge and leaves the other', () => {
    expect(dragEdge({ first: 2, last: 8 }, 'first', 4)).toEqual({ first: 4, last: 8 })
    expect(dragEdge({ first: 2, last: 8 }, 'last', 5)).toEqual({ first: 2, last: 5 })
  })

  it('swaps when an edge is pulled past the other', () => {
    // Crossing mid-drag means "the other way round", not an error — the
    // component relies on first <= last holding afterwards.
    expect(dragEdge({ first: 2, last: 8 }, 'first', 11)).toEqual({ first: 8, last: 11 })
    expect(dragEdge({ first: 2, last: 8 }, 'last', 0)).toEqual({ first: 0, last: 2 })
  })

  it('collapses to a single bar without complaint', () => {
    expect(dragEdge({ first: 2, last: 8 }, 'first', 8)).toEqual({ first: 8, last: 8 })
  })
})

describe('selectionRange', () => {
  const bars = mergeWeeks(
    fillWeeks([
      { start: MONDAY, count: 1 },
      { start: MONDAY + 2 * WEEK_MS, count: 1 },
    ]),
  )

  it('covers from the first bar to the end of the last', () => {
    expect(selectionRange(bars, { first: 0, last: 2 })).toEqual({
      after: MONDAY,
      before: MONDAY + 3 * WEEK_MS,
    })
  })

  it('one bar selects exactly that week', () => {
    expect(selectionRange(bars, { first: 1, last: 1 })).toEqual({
      after: MONDAY + WEEK_MS,
      before: MONDAY + 2 * WEEK_MS,
    })
  })

  it('returns null rather than inventing a range from stale indices', () => {
    // The buckets refresh under the selection when filters change.
    expect(selectionRange(bars, { first: 0, last: 99 })).toBeNull()
  })

  it('a merged bar selects its whole span, honestly including a short tail', () => {
    // Five weeks at two per bar: the last bar covers only one week, and its
    // range must say so rather than rounding the axis up.
    const five = mergeWeeks(
      fillWeeks([
        { start: MONDAY, count: 1 },
        { start: MONDAY + 4 * WEEK_MS, count: 1 },
      ]),
      3,
    )
    expect(five).toHaveLength(3)
    expect(selectionRange(five, { first: 2, last: 2 })).toEqual({
      after: MONDAY + 4 * WEEK_MS,
      before: MONDAY + 5 * WEEK_MS,
    })
  })
})

describe('mergeWeeks', () => {
  it('leaves a span under the cap exactly weekly', () => {
    const weeks = fillWeeks([
      { start: MONDAY, count: 5 },
      { start: MONDAY + 3 * WEEK_MS, count: 2 },
    ])
    const bars = mergeWeeks(weeks, 240)
    expect(bars).toHaveLength(4)
    expect(bars[0]).toEqual({ start: MONDAY, end: MONDAY + WEEK_MS, count: 5 })
  })

  it('caps a decades-long span at a drawable number of bars', () => {
    // The failure this exists for: thousands of week-slots divide the strip
    // into fractions of a pixel and the timeline renders as nothing at all.
    const weeks = fillWeeks([
      { start: MONDAY, count: 3 },
      { start: MONDAY + 2434 * WEEK_MS, count: 5 },
    ])
    expect(weeks.length).toBe(2435)

    const bars = mergeWeeks(weeks, 240)
    expect(bars.length).toBeLessThanOrEqual(240)
    // Nothing lost in the merge: the counts move into the bars.
    expect(bars.reduce((sum, bar) => sum + bar.count, 0)).toBe(8)
    // And the bars tile the span with no gaps or overlaps.
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i]!.start).toBe(bars[i - 1]!.end)
    }
  })

  it('is empty for an empty library', () => {
    expect(mergeWeeks([], 240)).toEqual([])
  })
})

describe('barHeights', () => {
  it('scales to the tallest bar', () => {
    const heights = barHeights([
      { start: MONDAY, count: 100 },
      { start: MONDAY + WEEK_MS, count: 50 },
    ])
    expect(heights).toEqual([1, 0.5])
  })

  it('keeps a tiny week visible next to a huge one', () => {
    // 1 against 4,000 proportionally is a fraction of a pixel —
    // indistinguishable from the empty week beside it, and clicking an
    // invisible bar is not a feature.
    const heights = barHeights([
      { start: MONDAY, count: 4000 },
      { start: MONDAY + WEEK_MS, count: 1 },
      { start: MONDAY + 2 * WEEK_MS, count: 0 },
    ])
    expect(heights[1]).toBeGreaterThan(0.03)
    // But an empty week shows nothing — nothing there is nothing to click.
    expect(heights[2]).toBe(0)
  })

  it('is all zero when everything is', () => {
    expect(barHeights([{ start: MONDAY, count: 0 }])).toEqual([0])
  })
})

describe('trimIslands', () => {
  const YEAR = 52 * WEEK_MS
  /** ~The DOS epoch: what zip extractors stamp on files. */
  const DOS_1980 = 315_446_400_000

  it('drops a handful of DOS-epoch files decades from the library', () => {
    // Three junk mtimes must not put Dec 1979 on the axis and flatten five
    // decades of real weeks into sub-pixel slivers.
    const kept = trimIslands([
      { start: DOS_1980, count: 3 },
      { start: MONDAY, count: 2000 },
      { start: MONDAY + WEEK_MS, count: 1500 },
    ])
    expect(kept.map((bucket) => bucket.start)).toEqual([MONDAY, MONDAY + WEEK_MS])
  })

  it('drops a far-future island too — a camera with a dead clock battery', () => {
    const kept = trimIslands([
      { start: MONDAY, count: 2000 },
      { start: MONDAY + 30 * YEAR, count: 1 },
    ])
    expect(kept).toHaveLength(1)
    expect(kept[0]!.start).toBe(MONDAY)
  })

  it('keeps a genuinely sparse early archive', () => {
    // Old but real: a 2005 folder next to a 2024 library is history, not junk.
    // It fails the "tiny" half of the rule, so the gap alone does not condemn it.
    const early = { start: MONDAY - 19 * YEAR, count: 500 }
    const kept = trimIslands([early, { start: MONDAY, count: 2000 }])
    expect(kept[0]).toEqual(early)
  })

  it('keeps a small cluster that is merely recent, not far away', () => {
    // Close in time fails the "far" half of the rule, whatever its size.
    const buckets = [
      { start: MONDAY, count: 2000 },
      { start: MONDAY + 10 * WEEK_MS, count: 3 },
    ]
    expect(trimIslands(buckets)).toEqual(buckets)
  })

  it('clears multiple islands in one call', () => {
    const kept = trimIslands([
      { start: DOS_1980, count: 1 },
      { start: DOS_1980 + 10 * YEAR, count: 2 },
      { start: MONDAY, count: 5000 },
    ])
    expect(kept).toHaveLength(1)
    expect(kept[0]!.start).toBe(MONDAY)
  })

  it('leaves an empty or single-bucket timeline alone', () => {
    expect(trimIslands([])).toEqual([])
    const one = [{ start: MONDAY, count: 7 }]
    expect(trimIslands(one)).toEqual(one)
  })
})

describe('moveSelection', () => {
  it('slides the whole selection, keeping its width', () => {
    expect(moveSelection({ first: 2, last: 5 }, 3, 20)).toEqual({ first: 5, last: 8 })
    expect(moveSelection({ first: 5, last: 8 }, -4, 20)).toEqual({ first: 1, last: 4 })
  })

  it('parks flush against an end rather than squashing', () => {
    // A hard shove right must land the same-width selection at the end — the
    // width is the thing being dragged, and the clamp must not eat it.
    expect(moveSelection({ first: 2, last: 5 }, 100, 10)).toEqual({ first: 6, last: 9 })
    expect(moveSelection({ first: 4, last: 7 }, -100, 10)).toEqual({ first: 0, last: 3 })
  })

  it('moves a single-bar selection like anything else', () => {
    expect(moveSelection({ first: 3, last: 3 }, 2, 10)).toEqual({ first: 5, last: 5 })
  })

  it('is identity at delta zero, and inert on an empty strip', () => {
    expect(moveSelection({ first: 2, last: 5 }, 0, 10)).toEqual({ first: 2, last: 5 })
    expect(moveSelection({ first: 2, last: 5 }, 3, 0)).toEqual({ first: 2, last: 5 })
  })
})


describe('selectionFromRange', () => {
  const bars = mergeWeeks(
    fillWeeks([
      { start: MONDAY, count: 1 },
      { start: MONDAY + 3 * WEEK_MS, count: 1 },
    ]),
  )

  it('round-trips with selectionRange', () => {
    // The pair is what lets the query be the single source of truth: the
    // panel writes a range from a selection and re-derives the selection
    // from the range, through any re-bucketing in between.
    const chosen = { first: 1, last: 2 }
    const range = selectionRange(bars, chosen)!
    expect(selectionFromRange(bars, range.after, range.before)).toEqual(chosen)
  })

  it('clamps to partial overlap when the bars shifted under the range', () => {
    // A filter change can trim weeks off the span; the surviving overlap is
    // still the selection, not nothing.
    expect(selectionFromRange(bars, MONDAY - 5 * WEEK_MS, MONDAY + WEEK_MS)).toEqual({
      first: 0,
      last: 0,
    })
  })

  it('is null when range and bars are disjoint', () => {
    expect(selectionFromRange(bars, MONDAY + 50 * WEEK_MS, MONDAY + 52 * WEEK_MS)).toBeNull()
  })
})


describe('overlayCounts', () => {
  const span = fillWeeks([
    { start: MONDAY, count: 100 },
    { start: MONDAY + 2 * WEEK_MS, count: 50 },
  ])

  it('keeps the axis and re-counts from the narrower set', () => {
    expect(overlayCounts(span, [{ start: MONDAY + WEEK_MS, count: 7 }])).toEqual([
      { start: MONDAY, count: 0 },
      { start: MONDAY + WEEK_MS, count: 7 },
      { start: MONDAY + 2 * WEEK_MS, count: 0 },
    ])
  })

  it('ignores matches outside the span — the axis decides what is drawable', () => {
    const overlaid = overlayCounts(span, [{ start: MONDAY + 90 * WEEK_MS, count: 5 }])
    expect(overlaid).toHaveLength(3)
    expect(overlaid.every((week) => week.count === 0)).toBe(true)
  })
})
