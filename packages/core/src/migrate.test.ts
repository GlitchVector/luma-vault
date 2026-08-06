import { describe, expect, it } from 'vitest'
import { facePrompt, migrateGeneration } from './migrate.ts'

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

describe('the always-on passes', () => {
  const SD_BLOCK =
    'a girl, blue hair, huge ass, looking at viewer\nNegative prompt: lowres\n' +
    'Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 512x768, Model: aniverse_v20'

  it('adds Hires fix when the block has none', () => {
    const { block, notes } = migrateGeneration(SD_BLOCK, { architecture: 'xl', checkpoint: 'x' })
    expect(block).toContain('Hires upscale: 1.65')
    expect(block).toContain('Hires steps: 30')
    expect(block).toContain('Hires upscaler: 4xUltrasharp_4xUltrasharpV10')
    expect(notes.some((note) => note.includes('Hires fix'))).toBe(true)
  })

  it('leaves a hires pass the block already names alone', () => {
    const withHires = SD_BLOCK.replace(
      'Model: aniverse_v20',
      'Model: aniverse_v20, Hires upscale: 2, Hires steps: 12, Hires upscaler: Latent',
    )
    const { block } = migrateGeneration(withHires, { architecture: 'xl', checkpoint: 'x' })
    // The crossing recomputes the factor, but the steps and upscaler are the
    // block's own and stay.
    expect(block).toContain('Hires steps: 12')
    expect(block).not.toContain('Hires steps: 30')
  })

  it('adds an ADetailer face pass built from the face words in the prompt', () => {
    const { block, notes } = migrateGeneration(SD_BLOCK, { architecture: 'xl', checkpoint: 'x' })
    expect(block).toContain('ADetailer model: face_yolov8s.pt')
    // Face vocabulary only: hair and gaze travel, the ass does not — the pass
    // repaints a head crop and must not re-argue the body inside it.
    expect(block).toMatch(/ADetailer prompt: "[^"]*blue hair[^"]*"/)
    expect(block).not.toMatch(/ADetailer prompt: "[^"]*huge ass[^"]*"/)
    expect(block).toMatch(/ADetailer negative prompt: "[^"]*worst quality[^"]*"/)
    expect(notes.some((note) => note.includes('ADetailer'))).toBe(true)
  })

  it('leaves an ADetailer block that is already there alone', () => {
    const withAd = SD_BLOCK.replace(
      'Model: aniverse_v20',
      'Model: aniverse_v20, ADetailer model: face_yolov8n.pt, ADetailer denoising strength: 0.3',
    )
    const { block } = migrateGeneration(withAd, { architecture: 'xl', checkpoint: 'x' })
    expect(block).toContain('face_yolov8n.pt')
    expect(block).not.toContain('face_yolov8s.pt')
  })

  it('vetoes fragments where a face word shares a line with a body word', () => {
    // Straight out of a real migration: "smile" dragged "full body" in, and
    // "hair" matched pubic hair — onto a head crop.
    expect(
      facePrompt('orange hair, Seductive Smile full body, (pubic hair:1.2), crimson eyes'),
    ).toBe('masterpiece, best quality, detailed face, beautiful detailed eyes, orange hair, crimson eyes')
    // Word-bounded: "glasses" is not "ass".
    expect(facePrompt('glasses, blue eyes')).toContain('glasses')
  })

  it('extracts identity, not scenery, into the face prompt', () => {
    expect(facePrompt('1girl, aqua (konosuba), blue hair, huge ass, ocean, blush')).toBe(
      'masterpiece, best quality, detailed face, beautiful detailed eyes, aqua (konosuba), blue hair, blush',
    )
    // Nothing face-like means no face prompt — inheriting is better than noise.
    expect(facePrompt('landscape, ocean, rocks')).toBe('')
  })
})

