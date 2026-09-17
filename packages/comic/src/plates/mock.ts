/**
 * A plate backend that draws the shape of a plate instead of asking a hosted
 * model: a two-tone field with a horizon, the reserved region left plain,
 * and one flat-coloured stand-in block per figure at a fixed spot. Enough
 * for the mask, the inpaint and QA to be exercised without a key or a GPU.
 * Same request, same bytes.
 */

import { PNG } from 'pngjs'
import { DUMMIES, type PlateBackend, type PlateRequest, type PlateResult } from './plate.ts'

export class MockPlates implements PlateBackend {
  readonly name = 'mock'

  async prepare(): Promise<void> {}

  async draw(request: PlateRequest): Promise<PlateResult> {
    return { png: drawPlate(request), info: { mock: true } }
  }
}

export function drawPlate(request: Pick<PlateRequest, 'prompt' | 'size'>): Buffer {
  const [width, height] = request.size.split('x').map(Number) as [number, number]
  const png = new PNG({ width, height })
  const figures = Number(request.prompt.match(/(\d+) stand-in figures/)?.[1] ?? (/One stand-in figure/.test(request.prompt) ? 1 : 0))
  const variation = Number(request.prompt.match(/Variation (\d+)/)?.[1] ?? 1)
  const reserve = request.prompt.match(/Leave the (top left|top right|bottom left|bottom right|top|bottom|left|right|middle) of the frame/)?.[1]
  const missing = /MOCK_NO_DUMMY/.test(request.prompt)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const fy = y / height
      const fx = x / width
      // Sky over ground, with a little texture the reserved corner does not get.
      let [r, g, b] = fy < 0.55 ? [150 + variation * 5, 180, 220] : [110, 120 + variation * 5, 90]
      const inReserve =
        reserve !== undefined &&
        (reserve.includes('top') ? fy < 0.3 : reserve.includes('bottom') ? fy > 0.7 : reserve === 'middle' ? fy > 0.35 && fy < 0.65 : true) &&
        (reserve.includes('left') ? fx < 0.42 : reserve.includes('right') ? fx > 0.58 : reserve === 'middle' ? fx > 0.3 && fx < 0.7 : true)
      if (!inReserve && (x * 7 + y * 3) % 40 < 4) {
        r -= 35
        g -= 35
        b -= 35
      }
      png.data[o] = r
      png.data[o + 1] = g
      png.data[o + 2] = b
      png.data[o + 3] = 255
    }
  }
  if (!missing) {
    for (let i = 0; i < figures; i++) {
      const dummy = DUMMIES[i] ?? DUMMIES[DUMMIES.length - 1]!
      const cx = width * (figures === 1 ? 0.5 : 0.3 + (0.4 * i) / Math.max(1, figures - 1))
      const x0 = Math.round(cx - width * 0.08)
      const x1 = Math.round(cx + width * 0.08)
      const y0 = Math.round(height * 0.35)
      const y1 = Math.round(height * 0.92)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * width + x) * 4
          png.data[o] = dummy.rgb[0]
          png.data[o + 1] = dummy.rgb[1]
          png.data[o + 2] = dummy.rgb[2]
        }
      }
    }
  }
  return PNG.sync.write(png)
}
