import { describe, expect, it } from 'vitest'
import { drawPlaceholder } from '../render/mock.ts'
import { inspectPixels, regionFor, stats, lumaOf } from './pixels.ts'
import { judgeFigures } from './tagger.ts'

const config = { blank_std: 6, space_edge_ratio: 0.55, space_std: 18 }
const draw = (prompt: string) => drawPlaceholder({ width: 256, height: 384, seed: 8812, prompt })

describe('pixel checks', () => {
  it('calls a flat picture blank', () => {
    const verdict = inspectPixels(draw('MOCK_BLANK'), 'top-right', config)
    expect(verdict.blank).toBe(true)
  })

  it('finds the corner the prompt asked to keep empty, and not a busy one', () => {
    const png = draw('scene, negative space, empty top right of the frame')
    expect(inspectPixels(png, 'top-right', config)).toMatchObject({ blank: false, space_usable: true })
    expect(inspectPixels(png, 'bottom-left', config)).toMatchObject({ blank: false, space_usable: false })
  })

  it('has no opinion on space when nothing is reserved', () => {
    expect(inspectPixels(draw('scene'), 'none', config).space_usable).toBeUndefined()
  })

  it('measures less edge energy in the plain region than in the whole', () => {
    const luma = lumaOf(draw('scene, negative space, empty top left of the frame'))
    expect(stats(luma, regionFor('top-left')).edge).toBeLessThan(stats(luma).edge * 0.55)
  })
})

describe('figure verdicts', () => {
  const t = 0.35
  it('accepts one person when the tagger sees one', () => {
    expect(judgeFigures({ '1girl': 0.95, solo: 0.9 }, 1, t)).toEqual([])
  })
  it('fails one expected person when nobody or several are seen', () => {
    expect(judgeFigures({ 'no humans': 0.8 }, 1, t)).toEqual(['figures: expected one, found nobody'])
    expect(judgeFigures({ '1girl': 0.9, '2girls': 0.6 }, 1, t)).toEqual(['figures: expected one, found several'])
  })
  it('fails two expected people when the picture is a solo', () => {
    expect(judgeFigures({ '1girl': 0.9, solo: 0.8 }, 2, t)).toEqual(['figures: expected 2, found one'])
    expect(judgeFigures({ '2girls': 0.7, 'multiple girls': 0.6 }, 2, t)).toEqual([])
  })
  it('fails an empty shot that has someone in it', () => {
    expect(judgeFigures({ '1girl': 0.5 }, 0, t)).toEqual(['figures: expected nobody, found someone'])
    expect(judgeFigures({ 'no humans': 0.9, scenery: 0.8 }, 0, t)).toEqual([])
  })
  it('treats a turnaround and an anatomy tag as hard failures', () => {
    expect(judgeFigures({ '1girl': 0.9, solo: 0.9, 'multiple views': 0.5, 'bad hands': 0.4 }, 1, t)).toEqual([
      'figures: multiple views (a turnaround, not a scene)',
      'anatomy: bad hands',
    ])
  })
})