describe('migrateGeneration, reframing', () => {
  it('imposes the asked-for shot, weighted, and removes the rung it replaces', () => {
    // Two rungs in one prompt fight; the reframe must not leave the old one.
    // Wide rungs go in weighted — bare, they lose to every body tag pulling
    // the camera in.
    const { block, notes } = migrateGeneration(SD15, { ...TO_XL, shot: 'wide shot' })
    expect(block.startsWith('(wide shot:1.3),')).toBe(true)
    expect(block).not.toContain('full body')
    expect(notes.join(' ')).toContain('Reframed to (wide shot:1.3), replacing full body')
  })

  it('adds the wide-shot backstop to the negative', () => {
    const { block } = migrateGeneration(SD15, { ...TO_XL, shot: 'full body' })
    const negative = block.split('\n').find((line) => line.startsWith('Negative prompt:'))!
    expect(negative).toContain('close-up')
    expect(negative).toContain('cropped')
    expect(negative).toContain('portrait')
    expect(negative).toContain('upper body')
  })

  it('does not double a backstop the negative already carries', () => {
    const withBackstop = SD15.replace('censored', 'censored, close-up, cropped')
    const { block } = migrateGeneration(withBackstop, { ...TO_XL, shot: 'full body' })
    const negative = block.split('\n').find((line) => line.startsWith('Negative prompt:'))!
    expect(negative.match(/close-up/g)).toHaveLength(1)
    expect(negative.match(/cropped/g)).toHaveLength(1)
  })

  it('a tight reframe gets no backstop', () => {
    const { block } = migrateGeneration(SD15, { ...TO_XL, shot: 'upper body' })
    expect(block.startsWith('upper body,')).toBe(true)
    expect(block).not.toContain('close-up')
  })

  it('applies on a same-architecture move too', () => {
    const { block, notes } = migrateGeneration(SD15, {
      architecture: 'sd',
      checkpoint: 'revAnimated_v11',
      shot: 'very wide shot',
    })
    expect(block.startsWith('(very wide shot:1.3),')).toBe(true)
    expect(notes).toHaveLength(1)
  })

  it('leaves the framing alone when no shot is asked for', () => {
    const { block } = migrateGeneration(SD15, TO_XL)
    expect(block).toContain('full body')
  })
})

describe('migrateGeneration, body overrides', () => {
  it('imposes body tags and clears the rungs of the axes they mention', () => {
    const { block, notes } = migrateGeneration(SD15, {
      ...TO_XL,
      body: '(gigantic ass:2), (wide hips:1.4)',
    })
    expect(block.startsWith('(gigantic ass:2), (wide hips:1.4),')).toBe(true)
    // Thighs were not mentioned, so the prompt's own thick thighs survive.
    expect(block).toContain('thick thighs')
    expect(notes.some((note) => note.includes('Imposed the asked-for body'))).toBe(true)
  })

  it('the hips maximum combo replaces the thigh rung the prompt carried', () => {
    const combo =
      '(wide hips:2), (thick thighs:2), (curvy:2), (narrow waist:2), (hyper hips:2), hip focus'
    const { block } = migrateGeneration(SD15, { ...TO_XL, body: combo })
    expect(block.startsWith('(wide hips:2),')).toBe(true)
    // One thick thighs — the combo's — not a tug of war with the original's.
    const prompt = block.split('\n').filter((line) => !line.startsWith('Negative prompt:')).slice(0, -1).join('\n')
    expect(prompt.match(/thick thighs/g)).toHaveLength(1)
  })

  it('a shot and a body compose, shot outermost', () => {
    const { block } = migrateGeneration(SD15, {
      ...TO_XL,
      shot: 'full body',
      body: '(gigantic breasts:2)',
    })
    expect(block.startsWith('(full body:1.3),\n(gigantic breasts:2),')).toBe(true)
  })
})

/**
 * The case this exists for: an **img2img** block, which is twelve words about a
 * face and nothing else. The character, the outfit, the pose and the room were
 * all in the init image, and a PNG parameter block does not carry that image —
 * so migrating one faithfully reproduces a prompt describing almost nothing,
 * and the model happily invents the rest. Reading the picture is the only way
 * back, and this is where what was read goes.
 */
