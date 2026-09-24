import { describe, expect, it } from 'vitest'
import { regionPrompt, sceneLight } from '../prompt.ts'
import { comfySampler, liftLoras } from './comfy.ts'

describe('the ComfyUI renderer', () => {
  it('lifts LoRA tags out of the prompt into loaders', () => {
    const { text, loras } = liftLoras('masterpiece, 1girl, <lora:ari_adopt_v4:1.2>, ari, white hair')
    expect(loras).toEqual([{ name: 'ari_adopt_v4', weight: 1.2 }])
    expect(text).toBe('masterpiece, 1girl, ari, white hair')
  })

  it("maps Forge's sampler names", () => {
    expect(comfySampler('DPM++ 2M SDE')).toBe('dpmpp_2m_sde')
    expect(comfySampler('Euler a')).toBe('euler_ancestral')
  })
})

describe("a character's region is lit like the place", () => {
  it('takes the light words out of the scene', () => {
    expect(sceneLight('rooftop, party, night, string lights, ice tubs, holiday')).toEqual(['night', 'string lights'])
  })

  it('puts her LoRA, look, body and the panel light in her region prompt', () => {
    const ari = { lora: 'ari_adopt_v4:1.2', trigger: 'ari', look: 'white hair', head: '', body: 'wide hips', subject: '1girl' as const, seed_family: 1 }
    const config = { prompt: { quality: 'masterpiece', style: 'anime coloring', lighting: 'warm light', negative: '', negative_lettering: '', camera_weight: 1.35, angle_weight: 1.1, wide_lora_scale: 0.6 } }
    const prompt = regionPrompt(ari, { camera: 'full body', scene: 'rooftop, night, string lights' }, config as never)
    expect(prompt).toBe('masterpiece, 1girl, <lora:ari_adopt_v4:1.2>, ari, white hair, wide hips, (full body:1.35), night, string lights, warm light, anime coloring')
    expect(prompt).not.toContain('rooftop')
  })
})

describe('the framing mask for a figure the detector missed', () => {
  it('covers the middle of a close-up and leaves the edges to the place', async () => {
    const { PNG } = await import('pngjs')
    const { framingMask } = await import('../stages/panels.ts')
    const png = PNG.sync.read(framingMask(100, 100, 'close-up'))
    const at = (x: number, y: number) => png.data[(y * 100 + x) * 4]
    expect(at(50, 50)).toBe(255)
    expect(at(5, 50)).toBe(0)
    expect(at(95, 50)).toBe(0)
    expect(at(50, 2)).toBe(0)
  })
})
