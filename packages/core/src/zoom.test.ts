import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  clampView,
  fitScale,
  fitView,
  isOverPicture,
  isZoomed,
  zoomAbout,
} from './zoom.ts'

/** A tall picture in a landscape window, which is the awkward case throughout. */
const PICTURE = { width: 2080, height: 3040 }
const VIEWPORT = { width: 1200, height: 800 }

describe('fitScale', () => {
  it('fits by whichever axis runs out first', () => {
    // Height binds: 800/3040 is smaller than 1200/2080.
    expect(fitScale(PICTURE, VIEWPORT)).toBeCloseTo(800 / 3040, 6)
    expect(fitScale({ width: 4000, height: 1000 }, VIEWPORT)).toBeCloseTo(1200 / 4000, 6)
  })

  it('never magnifies a small picture to fill the window', () => {
    expect(fitScale({ width: 200, height: 150 }, VIEWPORT)).toBe(1)
  })

  it('is a usable floor for zooming, being never above 1', () => {
    // What lets "fit" double as the lower bound: it can never be *more*
    // magnified than original size, so the zoom range is never inverted.
    expect(fitScale({ width: 1, height: 1 }, VIEWPORT)).toBeLessThanOrEqual(1)
  })

  it('answers rather than dividing by zero for a viewport not measured yet', () => {
    expect(fitScale(PICTURE, { width: 0, height: 0 })).toBe(1)
    expect(fitScale({ width: 0, height: 0 }, VIEWPORT)).toBe(1)
  })
})

describe('fitView', () => {
  it('centres the whole picture', () => {
    const view = fitView(PICTURE, VIEWPORT)
    expect(view.scale).toBeCloseTo(800 / 3040, 6)
    // Letterboxed left and right, flush top and bottom.
    expect(view.x).toBeCloseTo((1200 - 2080 * view.scale) / 2, 4)
    expect(view.y).toBeCloseTo(0, 4)
  })
})

describe('clampView', () => {
  it('will not let the edges of a large picture come inside the viewport', () => {
    const scale = 1
    // Dragged far past the top-left.
    const pulled = clampView({ scale, x: 500, y: 500 }, PICTURE, VIEWPORT)
    expect(pulled).toEqual({ scale, x: 0, y: 0 })

    // And far past the bottom-right.
    const pushed = clampView({ scale, x: -9000, y: -9000 }, PICTURE, VIEWPORT)
    expect(pushed).toEqual({ scale, x: 1200 - 2080, y: 800 - 3040 })
  })

  it('centres an axis where the picture is smaller than the viewport', () => {
    // Not clamped to an edge — a picture drifting around its own empty space
    // turns panning into a way to lose it.
    const view = clampView({ scale: 0.25, x: 999, y: -999 }, PICTURE, VIEWPORT)
    expect(view.x).toBeCloseTo((1200 - 2080 * 0.25) / 2, 4)
    expect(view.y).toBeCloseTo((800 - 3040 * 0.25) / 2, 4)
  })

  it('leaves a view that is already in bounds alone', () => {
    const view = { scale: 1, x: -400, y: -1000 }
    expect(clampView(view, PICTURE, VIEWPORT)).toEqual(view)
  })
})

