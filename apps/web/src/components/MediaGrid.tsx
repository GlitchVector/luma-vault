import type { MediaItem } from '@luma/core'
import { useCallback, useEffect, useRef } from 'react'
import { MediaTile } from './MediaTile.tsx'

interface MediaGridProps {
  items: MediaItem[]
  onOpen: (id: number) => void
  onReachEnd: () => void
  showBoxes: boolean
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
export function MediaGrid({ items, onOpen, onReachEnd, showBoxes }: MediaGridProps) {
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
      <div className="flex flex-wrap content-start gap-2">
        {items.map((item) => (
          <MediaTile key={item.id} item={item} onOpen={handleOpen} showBoxes={showBoxes} />
        ))}
      </div>
      <div ref={sentinelRef} className="h-px w-full" aria-hidden />
    </>
  )
}
