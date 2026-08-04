/**
 * The timeline's arithmetic: weeks, bars and the selection.
 *
 * Pure on purpose. The panel's dragging is the kind of interaction that is
 * miserable to test through a DOM and trivial to test as functions — what
 * pixel maps to what week, what a drag clamps to, what a click selects. The
 * component owns pointer capture and nothing else.
 */

import type { TimelineBucket } from './schemas.ts'

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Drop far-away islands of implausibly-dated files from the ends.
 *
 * The zero-mtime guard in the index catches one broken timestamp; this catches
 * the other one. Zip extractors and FAT-era copy tools stamp files with the
 * DOS epoch — 1980-01-01, which a timezone renders as Dec 1979 — and three
 * such files stretch the axis across five decades, flattening the actual
 * library into sub-pixel slivers at one end.
 *
 * The rule is shape-based rather than a cutoff year, because any fixed year is
 * wrong for somebody: an end cluster is dropped only when it is **both** tiny
 * (under `maxShare` of all items) **and** far away (separated from the rest by
 * more than `maxGapWeeks` of nothing). A genuinely sparse early archive fails
 * the first test and is kept; a recent quiet spell fails the second. Repeats
 * from both ends until stable, so 1980 junk and a lone 2099 file (a camera
 * with a dead clock battery) go in the same pass.
 */
export function trimIslands(
  buckets: readonly TimelineBucket[],
  { maxGapWeeks = 104, maxShare = 0.01 } = {},
): TimelineBucket[] {
  let kept = [...buckets]
  const total = kept.reduce((sum, bucket) => sum + bucket.count, 0)
  if (total === 0) return kept

  const gapMs = maxGapWeeks * WEEK_MS
  let changed = true
  while (changed && kept.length > 1) {
    changed = false

    // Leading island: everything before the first big gap.
    for (let i = 1; i < kept.length; i++) {
      if (kept[i]!.start - kept[i - 1]!.start <= gapMs) continue
      const share = kept.slice(0, i).reduce((sum, bucket) => sum + bucket.count, 0) / total
      if (share <= maxShare) {
        kept = kept.slice(i)
        changed = true
      }
      break
    }

    // Trailing island, same rule from the other end.
    for (let i = kept.length - 2; i >= 0; i--) {
      if (kept[i + 1]!.start - kept[i]!.start <= gapMs) continue
      const share = kept.slice(i + 1).reduce((sum, bucket) => sum + bucket.count, 0) / total
      if (share <= maxShare) {
        kept = kept.slice(0, i + 1)
        changed = true
      }
      break
    }
  }
  return kept
}

/**
 * Every week from the first bucket to the last, zeroes filled in.
 *
 * The backend sends only weeks that have items — a decade-spanning library
 * would otherwise be five hundred rows of zero — so the gaps are rebuilt here.
 * The bars have to exist to be clicked, and a timeline that skips its quiet
 * months misrepresents time itself: a gap in activity *is* information.
 */
export function fillWeeks(buckets: readonly TimelineBucket[]): TimelineBucket[] {
  const first = buckets[0]
  const last = buckets.at(-1)
  if (!first || !last) return []

  const byStart = new Map(buckets.map((bucket) => [bucket.start, bucket.count]))
  const weeks: TimelineBucket[] = []
  for (let start = first.start; start <= last.start; start += WEEK_MS) {
    weeks.push({ start, count: byStart.get(start) ?? 0 })
  }
  return weeks
}

/** The half-open range `[after, before)` one week's bar stands for. */
export function weekRange(week: TimelineBucket): { after: number; before: number } {
  return { after: week.start, before: week.start + WEEK_MS }
}

/**
 * One drawn bar: a half-open `[start, end)` slice of time and what it holds.
 *
 * Not the wire format — the backend speaks in weeks and this is a *drawing*
 * unit, which may cover several of them. `end` is explicit rather than implied
 * by a global width so a selection can always be read straight off the bars.
 */
export interface TimelineBar {
  start: number
  end: number
  count: number
}

/**
 * The filled weeks, merged into at most `maxBars` equal spans.
 *
 * The cap is what guarantees the strip is drawable at all. Bars divide the
 * available width, so their width is `strip / count` — and a span of decades
 * is thousands of weeks, which makes every bar a fraction of a pixel and the
 * whole timeline renders as *nothing*. That is not a hypothetical: a few
 * thousand DOS-epoch mtimes put 1979 on the axis and did exactly this.
 *
 * Weeks per bar is a whole number, so bars under the cap stay exactly weekly
 * and the merge only exists when weeks genuinely do not fit. The last bar may
 * cover fewer weeks than the rest; its `end` says so honestly rather than
 * rounding the axis up.
 */
export function mergeWeeks(weeks: readonly TimelineBucket[], maxBars = 240): TimelineBar[] {
  if (weeks.length === 0) return []
  const perBar = Math.max(1, Math.ceil(weeks.length / maxBars))

  const bars: TimelineBar[] = []
  for (let index = 0; index < weeks.length; index += perBar) {
    const group = weeks.slice(index, index + perBar)
    const last = group.at(-1)
    if (!last) break
    bars.push({
      start: group[0]!.start,
      end: last.start + WEEK_MS,
      count: group.reduce((sum, week) => sum + week.count, 0),
    })
  }
  return bars
}

/**
 * The selected range, as bar indices — inclusive on both ends, because that is
 * what a person sees: "from this bar to that bar".
 */
export interface BarSelection {
  first: number
  last: number
}

/** The `[after, before)` query range a bar selection means. */
export function selectionRange(
  bars: readonly TimelineBar[],
  selection: BarSelection,
): { after: number; before: number } | null {
  const first = bars[selection.first]
  const last = bars[selection.last]
  if (!first || !last) return null
  return { after: first.start, before: last.end }
}

/**
 * Which bar a pixel position lands on.
 *
 * Clamped rather than rejected: a drag runs past the edges of the strip as a
 * matter of course — that is how you say "all the way" — and returning null
 * there would make the selection stick at wherever the pointer left the strip.
 */
export function barAt(x: number, width: number, weekCount: number): number {
  if (weekCount === 0 || width <= 0) return 0
  const index = Math.floor((x / width) * weekCount)
  return Math.max(0, Math.min(weekCount - 1, index))
}

/**
 * Drag one edge of the selection to a bar.
 *
 * The edges may cross mid-drag — pull the left handle past the right — and
 * that means "the selection is now the other way round", not an error. Sorting
 * here rather than in the component keeps the invariant `first <= last` in one
 * place.
 */
export function dragEdge(
  selection: BarSelection,
  edge: 'first' | 'last',
  bar: number,
): BarSelection {
  const moved = edge === 'first' ? { ...selection, first: bar } : { ...selection, last: bar }
  return moved.first <= moved.last
    ? moved
    : { first: moved.last, last: moved.first }
}

/**
 * Bar heights as fractions of the tallest, with a floor.
 *
 * The floor is what keeps a week of 1 visible next to a week of 4,000 — a
 * strictly proportional bar would be a fraction of a pixel, indistinguishable
 * from the empty week beside it, and clicking an invisible bar is not a
 * feature. Zero stays zero: nothing there is nothing to show, or click.
 */
export function barHeights<T extends { count: number }>(
  bars: readonly T[],
  floor = 0.06,
): number[] {
  const tallest = Math.max(0, ...bars.map((bar) => bar.count))
  if (tallest === 0) return bars.map(() => 0)
  return bars.map((bar) => (bar.count === 0 ? 0 : Math.max(floor, bar.count / tallest)))
}
