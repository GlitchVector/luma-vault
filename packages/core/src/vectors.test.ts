import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rateFrame, rollUpVideo } from './classify.ts'
import { walkToOrigin, type Origin, type OriginCandidate } from './origin.ts'
import { planFrameTimestamps } from './sampling.ts'
import type { Detection, FrameVerdict, Rating } from './schemas.ts'

/**
 * The TypeScript half of the shared-vector suite.
 *
 * The rating rules exist in two languages — here, and in
 * `apps/desktop/src/rating.rs`, where the scan pipeline runs them. Mirrored
 * logic drifts, so both sides are driven by this one file. A rule change means
 * editing `contracts/classify-vectors.json` and watching *two* suites fail;
 * fixing only one side is exactly the failure this is here to prevent.
 */

const VECTORS = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../contracts/classify-vectors.json'),
    'utf8',
  ),
) as {
  frameVectors: Array<{
    name: string
    detections: Detection[]
    expect: { person: boolean; sexy: boolean; nude: boolean; rating: Rating; topLabel: string | null }
  }>
  videoVectors: Array<{
    name: string
    frames: Rating[]
    expect: {
      rating: Rating
      sexy: boolean
      sexyFrameCount: number
      posterFrameIndex: number | null
    }
  }>
  samplingVectors: Array<{
    name: string
    durationSec: number
    expectCount: number
    expectFirst?: number
    expectEvenlySpaced?: boolean
  }>
}

const ORIGIN_VECTORS = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../contracts/origin-vectors.json'),
    'utf8',
  ),
) as {
  cases: Array<{
    name: string
    rows: Array<{ id: number; phash: string; modifiedAt: number; img2img: boolean; grey: number }>
    start: number
    expect: Origin | null
  }>
}

/** Built from a rating name, exactly as `stub_frame` does in the Rust suite. */
function stubFrame(rating: Rating): FrameVerdict {
  const sexy = rating === 'suggestive' || rating === 'explicit'
  return {
    person: true,
    sexy,
    nude: rating === 'explicit',
    rating,
    topLabel: sexy ? 'BUTTOCKS_EXPOSED' : null,
    topLabelTitle: sexy ? 'exposed buttocks' : null,
    topScore: sexy ? 0.7 : 0,
    detections: [],
  }
}

describe('frame vectors (shared with apps/desktop/src/rating.rs)', () => {
  it('has cases to run', () => {
    expect(VECTORS.frameVectors.length).toBeGreaterThan(0)
  })

  for (const testCase of VECTORS.frameVectors) {
    it(testCase.name, () => {
      const verdict = rateFrame(testCase.detections)
      expect({
        person: verdict.person,
        sexy: verdict.sexy,
        nude: verdict.nude,
        rating: verdict.rating,
        topLabel: verdict.topLabel,
      }).toEqual(testCase.expect)
    })
  }
})

describe('video vectors (shared with apps/desktop/src/rating.rs)', () => {
  for (const testCase of VECTORS.videoVectors) {
    it(testCase.name, () => {
      const verdict = rollUpVideo(testCase.frames.map(stubFrame))
      expect({
        rating: verdict.rating,
        sexy: verdict.sexy,
        sexyFrameCount: verdict.sexyFrameCount,
        posterFrameIndex: verdict.posterFrameIndex,
      }).toEqual(testCase.expect)
    })
  }
})

describe('origin vectors (shared with apps/desktop/src/origin.rs)', () => {
  it('has cases to run', () => {
    expect(ORIGIN_VECTORS.cases.length).toBeGreaterThan(0)
  })

  for (const testCase of ORIGIN_VECTORS.cases) {
    it(testCase.name, () => {
      const rows: OriginCandidate[] = testCase.rows.map((row) => ({
        id: row.id,
        phash: BigInt(`0x${row.phash}`),
        modifiedAt: row.modifiedAt,
        img2img: row.img2img,
      }))
      // `grey` is a flat signature — every one of the 192 bytes at that value —
      // so two rows sit exactly |a - b| apart. See the fixture's own note.
      const greys = new Map(testCase.rows.map((row) => [row.id, row.grey]))
      const colourOf = (id: number) => {
        const grey = greys.get(id)
        return grey === undefined ? undefined : new Uint8Array(192).fill(grey)
      }

      expect(walkToOrigin(rows, testCase.start, colourOf)).toEqual(testCase.expect)
    })
  }
})

describe('sampling vectors (shared with apps/desktop/src/sampling.rs)', () => {
  for (const testCase of VECTORS.samplingVectors) {
    it(testCase.name, () => {
      const stamps = planFrameTimestamps(testCase.durationSec)
      expect(stamps).toHaveLength(testCase.expectCount)

      if (testCase.expectFirst !== undefined) {
        expect(stamps[0]).toBeCloseTo(testCase.expectFirst, 9)
      }
      for (const stamp of stamps) {
        expect(stamp).toBeGreaterThanOrEqual(0)
        expect(stamp).toBeLessThan(testCase.durationSec)
      }

      if (testCase.expectEvenlySpaced) {
        const gaps = stamps.slice(1).map((stamp, index) => stamp - stamps[index]!)
        for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0]!, 6)
      }
    })
  }
})
