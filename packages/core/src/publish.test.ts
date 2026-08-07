import { describe, expect, it } from 'vitest'
import {
  DISPLAY_ORIGINAL,
  MAX_TAGS,
  MAX_TITLE,
  POSE_TAGS,
  describeForDeviantArt,
  poseFromLabel,
  poseOf,
  promptSubjects,
  toTag,
} from './publish.ts'
import type { Generation, MediaItem, MediaVerdict, Rating } from './schemas.ts'

function verdict(rating: Rating, topLabel: string | null): MediaVerdict {
  return {
    person: true,
    sexy: rating === 'suggestive' || rating === 'explicit',
    nude: rating === 'explicit',
    rating,
    topLabel,
    topLabelTitle: topLabel,
    topScore: 0.8,
    frameCount: 1,
    sexyFrameCount: rating === 'sfw' || rating === 'unrated' ? 0 : 1,
    posterFrameIndex: null,
  }
}

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 1,
    folderId: 1,
    path: 'D:/pics/00042-3746152819.png',
    name: '00042-3746152819.png',
    kind: 'image',
    width: 1024,
    height: 1536,
    sizeBytes: 1_200_000,
    modifiedAt: 0,
    addedAt: 0,
    thumbPath: null,
    thumbWidth: null,
    thumbHeight: null,
    durationSec: null,
    verdict: null,
    classifiedAt: null,
    stars: null,
    generation: null,
    dupeGroup: null,
    upscaledFrom: null,
    upscaledTo: null,
    deviantArt: null,
    ratingOverride: null,
    ...overrides,
  }
}

function generation(overrides: Partial<Generation> = {}): Generation {
  return {
    tool: 'Stable Diffusion',
    needsSourceImage: false, postprocessed: false,
    ...overrides,
  }
}

describe('toTag', () => {
  it('keeps only what DeviantArt accepts', () => {
    // Their rule is letters, digits and underscores. This is not tidying — a
    // stray character is a rejected submission.
    expect(toTag('Blue Hair')).toBe('blue_hair')
    expect(toTag('sci-fi!')).toBe('sci_fi')
    expect(toTag('  spaced  out  ')).toBe('spaced_out')
    expect(toTag('***')).toBe('')
  })

  it('folds accents rather than dropping the letters under them', () => {
    // Stripping non-ASCII outright would turn `café` into `caf`.
    expect(toTag('café')).toBe('cafe')
    expect(toTag('Grün')).toBe('grun')
  })
})

describe('promptSubjects', () => {
  it('drops the weight syntax but keeps the word it was applied to', () => {
    expect(promptSubjects('(blue hair:1.3), solo')).toEqual(['blue hair', 'solo'])
  })

  it('drops LoRA invocations, which name a file and not a subject', () => {
    expect(promptSubjects('1girl, <lora:styleXL:0.8>, forest')).toEqual([
      '1girl',
      'forest',
    ])
  })

  it('drops render boilerplate and the Pony score ladder', () => {
    const subjects = promptSubjects(
      'score_9, score_8_up, masterpiece, best quality, absurdres, 1girl, red dress',
    )
    expect(subjects).toEqual(['1girl', 'red dress'])
  })
})

