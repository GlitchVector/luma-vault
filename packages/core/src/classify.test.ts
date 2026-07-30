import { describe, expect, it } from 'vitest'
import { DEFAULT_CLASSIFY_OPTIONS, fromSingleFrame, rateFrame, rollUpVideo } from './classify.ts'
import type { Detection, FrameVerdict } from './schemas.ts'

const det = (label: string, score: number): Detection => ({
  label,
  score,
  box: [0.1, 0.1, 0.2, 0.2],
})

describe('rateFrame', () => {
  it('rates a frame with no detections as sfw and nobody present', () => {
    const verdict = rateFrame([])
    expect(verdict).toMatchObject({ person: false, sexy: false, nude: false, rating: 'sfw' })
    expect(verdict.topLabel).toBeNull()
  })

  it('treats a face as a person but not as sexy', () => {
    const verdict = rateFrame([det('FACE_FEMALE', 0.95)])
    expect(verdict).toMatchObject({ person: true, sexy: false, nude: false, rating: 'sfw' })
  })

  it('does not let neutral anatomy make a frame sexy, however confident', () => {
    // Feet and covered bellies are the classic false-positive source. corn-dog
    // handled this with a runtime SFW exclusion list; here it falls out of the
    // label weights, so there is no list to keep in sync.
    const verdict = rateFrame([det('FEET_EXPOSED', 0.99), det('BELLY_COVERED', 0.99)])
    expect(verdict.sexy).toBe(false)
    expect(verdict.rating).toBe('sfw')
  })

  it('rates a suggestive label as suggestive, not explicit', () => {
    const verdict = rateFrame([det('BUTTOCKS_EXPOSED', 0.8)])
    expect(verdict).toMatchObject({ sexy: true, nude: false, rating: 'suggestive' })
    expect(verdict.topLabelTitle).toBe('exposed buttocks')
  })

  it('rates an explicit label as explicit and also sexy', () => {
    const verdict = rateFrame([det('FEMALE_GENITALIA_EXPOSED', 0.7)])
    expect(verdict).toMatchObject({ sexy: true, nude: true, rating: 'explicit' })
  })

  it('ignores rated labels below the score threshold', () => {
    const verdict = rateFrame([det('FEMALE_BREAST_EXPOSED', 0.3)])
    expect(verdict.sexy).toBe(false)
    expect(verdict.person).toBe(false)
  })

  it('counts a low-but-present detection as a person before it counts as sexy', () => {
    const verdict = rateFrame([det('FEMALE_BREAST_EXPOSED', 0.4)])
    expect(verdict).toMatchObject({ person: true, sexy: false })
  })

  it('picks the highest-scoring RATED label as the top part, never a higher face', () => {
    const verdict = rateFrame([det('FACE_MALE', 0.99), det('BUTTOCKS_EXPOSED', 0.61)])
    expect(verdict.topLabel).toBe('BUTTOCKS_EXPOSED')
    expect(verdict.topScore).toBeCloseTo(0.61)
  })

  it('is independent of detection order', () => {
    const detections = [
      det('FACE_FEMALE', 0.9),
      det('FEMALE_BREAST_EXPOSED', 0.72),
      det('BELLY_EXPOSED', 0.66),
    ]
    const forward = rateFrame(detections)
    const reversed = rateFrame([...detections].reverse())
    expect(forward).toEqual(reversed)
  })

  it('treats an unknown label from a newer model as neutral instead of throwing', () => {
    const verdict = rateFrame([det('SOME_FUTURE_CLASS', 0.9)])
    expect(verdict).toMatchObject({ person: true, sexy: false, rating: 'sfw' })
  })

  it('honours raised thresholds', () => {
    const strict = { ...DEFAULT_CLASSIFY_OPTIONS, explicitMinScore: 0.9 }
    expect(rateFrame([det('ANUS_EXPOSED', 0.85)], strict).nude).toBe(false)
    expect(rateFrame([det('ANUS_EXPOSED', 0.95)], strict).nude).toBe(true)
  })
})

describe('rollUpVideo', () => {
  const frame = (sexy: boolean, nude = false, score = 0.7): FrameVerdict => ({
    person: true,
    sexy,
    nude,
    rating: nude ? 'explicit' : sexy ? 'suggestive' : 'sfw',
    topLabel: sexy ? 'BUTTOCKS_EXPOSED' : null,
    topLabelTitle: sexy ? 'exposed buttocks' : null,
    topScore: sexy ? score : 0,
    detections: [],
  })

  it('returns an unrated verdict for a video with no sampled frames', () => {
    expect(rollUpVideo([])).toMatchObject({ rating: 'unrated', frameCount: 0, posterFrameIndex: null })
  })

  it('makes the whole video sexy when a single frame is sexy', () => {
    const verdict = rollUpVideo([frame(false), frame(false), frame(true), frame(false)])
    expect(verdict.sexy).toBe(true)
    expect(verdict.sexyFrameCount).toBe(1)
    expect(verdict.frameCount).toBe(4)
  })

  it('takes the most severe rating across frames', () => {
    const verdict = rollUpVideo([frame(true), frame(true, true)])
    expect(verdict.rating).toBe('explicit')
    expect(verdict.nude).toBe(true)
  })

  it('posters on the FIRST sexy frame, not the highest-scoring one', () => {
    const verdict = rollUpVideo([
      frame(false),
      frame(true, false, 0.55),
      frame(true, false, 0.99),
    ])
    expect(verdict.posterFrameIndex).toBe(1)
  })

  it('posters on the middle frame when nothing is sexy', () => {
    expect(rollUpVideo([frame(false), frame(false), frame(false)]).posterFrameIndex).toBe(1)
    expect(rollUpVideo([frame(false), frame(false)]).posterFrameIndex).toBe(1)
  })

  it('reports the highest top score seen across all frames', () => {
    const verdict = rollUpVideo([frame(true, false, 0.6), frame(true, false, 0.88)])
    expect(verdict.topScore).toBeCloseTo(0.88)
  })
})

describe('fromSingleFrame', () => {
  it('promotes an image verdict with a single frame and a zero poster index', () => {
    const verdict = fromSingleFrame(rateFrame([det('FEMALE_BREAST_EXPOSED', 0.8)]))
    expect(verdict).toMatchObject({
      rating: 'explicit',
      frameCount: 1,
      sexyFrameCount: 1,
      posterFrameIndex: 0,
    })
  })
})
