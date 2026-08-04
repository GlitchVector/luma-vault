/**
 * Panning and zooming a picture inside a fixed viewport.
 *
 * Pure geometry, deliberately: jsdom has no layout engine, so a component test
 * can only assert that *some* numbers reached the style attribute. Whether they
 * are the right numbers has to be decided somewhere a fast unit test can reach,
 * and this is that place.
 *
 * The model is one `View` — a scale and the top-left corner of the scaled
 * picture, in viewport coordinates. Everything else is derived from it. There
 * is no separate "fitted" and "zoomed" mode down here; fitting is just the view
 * at {@link fitScale}, which is what lets the same clamping and anchoring code
 * serve both.
 */

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface View {
  /** Multiplier on the picture's natural size. 1 is one image pixel per CSS pixel. */
  scale: number
  /** Top-left of the scaled picture, relative to the viewport's top-left. */
  x: number
  y: number
}

/**
 * How far in zooming may go.
 *
 * 8x an original is already well past the point where there is more detail to
 * find — beyond it you are inspecting the upscaler, not the picture.
 */
export const MAX_SCALE = 8

/**
 * The scale at which the whole picture is visible.
 *
 * Capped at 1 for the same reason {@link fitInside} is: a small picture shown
 * at its own size is the honest rendering, and blowing it up to fill the window
 * shows its pixels while adding nothing. That cap is also what makes this a
 * usable lower bound for zooming — it can never exceed 1, so "fit" is never
 * more magnified than "original size".
 */
export function fitScale(natural: Size, viewport: Size): number {
  if (natural.width <= 0 || natural.height <= 0) return 1
  if (viewport.width <= 0 || viewport.height <= 0) return 1
  return Math.min(1, viewport.width / natural.width, viewport.height / natural.height)
}

/**
 * Keep the picture somewhere it can be seen.
 *
 * On an axis where the picture is larger than the viewport its edges are not
 * allowed inside, so every part of it is reachable and nothing beyond it is. On
 * an axis where it is smaller it is centred outright — there is nothing to
 * explore there, and letting it drift around its own empty space would turn a
 * pan into a way to lose the picture.
 */
export function clampView(view: View, natural: Size, viewport: Size): View {
  return {
    scale: view.scale,
    x: clampAxis(view.x, natural.width * view.scale, viewport.width),
    y: clampAxis(view.y, natural.height * view.scale, viewport.height),
  }
}

function clampAxis(offset: number, size: number, bound: number): number {
  if (size <= bound) return (bound - size) / 2
  return Math.min(0, Math.max(bound - size, offset))
}

/** The view that shows the whole picture, centred. */
export function fitView(natural: Size, viewport: Size): View {
  return clampView({ scale: fitScale(natural, viewport), x: 0, y: 0 }, natural, viewport)
}

/**
 * Change the scale while holding one point of the picture still.
 *
 * The fixed point is what makes zooming feel like moving a magnifier over the
 * picture rather than like the picture jumping: you point at a detail and it
 * stays under the cursor, instead of sliding away toward the centre as the
 * whole thing grows.
 *
 * `scale` is a request, not an instruction — it is clamped to between fitting
 * and {@link MAX_SCALE}, so a caller can multiply freely without tracking the
 * bounds itself.
 */
export function zoomAbout(
  view: View,
  natural: Size,
  viewport: Size,
  scale: number,
  at: Point,
): View {
  const lowest = fitScale(natural, viewport)
  const next = Math.min(MAX_SCALE, Math.max(lowest, scale))

  // Where in the picture the cursor currently is. Guard the divide: a view
  // built from a zero-sized viewport has no meaningful scale, and NaN offsets
  // would propagate into the style attribute and blank the picture.
  if (view.scale <= 0) return fitView(natural, viewport)
  const pictureX = (at.x - view.x) / view.scale
  const pictureY = (at.y - view.y) / view.scale

  return clampView(
    { scale: next, x: at.x - pictureX * next, y: at.y - pictureY * next },
    natural,
    viewport,
  )
}

/**
 * Is this viewport point on the picture rather than the space around it?
 *
 * What separates "clicked the backdrop to close" from "clicked the picture to
 * zoom". Fitting letterboxes, so at rest most of the viewport is *not* the
 * picture, and the two have to be told apart by geometry — the picture fills
 * its own element, so there is no hit-testable gap to lean on.
 */
export function isOverPicture(view: View, natural: Size, at: Point): boolean {
  return (
    at.x >= view.x &&
    at.y >= view.y &&
    at.x <= view.x + natural.width * view.scale &&
    at.y <= view.y + natural.height * view.scale
  )
}

/** Whether this view magnifies beyond fitting, i.e. whether panning does anything. */
export function isZoomed(view: View, natural: Size, viewport: Size): boolean {
  // A tolerance rather than an equality: the scale arrives from repeated
  // multiplication by a wheel factor, so landing exactly on the fit scale is
  // the one thing it will never do.
  return view.scale > fitScale(natural, viewport) + 1e-6
}
