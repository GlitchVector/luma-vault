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
