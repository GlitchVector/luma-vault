/**
 * A renderer that draws a placeholder instead of asking a GPU.
 *
 * It exists so the layout, lettering and QA stages can be exercised — by the
 * tests and by `comic.config.json` with `"renderer": "mock"` — while Forge
 * is off or busy. The picture is a flat field in a colour derived from the
 * seed, a darker "figure" block in the lower middle, and diagonal hatching
 * everywhere except the reserved region, so the negative-space check has
 * something to measure. Same request, same bytes: `PNG.sync.write` is
 * deterministic, and nothing here reads a clock.
 */

import { PNG } from 'pngjs'
import type { RenderRequest } from '../cache.ts'
import type { InpaintRequest, Needs, Prepared, Progress, RenderResult, Renderer } from './renderer.ts'

export class MockRenderer implements Renderer {
  readonly name = 'mock'

  async prepare(needs: Needs): Promise<Prepared> {
    return { checkpoint: needs.checkpoint }
  }

  async render(request: RenderRequest, onProgress?: Progress): Promise<RenderResult> {
    onProgress?.(1, 0)
    return { png: drawPlaceholder(request), info: { mock: true } }
  }

  /** Nearest-neighbour, so a retina page can be tested without a GPU and
   *  the result is still deterministic. */
  async upscale(png: Buffer, scale: number): Promise<Buffer> {
    const source = PNG.sync.read(png)
    const out = new PNG({ width: Math.round(source.width * scale), height: Math.round(source.height * scale) })
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const from = (Math.min(source.height - 1, Math.floor(y / scale)) * source.width + Math.min(source.width - 1, Math.floor(x / scale))) * 4
        const to = (y * out.width + x) * 4
        out.data[to] = source.data[from]!
        out.data[to + 1] = source.data[from + 1]!
        out.data[to + 2] = source.data[from + 2]!
        out.data[to + 3] = 255
      }
    }
    return PNG.sync.write(out)
  }

  async inpaint(request: InpaintRequest, onProgress?: Progress): Promise<RenderResult> {
    onProgress?.(1, 0)
    return { png: paintUnderMask(request), info: { mock: true, inpaint: true } }
  }
}

/** The "character": a dark, seed-tinted fill wherever the mask is white,
 *  the plate untouched everywhere else. */
export function paintUnderMask(request: Pick<InpaintRequest, 'init' | 'mask' | 'seed'>): Buffer {
  const init = PNG.sync.read(request.init)
  const mask = PNG.sync.read(request.mask)
  if (mask.width !== init.width || mask.height !== init.height) {
    throw new Error(`mask ${mask.width}x${mask.height} does not match the plate ${init.width}x${init.height}`)
  }
  const tint = [40 + (request.seed % 40), 30 + ((request.seed >> 3) % 40), 50 + ((request.seed >> 6) % 40)] as const
  for (let i = 0; i < init.width * init.height; i++) {
    const o = i * 4
    if (mask.data[o]! > 127) {
      init.data[o] = tint[0]
      init.data[o + 1] = tint[1]
      init.data[o + 2] = tint[2]
    }
  }
  return PNG.sync.write(init)
}

/** Which corner the prompt asked to keep empty, read back off the clause the
 *  prompt builder wrote — the mock has no other channel to the script. */
function reservedRegion(prompt: string): { x0: number; y0: number; x1: number; y1: number } | null {
  const m = prompt.match(/empty (top left|top right|bottom left|bottom right|top|bottom|left|right|middle) of the frame/)
  if (!m) return null
  const place = m[1]!
  const x0 = place.includes('right') ? 0.6 : 0
  const x1 = place.includes('left') ? 0.4 : place.includes('right') ? 1 : 1
  const y0 = place.includes('bottom') ? 0.7 : 0
  const y1 = place.includes('top') ? 0.3 : place.includes('bottom') ? 1 : 1
  if (place === 'left') return { x0: 0, x1: 0.3, y0: 0, y1: 1 }
  if (place === 'right') return { x0: 0.7, x1: 1, y0: 0, y1: 1 }
  if (place === 'middle') return { x0: 0.3, x1: 0.7, y0: 0.35, y1: 0.65 }
  return { x0, y0, x1, y1 }
}

export function drawPlaceholder(request: Pick<RenderRequest, 'width' | 'height' | 'seed' | 'prompt'>): Buffer {
  const { width, height, seed } = request
  const png = new PNG({ width, height })
  const base = [120 + (seed % 90), 110 + ((seed >> 3) % 90), 130 + ((seed >> 6) % 90)] as const
  // `MOCK_BUSY` in a scene hatches the whole frame, reserved corner included,
  // so a test can watch QA fail a panel for having nowhere to letter.
  const reserved = /MOCK_BUSY/.test(request.prompt) ? null : reservedRegion(request.prompt)
  const blank = /MOCK_BLANK/.test(request.prompt)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      let [r, g, b] = base
      if (!blank) {
        const fx = x / width
        const fy = y / height
        const inReserved =
          reserved !== null && fx >= reserved.x0 && fx < reserved.x1 && fy >= reserved.y0 && fy < reserved.y1
        if (!inReserved && (x + y) % 24 < 6) {
          r -= 60
          g -= 60
          b -= 60
        }
        // The stand-in for a person: a block from the waist down.
        if (fx > 0.38 && fx < 0.62 && fy > 0.35 && fy < 0.95) {
          r = 50
          g = 40
          b = 60
        }
      }
      png.data[i] = r
      png.data[i + 1] = g
      png.data[i + 2] = b
      png.data[i + 3] = 255
    }
  }
  return PNG.sync.write(png)
}
