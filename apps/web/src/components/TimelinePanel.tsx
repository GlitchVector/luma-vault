import {
  barAt,
  barHeights,
  dragEdge,
  fillWeeks,
  mergeWeeks,
  moveSelection,
  selectionRange,
  trimIslands,
  type BarSelection,
  type MediaQuery,
  type TimelineBucket,
} from '@luma/core'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { mediaTimeline } from '#/lib/native.ts'

interface TimelinePanelProps {
  /** The grid's current query, so the bars honour the same filters. */
  query: MediaQuery
  /** Narrow the grid to `[after, before)`, or null for the whole span. */
  onRange: (range: { after: number; before: number } | null) => void
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function label(ms: number): string {
  const date = new Date(ms)
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

function dayLabel(ms: number): string {
  const date = new Date(ms)
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/**
 * When the library is, as a strip of weekly bars with a draggable selection.
 *
 * The bars describe the *filtered* library — the same query the grid runs,
 * minus the date range itself, which the backend ignores for the histogram so
 * that a selection never erases the context around it.
 *
 * The selection is bar-based rather than pixel-based: a drag lands on whole
 * weeks. That is deliberate — the data is weekly, so a finer-grained selection
 * would imply a precision the bars do not have.
 */
export const TimelinePanel = memo(function TimelinePanel({ query, onRange }: TimelinePanelProps) {
  const [buckets, setBuckets] = useState<TimelineBucket[] | null>(null)
  const [selection, setSelection] = useState<BarSelection | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  /**
   * The drag in flight: an edge being resized, or the whole selection being
   * carried. `moved` distinguishes a carry from a click on the body — a press
   * that never crossed a bar boundary is someone clicking, not dragging, and
   * gets the single-bar select the body otherwise covers up.
   */
  const dragging = useRef<
    | { kind: 'first' }
    | { kind: 'last' }
    | { kind: 'move'; anchor: number; from: BarSelection; moved: boolean }
    | null
  >(null)

  // The histogram's inputs are everything about the query *except* the range
  // and the paging — the range is the one thing the timeline controls rather
  // than obeys, and depending on either would refetch the bars on every drag
  // and every scrolled page, for identical data.
  //
  // **Neutralised, never deleted.** The wire format is the full struct: Rust
  // rejects an object with fields missing, and an earlier version of this
  // panel deleted them — every fetch failed, and the failure wore the empty
  // state's clothes. Pinning them to constants gets the same memo behaviour
  // with a shape that is always valid.
  const inputs = useMemo(() => {
    const neutral: MediaQuery = { ...query, modifiedAfter: null, modifiedBefore: null, offset: 0 }
    return JSON.stringify(neutral)
  }, [query])

  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void mediaTimeline(JSON.parse(inputs) as MediaQuery).then(
      (next) => {
        if (cancelled) return
        setFailure(null)
        setBuckets(next)
        // The old selection indexed into the old bars; carrying it onto a
        // different set would silently select different weeks. Dropping it
        // also matches what a filter change means: a new question, asked from
        // the whole span.
        setSelection(null)
        onRange(null)
      },
      (reason: unknown) => {
        if (cancelled) return
        // Its own message, never the empty state. "Nothing here has a usable
        // date" over a working library sends someone auditing their files'
        // mtimes for a bug that lives in this panel.
        setFailure(String(reason))
        setBuckets([])
      },
    )
    return () => {
      cancelled = true
    }
    // `onRange` deliberately omitted: it is a state setter from the parent and
    // this effect must run only when the *data* changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs])

  // Two defences against a stretched axis, in order. Islands of implausibly-
  // dated files are trimmed — a few DOS-epoch mtimes must not put 1979 on the
  // axis. What survives is merged to a bounded number of bars, because the trim
  // is share-based and *thousands* of junk mtimes are no longer an island: the
  // axis then genuinely spans decades, and without the cap every bar divides
  // into a fraction of a pixel and the strip draws as nothing at all.
  const { bars, hidden, weeksPerBar } = useMemo(() => {
    const all = buckets ?? []
    const kept = trimIslands(all)
    const counted = (list: readonly { count: number }[]) =>
      list.reduce((sum, bucket) => sum + bucket.count, 0)
    const weeks = fillWeeks(kept)
    const merged = mergeWeeks(weeks)
    return {
      bars: merged,
      hidden: counted(all) - counted(kept),
      weeksPerBar: merged.length > 0 ? Math.ceil(weeks.length / merged.length) : 1,
    }
  }, [buckets])
  const heights = useMemo(() => barHeights(bars), [bars])

  const apply = (next: BarSelection | null) => {
    setSelection(next)
    onRange(next ? selectionRange(bars, next) : null)
  }

  /** The bar under a pointer event, in the strip's own coordinates. */
  const barUnder = (event: React.PointerEvent): number => {
    const strip = stripRef.current
    if (!strip) return 0
    const rect = strip.getBoundingClientRect()
    return barAt(event.clientX - rect.left, rect.width, bars.length)
  }

  /** Route further pointer events to the strip, wherever the pointer goes. */
  const capture = (event: React.PointerEvent) => {
    // Capture on the *strip*: the element the drag started on is about to move
    // out from under the pointer, and losing the capture with it would end
    // every drag after a few pixels. Optional-called — jsdom has no pointer
    // capture, and a missing refinement must not take the handler down.
    stripRef.current?.setPointerCapture?.(event.pointerId)
  }

  const beginDrag = (edge: 'first' | 'last') => (event: React.PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragging.current = { kind: edge }
    capture(event)
  }

  const beginMove = (event: React.PointerEvent) => {
    if (!selection) return
    event.preventDefault()
    event.stopPropagation()
    dragging.current = { kind: 'move', anchor: barUnder(event), from: selection, moved: false }
    capture(event)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragging.current
    if (!drag || !selection) return
    const bar = barUnder(event)

    if (drag.kind === 'move') {
      // The delta is measured from where the body was *grabbed*, against the
      // selection as it was then — accumulating against the current one would
      // compound the clamp and creep the selection off its width at the ends.
      const carried = moveSelection(drag.from, bar - drag.anchor, bars.length)
      if (bar !== drag.anchor) drag.moved = true
      if (carried.first !== selection.first || carried.last !== selection.last) {
        apply(carried)
      }
      return
    }

    const moved = dragEdge(selection, drag.kind, bar)

    // The edges can cross mid-drag — pull the left handle past the right — and
    // `dragEdge` swaps them. The hand should then be dragging whichever edge is
    // under the pointer, or the next move would fight the swap and the
    // selection would jump. The pointer's bar *is* one of the edges by
    // construction; when the selection is one bar wide it is both, and keeping
    // the current edge is what lets the next move decide the direction.
    if (moved.first !== moved.last) {
      dragging.current = { kind: bar === moved.first ? 'first' : 'last' }
    }

    if (moved.first !== selection.first || moved.last !== selection.last) {
      apply(moved)
    }
  }

  const endDrag = (event: React.PointerEvent) => {
    const drag = dragging.current
    dragging.current = null
    // A press on the body that never crossed a bar is a click, and the body
    // sits over the bars — so the click does what the bar underneath would
    // have: select just that one. Without this, an active selection makes the
    // bars inside it unclickable, which reads as the timeline breaking.
    if (drag?.kind === 'move' && !drag.moved) {
      apply({ first: barUnder(event), last: barUnder(event) })
    }
  }

  if (failure !== null) {
    return (
      <div className="border-b border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-200">
        The timeline could not be read: {failure}
      </div>
    )
  }
  if (buckets === null) {
    return (
      <div className="border-b border-white/5 px-4 py-3 text-xs text-zinc-500">
        Reading the library&rsquo;s dates…
      </div>
    )
  }
  if (bars.length === 0) {
    return (
      <div className="border-b border-white/5 px-4 py-3 text-xs text-zinc-500">
        Nothing here has a usable date.
      </div>
    )
  }

  const range = selection ? selectionRange(bars, selection) : null
  const selectedCount = selection
    ? bars
        .slice(selection.first, selection.last + 1)
        .reduce((total, bar) => total + bar.count, 0)
    : null

  return (
    <div className="border-b border-white/5 px-4 pb-1 pt-2 text-xs">
      <div className="flex items-baseline gap-3 pb-1 text-[11px] text-zinc-500">
        <span>{label(bars[0]!.start)}</span>
        {range && selectedCount !== null ? (
          <span className="text-indigo-300">
            {dayLabel(range.after)} – {dayLabel(range.before - 1)} ·{' '}
            {selectedCount.toLocaleString()} items
            <button
              type="button"
              onClick={() => apply(null)}
              className="ml-2 text-indigo-300 underline decoration-dotted underline-offset-2 hover:text-indigo-100"
            >
              clear
            </button>
          </span>
        ) : (
          <span>
            drag across the bars, or click one
            {weeksPerBar > 1 ? ` — each bar is ${weeksPerBar} weeks here` : ''}
          </span>
        )}
        {/* Said out loud, so the trim is never mistaken for the files not
            existing. They are in the grid — only the axis ignores them. */}
        {hidden > 0 ? (
          <span
            className="text-zinc-600"
            title="Files whose modified date is decades away from everything else — usually the 1980 timestamp zip extractors write. They are still in the grid; only the timeline's axis ignores them."
          >
            {hidden.toLocaleString()} with implausible dates not drawn
          </span>
        ) : null}
        <span className="ml-auto">{label(bars.at(-1)!.start)}</span>
      </div>

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
          the bars inside are the buttons; this wrapper only routes pointer
          moves while a drag it did not start is in flight. */}
      <div
        ref={stripRef}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={() => {
          // Abandoned, not finished: the click fallback must not fire off a
          // cancelled gesture, or a palm-brush selects a random week.
          dragging.current = null
        }}
        className="relative flex h-16 items-end"
      >
        {bars.map((bar, index) => {
          const inSelection =
            selection !== null && index >= selection.first && index <= selection.last
          const oneWeek = bar.end - bar.start <= 7 * 24 * 60 * 60 * 1000
          return (
            <button
              key={bar.start}
              type="button"
              // The title carries the numbers, because at a few hundred bars
              // there is no room for axis labels.
              title={`${dayLabel(bar.start)}${oneWeek ? '' : ` – ${dayLabel(bar.end - 1)}`} — ${bar.count.toLocaleString()} item${bar.count === 1 ? '' : 's'}. Click to show only ${oneWeek ? 'this week' : 'this span'}.`}
              onClick={() => apply({ first: index, last: index })}
              // A hairline gap via padding, but only when the bars can afford
              // it: at hundreds of bars a fixed 2px of padding is wider than
              // the bar itself, and the strip drew as nothing at all.
              className={`group flex h-full min-w-0 flex-1 items-end ${bars.length <= 160 ? 'px-px' : ''}`}
            >
              <span
                style={{ height: `${(heights[index] ?? 0) * 100}%` }}
                className={
                  inSelection
                    ? 'w-full rounded-sm bg-indigo-400'
                    : 'w-full rounded-sm bg-zinc-700 transition-colors group-hover:bg-zinc-500'
                }
              />
            </button>
          )
        })}

        {selection ? (
          <>
            {/* The dimmed outside, so the selection reads as a window onto the
                strip rather than a recolouring of some bars. `pointer-events-
                none`: the bars underneath stay clickable. */}
            <div
              className="pointer-events-none absolute inset-y-0 left-0 bg-zinc-950/60"
              style={{ width: `${(selection.first / bars.length) * 100}%` }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 bg-zinc-950/60"
              style={{ width: `${((bars.length - selection.last - 1) / bars.length) * 100}%` }}
            />

            {/* The selection body: grab anywhere on it and slide the whole
                range. Below the handles, so the edges still win where they
                overlap on a narrow selection. A press that never crosses a
                bar falls through as a click on the bar underneath. */}
            <button
              type="button"
              aria-label="Drag to move the selection"
              title="Drag to move the whole selection. Click to select just this bar."
              onPointerDown={beginMove}
              style={{
                left: `${(selection.first / bars.length) * 100}%`,
                width: `${((selection.last - selection.first + 1) / bars.length) * 100}%`,
              }}
              className="absolute inset-y-0 z-[5] cursor-grab touch-none active:cursor-grabbing"
            />

            {/* The handles. Outward-pointing arrows, on the outer face of each
                edge — grabbing one and dragging is how the range grows or
                shrinks. Wider than they look: a 4px line is not a target. */}
            <button
              type="button"
              aria-label="Drag to move the start of the selection"
              title="Drag to move the start of the selection"
              onPointerDown={beginDrag('first')}
              style={{ left: `calc(${(selection.first / bars.length) * 100}% - 9px)` }}
              className="absolute inset-y-0 z-10 flex w-[18px] cursor-ew-resize touch-none items-center justify-center"
            >
              <span className="flex h-8 w-3.5 items-center justify-center rounded-sm bg-indigo-500 text-[9px] leading-none text-white shadow">
                ◀
              </span>
            </button>
            <button
              type="button"
              aria-label="Drag to move the end of the selection"
              title="Drag to move the end of the selection"
              onPointerDown={beginDrag('last')}
              style={{
                left: `calc(${((selection.last + 1) / bars.length) * 100}% - 9px)`,
              }}
              className="absolute inset-y-0 z-10 flex w-[18px] cursor-ew-resize touch-none items-center justify-center"
            >
              <span className="flex h-8 w-3.5 items-center justify-center rounded-sm bg-indigo-500 text-[9px] leading-none text-white shadow">
                ▶
              </span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
})
