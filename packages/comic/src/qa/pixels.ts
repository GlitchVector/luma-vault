/**
 * What can be said about a panel from its pixels alone: whether there is a
 * picture at all, and whether the region reserved for lettering is empty
 * enough to letter on.
 *
 * "Empty enough" is edge energy — the mean absolute luminance gradient — in
 * the region against the whole picture's. A sky or a wall has almost none;
 * a face or a crowd has a lot. It is a heuristic with two knobs in the
 * config, and it is deliberately only asked for a hard verdict.
 */

import { PNG } from 'pngjs'
import type { Anchor, QaConfig } from '../schema.ts'

export interface Luma {
  width: number
  height: number
  data: Float32Array
}

export function lumaOf(png: Buffer): Luma {
  const image = PNG.sync.read(png)
  const data = new Float32Array(image.width * image.height)
  for (let i = 0; i < data.length; i++) {
    const o = i * 4
    data[i] = 0.299 * image.data[o]! + 0.587 * image.data[o + 1]! + 0.114 * image.data[o + 2]!
  }
  return { width: image.width, height: image.height, data }
}

export interface Region {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The part of the frame an anchor names, as fractions. Corners are a bit
 *  more than a balloon needs, so a balloon fits with margin. */
export function regionFor(anchor: Anchor): Region {
  switch (anchor) {
    case 'top-left':
      return { x0: 0, y0: 0, x1: 0.42, y1: 0.3 }
    case 'top':
      return { x0: 0, y0: 0, x1: 1, y1: 0.24 }
    case 'top-right':
      return { x0: 0.58, y0: 0, x1: 1, y1: 0.3 }
    case 'left':
      return { x0: 0, y0: 0, x1: 0.32, y1: 1 }
    case 'center':
      return { x0: 0.3, y0: 0.35, x1: 0.7, y1: 0.65 }
    case 'right':
      return { x0: 0.68, y0: 0, x1: 1, y1: 1 }
    case 'bottom-left':
      return { x0: 0, y0: 0.7, x1: 0.42, y1: 1 }
    case 'bottom':
      return { x0: 0, y0: 0.76, x1: 1, y1: 1 }
    case 'bottom-right':
      return { x0: 0.58, y0: 0.7, x1: 1, y1: 1 }
  }
}

export interface Stats {
  mean: number
  std: number
  /** Mean |dx| + |dy| of luminance, per pixel. */
  edge: number
}

export function stats(luma: Luma, region: Region = { x0: 0, y0: 0, x1: 1, y1: 1 }): Stats {
  const { width, height, data } = luma
  const xa = Math.floor(region.x0 * width)
  const xb = Math.max(xa + 2, Math.floor(region.x1 * width))
  const ya = Math.floor(region.y0 * height)
  const yb = Math.max(ya + 2, Math.floor(region.y1 * height))
  let sum = 0
  let sumSq = 0
  let edge = 0
  let n = 0
  let en = 0
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const v = data[y * width + x]!
      sum += v
      sumSq += v * v
      n++
      if (x + 1 < xb && y + 1 < yb) {
        edge += Math.abs(data[y * width + x + 1]! - v) + Math.abs(data[(y + 1) * width + x]! - v)
        en++
      }
    }
  }
  const mean = sum / n
  return { mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)), edge: en ? edge / en : 0 }
}

export interface PixelVerdict {
  blank: boolean
  /** `undefined` when the panel reserves nothing. */
  space_usable: boolean | undefined
  whole: Stats
  region?: Stats
}

export function inspectPixels(png: Buffer, reserve: Anchor | 'none', config: Pick<QaConfig, 'blank_std' | 'space_edge_ratio' | 'space_std'>): PixelVerdict {
  const luma = lumaOf(png)
  const whole = stats(luma)
  const blank = whole.std < config.blank_std
  if (reserve === 'none') return { blank, space_usable: undefined, whole }
  const region = stats(luma, regionFor(reserve))
  const usable = region.edge <= Math.max(1, whole.edge * config.space_edge_ratio) || region.std < config.space_std
  return { blank, space_usable: usable, whole, region }
}
