import { describe, expect, it } from 'vitest'
import { migrateGeneration } from './migrate.ts'

/**
 * These pin the three failures the migration exists to prevent, all of which
 * are silent: a LoRA that does nothing, an embedding that becomes prose, and a
 * canvas the target model never saw. None of them raises an error in Forge —
 * each one just changes the picture.
 */

// A real block, from an image in this library.
const SD15 = [
  'official art, (Moona Hoshinova), 1girl, full body, nsfw,',
  'thighhighs, breasts, purple hair, thigh boots,',
  'BREAK',
  'thick thighs, (naked breasts:1.2),   <lora:hyperfusion_279k_64dim-LoCon-v6:0.65>',
  'Negative prompt: (worst quality, low quality:1.4), EasyNegative, bad-hands-5, garter straps, censored',
  'Steps: 50, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 3997412987, Size: 660x990, ' +
    'Model hash: a1ff10e2dc, Model: aniversev20-revAnimatedv122-50p-hll3vtubers, Clip skip: 2, ' +
    'Denoising strength: 0.4, Hires upscale: 2, Hires steps: 30, ' +
    'Hires upscaler: 4xUltrasharp_4xUltrasharpV10, ADetailer model: face_yolov8n.pt',
].join('\n')

const TO_XL = { architecture: 'xl', checkpoint: 'perfectdeliberate_v10' } as const