const IMG2IMG = [
  'masterpiece, best quality, pink hair bangs, (beautiful green eyes:1.2), open mouth, blush, happy',
  'Negative prompt: (worst quality, low quality:1.4), text, watermark',
  'Steps: 30, Sampler: DPM++ SDE Karras, CFG scale: 7, Seed: 2824184793, Size: 1024x1024, ' +
    'Model hash: 2839a9c268, Model: meinaunrealv41, Denoising strength: 0.43',
].join('\n')

describe('migrateGeneration, what the picture shows', () => {
  it('appends the tags the prompt never said, behind what it did say', () => {
    const { block, notes } = migrateGeneration(IMG2IMG, {
      ...TO_XL,
      add: 'black dress, garter straps, black thighhighs, demon horns',
    })
    const prompt = block.split('\nNegative prompt:')[0]!

    // The person's own words stay in front, where their weight is.
    expect(prompt.startsWith('masterpiece, best quality, pink hair bangs')).toBe(true)
    expect(prompt).toContain('black dress, garter straps, black thighhighs, demon horns')
    expect(notes.some((note) => note.includes('what the picture shows'))).toBe(true)
  })

  it('never says a tag the prompt already carries', () => {
    const { block, notes } = migrateGeneration(IMG2IMG, {
      ...TO_XL,
      add: 'blush, black dress, happy',
    })
    const prompt = block.split('\nNegative prompt:')[0]!
    // Duplicated concepts are encoded twice at half the attention each.
    expect(prompt.match(/blush/g)).toHaveLength(1)
    expect(prompt.match(/happy/g)).toHaveLength(1)
    expect(prompt).toContain('black dress')
    expect(notes.some((note) => note.includes('2 already there'))).toBe(true)
  })

  it('dedupes against the imposed body and shot too, not only the original', () => {
    const { block } = migrateGeneration(IMG2IMG, {
      ...TO_XL,
      shot: 'cowboy shot',
      body: '(large breasts:1.3)',
      add: 'cowboy shot, black dress',
    })
    const prompt = block.split('\nNegative prompt:')[0]!
    expect(prompt.match(/cowboy shot/g)).toHaveLength(1)
  })
})

describe('migrateGeneration, an explicit canvas', () => {
  it('takes the asked-for shape instead of the bucket rule, and says so once', () => {
    const { block, notes } = migrateGeneration(IMG2IMG, { ...TO_XL, size: '832x1216' })
    expect(block.split('\n').at(-1)).toContain('Size: 832x1216')
    expect(notes.filter((note) => /Size|Canvas/.test(note))).toHaveLength(1)
    expect(notes.some((note) => note.includes('Canvas set to 832x1216'))).toBe(true)
  })

  it('snaps an off-bucket canvas to the nearest one, keeping the shape', () => {
    const { block, notes } = migrateGeneration(IMG2IMG, { ...TO_XL, size: '800x1200' })
    expect(block.split('\n').at(-1)).toContain('Size: 832x1216')
    expect(notes.some((note) => note.includes('nearest SDXL bucket'))).toBe(true)
  })

  it('applies on a same-architecture move, where no bucket rule runs at all', () => {
    const { block } = migrateGeneration(IMG2IMG, {
      architecture: 'sd',
      checkpoint: 'anything_v5',
      size: '512x768',
    })
    expect(block.split('\n').at(-1)).toContain('Size: 512x768')
  })
})

