/**
 * Putting several sets of the same character into one order.
 *
 * A set is a narrative, and the narrative lives in the member labels a run
 * writes. Three shapes appear in them, and this library's 8,000 labelled
 * members use all three:
 *
 *   stage 3 — full body from behind      the dressed-to-undressed progression
 *   bridge 2→3 — taking the jacket off   a transition *between* two stages
 *   act 7 — spitroast                    the acts, which follow the stages
 *
 * One photostory carries both kinds — a single run of Aerith has 26 stages and
 * 51 acts — so "the order of a set" is already stage 1…N then act 1…M, with
 * each bridge sitting between the stages it names.
 *
 * Merging two sets of the same character therefore cannot mean appending one to
 * the other: that would run the whole progression twice. It means collating
 * them, so every set's stage 1 comes before any set's stage 2, and the stages
 * come before the acts. Which is what "keep the order by acts" asks for.
 */

/** Where a member sits in the narrative. Lower sorts first, field by field. */
export interface ActKey {
  /** Stages and bridges (0) come before acts (1); anything unlabelled (2) last. */
  readonly phase: number
  /** The number in the label. */
  readonly index: number
  /** A bridge is 1 so it falls after the stage it leaves and before the next. */
  readonly sub: number
}

const STAGE = /^\s*stage\s*(\d+)/i
/** `1→2`, `1->2` and `1-2` all appear; the arrow is whatever the run felt like. */
const BRIDGE = /^\s*bridge\s*(\d+)\s*(?:→|->|-|to)\s*(\d+)/i
const ACT = /^\s*act\s*(\d+)/i

/** The unlabelled phase. Named because two places have to agree on it. */
const UNLABELLED = 2

/**
 * Read a member's place in the narrative out of its label.
 *
 * Unrecognised labels are not an error and must not be dropped — more than half
 * the labelled members in this library are lora crops like `4-6-susp-01`, which
 * have no narrative at all. They sort last and keep the order they arrived in.
 */
export function actKeyOf(label: string | null | undefined): ActKey {
  if (label === null || label === undefined) return { phase: UNLABELLED, index: 0, sub: 0 }

  const bridge = BRIDGE.exec(label)
  // Checked before `stage`, because "bridge 1→2" would otherwise not match at
  // all and a transition would be thrown to the end of the post.
  if (bridge?.[1] !== undefined) return { phase: 0, index: Number(bridge[1]), sub: 1 }

  const stage = STAGE.exec(label)
  if (stage?.[1] !== undefined) return { phase: 0, index: Number(stage[1]), sub: 0 }

  const act = ACT.exec(label)
  if (act?.[1] !== undefined) return { phase: 1, index: Number(act[1]), sub: 0 }

  return { phase: UNLABELLED, index: 0, sub: 0 }
}

/** One picture, as the merge needs to see it. */
export interface SetMember<T> {
  readonly item: T
  /** Which selected set it came from — ties break by this, so a set stays together. */
  readonly setOrdinal: number
  /** Its position within its own set. */
  readonly position: number
  readonly label: string | null
}

/**
 * Collate several sets into the order a merged post should use.
 *
 * Ties break by set and then by position, so two sets' stage-3 frames appear as
 * one set's stage 3 followed by the other's — interleaved by stage, not shuffled
 * frame by frame. A reader should still be able to tell the two shoots apart.
 *
 * A selection with no usable labels at all comes back exactly as it went in:
 * every member lands in the unlabelled phase, and the tie-break is set then
 * position, which is the order the grid already showed.
 */
export function mergeSetOrder<T>(members: readonly SetMember<T>[]): T[] {
  return [...members]
    .map((member, arrival) => ({ member, arrival, key: actKeyOf(member.label) }))
    .sort((left, right) => {
      const byPhase = left.key.phase - right.key.phase
      if (byPhase !== 0) return byPhase
      const byIndex = left.key.index - right.key.index
      if (byIndex !== 0) return byIndex
      const bySub = left.key.sub - right.key.sub
      if (bySub !== 0) return bySub
      const bySet = left.member.setOrdinal - right.member.setOrdinal
      if (bySet !== 0) return bySet
      const byPosition = left.member.position - right.member.position
      if (byPosition !== 0) return byPosition
      // Positions collide across manifests: a run split over two date folders
      // records each from zero. Arrival order is the last tie-break so the
      // result is at least stable rather than dependent on sort internals.
      return left.arrival - right.arrival
    })
    .map((entry) => entry.member.item)
}

/**
 * A short human name for a member's place, for grouping headers in the panel.
 *
 * `null` for the unlabelled, so a caller can leave those ungrouped rather than
 * inventing a heading for a lora crop.
 */
export function actLabelOf(label: string | null | undefined): string | null {
  const key = actKeyOf(label)
  if (key.phase === UNLABELLED) return null
  if (key.phase === 1) return `act ${key.index}`
  return key.sub === 1 ? `bridge ${key.index}→${key.index + 1}` : `stage ${key.index}`
}