describe('migrateGeneration, SD1.5 to SDXL', () => {
  const { block, notes } = migrateGeneration(SD15, TO_XL)
  const settings = block.split('\n').at(-1)!

  it('drops the LoRA, which would do nothing and say nothing', () => {
    expect(block).not.toContain('<lora:')
    expect(notes.join(' ')).toContain('hyperfusion_279k_64dim-LoCon-v6')
  })

  it('drops SD1.5 embeddings, which would become literal words in the negative', () => {
    expect(block).not.toMatch(/EasyNegative/i)
    expect(block).not.toMatch(/bad-hands-5/i)
    // The terms that were never embeddings stay.
    expect(block).toContain('garter straps')
    expect(block).toContain('censored')
  })

  it('lands on an SDXL bucket with the aspect ratio it had', () => {
    // 660x990 is 2:3, and 832x1216 is the bucket closest to it.
    expect(settings).toContain('Size: 832x1216')
  })

  it('keeps the hires pass aiming at roughly the original final height', () => {
    // 990 x 2 = 1980 wanted; 1216 x 1.6 = 1946.
    expect(settings).toMatch(/Hires upscale: 1\.6/)
  })

  it('adds the quality tags booru-trained models expect', () => {
    expect(block).toContain('masterpiece, best quality')
  })

  it('sets the settings those models are tuned for', () => {
    expect(settings).toContain('CFG scale: 5')
    expect(settings).toContain('Steps: 28')
    expect(settings).toContain('Clip skip: 2')
  })

  it('points at the target checkpoint', () => {
    expect(settings).toContain('Model: perfectdeliberate_v10')
  })

  it('randomises the seed, because a seed does not survive a model change', () => {
    expect(settings).toContain('Seed: -1')
    expect(settings).not.toContain('3997412987')
  })

  it('drops an SD1.5 VAE, which would decode to rainbow noise', () => {
    // The one that has actually bitten in this project: an SD1.5 VAE left on an
    // SDXL model produces saturated garbage and reads as a broken checkpoint.
    const withVae = migrateGeneration(
      SD15.replace('Clip skip: 2', 'VAE: vae-ft-mse-840000-ema-pruned.safetensors, VAE hash: 42a404c885'),
      TO_XL,
    )
    const line = withVae.block.split('\n').at(-1)!
    expect(line).toContain('VAE: Automatic')
    expect(line).not.toContain('vae-ft-mse-840000')
    expect(line).not.toContain('VAE hash')
    expect(withVae.notes.join(' ')).toContain('rainbow noise')
  })

  it('drops the receipts for everything it removed', () => {
    // These are how a webui records what a generation used. Left behind they
    // contradict the block: `Model hash` names the old checkpoint, and
    // `Lora hashes` names a LoRA no longer in the prompt — which Forge's paste
    // tries to resolve, and errors on.
    const real = migrateGeneration(
      SD15.replace(
        'ADetailer model: face_yolov8n.pt',
        'ADetailer model: face_yolov8n.pt, Lora hashes: "hyperfusion_279k_64dim-LoCon-v6: 3005add0a210", ' +
          'TI: "easynegative, bad-hands-5", Version: f2.0.1v1.10.1',
      ),
      TO_XL,
    )
    const line = real.block.split('\n').at(-1)!
    expect(line).not.toContain('Model hash')
    expect(line).not.toContain('Lora hashes')
    expect(line).not.toMatch(/(^|,\s)TI:/)
    expect(line).not.toContain('Version:')
    // The setting that replaced them is still right.
    expect(line).toContain('Model: perfectdeliberate_v10')
  })

  it('states the emphasis mode, so the paste cannot override it back', () => {
    // A block silent about a settings-backed field does not leave that setting
    // alone: the paste fills in the default and records the difference as an
    // override, reverting a choice the person made and showing them a chip
    // they never added.
    const stated = migrateGeneration(SD15, { ...TO_XL, emphasis: 'No norm' })
    expect(stated.block.split('\n').at(-1)!).toContain('Emphasis: No norm')
  })

  it('says so when the emphasis mode will blunt the weights', () => {
    const original = migrateGeneration(SD15, { ...TO_XL, emphasis: 'Original' })
    expect(original.notes.join(' ')).toContain('renormalises')
  })

  it('does not repeat a negative term the block already had', () => {
    // `(worst quality, low quality:1.4)` is one weighted group holding two
    // terms; appending them again halves the attention each one gets.
    const line = block.split('\n').find((row) => row.startsWith('Negative prompt:'))!
    expect(line.match(/worst quality/g)).toHaveLength(1)
    expect(line.match(/low quality/g)).toHaveLength(1)
  })

  it('rewrites phrases that only look like danbooru tags', () => {
    // `huge hips` is not one of the 10,861 tags these models learned, so it
    // carries no meaning and the hips come out *smaller* than with `wide hips`.
    // Checked against models/anime-tagger/selected_tags.csv.
    const { block: out, notes: why } = migrateGeneration(
      'a girl, huge hips, big ass, hyper breasts, chubby\nSteps: 20, Size: 512x768',
      TO_XL,
    )
    expect(out).toContain('wide hips')
    expect(out).toContain('huge ass')
    expect(out).toContain('gigantic breasts')
    expect(out).toContain('plump')
    expect(out).not.toMatch(/huge hips|big ass|hyper breasts|chubby/)
    expect(why.join(' ')).toContain('huge hips → wide hips')
  })

  it('keeps the weight when it rewrites a tag', () => {
    const { block: out } = migrateGeneration(
      'a girl, (huge hips:1.3), (big ass:0.8)\nSteps: 20, Size: 512x768',
      TO_XL,
    )
    expect(out).toContain('(wide hips:1.3)')
    expect(out).toContain('(huge ass:0.8)')
  })

  it('removes negatives that cancel what the prompt asks for', () => {
    // Straight from this library: an SD1.5 negative carried `fat, chubby` to
    // fight that model's doughiness. On a booru model it deletes the very body
    // type `thick thighs` and `wide hips` just requested, and the result reads
    // as the model ignoring the prompt.
    const { block: out, notes: why } = migrateGeneration(
      'a girl, thick thighs, wide hips\nNegative prompt: fat, chubby, blurry, watermark\nSteps: 20, Size: 512x768',
      TO_XL,
    )
    const negative = out.split('\n').find((line) => line.startsWith('Negative prompt:'))!
    expect(negative).not.toMatch(/\bfat\b|\bchubby\b/)
    expect(negative).toContain('blurry')
    expect(why.join(' ')).toContain('the prompt asks for the opposite')
  })

  it('leaves a negative alone when the prompt does not contradict it', () => {
    // `fat` in the negative is perfectly reasonable on a prompt that says
    // nothing about body shape. Only the contradiction is removed.
    const { block: out } = migrateGeneration(
      'a castle at dusk\nNegative prompt: fat, chubby, blurry\nSteps: 20, Size: 512x768',
      TO_XL,
    )
    const negative = out.split('\n').find((line) => line.startsWith('Negative prompt:'))!
    expect(negative).toContain('fat')
    expect(negative).toContain('chubby')
  })

  it('drops a negative that also appears in the prompt', () => {
    const { block: out } = migrateGeneration(
      'a girl, muscular\nNegative prompt: muscular, blurry\nSteps: 20, Size: 512x768',
      TO_XL,
    )
    const negative = out.split('\n').find((line) => line.startsWith('Negative prompt:'))!
    expect(negative).not.toMatch(/\bmuscular\b/)
    expect(negative).toContain('blurry')
  })

  it('leaves everything it has no opinion about alone', () => {
    // The upscaler and the detector are architecture-agnostic; rewriting them
    // would be changing the picture for no reason.
    expect(settings).toContain('Hires upscaler: 4xUltrasharp_4xUltrasharpV10')
    expect(settings).toContain('ADetailer model: face_yolov8n.pt')
    expect(settings).toContain('Sampler: DPM++ 2M Karras')
  })

  it('explains each change rather than performing it silently', () => {
    expect(notes.length).toBeGreaterThanOrEqual(5)
    expect(notes.every((note) => note.length > 20)).toBe(true)
  })
})

