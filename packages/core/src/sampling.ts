/**
 * Where to sample a video for classification.
 *
 * A whole video is classified from a handful of stills, so the sampling plan is
 * the single biggest lever on both accuracy and scan time. The rules:
 *
 * - Sample on a fixed interval, not a fixed count, so a 3-minute clip and a
 *   3-hour film get comparable coverage per minute.
 * - Clamp the total, so one very long file cannot monopolise the classifier
 *   pool. Above the clamp the interval stretches to spread the budget evenly.
 * - Skip the head and tail of long videos, where studio logos, title cards and
 *   credits produce frames that are representative of nothing. Short videos
 *   skip nothing — trimming 2 minutes off a 4-minute clip would leave almost
 *   no signal.
 */
export interface SamplingOptions {
  /** Seconds between sampled frames, before the clamp stretches it. */
  intervalSec: number
  /** Never sample more than this many frames from one video. */
  maxFrames: number
  /** Seconds to skip at the start (long videos only). */
  skipStartSec: number
  /** Seconds to skip at the end (long videos only). */
  skipEndSec: number
  /** Videos at or below this duration skip nothing. */
  shortVideoSec: number
}

export const DEFAULT_SAMPLING: SamplingOptions = {
  intervalSec: 10,
  maxFrames: 60,
  skipStartSec: 60,
  skipEndSec: 45,
  shortVideoSec: 420,
}

/**
 * Timestamps (seconds) to grab, in ascending order.
 *
 * Always returns at least one timestamp for any positive duration, so a 2-second
 * GIF-like clip still gets classified instead of silently landing as `unrated`.
 */
export function planFrameTimestamps(
  durationSec: number,
  options: SamplingOptions = DEFAULT_SAMPLING,
): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return []

  const isShort = durationSec <= options.shortVideoSec
  const skipStart = isShort ? 0 : options.skipStartSec
  const skipEnd = isShort ? 0 : options.skipEndSec

  let start = skipStart
  let end = durationSec - skipEnd

  // The skips can swallow the whole video (a 70-second file with a 60s head
  // skip). Fall back to the untrimmed range rather than returning nothing.
  if (end - start < options.intervalSec) {
    start = 0
    end = durationSec
  }

  const span = end - start
  const wanted = Math.max(1, Math.floor(span / options.intervalSec))
  const count = Math.min(wanted, options.maxFrames)
  const step = count === 1 ? 0 : span / count

  const timestamps: number[] = []
  for (let i = 0; i < count; i += 1) {
    const at = count === 1 ? start + span / 2 : start + step * i
    // Never seek to the exact final byte — some containers return no frame there.
    timestamps.push(Math.min(at, Math.max(0, durationSec - 0.1)))
  }
  return timestamps
}
