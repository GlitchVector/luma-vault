import type { MediaItem } from '@luma/core'
import { useCallback, useEffect, useRef } from 'react'
import { MediaTile } from './MediaTile.tsx'

interface MediaGridProps {
  items: MediaItem[]
  onOpen: (id: number) => void
  onReachEnd: () => void
  showBoxes: boolean
  /** Draw each set of duplicates inside its own frame. */
  groupDuplicates: boolean
}

/**
 * Split a list into its duplicate sets, keyed by group rather than adjacency.
 *
 * The first version collected *consecutive runs*, on the reasoning that the
 * query orders by `dupeGroup` so members arrive adjacent. The database does
 * order them — verified directly against the exact page the grid asks for, 300
 * rows, 117 runs, not one of length 1 — and the grid still rendered sets of
 * one. Rather than keep hunting for what reorders them in between, this stops
 * depending on the order at all.
 *
 * That is the better design regardless of the answer: adjacency is an
 * invariant maintained three layers away, in SQL, and a UI that silently
 * mis-renders when it breaks is a UI with a hidden contract. A map has no such
 * contract. Insertion order preserves whatever order the rows did arrive in,
 * so a correctly sorted page still lays out exactly as the index gave it.
 */
function intoGroups(items: MediaItem[]): MediaItem[][] {
  const groups = new Map<number | string, MediaItem[]>()
  for (const item of items) {
    // Ungrouped rows should not reach here — the query filters them out — but
    // one key per row is the safe reading if they do, rather than sweeping
    // every unrelated picture into a single set called `null`.
    const key = item.dupeGroup ?? `ungrouped:${item.id}`
    const existing = groups.get(key)
    if (existing) existing.push(item)
    else groups.set(key, [item])
  }
  return [...groups.values()]
}

/**
 * The wall.
 *
 * There is no column maths here, and that is deliberate: a flex row with
 * `flex-wrap` lets the browser's own line-breaking algorithm place every tile,
 * which is C++ doing in one pass what a JavaScript masonry layout would do in
 * many. Because each tile carries an explicit width and height, the result is a
 * justified wall of correctly-shaped cells with ragged row heights — visually a
 * masonry, computationally a single reflow.
 *
 * Paging is by sentinel rather than by scroll handler: an IntersectionObserver
 * on a trailing element fires once when it comes into view, instead of a scroll
 * listener running on every frame and computing offsets.
 */
export function MediaGrid({
  items,
  onOpen,
  onReachEnd,
  showBoxes,
  groupDuplicates,
}: MediaGridProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const reachEndRef = useRef(onReachEnd)

  // A latest-ref so the observer below is created once rather than on every
  // render — the caller almost certainly passes a fresh closure each time.
  useEffect(() => {
    reachEndRef.current = onReachEnd
  })

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reachEndRef.current()
      },
      // Fire a screen early so the next page is already arriving by the time
      // the user gets there.
      { rootMargin: '1200px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  const handleOpen = useCallback((id: number) => onOpen(id), [onOpen])

  return (
    <>
      {groupDuplicates ? (
        // One frame per set, stacked. Adjacency alone does not say where a set
        // ends — with tiles the same size and no divider, three copies of one
        // picture beside two of another read as one run of five.
        //
        // A frame per group rather than an outline per tile, because the
        // question is "which of these are the same", and a border around the
        // set answers it without having to compare five outline colours.
        <div className="flex flex-col gap-3">
          {intoGroups(items).map((group) => (
            <section
              key={group[0]?.dupeGroup ?? `ungrouped:${group[0]?.id}`}
              className="rounded-lg border border-amber-400/25 bg-amber-400/[0.03] p-2"
            >
              <header className="mb-1.5 px-0.5 text-[10px] uppercase tracking-wide text-amber-400/60">
                {group.length === 1 ? '1 copy shown' : `${group.length} copies`}
              </header>
              <div className="flex flex-wrap content-start gap-2">
                {group.map((item) => (
                  <MediaTile
                    key={item.id}
                    item={item}
                    onOpen={handleOpen}
                    showBoxes={showBoxes}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap content-start gap-2">
          {items.map((item) => (
            <MediaTile key={item.id} item={item} onOpen={handleOpen} showBoxes={showBoxes} />
          ))}
        </div>
      )}
      <div ref={sentinelRef} className="h-px w-full" aria-hidden />
    </>
  )
}
