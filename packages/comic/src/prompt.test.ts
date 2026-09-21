import { describe, expect, it } from 'vitest'
import { buildPrompt, isWideShot, reserveClause, scaleLora, subjectTags, weighted } from './prompt.ts'
import type { Character, Panel } from './schema.ts'

const ari: Character = {
  lora: 'ari_adopt_v1:1.2',
  trigger: 'ari',
  look: 'white hair, aqua hair, aqua shirt, white shorts',
  head: 'white hair, blue eyes',
  body: 'large breasts, wide hips',
  subject: '1girl',
  seed_family: 8812,
}
const kira: Character = { ...ari, lora: 'kvoss_v2:0.9', trigger: 'kvoss', look: 'pink hair, black hoodie', seed_family: 1 }
const config = {
  prompt: {
    quality: 'masterpiece, best quality',
    style: '',
    negative: 'worst quality, lowres',
    negative_lettering: 'speech bubble, english text',
    camera_weight: 1,
    angle_weight: 1,
    wide_lora_scale: 1,
  },
}

const panel: Panel = {
  id: 'p1-1',
  camera: 'from below, cowboy shot',
  scene: 'rooftop at dawn, wind, smirk',
  pose: [],
  characters: ['ari'],
  reserve_space: 'top-right',
  dialogue: [{ speaker: 'ari', text: 'THIS MUST NEVER BE DRAWN', anchor: 'top-right', kind: 'speech' }],
  sfx: [{ text: 'WHAM', anchor: 'bottom-left', rotate: -8 }],
}

describe('the panel prompt', () => {
  it('restates the whole character every time: lora, trigger, look', () => {
    const first = buildPrompt(panel, { ari }, config).prompt
    const second = buildPrompt({ ...panel, scene: 'alley, rain' }, { ari }, config).prompt
    for (const prompt of [first, second]) {
      expect(prompt).toContain('<lora:ari_adopt_v1:1.2>, ari, white hair, aqua hair, aqua shirt, white shorts')
    }
  })

  it('never carries dialogue or sound effects', () => {
    const { prompt, negative } = buildPrompt(panel, { ari }, config)
    expect(prompt).not.toMatch(/NEVER BE DRAWN|WHAM/)
    expect(negative).not.toMatch(/NEVER BE DRAWN|WHAM/)
  })

  it('weights the camera words, because unweighted framing loses to the LoRA', () => {
    const pushy = { prompt: { ...config.prompt, camera_weight: 1.35, angle_weight: 1.35 } }
    const { prompt } = buildPrompt(panel, { ari }, pushy)
    expect(prompt).toContain('(from below:1.35), (cowboy shot:1.35)')
    // The scene is never weighted: only the camera has to fight the LoRA.
    expect(prompt).toContain('rooftop at dawn, wind, smirk')
    expect(weighted('wide shot, full body', 1.4)).toBe('(wide shot:1.4), (full body:1.4)')
    // A script that weighted a term itself keeps its own number.
    expect(weighted('(close-up:1.6), from side', 1.35)).toBe('(close-up:1.6), (from side:1.35)')
    expect(weighted('wide shot', 1)).toBe('wide shot')
  })

  it('weights the angle far more gently than the framing', () => {
    // `from below` at 1.35 does not read as a low camera, it reads as a
    // giant. The owner's first studio page came back forty metres tall.
    const pushy = { prompt: { ...config.prompt, camera_weight: 1.35, angle_weight: 1.1 } }
    const { prompt } = buildPrompt({ ...panel, camera: 'wide shot, full body, from below' }, { ari }, pushy)
    expect(prompt).toContain('(wide shot:1.35)')
    expect(prompt).toContain('(full body:1.35)')
    expect(prompt).toContain('(from below:1.1)')
    expect(weighted('close-up, from above', 1.35, 1.1)).toBe('(close-up:1.35), (from above:1.1)')
  })

  it('eases the LoRA on a wide shot so she reads at human scale', () => {
    const scaled = { prompt: { ...config.prompt, wide_lora_scale: 0.6 } }
    const wide = buildPrompt({ ...panel, camera: 'wide shot, from below' }, { ari }, scaled).prompt
    expect(wide).toContain('<lora:ari_adopt_v1:0.72>')
    // A close-up is about her, so she keeps her full strength.
    const close = buildPrompt({ ...panel, camera: 'close-up' }, { ari }, scaled).prompt
    expect(close).toContain('<lora:ari_adopt_v1:1.2>')

    expect(isWideShot('wide shot, from below')).toBe(true)
    expect(isWideShot('establishing shot')).toBe(true)
    expect(isWideShot('close-up, from above')).toBe(false)
    expect(scaleLora('ari_adopt_v1:1.2', 0.6)).toBe('ari_adopt_v1:0.72')
    expect(scaleLora('ari_adopt_v1:1.2', 1)).toBe('ari_adopt_v1:1.2')
  })

  it('ends with the clause reserving the lettering space', () => {
    const { prompt } = buildPrompt(panel, { ari }, config)
    expect(prompt.endsWith(reserveClause('top-right'))).toBe(true)
    expect(reserveClause('top-right')).toContain('empty top right of the frame')
  })

  it('reserves nothing when the panel reserves nothing, and puts the style before it', () => {
    const styled = { prompt: { ...config.prompt, style: 'bold lineart' } }
    const { prompt } = buildPrompt({ ...panel, reserve_space: 'none' }, { ari }, styled)
    expect(prompt.endsWith('bold lineart')).toBe(true)
    expect(prompt).not.toContain('negative space')
  })

  it('counts the cast the way the checkpoint does', () => {
    expect(subjectTags([])).toBe('no humans, scenery')
    expect(subjectTags(['1girl'])).toBe('1girl, solo')
    expect(subjectTags(['1girl', '1girl'])).toBe('2girls')
    expect(subjectTags(['1girl', '1boy'])).toBe('1girl, 1boy')
    const { prompt } = buildPrompt({ ...panel, characters: ['ari', 'kira'] }, { ari, kira }, config)
    expect(prompt).toContain('2girls, <lora:ari_adopt_v1:1.2>')
    expect(prompt).toContain('<lora:kvoss_v2:0.9>, kvoss, pink hair')
  })

  it('names a character the script does not define', () => {
    expect(() => buildPrompt({ ...panel, characters: ['bob'] }, { ari }, config)).toThrow(/"bob"/)
  })

  it('adds the lettering words to every negative', () => {
    expect(buildPrompt(panel, { ari }, config).negative).toBe('worst quality, lowres, speech bubble, english text')
  })
})
