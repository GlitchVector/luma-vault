/**
 * Page layouts as CSS grid templates, and the geometry the renderer needs
 * from them.
 *
 * A preset is a grid plus one cell per panel. The writer names a preset with
 * the right number of cells; the assembler turns it into `grid-template-*`
 * and `grid-column`/`grid-row`; the panel stage reads each cell's aspect off
 * the same definition to choose an SDXL bucket. One source, three readers —
 * so a layout cannot render at one shape and be pasted into another.
 */

import { COMIC_LAYOUTS, type ComicLayout } from '@luma/core'
import type { Grid, Page, Panel, Span } from './schema.ts'

/** The presets live in `@luma/core` so the app's editor offers the same names. */
export type Layout = ComicLayout
export const LAYOUTS: Record<string, Layout> = COMIC_LAYOUTS

/** The preset a page with `count` panels gets when the writer names none. */
export function defaultLayoutFor(count: number): string {
  const byCount: Record<number, string> = {
    1: 'splash',
    2: 'two-stack',
    3: 'hero-top',
    4: 'grid-2x2',
    5: 'wide-2-2',
    6: 'grid-2x3',
    9: 'grid-3x3',
  }
  const name = byCount[count]
  if (!name) throw new Error(`no default layout for ${count} panels; name one, or give each panel a span`)
  return name
}

export function resolveGrid(page: Page): Grid {
  if (typeof page.layout !== 'string') return page.layout
  const preset = LAYOUTS[page.layout]
  if (!preset) {
    throw new Error(`unknown layout "${page.layout}"; presets: ${Object.keys(LAYOUTS).join(', ')}`)
  }
  return { columns: preset.columns, rows: preset.rows }
}

/** Each panel's span: its own if it has one, else the preset's cell in order. */
export function resolveSpans(page: Page): Span[] {
  const preset = typeof page.layout === 'string' ? LAYOUTS[page.layout] : undefined
  if (typeof page.layout === 'string' && !preset) {
    throw new Error(`unknown layout "${page.layout}"; presets: ${Object.keys(LAYOUTS).join(', ')}`)
  }
  return page.panels.map((panel: Panel, index: number) => {
    if (panel.span) return panel.span
    const cell = preset?.cells[index]
    if (!cell) {
      throw new Error(
        `panel ${panel.id} has no span and layout ${String(page.layout)} has ${preset?.cells.length ?? 0} cells`,
      )
    }
    return cell
  })
}

/**
 * Track sizes as fractions of the whole, from a template.
 *
 * Only `repeat(n, 1fr)` and space-separated `<n>fr` lists are understood,
 * because those are the only templates a page layout needs. Anything else
 * is an error at parse time rather than a wrong-shaped panel at render time.
 */
export function trackFractions(template: string): number[] {
  const repeat = template.trim().match(/^repeat\(\s*(\d+)\s*,\s*([\d.]+)fr\s*\)$/)
  if (repeat) return Array.from({ length: Number(repeat[1]) }, () => 1 / Number(repeat[1]))
  const parts = template.trim().split(/\s+/)
  const weights = parts.map((part) => {
    const m = part.match(/^([\d.]+)fr$/)
    if (!m) throw new Error(`grid template "${template}": only fr tracks are supported`)
    return Number(m[1])
  })
  const total = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => w / total)
}

/** `"1 / 3"` → lines 1 to 3; `"2"` → lines 2 to 3; `"2 / span 2"` → 2 to 4. */
export function lineRange(spec: string): { start: number; end: number } {
  const [a, b] = spec.split('/').map((s) => s.trim())
  const start = Number(a)
  if (!Number.isInteger(start) || start < 1) throw new Error(`grid line "${spec}" is not a positive integer`)
  if (b === undefined || b === '') return { start, end: start + 1 }
  const span = b.match(/^span\s+(\d+)$/)
  const end = span ? start + Number(span[1]) : Number(b)
  if (!Number.isInteger(end) || end <= start) throw new Error(`grid line "${spec}" ends before it starts`)
  return { start, end }
}

/** The fraction of the page a span covers, on one axis. */
export function coverage(template: string, spec: string): number {
  const tracks = trackFractions(template)
  const { start, end } = lineRange(spec)
  if (end - 1 > tracks.length) throw new Error(`grid line "${spec}" is past the ${tracks.length} tracks of "${template}"`)
  return tracks.slice(start - 1, end - 1).reduce((a, b) => a + b, 0)
}

/** Width over height of a panel's cell on a page of the given size. */
export function cellAspect(grid: Grid, span: Span, pageWidth: number, pageHeight: number): number {
  const w = pageWidth * coverage(grid.columns, span.col)
  const h = pageHeight * coverage(grid.rows, span.row)
  return w / h
}

/** The SDXL resolutions a checkpoint trained at. Anything else is a bucket
 *  the model never saw and the first thing to go is anatomy. */
export const BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [640, 1536],
  [768, 1344],
  [832, 1216],
  [896, 1152],
  [1024, 1024],
  [1152, 896],
  [1216, 832],
  [1344, 768],
  [1536, 640],
]


