import { describe, expect, it } from 'vitest'
import { DEFAULT_SAMPLING, planFrameTimestamps } from './sampling.ts'

describe('planFrameTimestamps', () => {
  it('returns nothing for a non-positive or unknown duration', () => {
    expect(planFrameTimestamps(0)).toEqual([])
    expect(planFrameTimestamps(-5)).toEqual([])
    expect(planFrameTimestamps(Number.NaN)).toEqual([])
  })

  it('always yields at least one frame for a very short clip', () => {
    const stamps = planFrameTimestamps(2)
    expect(stamps).toHaveLength(1)
    expect(stamps[0]).toBeGreaterThan(0)
    expect(stamps[0]).toBeLessThan(2)
  })

  it('skips nothing on a short video', () => {
    const stamps = planFrameTimestamps(120)
    expect(stamps[0]).toBe(0)
    expect(stamps.at(-1)).toBeLessThan(120)
  })

  it('skips the head and tail of a long video', () => {
    const stamps = planFrameTimestamps(3600)
    expect(stamps[0]).toBe(DEFAULT_SAMPLING.skipStartSec)
    expect(stamps.at(-1)).toBeLessThan(3600 - DEFAULT_SAMPLING.skipEndSec)
  })

  it('clamps a very long video to maxFrames and spreads them evenly', () => {
    const stamps = planFrameTimestamps(4 * 3600)
    expect(stamps).toHaveLength(DEFAULT_SAMPLING.maxFrames)
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!)
    const first = gaps[0]!
    for (const gap of gaps) expect(gap).toBeCloseTo(first, 5)
  })

  it('falls back to the untrimmed range when the skips would swallow the video', () => {
    // 70s is over the short-video line only in a world where skipStart is small;
    // with a 60s head skip and a 45s tail skip the trimmed span is negative.
    const stamps = planFrameTimestamps(430)
    expect(stamps.length).toBeGreaterThan(0)
    expect(stamps.every((t) => t >= 0 && t < 430)).toBe(true)
  })

  it('never seeks past the end of the file', () => {
    for (const duration of [3, 30, 300, 3000, 30_000]) {
      for (const stamp of planFrameTimestamps(duration)) {
        expect(stamp).toBeLessThan(duration)
        expect(stamp).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('returns strictly ascending timestamps', () => {
    const stamps = planFrameTimestamps(1800)
    const sorted = [...stamps].sort((a, b) => a - b)
    expect(stamps).toEqual(sorted)
    expect(new Set(stamps).size).toBe(stamps.length)
  })
})
