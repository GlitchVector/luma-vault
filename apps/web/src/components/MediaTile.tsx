import { fitWithin, formatDuration, isAnimatedImage, isFourK, type MediaItem } from '@luma/core'
import { cn } from '@luma/ui'
import { memo } from 'react'
import { fileUrl } from '#/lib/native.ts'
import { useInView } from '#/lib/useInView.ts'

/** Longest edge of a tile, in CSS pixels. Tiles never exceed this in either axis. */
export const DEFAULT_TILE_SIZE = 260

/**
 * How small tiles may go.
 *
 * Not a taste limit — a memory one. Every mounted tile decodes the same 512px
 * thumbnail whatever size it is drawn at, so halving the tile roughly
 * quadruples how many are in view and therefore how many bitmaps are resident.
 * At 140 a wide window holds around a hundred, which is the point where that
 * stops being free.
 */
export const MIN_TILE_SIZE = 140

/** How large. Past this a "grid" is a single column of pictures. */
export const MAX_TILE_SIZE = 480

interface MediaTileProps {
  item: MediaItem
  /**
   * Clicked.
   *
   * `range` is the shift key, passed on rather than acted on here: a tile knows
   * nothing about what came before it, and "everything between" is a question
   * only the list can answer.
   */
  onOpen: (id: number, range: boolean) => void
  showBoxes: boolean
  /** Longest edge, in CSS pixels. See {@link DEFAULT_TILE_SIZE}. */
  size: number
  /** Drawn as picked. Only meaningful while the grid is selecting. */
  selected?: boolean
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
export const MediaTile = memo(function MediaTile({
  item,
  onOpen,
  showBoxes,
  size,
  selected = false,
}: MediaTileProps) {
  const { ref, inView } = useInView()

  // Prefer the thumbnail. Animated images are the one exception: a still
  // thumbnail would throw away the animation, which for a GIF library is the
  // entire point of the file.
  //
  // No thumbnail yet means **no `<img>` at all**, never the original. Falling
  // back to the full-resolution source is the specific mistake the previous
  // generation of this app made — see the module note in `thumbs.rs`. It is
  // invisible on a scanned library and fatal on a scanning one: with 64,000 of
  // 66,000 rows still awaiting a thumbnail, the grid points at 3072x4608
  // originals, each ~56MB once decoded. A screenful is over a gigabyte and
  // scrolling kills the webview outright — Chromium raises its OOM exception
  // (0xE0000008) and takes the whole app down with it.
  //
  // The wrapper is sized from the index either way, so a tile waiting for its
  // thumbnail looks exactly like an offscreen one and the layout never shifts.
  const animated = item.kind === 'image' && isAnimatedImage(item.path)
  const source = animated ? item.path : item.thumbPath

  // Fall back to the source dimensions when a thumbnail has not been generated
  // yet, so a mid-scan tile still gets a correctly-shaped placeholder.
  const intrinsicWidth = item.thumbWidth ?? item.width
  const intrinsicHeight = item.thumbHeight ?? item.height
  const { width, height } = fitWithin(intrinsicWidth || 1, intrinsicHeight || 1, size)

  const verdict = item.verdict
  const isVideo = item.kind === 'video'
  // The source's own size, never the thumbnail's — the badge is a claim about
  // the file, and every thumbnail in the library is 512px.
  const fourK = isFourK(item.width, item.height)

  return (
    <button
      type="button"
      ref={ref}
      onClick={(event) => onOpen(item.id, event.shiftKey)}
      style={{ width, height }}
      title={item.name}
      aria-pressed={selected || undefined}
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-md bg-zinc-800/80',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400',
        // An inset ring rather than an outline: the grid packs tiles two
        // pixels apart, and anything drawn outside the box would overlap the
        // neighbour and read as though both were picked.
        selected && 'ring-2 ring-inset ring-indigo-400',
      )}
    >
      {selected ? (
        <span className="pointer-events-none absolute inset-0 z-10 bg-indigo-500/25" />
      ) : null}
      {selected ? (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 grid size-4 place-items-center rounded-full bg-indigo-500 text-[10px] font-bold leading-none text-white">
          ✓
        </span>
      ) : null}

      {inView ? (
        <>
          {source ? (
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
          ) : null}

          {showBoxes && verdict?.sexy
            ? verdict.topLabel && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/70 px-1.5 py-0.5 text-[10px] text-amber-200">
                  {verdict.topLabelTitle} · {Math.round(verdict.topScore * 100)}%
                </span>
              )
            : null}

          {/* One row, so a 4K video does not stack two badges on one corner. */}
          {isVideo || fourK || item.generation?.needsSourceImage || item.generation?.postprocessed ? (
            <span className="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
              {isVideo ? (
                <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-zinc-100">
                  {formatDuration(item.durationSec)}
                </span>
              ) : null}
              {fourK ? (
                <span
                  className="rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold tracking-wide text-zinc-100"
                  title={`${item.width}×${item.height}`}
                >
                  4K
                </span>
              ) : null}
              {item.generation?.needsSourceImage ? (
                <span
                  className="rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold tracking-wide text-amber-200/90"
                  title="Made from another image — its parameters alone cannot reproduce it"
                >
                  i2i
                </span>
              ) : null}
              {item.generation?.postprocessed ? (
                <span
                  className="rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold tracking-wide text-sky-200/90"
                  title="Upscaled in the Extras tab — an existing image, resized"
                >
                  e
                </span>
              ) : null}
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
