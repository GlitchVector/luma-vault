/**
 * Where the stand-in is, from its colour.
 *
 * The plate prompt asks for flat, unlit, saturated mannequins because a
 * threshold in RGB is then enough to find them — no detector, no model, and
 * the same answer every time. The mask grows by a few pixels so the redraw
 * also covers the anti-aliased edge the hosted model drew around the colour.
 */

import { PNG } from 'pngjs'

export interface Mask {
  width: number
  height: number
  /** One byte per pixel, 255 inside. */
  data: Uint8Array
  /** Pixels inside, before growing. Zero means the stand-in was not found. */
  found: number
}

export function maskForColour(png: Buffer, rgb: readonly [number, number, number], tolerance: number, grow: number): Mask {
  const image = PNG.sync.read(png)
  const { width, height } = image
  const data = new Uint8Array(width * height)
  let found = 0
  const limit = tolerance * tolerance
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const dr = image.data[o]! - rgb[0]
    const dg = image.data[o + 1]! - rgb[1]
    const db = image.data[o + 2]! - rgb[2]
    if (dr * dr + dg * dg + db * db <= limit) {
      data[i] = 255
      found++
    }
  }
  return { width, height, data: grow > 0 ? dilate(data, width, height, grow) : data, found }
}

/** A square dilation, done as two 1-D passes so it is linear in the radius. */
export function dilate(data: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const pass = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    let run = -1
    for (let x = 0; x < width; x++) {
      if (data[row + x]) run = x
      if (run >= 0 && x - run <= radius) pass[row + x] = 255
    }
    run = -1
    for (let x = width - 1; x >= 0; x--) {
      if (data[row + x]) run = x
      if (run >= 0 && run - x <= radius) pass[row + x] = 255
    }
  }
  const out = new Uint8Array(width * height)
  for (let x = 0; x < width; x++) {
    let run = -1
    for (let y = 0; y < height; y++) {
      if (pass[y * width + x]) run = y
      if (run >= 0 && y - run <= radius) out[y * width + x] = 255
    }
    run = -1
    for (let y = height - 1; y >= 0; y--) {
      if (pass[y * width + x]) run = y
      if (run >= 0 && run - y <= radius) out[y * width + x] = 255
    }
  }
  return out
}

/** The mask as the PNG Forge's img2img wants: white where to paint. */
export function maskPng(mask: Mask): Buffer {
  const png = new PNG({ width: mask.width, height: mask.height })
  for (let i = 0; i < mask.data.length; i++) {
    const v = mask.data[i]!
    const o = i * 4
    png.data[o] = v
    png.data[o + 1] = v
    png.data[o + 2] = v
    png.data[o + 3] = 255
  }
  return PNG.sync.write(png)
}

/** The mask's bounding box as fractions, for the QA report and the app. */
export function bounds(mask: Mask): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = mask.width
  let y0 = mask.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[y * mask.width + x]) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  return { x0: x0 / mask.width, y0: y0 / mask.height, x1: (x1 + 1) / mask.width, y1: (y1 + 1) / mask.height }
}
