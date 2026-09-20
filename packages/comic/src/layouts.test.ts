import { describe, expect, it } from 'vitest'
import { LAYOUTS, bucketFor, cellAspect, cellPixels, coverage, defaultLayoutFor, lineRange, resolveGrid, resolveSpans, sizeForCell, targetForCell, trackFractions } from './layouts.ts'
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

describe('render size', () => {
  const cells = [
    ['a wide hero on a 2:3 page', 2000 / 1500],
    ['a half-width cell', 1000 / 1500],
    ['a square cell', 1],
    ['a tall narrow cell', 500 / 1500],
  ] as const

  it('matches the cell aspect closely enough that the page crops nothing visible', () => {
    for (const [what, aspect] of cells) {
      const size = sizeForCell(aspect)
      const error = Math.abs(size.width / size.height - aspect) / aspect
      // The page would crop this fraction away; the old bucket cost 4%.
      expect(error, what).toBeLessThan(0.012)
    }
  })

  it('keeps both sides on multiples of 8, which is what the sampler needs', () => {
    for (const [what, aspect] of cells) {
      const size = sizeForCell(aspect)
      expect(size.width % 8, what).toBe(0)
      expect(size.height % 8, what).toBe(0)
    }
  })

  it('stays near the bucket it replaces, so quality does not drift', () => {
    for (const [what, aspect] of cells) {
      const size = sizeForCell(aspect)
      const bucket = bucketFor(aspect)
      const ratio = (size.width * size.height) / (bucket.width * bucket.height)
      expect(ratio, what).toBeGreaterThan(0.85)
      expect(ratio, what).toBeLessThan(1.15)
    }
  })

  it('beats the bucket on the 4:3 hero cell that was losing its heads', () => {
    const aspect = 2000 / 1500
    const bucket = bucketFor(aspect)
    const bucketError = Math.abs(bucket.width / bucket.height - aspect) / aspect
    const size = sizeForCell(aspect)
    const sizeError = Math.abs(size.width / size.height - aspect) / aspect
    expect(bucketError).toBeGreaterThan(0.03)
    expect(sizeError).toBeLessThan(bucketError / 3)
  })
})

describe('the size a panel has to be', () => {
  const box = { width: 2000, height: 3000, margin: 60, gutter: 28 }
  const page: Page = { layout: 'grid-2x2', panels: [panel('p1-1'), panel('p1-2'), panel('p1-3'), panel('p1-4')] }

  it('is the cell in device pixels, so the page never stretches it', () => {
    const cell = cellPixels(page, 0, { page: box })
    for (const scale of [1, 1.5, 2]) {
      const target = targetForCell(page, 0, box, scale, 99)
      expect(target.width, `scale ${scale}`).toBeCloseTo(cell.width * scale, -1)
      expect(target.height, `scale ${scale}`).toBeCloseTo(cell.height * scale, -1)
      expect(target.width % 8, `scale ${scale}`).toBe(0)
      expect(target.height % 8, `scale ${scale}`).toBe(0)
    }
  })

  it('keeps the cell aspect, which is what stops a crop', () => {
    const cell = cellPixels(page, 0, { page: box })
    const target = targetForCell(page, 0, box, 2, 99)
    expect(target.width / target.height).toBeCloseTo(cell.width / cell.height, 2)
  })

  it('gives up size rather than shape when it hits the megapixel ceiling', () => {
    const cell = cellPixels(page, 0, { page: box })
    const target = targetForCell(page, 0, box, 2, 2)
    expect(target.width * target.height).toBeLessThanOrEqual(2.05e6)
    expect(target.width / target.height).toBeCloseTo(cell.width / cell.height, 2)
  })
})
