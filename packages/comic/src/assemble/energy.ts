/**
 * How busy each part of a panel is, as a coarse grid.
 *
 * The assembler cannot ask the checkpoint to leave room for a balloon (four
 * wordings were measured, none worked — see `stages/qa.ts`), so instead the
 * balloon goes where the picture is already quiet. This produces the map;
 * `balloons.js` does the placing, in the browser, because only the browser
 * knows how wide a balloon wraps.
 *
 * "Busy" is mean absolute luminance gradient per cell, the same measure QA
 * uses, quantised to one digit a cell so the whole map rides on a data
 * attribute instead of a second file.
 */

import { PNG } from 'pngjs'

export interface EnergyMap {
  cols: number
  rows: number
  /** Row-major, one 0-9 digit per cell. */
  cells: string
}

export const ENERGY_COLS = 16
export const ENERGY_ROWS = 24

/**
 * A face is busier than a wall, so a balloon lands on the wall. Faces also
 * matter more than walls, which the digit cannot express — that is what the
 * anchor is for: the writer said which corner, and this only refines it.
 */
export function energyMap(png: Buffer, cols = ENERGY_COLS, rows = ENERGY_ROWS): EnergyMap {
  const image = PNG.sync.read(png)
  const { width, height } = image
  const luma = new Float32Array(width * height)
  for (let i = 0; i < luma.length; i++) {
    const o = i * 4
    luma[i] = 0.299 * image.data[o]! + 0.587 * image.data[o + 1]! + 0.114 * image.data[o + 2]!
  }

  const sums = new Float64Array(cols * rows)
  const counts = new Int32Array(cols * rows)
  for (let y = 0; y < height - 1; y++) {
    const cellY = Math.min(rows - 1, Math.floor((y / height) * rows))
    for (let x = 0; x < width - 1; x++) {
      const cellX = Math.min(cols - 1, Math.floor((x / width) * cols))
      const v = luma[y * width + x]!
      const gradient = Math.abs(luma[y * width + x + 1]! - v) + Math.abs(luma[(y + 1) * width + x]! - v)
      const cell = cellY * cols + cellX
      sums[cell] = sums[cell]! + gradient
      counts[cell] = counts[cell]! + 1
    }
  }

  const means = Array.from(sums, (sum, i) => (counts[i] ? sum / counts[i]! : 0))
  // Scaled against this panel's own busiest cell, not an absolute: a dark
  // night panel and a bright one should both letter on their own quiet parts.
  const peak = Math.max(1, ...means)
  return {
    cols,
    rows,
    cells: means.map((mean) => Math.min(9, Math.round((mean / peak) * 9))).join(''),
  }
}