describe('a negative that fights the imposed body', () => {
  /** An SD1.5 negative written to fight that model's doughiness. */
  const WITH_FAT = [
    'masterpiece, best quality, pink hair bangs, open mouth, blush',
    'Negative prompt: (worst quality, low quality:1.4), crease, fat, chubby, text',
    'Steps: 30, Sampler: DPM++ SDE Karras, CFG scale: 7, Seed: 1, Size: 1024x1024, ' +
      'Model hash: 2839a9c268, Model: meinaunrealv41, Denoising strength: 0.43',
  ].join('\n')

  it('is cleared by a body the command imposed, not only by one the prompt already had', () => {
    const { block, notes } = migrateGeneration(WITH_FAT, {
      ...TO_XL,
      body: '(thick thighs:1.4), (wide hips:1.4)',
    })
    const negative = block.split('\n').find((line) => line.startsWith('Negative prompt:'))!

    // The scan used to run before the override was applied, so the loudest ask
    // in the whole block was the one thing it could not see — and the render
    // came back slim with nothing in the notes saying why.
    expect(negative).not.toContain('chubby')
    expect(negative).not.toMatch(/(^|[^a-z])fat([^a-z]|$)/)
    // Untouched: it is not one of the terms that cancels a body tag.
    expect(negative).toContain('crease')
    expect(notes.some((note) => note.includes('Removed'))).toBe(true)
  })
})

describe('a v-prediction target', () => {
  // The mode itself needs no help: Forge reads `v_pred` out of the checkpoint's
  // own header. The sampler is the part a parameter block can get wrong, and it
  // fails by handing back a burnt image rather than an error.
  const TO_VPRED = {
    architecture: 'xl',
    checkpoint: 'noobaiXLNAIXL_vPred10Version',
    vPred: true,
    family: 'noob',
  } as const

  it('replaces a sampler that can diverge on it', () => {
    const { block, notes } = migrateGeneration(SD15, TO_VPRED)
    const settings = block.split('\n').at(-1)!
    expect(settings).toContain('Sampler: Euler a')
    expect(settings).not.toContain('DPM++')
    // The schedule went with it — an ancestral sampler does its own.
    expect(settings).not.toContain('Schedule type')
    expect(notes.join(' ')).toMatch(/predicts v rather than noise/)
  })

  it('leaves a sampler that is already safe, and says so', () => {
    const already = SD15.replace('Sampler: DPM++ 2M Karras', 'Sampler: Euler a')
    const { block, notes } = migrateGeneration(already, TO_VPRED)
    expect(block.split('\n').at(-1)!).toContain('Sampler: Euler a')
    expect(notes.join(' ')).toMatch(/safe on a v-prediction checkpoint/)
  })

  it('touches nothing about the sampler on an ordinary checkpoint', () => {
    // The guard that keeps this from becoming a migration that rewrites
    // samplers generally — they are architecture-agnostic otherwise.
    const { block } = migrateGeneration(SD15, TO_XL)
    expect(block.split('\n').at(-1)!).toContain('DPM++')
  })

  it('applies on a same-architecture move, where nothing else would', () => {
    // XL→XL onto a v-pred checkpoint is exactly the case where the block
    // already carries a sampler chosen for an epsilon model.
    const xlBlock = [
      '1girl, solo',
      'Negative prompt: worst quality',
      'Steps: 28, Sampler: DPM++ 2M SDE, CFG scale: 5, Size: 832x1216, Model: someXL_v1',
    ].join('\n')
    const { block } = migrateGeneration(xlBlock, TO_VPRED)
    expect(block.split('\n').at(-1)!).toContain('Sampler: Euler a')
  })
})

describe('the NoobAI vocabulary', () => {
  const TO_NOOB = {
    architecture: 'xl',
    checkpoint: 'noobaiXLNAIXL_vPred10Version',
    family: 'noob',
  } as const

  it('uses the quality tags it was actually trained with', () => {
    // `newest` is a recency tag NoobAI learned and the other XL checkpoints
    // never saw; `very aesthetic` is the one it does not have.
    const { block } = migrateGeneration(SD15, TO_NOOB)
    expect(block).toContain('newest')
    expect(block).toContain('highres')
    expect(block).not.toContain('very aesthetic')
  })

  it('puts the recency terms in the negative too', () => {
    const { block } = migrateGeneration(SD15, TO_NOOB)
    const negative = block.split('\n').find((line) => line.startsWith('Negative prompt:'))!
    expect(negative).toContain('old')
    expect(negative).toContain('early')
    expect(negative).toContain('normal quality')
  })

  it('leaves the common XL set alone for everything else', () => {
    const { block } = migrateGeneration(SD15, TO_XL)
    expect(block).toContain('very aesthetic')
    expect(block).not.toContain('newest')
  })
})

