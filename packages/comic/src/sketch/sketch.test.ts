import { describe as suite, expect, it } from 'vitest'
import { controlUnit, resolveControl, toPayload } from '../render/forge.ts'
import type { RenderRequest } from '../cache.ts'
import { assignFigures, castFigures } from './people.ts'
import { describe, isExplicit, sketchPrompt } from './prompt.ts'

suite('the sketch route', () => {
  it('never sends an explicit panel to the hosted model', () => {
    expect(isExplicit('rooftop, party, crowd, string lights')).toBe(false)
    expect(isExplicit('bed, completely nude, doggystyle')).toBe(true)
    expect(isExplicit(undefined, 'hotel room, night', 'topless, kneeling')).toBe(true)
    // Whole words only: "sextant" and "Essex" are not sex.
    expect(isExplicit('sextant on a desk, Essex street')).toBe(false)
  })

  it('names the cast left to right, then the people around them', () => {
    const prompt = sketchPrompt({
      style: 'comic',
      setting: 'a hotel rooftop at dusk',
      camera: 'wide shot',
      cast: [
        { description: describe({ subject: '1girl', look: 'white hair, aqua shirt' }), pose: 'walking in' },
        { description: describe({ subject: '1boy', look: 'grey suit' }), pose: 'leaning on the bar' },
      ],
      extras: 5,
      details: 'rooftop, party, crowd',
    })
    expect(prompt).toContain('from left to right in the picture: 1. a young woman (white hair, aqua shirt), walking in; 2. a man (grey suit), leaning on the bar')
    expect(prompt).toContain('5 other people around them')
    expect(prompt).toContain('Details: rooftop, party, crowd')
    expect(prompt).toContain('Everyone fully clothed')
  })

  it('draws a crowd with no cast, and nobody when there is nobody', () => {
    expect(sketchPrompt({ style: '', camera: 'wide shot', cast: [], extras: 6 })).toContain('6 people')
    expect(sketchPrompt({ style: '', camera: 'wide shot', cast: [], extras: 0 })).toContain('No people')
  })

  it('gives the repaint the largest figures, ordered left to right', () => {
    const people = [
      { box: [0.7, 0.1, 0.9, 0.9] as [number, number, number, number], area: 0.12, name: 'right' },
      { box: [0.4, 0.5, 0.45, 0.6] as [number, number, number, number], area: 0.01, name: 'crowd' },
      { box: [0.1, 0.1, 0.3, 0.9] as [number, number, number, number], area: 0.15, name: 'left' },
    ]
    expect(castFigures(people, 2).map((p) => p.name)).toEqual(['left', 'right'])
    expect(castFigures(people, 1).map((p) => p.name)).toEqual(['left'])
  })

  it('repaints every figure with her hair as her, a mirror image included, and the largest rest for the others', () => {
    const box = (x: number): [number, number, number, number] => [x, 0.1, x + 0.2, 0.9]
    const people = [
      { box: box(0.0), area: 0.11, match: { ari: 0.41 }, name: 'ari' },
      { box: box(0.3), area: 0.2, match: { ari: 0.0 }, name: 'guest' },
      { box: box(0.7), area: 0.09, match: { ari: 0.37 }, name: 'reflection' },
      { box: box(0.5), area: 0.02, match: { ari: 0.0 }, name: 'crowd' },
    ]
    const cast = [{ id: 'ari', hair: ['#eef1f2'] }, { id: 'tom' }]
    const assigned = assignFigures(people, cast).map((a) => `${cast[a.castIndex]!.id}:${a.person.name}`)
    expect(assigned).toEqual(['ari:ari', 'ari:reflection', 'tom:guest'])
    // No hair colours: the old rule, largest first.
    expect(assignFigures(people, [{ id: 'ari' }]).map((a) => a.person.name)).toEqual(['guest'])
  })

  it('finds the ControlNet by name and refuses one Forge has not loaded', () => {
    const listed = ['None', 'noob-sdxl-controlnet-lineart_anime [f0e048f8]', 'noob_sdxl_controlnet_depth [343a9b5d]']
    expect(resolveControl(listed, 'lineart_anime')).toBe('noob-sdxl-controlnet-lineart_anime [f0e048f8]')
    expect(() => resolveControl(['None'], 'lineart_anime')).toThrow(/Forge restart/)
    expect(() => resolveControl(listed, 'noob')).toThrow(/matches 2/)
  })

  it('adds the ControlNet unit only when there is a picture to read', () => {
    const request = {
      prompt: 'p', negative: 'n', seed: 1, width: 64, height: 64, steps: 20, cfg: 5, sampler: 's', scheduler: 'k', checkpoint: 'c', backend: 'forge',
      control: { sketch: 'abc', module: 'lineart_anime', model: 'lineart [x]', weight: 0.85, end: 0.8 },
    } satisfies RenderRequest
    const withImage = toPayload(request, { save_to_forge: false }, Buffer.from('png')) as { alwayson_scripts?: Record<string, { args: unknown[] }> }
    expect(withImage.alwayson_scripts?.['ControlNet']?.args[0]).toEqual(controlUnit(request.control, Buffer.from('png')))
    expect((toPayload(request, { save_to_forge: false }) as { alwayson_scripts?: unknown }).alwayson_scripts).toBeUndefined()
  })
})