describe('describeForDeviantArt', () => {
  it('titles from the prompt when the filename is a counter and a seed', () => {
    // Which is what generated output is called, essentially always — so this is
    // the normal path rather than the fallback.
    const draft = describeForDeviantArt(
      item({
        generation: generation({ prompt: 'masterpiece, 1girl, silver hair, red dress, forest' }),
      }),
    )
    expect(draft.title).toBe('1girl, Silver Hair, Red Dress, Forest')
  })

  it('prefers a filename that a person actually chose', () => {
    const draft = describeForDeviantArt(
      item({
        name: 'winter_market_study.png',
        generation: generation({ prompt: '1girl, snow' }),
      }),
    )
    expect(draft.title).toBe('Winter Market Study')
  })

  it('never exceeds the title cap', () => {
    const draft = describeForDeviantArt(
      item({
        generation: generation({
          prompt: 'an extraordinarily long single fragment that runs well past the limit on its own',
        }),
      }),
    )
    expect(draft.title.length).toBeLessThanOrEqual(MAX_TITLE)
  })

  it('falls back to Untitled rather than inventing one', () => {
    expect(describeForDeviantArt(item()).title).toBe('Untitled')
  })

  it('does not title an upscaled variant "Upscaled 4k"', () => {
    // The failure this exists for, and it was not an edge case: the grid shows
    // variants *in place of* their originals, so a selection is normally all
    // variants — and every one of them came out with this same title, because
    // the suffix is the only thing in the name that survives the digit strip.
    const draft = describeForDeviantArt(
      item({
        name: '00242-3753124055_upscaled_4k.png',
        generation: generation({ prompt: '1girl, blue hair, nun, halberd' }),
      }),
    )
    expect(draft.title).toBe('1girl, Blue Hair, Nun, Halberd')
  })

  it('titles every draft the same when one is given for the batch', () => {
    const draft = describeForDeviantArt(item({ name: 'winter_market_study.png' }), {
      title: '  Sister of the Halberd  ',
    })
    expect(draft.title).toBe('Sister of the Halberd')
  })

  it('leaves the description empty rather than naming the checkpoint', () => {
    // A public page does not need to say which model made the picture. The
    // checkpoint still goes out as a tag, which is browsable and removable.
    const draft = describeForDeviantArt(item({ generation: generation() }))
    expect(draft.description).toBe('')
  })

  it('shows at original resolution, not DeviantArt’s downscaled default', () => {
    expect(describeForDeviantArt(item()).displayResolution).toBe(DISPLAY_ORIGINAL)
  })

  it('does not claim no-AI-training over a generated library', () => {
    // Opt-in: asserting it is a claim the owner has to actually want to make.
    expect(describeForDeviantArt(item({ generation: generation() })).noai).toBe(false)
    expect(describeForDeviantArt(item(), { noai: true }).noai).toBe(true)
  })

  it('sends the 18+ tier and both classifications for explicit anatomy', () => {
    const draft = describeForDeviantArt(
      item({ verdict: verdict('explicit', 'FEMALE_GENITALIA_EXPOSED') }),
    )
    expect(draft.isMature).toBe(true)
    expect(draft.matureLevel).toBe('strict')
    expect(draft.matureClassification).toEqual(['nudity', 'sexual'])
  })

  it('does not call a bare midriff nudity', () => {
    // BELLY_EXPOSED and FEMALE_BREAST_EXPOSED are both `sexy` to the rating
    // rules and only one of them is nudity. Over-flagging filters a gallery out
    // of everyone's browse page for nothing.
    const draft = describeForDeviantArt(item({ verdict: verdict('suggestive', 'BELLY_EXPOSED') }))
    expect(draft.matureLevel).toBe('moderate')
    expect(draft.matureClassification).toEqual(['sexual'])
    expect(draft.matureClassification).not.toContain('nudity')
  })

  it('leaves an unrated row unflagged, for a person to correct', () => {
    // The classifier has not reached it. Guessing mature would be inventing a
    // verdict; guessing safe is visible in the panel and easy to fix.
    const draft = describeForDeviantArt(item())
    expect(draft.isMature).toBe(false)
    expect(draft.matureLevel).toBeNull()
    expect(draft.matureClassification).toEqual([])
  })

  it('still flags a rating whose label means nothing to us', () => {
    // A newer model revision emitting a class this build does not know must
    // under-report the *tags*, never the maturity.
    const draft = describeForDeviantArt(item({ verdict: verdict('explicit', 'NOVEL_CLASS') }))
    expect(draft.isMature).toBe(true)
    expect(draft.matureLevel).toBe('strict')
  })

  it('declares AI generation from the metadata, not from a guess', () => {
    expect(describeForDeviantArt(item()).isAiGenerated).toBe(false)
    expect(
      describeForDeviantArt(item({ generation: generation() })).isAiGenerated,
    ).toBe(true)
  })

  it('tags the checkpoint by its name, not its filename', () => {
    const draft = describeForDeviantArt(
      item({
        generation: generation({ model: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors' }),
      }),
    )
    expect(draft.tags).toContain('ponydiffusionv6xl')
    expect(draft.tags).toContain('aiart')
    expect(draft.tags).toContain('stablediffusion')
  })

  it('puts deliberate tags first and never repeats one', () => {
    const draft = describeForDeviantArt(
      item({ verdict: verdict('explicit', 'FEMALE_BREAST_EXPOSED') }),
      { baseTags: ['glitchvector', 'nude'] },
    )
    expect(draft.tags[0]).toBe('glitchvector')
    // `nude` is also implied by the label; it must appear once, where it was
    // asked for.
    expect(draft.tags.filter((tag) => tag === 'nude')).toHaveLength(1)
    expect(draft.tags.indexOf('nude')).toBe(1)
  })

  it('trims to the tag cap rather than being rejected for exceeding it', () => {
    const many = Array.from({ length: 40 }, (_, index) => `tag${index}`)
    const draft = describeForDeviantArt(item(), { baseTags: many })
    expect(draft.tags).toHaveLength(MAX_TAGS)
  })
})

describe('poseFromLabel', () => {
  it('calls it from behind when buttocks scored highest', () => {
    expect(poseFromLabel('BUTTOCKS_EXPOSED')).toBe('rear')
    expect(poseFromLabel('BUTTOCKS_COVERED')).toBe('rear')
  })

  it('calls it front-facing when anything else scored highest', () => {
    expect(poseFromLabel('FEMALE_BREAST_EXPOSED')).toBe('front')
    expect(poseFromLabel('FEMALE_GENITALIA_EXPOSED')).toBe('front')
    expect(poseFromLabel('BELLY_EXPOSED')).toBe('front')
  })

  it('treats an anus as the same view as buttocks', () => {
    // A spread pose can score the anus above the buttocks around it, and it is
    // plainly the same camera position.
    expect(poseFromLabel('ANUS_EXPOSED')).toBe('rear')
    expect(poseFromLabel('ANUS_COVERED')).toBe('rear')
  })

  it('has no opinion when the whole-image anime rating was the strongest', () => {
    // ANIME_* is a judgement of the picture on a frame-filling placeholder box.
    // It has no location, so it cannot mean from behind or from the front, and
    // guessing "front" from it would tag half a gallery wrongly.
    expect(poseFromLabel('ANIME_EXPLICIT')).toBeNull()
    expect(poseFromLabel('ANIME_QUESTIONABLE')).toBeNull()
  })

  it('has no opinion about an unclassified row', () => {
    expect(poseFromLabel(null)).toBeNull()
    expect(poseFromLabel(undefined)).toBeNull()
    expect(poseFromLabel('')).toBeNull()
  })

  it('ignores faces, which appear in both orientations', () => {
    // `rateFrame` already keeps a 0.99 face from becoming topLabel over a 0.6
    // exposure, so this is defence in depth rather than the primary guard — but
    // a face turned back over the shoulder is the commonest from-behind pose
    // there is, and it must never be read as front-facing.
    expect(poseFromLabel('FACE_FEMALE')).toBeNull()
    expect(poseFromLabel('FACE_MALE')).toBeNull()
  })
})

describe('poseOf', () => {
  it('reads the pose an upscaled variant inherited', () => {
    // The case this exists for. A variant never goes through classification, so
    // it has no frame rows and no raw detections — but it does carry the
    // verdict copied from its original. Since the grid hides an original once a
    // variant exists, this is what almost every real selection looks like.
    const variant = item({
      name: '00157-2782069719_upscaled_4k.png',
      upscaledFrom: 'D:/pics/00157-2782069719.png',
      verdict: verdict('suggestive', 'BUTTOCKS_EXPOSED'),
    })
    expect(poseOf(variant)).toBe('rear')
  })

  it('has no opinion about a row the classifier has not reached', () => {
    expect(poseOf(item())).toBeNull()
  })
})

describe('the tag budget', () => {
  it('keeps the tuned pose lists inside what DeviantArt will accept', () => {
    // 30 is a HARD limit — the site refuses to publish a submission carrying a
    // 31st tag rather than trimming it. A pose list long enough to leave no room
    // for the derived tags is not a style question, it is a rejected upload.
    for (const [pose, tags] of Object.entries(POSE_TAGS)) {
      expect(tags.length, `${pose} has ${tags.length} tags`).toBeLessThanOrEqual(MAX_TAGS)
      // Room for what a classified, generated picture contributes on its own:
      // up to 3 label tags, 2 rating tags and 4 generation tags.
      expect(tags.length, `${pose} leaves no room for the derived tags`).toBeLessThanOrEqual(
        MAX_TAGS - 6,
      )
    }
  })

  it('only sends tags DeviantArt accepts, straight from the table', () => {
    // The lists are hand-written, so a stray space or hyphen would otherwise
    // reach the API and be rejected there instead of here.
    for (const tags of Object.values(POSE_TAGS)) {
      for (const tag of tags) expect(toTag(tag)).toBe(tag)
    }
  })

  it('has no duplicates within a pose list', () => {
    // A repeat spends one of thirty slots on nothing.
    for (const [pose, tags] of Object.entries(POSE_TAGS)) {
      expect(new Set(tags).size, `${pose} repeats a tag`).toBe(tags.length)
    }
  })

  it('drops the large-breast tags from the rear set', () => {
    // They describe something a from-behind shot does not show.
    for (const tag of ['hugeboobs', 'hugebreasts', 'largeboobs', 'largebreasts']) {
      expect(POSE_TAGS.front).toContain(tag)
      expect(POSE_TAGS.rear).not.toContain(tag)
    }
  })

  it('spells the tool exactly as the pose lists spell it', () => {
    // Both spellings are real, populated tags on DeviantArt — which is the
    // problem, not the tie-breaker. They are separate pages with separate
    // search results, so emitting one while the pose list carries the other
    // spends two of thirty slots saying the same thing, in a budget that is
    // already over.
    //
    // So this asserts *agreement*, not a winner. Whichever spelling the tuned
    // lists settle on, the derived tag has to follow it, and changing one
    // without the other fails here rather than silently costing a slot.
    const draft = describeForDeviantArt(item({ generation: generation() }))
    const inPoseLists = POSE_TAGS.front.filter((tag) => tag.replace(/_/g, '') === 'stablediffusion')

    expect(inPoseLists).toHaveLength(1)
    expect(draft.tags).toContain(inPoseLists[0])
  })
})
