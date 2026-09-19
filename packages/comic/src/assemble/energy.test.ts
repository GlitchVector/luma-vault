import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { ENERGY_COLS, ENERGY_ROWS, energyMap } from './energy.ts'

/** Flat on the left half, dense vertical stripes on the right. */
function halfBusy(width = 128, height = 192): Buffer {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const v = x > width / 2 && x % 2 === 0 ? 10 : 240
      png.data[o] = v
      png.data[o + 1] = v
      png.data[o + 2] = v
      png.data[o + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

describe('the energy map', () => {
  const map = energyMap(halfBusy())
  const at = (col: number, row: number) => Number(map.cells.charAt(row * map.cols + col))

  it('is one digit per cell, row major, at the stated size', () => {
    expect(map.cols).toBe(ENERGY_COLS)
    expect(map.rows).toBe(ENERGY_ROWS)
    expect(map.cells).toHaveLength(ENERGY_COLS * ENERGY_ROWS)
    expect(map.cells).toMatch(/^[0-9]+$/)
  })

  it('calls the flat half quiet and the striped half busy', () => {
    expect(at(2, 10)).toBe(0)
    expect(at(13, 10)).toBeGreaterThan(7)
  })

  it('scales to the panel, so a dark scene still has a quiet corner', () => {
    const dim = PNG.sync.read(halfBusy())
    for (let i = 0; i < dim.data.length; i += 4) {
      dim.data[i] = Math.round(dim.data[i]! * 0.25)
      dim.data[i + 1] = Math.round(dim.data[i + 1]! * 0.25)
      dim.data[i + 2] = Math.round(dim.data[i + 2]! * 0.25)
    }
    const darker = energyMap(PNG.sync.write(dim))
    const dark = (col: number, row: number) => Number(darker.cells.charAt(row * darker.cols + col))
    expect(dark(2, 10)).toBe(0)
    expect(dark(13, 10)).toBeGreaterThan(7)
  })

  it('a flat picture is all zeroes, and nothing divides by zero', () => {
    const flat = new PNG({ width: 64, height: 64 })
    flat.data.fill(128)
    const map2 = energyMap(PNG.sync.write(flat))
    expect(map2.cells).toBe('0'.repeat(ENERGY_COLS * ENERGY_ROWS))
  })
})
