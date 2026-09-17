import { describe, expect, it } from 'vitest'
import { LAYOUTS, bucketFor, cellAspect, coverage, defaultLayoutFor, lineRange, resolveGrid, resolveSpans, trackFractions } from './layouts.ts'
import type { Page } from './schema.ts'

const panel = (id: string) => ({
  id,
  camera: 'cowboy shot',
  scene: 'rooftop',
  pose: [],
  characters: [],
  reserve_space: 'none' as const,
  dialogue: [],
  sfx: [],
})

describe('grid templates', () => {
  it('reads repeat() and fr lists as fractions', () => {
    expect(trackFractions('repeat(2, 1fr)')).toEqual([0.5, 0.5])
    expect(trackFractions('1fr 3fr')).toEqual([0.25, 0.75])
  })

  it('refuses tracks it cannot size', () => {
    expect(() => trackFractions('200px 1fr')).toThrow(/only fr tracks/)
  })

  it('reads a span as grid lines', () => {
    expect(lineRange('1 / 3')).toEqual({ start: 1, end: 3 })
    expect(lineRange('2')).toEqual({ start: 2, end: 3 })
    expect(lineRange('2 / span 2')).toEqual({ start: 2, end: 4 })
    expect(() => lineRange('3 / 2')).toThrow(/ends before it starts/)
  })

  it('covers the fraction of the axis a span takes', () => {
    expect(coverage('repeat(2, 1fr)', '1 / 3')).toBe(1)
    expect(coverage('repeat(6, 1fr)', '1 / 4')).toBeCloseTo(0.5)
    expect(() => coverage('repeat(2, 1fr)', '1 / 4')).toThrow(/past the 2 tracks/)
  })
})

describe('presets', () => {
  it('every preset has as many cells as its name promises, all inside the grid', () => {
    for (const [name, layout] of Object.entries(LAYOUTS)) {
      for (const cell of layout.cells) {
        expect(() => coverage(layout.columns, cell.col), name).not.toThrow()
        expect(() => coverage(layout.rows, cell.row), name).not.toThrow()
      }
    }
  })

  it('picks a default by panel count and names the gap', () => {
    expect(defaultLayoutFor(3)).toBe('hero-top')
    expect(() => defaultLayoutFor(7)).toThrow(/no default layout for 7/)
  })

  it('fills spans from the preset, in order, and keeps an explicit span', () => {
    const page: Page = {
      layout: 'hero-top',
      panels: [panel('p1-1'), { ...panel('p1-2'), span: { col: '2', row: '2' } }, panel('p1-3')],
    }
    expect(resolveSpans(page)).toEqual([{ col: '1 / 3', row: '1' }, { col: '2', row: '2' }, { col: '2', row: '2' }])
    expect(resolveGrid(page)).toEqual({ columns: 'repeat(2, 1fr)', rows: 'repeat(2, 1fr)' })
  })

  it('names an unknown preset and a panel past the preset', () => {
    expect(() => resolveSpans({ layout: 'nope', panels: [panel('p1-1')] })).toThrow(/unknown layout "nope"/)
    expect(() => resolveSpans({ layout: 'splash', panels: [panel('p1-1'), panel('p1-2')] })).toThrow(/has 1 cells/)
  })
})

describe('buckets', () => {
  it('a wide hero cell on a 2:3 page lands on a landscape bucket', () => {
    const aspect = cellAspect({ columns: 'repeat(2, 1fr)', rows: 'repeat(2, 1fr)' }, { col: '1 / 3', row: '1' }, 2000, 3000)
    expect(aspect).toBeCloseTo(2000 / 1500)
    expect(bucketFor(aspect)).toEqual({ width: 1152, height: 896 })
  })

  it('a half-width cell in a two-row grid is a portrait bucket', () => {
    const aspect = cellAspect({ columns: 'repeat(2, 1fr)', rows: 'repeat(2, 1fr)' }, { col: '1', row: '2' }, 2000, 3000)
    expect(bucketFor(aspect)).toEqual({ width: 832, height: 1216 })
  })

  it('a square cell is the square bucket', () => {
    expect(bucketFor(1)).toEqual({ width: 1024, height: 1024 })
  })
})
