/**
 * Finding the picture an img2img was made from.
 *
 * The rule exists twice on purpose: here, and in `apps/desktop/src/origin.rs`.
 * The app answers this question through Rust because that is where the index
 * lives; the `migrate-prompt` script answers it in TypeScript because it runs
 * with the app closed and reads the index directly. Both are pinned by
 * `contracts/origin-vectors.json` — see the note at the top of that file, and
 * `origin.rs` for the measurements behind every constant below.
 *
 * The short version: an img2img keeps its subject in an init image that no
 * parameter block records, but which is usually still in the library and can be
 * recognised by perceptual hash. Matches at or under the dupe threshold are
 * excluded — those are the same picture re-saved, not what it was made from.
 */

/** Anything this close is the same picture, not its source. Mirrors `dupes::MAX_DISTANCE`. */
export const SAME_PICTURE = 3

/** How many bits may differ before one picture cannot have been made from the other. */
export const MAX_HASH_DISTANCE = 8

/** How far apart two colour signatures may be and still be one lineage. */
export const MAX_COLOUR_DISTANCE = 16

/** A backstop against a pathological chain, not a tuning knob. Median 2. */
export const MAX_HOPS = 12

/** One row as the walk sees it. */
export interface OriginCandidate {
  id: number
  /** The 64-bit difference hash. `bigint` because a number would round it. */
  phash: bigint
  modifiedAt: number
  /** The row's own `needsSourceImage` claim. A row that is not one ends the walk. */
  img2img: boolean
}

/** Where a picture came from, as far back as the trail can be followed. */
export interface Origin {
  id: number
  /** How many img2img passes back. Never zero — no link is reported as `null`. */
  hops: number
  /** Whether that ancestor is where the lineage started, or where the trail went cold. */
  reachedRoot: boolean
  /** The widest hop in the chain: a chain is worth what its weakest link is worth. */
  weakestHop: number
}

export function hashDistance(a: bigint, b: bigint): number {
  let bits = BigInt.asUintN(64, a ^ b)
  let count = 0
  while (bits) {
    count += Number(bits & 1n)
    bits >>= 1n
  }
  return count
}

/**
 * Mean absolute channel difference, 0-255.
 *
 * An absent or mismatched signature must not silently pass the check, so it
 * scores the maximum rather than zero.
 */
export function colourDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return Number.MAX_VALUE
  let total = 0
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i]! - b[i]!)
  return total / a.length
}

/**
 * Walk back from `start` to the furthest ancestor the trail reaches.
 *
 * `colourOf` is asked only about rows that already clear the hash test — it
 * costs a query and 192 bytes where the hash costs an xor — so a caller may
 * make it a database round trip. Returning `undefined` from it ends the walk
 * without discarding the hops already made.
 */
export function walkToOrigin(
  rows: readonly OriginCandidate[],
  start: number,
  colourOf: (id: number) => ArrayLike<number> | undefined,
): Origin | null {
  let at = rows.find((row) => row.id === start)
  if (!at) return null

  let hops = 0
  let weakestHop = 0

  while (hops < MAX_HOPS) {
    const colour = colourOf(at.id)
    if (!colour) break

    let best: { row: OriginCandidate; distance: number } | null = null
    for (const row of rows) {
      // Strictly older: what makes the walk acyclic, and also the claim being
      // made — a picture cannot be made from one that did not exist yet.
      if (row.modifiedAt >= at.modifiedAt || row.id === at.id) continue
      const distance = hashDistance(row.phash, at.phash)
      if (distance <= SAME_PICTURE || distance > MAX_HASH_DISTANCE) continue
      if (best) {
        if (distance > best.distance) continue
        // Ties go to the newest: a chain generates forward in time, so the later
        // of two equally close ancestors is the likelier parent.
        if (distance === best.distance && row.modifiedAt <= best.row.modifiedAt) continue
      }
      const candidateColour = colourOf(row.id)
      if (!candidateColour) continue
      if (colourDistance(colour, candidateColour) > MAX_COLOUR_DISTANCE) continue
      best = { row, distance }
    }

    if (!best) break
    at = best.row
    hops += 1
    weakestHop = Math.max(weakestHop, best.distance)
    // A row that was not made from another image is where this started.
    if (!at.img2img) return { id: at.id, hops, reachedRoot: true, weakestHop }
  }

  // The trail went cold, or ran out of hops, on another img2img. Reporting it
  // anyway is the difference between answering 68% of the time and 28%.
  return hops > 0 ? { id: at.id, hops, reachedRoot: false, weakestHop } : null
}
