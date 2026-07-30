import { fitWithin, formatDuration, isAnimatedImage, type MediaItem } from '@luma/core'
import { cn } from '@luma/ui'
import { memo } from 'react'
import { fileUrl } from '#/lib/native.ts'
import { useInView } from '#/lib/useInView.ts'

/** Longest edge of a tile, in CSS pixels. Tiles never exceed this in either axis. */
export const TILE_SIZE = 260

interface MediaTileProps {
  item: MediaItem
  onOpen: (id: number) => void
  showBoxes: boolean
}

/**
 * One cell of the grid.
 *
 * Two things make this fast, and they are both structural rather than clever:
 *
 * 1. **The wrapper is sized before anything loads.** Width and height come from
 *    the index, which recorded them at scan time. The whole wall therefore lays
 *    out in a single pass and nothing shifts as images arrive — no cumulative
 *    layout shift, no scroll anchoring fighting the user.
 *
 * 2. **The `<img>` is mounted, not just `src`-swapped.** Offscreen tiles are an
 *    empty sized `<div>`. Ten thousand empty divs are cheap; ten thousand
 *    decoded bitmaps are not. Because the wrapper keeps its size either way,
 *    unmounting is invisible. This is what lets the grid render an entire
 *    directory without virtualization.
 *
 * `memo` is not decoration here: without it, every parent state change — a
 * filter toggle, a progress event arriving four times a second during a scan —
 * re-renders every tile in the list.
 */
export const MediaTile = memo(function MediaTile({ item, onOpen, showBoxes }: MediaTileProps) {
  const { ref, inView } = useInView()

  // Prefer the thumbnail. Animated images are the one exception: a still
  // thumbnail would throw away the animation, which for a GIF library is the
  // entire point of the file.
  const animated = item.kind === 'image' && isAnimatedImage(item.path)
  const source = animated ? item.path : (item.thumbPath ?? item.path)

  // Fall back to the source dimensions when a thumbnail has not been generated
  // yet, so a mid-scan tile still gets a correctly-shaped placeholder.
  const intrinsicWidth = item.thumbWidth ?? item.width
  const intrinsicHeight = item.thumbHeight ?? item.height
  const { width, height } = fitWithin(intrinsicWidth || 1, intrinsicHeight || 1, TILE_SIZE)

  const verdict = item.verdict
  const isVideo = item.kind === 'video'

  return (
    <button
      type="button"
      ref={ref}
      onClick={() => onOpen(item.id)}
      style={{ width, height }}
      title={item.name}
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-md bg-zinc-800/80',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400',
      )}
    >
      {inView ? (
        <>
          <img
            src={fileUrl(source)}
            alt={item.name}
            width={width}
            height={height}
            // Async decode keeps a large JPEG off the main thread; the browser
            // paints the placeholder until it is ready rather than janking.
            decoding="async"
            className="size-full object-cover"
            draggable={false}
          />

          {showBoxes && verdict?.sexy
            ? verdict.topLabel && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/70 px-1.5 py-0.5 text-[10px] text-amber-200">
                  {verdict.topLabelTitle} · {Math.round(verdict.topScore * 100)}%
                </span>
              )
            : null}

          {isVideo ? (
            <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-zinc-100">
              {formatDuration(item.durationSec)}
            </span>
          ) : null}

          {verdict?.rating === 'explicit' ? (
            <span
              className="pointer-events-none absolute right-1.5 top-1.5 size-2 rounded-full bg-red-400"
              title="explicit"
            />
          ) : verdict?.rating === 'suggestive' ? (
            <span
              className="pointer-events-none absolute right-1.5 top-1.5 size-2 rounded-full bg-amber-400"
              title="suggestive"
            />
          ) : verdict === null ? (
            <span
              className="pointer-events-none absolute right-1.5 top-1.5 size-2 rounded-full bg-zinc-500"
              title="not classified yet"
            />
          ) : null}
        </>
      ) : null}
    </button>
  )
})
