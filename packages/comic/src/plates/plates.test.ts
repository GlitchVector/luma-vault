import { describe, expect, it } from 'vitest'
import { bounds, dilate, maskForColour, maskPng } from './mask.ts'
import { drawPlate } from './mock.ts'
import { editForm, generateBody } from './openai.ts'
import { DUMMIES, plateSizeFor } from './plate.ts'
import { masterPrompt, platePrompt } from './prompt.ts'
import { PNG } from 'pngjs'

describe('the plate prompt', () => {
  it('names the place, the camera, one coloured mannequin per figure and the empty corner, and nothing from the scene', () => {
    const prompt = platePrompt({
      style: 'clean illustration',
      location: 'gravel rooftop, radio building',
      setting: 'the parapet from below, sky above',
      camera: 'from below, cowboy shot',
      poses: ['leaning on the rail'],
      figures: 1,
      reserve: 'top-right',
    })
    expect(prompt).toContain('gravel rooftop')
    expect(prompt).toContain('Camera: from below, cowboy shot')
    expect(prompt).toContain('One stand-in figure')
    expect(prompt).toContain('matte magenta (#FF00FF)')
    expect(prompt).toContain('leaning on the rail')
    expect(prompt).toContain('Leave the top right of the frame plain')
    expect(prompt).toContain('no speech bubbles')
  })

  it('says "the reference picture" instead of the location when a master rides along', () => {
    const prompt = platePrompt({ style: '', location: 'rooftop', references: true, camera: 'wide shot', poses: [], figures: 2, reserve: 'none' })
    expect(prompt).toContain('same place as the reference picture')
    expect(prompt).not.toContain('rooftop')
    expect(prompt).toContain('2 stand-in figures')
    expect(prompt).toContain('cyan (#00FFFF)')
  })

  it('asks for nobody in a master, and a variation number on a retry', () => {
    expect(masterPrompt('ink wash', 'a rainy alley')).toBe('ink wash. a rainy alley. no people, no figures, no text, no letters, no speech bubbles')
    expect(platePrompt({ style: '', camera: 'wide shot', poses: [], figures: 0, reserve: 'none', variation: 1 })).toMatch(/No people.*Variation 2/)
  })

  it('picks the hosted size nearest the bucket', () => {
    expect(plateSizeFor(1216, 832)).toBe('1536x1024')
    expect(plateSizeFor(832, 1216)).toBe('1024x1536')
    expect(plateSizeFor(1024, 1024)).toBe('1024x1024')
    expect(plateSizeFor(1152, 896)).toBe('1536x1024')
  })
})

describe('masks', () => {
  const plate = drawPlate({ prompt: 'One stand-in figure. Leave the top right of the frame plain', size: '1024x1536' })

  it('finds the magenta stand-in and nothing else', () => {
    const magenta = maskForColour(plate, DUMMIES[0]!.rgb, 90, 0)
    expect(magenta.found).toBeGreaterThan(1000)
    const box = bounds(magenta)!
    expect(box.x0).toBeCloseTo(0.42, 1)
    expect(box.y1).toBeCloseTo(0.92, 1)
    const cyan = maskForColour(plate, DUMMIES[1]!.rgb, 90, 0)
    expect(cyan.found).toBe(0)
    expect(bounds(cyan)).toBeNull()
  })

  it('grows by the radius on every side', () => {
    const tight = bounds(maskForColour(plate, DUMMIES[0]!.rgb, 90, 0))!
    const grown = bounds(maskForColour(plate, DUMMIES[0]!.rgb, 90, 24))!
    expect((tight.x0 - grown.x0) * 1024).toBeCloseTo(24, 0)
    expect((grown.y1 - tight.y1) * 1536).toBeCloseTo(24, 0)
  })

  it('dilates a single pixel into a square', () => {
    const data = new Uint8Array(25)
    data[12] = 255
    const out = dilate(data, 5, 5, 1)
    expect([...out].filter((v) => v === 255)).toHaveLength(9)
    expect(out[0]).toBe(0)
  })

  it('writes a white-on-black PNG of the plate size', () => {
    const png = PNG.sync.read(maskPng(maskForColour(plate, DUMMIES[0]!.rgb, 90, 8)))
    expect([png.width, png.height]).toEqual([1024, 1536])
    expect(png.data[3]).toBe(255)
  })
})

describe('the OpenAI request', () => {
  it('generates from words as JSON and edits with every reference as a file', () => {
    const body = generateBody('gpt-image-1', { prompt: 'p', size: '1536x1024', quality: 'medium' })
    expect(body).toMatchObject({ model: 'gpt-image-1', prompt: 'p', n: 1, size: '1536x1024', quality: 'medium', output_format: 'png' })

    const form = editForm('gpt-image-1', {
      prompt: 'view',
      size: '1024x1024',
      quality: 'high',
      input_fidelity: 'high',
      references: [Buffer.from('a'), Buffer.from('b')],
    })
    expect(form.get('prompt')).toBe('view')
    expect(form.get('input_fidelity')).toBe('high')
    expect(form.getAll('image[]')).toHaveLength(2)
    expect((form.getAll('image[]')[0] as File).name).toBe('reference-0.png')
  })
})