describe('migrateGeneration, staying on the same architecture', () => {
  it('swaps the model and the seed and touches nothing else', () => {
    const { block, notes } = migrateGeneration(SD15, {
      architecture: 'sd',
      checkpoint: 'revAnimated_v11',
    })
    const settings = block.split('\n').at(-1)!

    expect(settings).toContain('Model: revAnimated_v11')
    expect(settings).toContain('Seed: -1')
    // Still an SD1.5 model, so the LoRA and the embeddings still work.
    expect(block).toContain('<lora:hyperfusion_279k_64dim-LoCon-v6:0.65>')
    expect(block).toContain('EasyNegative')
    expect(settings).toContain('Size: 660x990')
    expect(settings).toContain('CFG scale: 7')
    expect(notes).toEqual([])
  })
})

describe('migrateGeneration, edge cases', () => {
  it('handles a block with no negative prompt', () => {
    const { block } = migrateGeneration('a castle\nSteps: 20, Size: 512x512, Seed: 5', TO_XL)
    expect(block).toContain('Size: 1024x1024')
    expect(block).toContain('Seed: -1')
  })

  it('does not add quality tags a prompt already has', () => {
    const { block } = migrateGeneration(
      'masterpiece, a castle\nSteps: 20, Size: 512x512',
      TO_XL,
    )
    expect(block.match(/masterpiece/g)).toHaveLength(1)
  })

  it('strips an embedding wearing emphasis syntax', () => {
    const { block } = migrateGeneration(
      'a castle\nNegative prompt: (EasyNegative:1.2), blurry\nSteps: 20, Size: 512x512',
      TO_XL,
    )
    expect(block).not.toMatch(/EasyNegative/i)
    expect(block).toContain('blurry')
  })

  it('leaves a quoted ADetailer prompt containing commas intact', () => {
    const source =
      'a castle\nSteps: 20, Size: 512x512, ADetailer prompt: "a face, smiling, detailed", CFG scale: 7'
    const { block } = migrateGeneration(source, TO_XL)
    expect(block).toContain('ADetailer prompt: "a face, smiling, detailed"')
  })
})
