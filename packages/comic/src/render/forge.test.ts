import { describe, expect, it } from 'vitest'
import { resolveCheckpoint, toPayload } from './forge.ts'

const models = [
  { title: 'delburry75.safetensors [abc]', model_name: 'delburry75' },
  { title: 'delnoob.safetensors [def]', model_name: 'delnoob' },
  { title: 'noobaiXLNAIXL_epsilonPred11Version.safetensors [ghi]', model_name: 'noobaiXLNAIXL_epsilonPred11Version' },
]

describe('checkpoint resolution', () => {
  it('takes an exact name, or a unique substring', () => {
    expect(resolveCheckpoint(models, 'delburry75')).toBe('delburry75.safetensors [abc]')
    expect(resolveCheckpoint(models, 'burry')).toBe('delburry75.safetensors [abc]')
  })
  it('refuses an ambiguous substring rather than guessing', () => {
    expect(() => resolveCheckpoint(models, 'noob')).toThrow(/matches 2 checkpoints/)
  })
  it('lists what is installed when nothing matches', () => {
    expect(() => resolveCheckpoint(models, 'nova')).toThrow(/Installed: delburry75, delnoob/)
  })
})

describe('the txt2img payload', () => {
  it('selects the checkpoint per request and keeps it loaded', () => {
    const payload = toPayload(
      {
        prompt: 'p',
        negative: 'n',
        seed: 1,
        width: 832,
        height: 1216,
        steps: 28,
        cfg: 5,
        sampler: 'Euler a',
        scheduler: 'Automatic',
        checkpoint: 'delburry75.safetensors [abc]',
        clip_skip: 2,
        backend: 'forge',
      },
      { save_to_forge: true },
    )
    expect(payload).toMatchObject({
      prompt: 'p',
      negative_prompt: 'n',
      seed: 1,
      sampler_name: 'Euler a',
      scheduler: 'Automatic',
      batch_size: 1,
      n_iter: 1,
      save_images: true,
      override_settings: { sd_model_checkpoint: 'delburry75.safetensors [abc]', CLIP_stop_at_last_layers: 2 },
      override_settings_restore_afterwards: false,
    })
  })
})

describe('the hires pass', () => {
  const request = {
    prompt: 'p',
    negative: 'n',
    seed: 1,
    width: 832,
    height: 1280,
    steps: 28,
    cfg: 5,
    sampler: 'Euler a',
    scheduler: 'Automatic',
    checkpoint: 'delburry75.safetensors [abc]',
    backend: 'forge',
  }

  it('asks for the exact target size, not a scale factor', () => {
    const payload = toPayload(
      { ...request, hires: { width: 1856, height: 2856, upscaler: 'R-ESRGAN 4x+ Anime6B', denoise: 0.45, steps: 14 } },
      { save_to_forge: true },
    )
    expect(payload['enable_hr']).toBe(true)
    expect(payload['hr_resize_x']).toBe(1856)
    expect(payload['hr_resize_y']).toBe(2856)
    expect(payload['hr_upscaler']).toBe('R-ESRGAN 4x+ Anime6B')
    expect(payload['hr_second_pass_steps']).toBe(14)
    expect(payload['denoising_strength']).toBe(0.45)
    // The first pass still composes at the size the checkpoint likes.
    expect(payload['width']).toBe(832)
  })

  it('says nothing about hires when there is no second pass', () => {
    const payload = toPayload(request, { save_to_forge: true })
    expect(payload).not.toHaveProperty('enable_hr')
    expect(payload).not.toHaveProperty('denoising_strength')
  })
})