/** What the stylesheet needs to lay a page out, and the renderer needs to
 *  know how big a panel really is. */
export interface PageBox {
  width: number
  height: number
  margin: number
  gutter: number
}

/**
 * How big a panel's cell actually is, in CSS pixels.
 *
 * The grid is the page minus its margins, minus a gutter between every pair
 * of tracks, shared out by the track fractions. The upscaler needs this:
 * enlarging a panel by the device scale alone leaves it short, because a
 * panel is drawn at the sampler's comfortable size rather than the cell's.
 */
export function cellPixels(page: Page, index: number, config: { page: PageBox }): { width: number; height: number } {
  const grid = resolveGrid(page)
  const span = resolveSpans(page)[index]!
  const inner = {
    width: config.page.width - 2 * config.page.margin,
    height: config.page.height - 2 * config.page.margin,
  }
  const columns = trackFractions(grid.columns).length
  const rows = trackFractions(grid.rows).length
  const usable = {
    width: inner.width - config.page.gutter * (columns - 1),
    height: inner.height - config.page.gutter * (rows - 1),
  }
  const spanned = { col: lineRange(span.col), row: lineRange(span.row) }
  return {
    width: usable.width * coverage(grid.columns, span.col) + config.page.gutter * (spanned.col.end - spanned.col.start - 1),
    height: usable.height * coverage(grid.rows, span.row) + config.page.gutter * (spanned.row.end - spanned.row.start - 1),
  }
}

/**
 * The size to render a panel at: the nearest bucket's pixel budget, but at
 * the CELL's exact aspect rather than the bucket's.
 *
 * A bucket is a coarse step, so a 4:3 cell was rendered at 1152x896 (1.286)
 * and the page's `object-fit: cover` then threw away 4% of it — off the top
 * and bottom, on a render that already had the character's head at the very
 * edge. Worse, QA measured the whole file while the reader saw the crop.
 * Multiples of 8 are what the sampler needs, and they land within about a
 * percent of any aspect, so nothing meaningful is cropped.
 */
export function sizeForCellBox(page: Page, index: number, box: PageBox): { width: number; height: number } {
  const cell = cellPixels(page, index, { page: box })
  return sizeForCell(cell.width / cell.height)
}

/**
 * The size a panel has to BE for the page never to enlarge it: its own cell,
 * in device pixels.
 *
 * `sizeForCellBox` gives the size the checkpoint composes well at, which is
 * smaller than any cell on a retina page. The difference used to be made up
 * afterwards by an ESRGAN pass, and an ESRGAN pass cannot draw what it
 * cannot see: a face came back sharp and wrong. So the panel is asked for at
 * this size to begin with, as the second pass of its own render.
 */
export function targetForCell(
  page: Page,
  index: number,
  box: PageBox,
  scale: number,
  maxMegapixels: number,
): { width: number; height: number } {
  const cell = cellPixels(page, index, { page: box })
  let width = cell.width * scale
  let height = cell.height * scale
  const cap = maxMegapixels * 1e6
  if (width * height > cap) {
    // Keep the shape, give up the size. What is lost here the assembler's
    // upscaler makes up, badly but finitely.
    const shrink = Math.sqrt(cap / (width * height))
    width *= shrink
    height *= shrink
  }
  return { width: eight(width), height: eight(height) }
}

/** The sampler works in units of 8 pixels. Rounding each side on its own
 *  moves the aspect by under a tenth of a percent at these sizes. */
function eight(value: number): number {
  return Math.max(256, Math.round(value / 8) * 8)
}

export function sizeForCell(aspect: number): { width: number; height: number } {
  const bucket = bucketFor(aspect)
  const budget = bucket.width * bucket.height
  let best = { width: bucket.width, height: bucket.height }
  let bestError = Infinity
  // A few steps either side of the ideal, so both dimensions stay on 8 and
  // the total stays near the budget the checkpoint was trained around.
  const ideal = Math.sqrt(budget * aspect)
  for (let step = -4; step <= 4; step++) {
    const width = Math.round((ideal + step * 8) / 8) * 8
    if (width < 256) continue
    const height = Math.round(width / aspect / 8) * 8
    if (height < 256) continue
    const shape = Math.abs(width / height - aspect) / aspect
    const size = Math.abs(width * height - budget) / budget
    // Shape is what causes a crop; total pixels only affect quality a little.
    const error = shape * 10 + size
    if (error < bestError) {
      bestError = error
      best = { width, height }
    }
  }
  return best
}

/** The bucket whose aspect is nearest — in log space, so 2:1 and 1:2 are
 *  equally far from square. */
export function bucketFor(aspect: number): { width: number; height: number } {
  let best = BUCKETS[0]!
  let bestDistance = Infinity
  for (const bucket of BUCKETS) {
    const distance = Math.abs(Math.log(bucket[0] / bucket[1]) - Math.log(aspect))
    if (distance < bestDistance) {
      bestDistance = distance
      best = bucket
    }
  }
  return { width: best[0], height: best[1] }
}