describe('the AniVerse family', () => {
  // Everything here comes from this library's own 1,806 AniVerse images rated
  // four or better, not from a model card — see ANIVERSE_SETTINGS.
  const TO_ANIVERSE = {
    architecture: 'xl',
    checkpoint: 'aniverseXL_v40',
    family: 'aniverse',
  } as const

  it('uses the settings the highest-rated images were made at', () => {
    // CFG 7 on 1,795 of 1,806, and DPM++ SDE Karras on 1,220. Sending the
    // booru-XL tuning instead is why one prompt came back looking like several
    // different models.
    const { block, notes } = migrateGeneration(SD15, TO_ANIVERSE)
    const settings = block.split('\n').at(-1)!
    expect(settings).toContain('CFG scale: 7')
    expect(settings).toContain('Steps: 40')
    expect(settings).toContain('Sampler: DPM++ SDE')
    expect(settings).toContain('Schedule type: Karras')
    expect(notes.join(' ')).toMatch(/your own\s+highest-rated AniVerse images/)
  })

  it('leaves every other target on the booru-XL tuning', () => {
    const settings = migrateGeneration(SD15, TO_XL).block.split('\n').at(-1)!
    expect(settings).toContain('CFG scale: 5')
    expect(settings).toContain('Steps: 28')
  })

  it('uses the quality prefix those images actually open with', () => {
    const { block } = migrateGeneration(SD15, TO_ANIVERSE)
    expect(block).toContain('perfect face')
    expect(block).toContain('highest detailed face')
    // Not the booru set, and not NoobAI's.
    expect(block).not.toContain('very aesthetic')
    expect(block).not.toContain('newest')
  })

  it('keeps the SD1.5 embeddings out of the negative it inherits', () => {
    // The measured negative carries EasyNegative and bad-hands-5 on 451 of
    // those images. On SDXL they are the literal words, which is the whole
    // reason the embedding strip exists — the family baseline must not put
    // them back.
    const { block } = migrateGeneration(SD15, TO_ANIVERSE)
    const negative = block.split('\n').find((line) => line.startsWith('Negative prompt:'))!
    expect(negative.toLowerCase()).not.toContain('easynegative')
    expect(negative.toLowerCase()).not.toContain('bad-hands-5')
    expect(negative).toContain('greyscale')
  })

  it('does not negate realistic, whatever the original did', () => {
    // The measured negative has `(realistic:1.0)`. Left out on purpose: a
    // tag's job depends on what the checkpoint renders by default, and
    // negating it on a model that is already flat produces cel shading rather
    // than the soft look it was reaching for.
    const { block } = migrateGeneration(SD15, TO_ANIVERSE)
    const negative = block.split('\n').find((line) => line.startsWith('Negative prompt:'))!
    expect(negative).not.toMatch(/(^|[^a-z])realistic/)
  })
})

describe('facePrompt and brackets', () => {
  it('drops a closing bracket its partner was split away from', () => {
    // A weighted group spans commas, so splitting on them hands back
    // `highest detailed face)` with nothing to match it. Pasted into
    // ADetailer that re-weights everything after it, or fails outright —
    // and the AniVerse quality prefix is exactly such a group.
    const face = facePrompt('(best quality, perfect face, highest detailed face), pink eyes')
    expect(face).toContain('highest detailed face')
    expect((face.match(/\(/g) ?? []).length).toBe((face.match(/\)/g) ?? []).length)
  })

  it('leaves a group that is already balanced alone', () => {
    // `(perfect face:1.2)` arrives whole; it is not a casualty of the split
    // and its weight is the person's own.
    expect(facePrompt('(perfect face:1.2), blue eyes')).toContain('(perfect face:1.2)')
  })

  it('drops a weight left stranded on a tag', () => {
    // The number was calibrated against the prompt it came from, not against
    // the much smaller face pass.
    expect(facePrompt('(smile, perfect face:1.4), blue eyes')).toContain('perfect face,')
  })
})