describe('zoomAbout', () => {
  it('holds the point under the cursor still', () => {
    // The property the whole thing rests on: point at a detail, and it stays
    // where you pointed instead of sliding toward the centre.
    //
    // A point on the picture and clear of its edges. Fitting letterboxes this
    // one to x 326-874, so a point further out is in the surround, and near an
    // edge the clamp overrides the anchor on purpose — that is the next case.
    const at = { x: 650, y: 450 }
    const from = fitView(PICTURE, VIEWPORT)
    const pictureX = (at.x - from.x) / from.scale
    const pictureY = (at.y - from.y) / from.scale

    const to = zoomAbout(from, PICTURE, VIEWPORT, 1, at)

    expect(to.x + pictureX * to.scale).toBeCloseTo(at.x, 4)
    expect(to.y + pictureY * to.scale).toBeCloseTo(at.y, 4)
  })

  it('gives up the fixed point rather than the bounds at an edge', () => {
    // Zooming about a corner would otherwise pull the picture off the viewport.
    // Clamping wins, so the anchor slides — the alternative is a gap.
    const from = fitView(PICTURE, VIEWPORT)
    const to = zoomAbout(from, PICTURE, VIEWPORT, 1, { x: 0, y: 0 })
    expect(to.x).toBeLessThanOrEqual(0)
    expect(to.y).toBeLessThanOrEqual(0)
    expect(to.x).toBeGreaterThanOrEqual(1200 - 2080)
  })

  it('clamps the request to between fitting and the maximum', () => {
    const from = fitView(PICTURE, VIEWPORT)
    const at = { x: 600, y: 400 }

    // Callers multiply freely; the bounds live here.
    expect(zoomAbout(from, PICTURE, VIEWPORT, 999, at).scale).toBe(MAX_SCALE)
    expect(zoomAbout(from, PICTURE, VIEWPORT, 0.0001, at).scale).toBeCloseTo(
      fitScale(PICTURE, VIEWPORT),
      6,
    )
  })

  it('recovers rather than producing NaN from a degenerate view', () => {
    // A view built before the viewport was measured. NaN offsets would reach
    // the style attribute and blank the picture outright.
    const to = zoomAbout({ scale: 0, x: 0, y: 0 }, PICTURE, VIEWPORT, 1, { x: 10, y: 10 })
    expect(Number.isFinite(to.x)).toBe(true)
    expect(Number.isFinite(to.y)).toBe(true)
    expect(Number.isFinite(to.scale)).toBe(true)
  })

  it('round-trips back to fitting', () => {
    const at = { x: 700, y: 300 }
    const fitted = fitView(PICTURE, VIEWPORT)
    const inThenOut = zoomAbout(
      zoomAbout(fitted, PICTURE, VIEWPORT, 1, at),
      PICTURE,
      VIEWPORT,
      fitScale(PICTURE, VIEWPORT),
      at,
    )
    expect(inThenOut.scale).toBeCloseTo(fitted.scale, 6)
    expect(inThenOut.x).toBeCloseTo(fitted.x, 4)
    expect(inThenOut.y).toBeCloseTo(fitted.y, 4)
  })
})

describe('isOverPicture', () => {
  it('separates the picture from the space around it', () => {
    // Which is what tells "clicked the backdrop to close" from "clicked the
    // picture to zoom". Fitting letterboxes, so at rest most of the viewport is
    // not the picture.
    const view = fitView(PICTURE, VIEWPORT)
    expect(isOverPicture(view, PICTURE, { x: 600, y: 400 })).toBe(true)
    expect(isOverPicture(view, PICTURE, { x: 5, y: 400 })).toBe(false)
    expect(isOverPicture(view, PICTURE, { x: 1195, y: 400 })).toBe(false)
  })

  it('counts the edges as the picture', () => {
    const view = { scale: 1, x: 100, y: 50 }
    expect(isOverPicture(view, { width: 10, height: 10 }, { x: 100, y: 50 })).toBe(true)
    expect(isOverPicture(view, { width: 10, height: 10 }, { x: 110, y: 60 })).toBe(true)
    expect(isOverPicture(view, { width: 10, height: 10 }, { x: 111, y: 60 })).toBe(false)
  })
})

describe('isZoomed', () => {
  it('is false at rest and true once magnified', () => {
    expect(isZoomed(fitView(PICTURE, VIEWPORT), PICTURE, VIEWPORT)).toBe(false)
    expect(isZoomed({ scale: 1, x: 0, y: 0 }, PICTURE, VIEWPORT)).toBe(true)
  })

  it('tolerates the rounding a wheel factor leaves behind', () => {
    // The scale arrives from repeated multiplication, so landing exactly on the
    // fit scale is the one thing it will never do. Without the tolerance, a
    // picture zoomed out to fitting would still report as zoomed and keep
    // offering a grab cursor over a picture that cannot move.
    const fit = fitScale(PICTURE, VIEWPORT)
    expect(isZoomed({ scale: fit + 1e-12, x: 0, y: 0 }, PICTURE, VIEWPORT)).toBe(false)
  })
})
