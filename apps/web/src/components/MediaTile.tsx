import {
  displayPath,
  effectiveRating,
  fitWithin,
  folderMatch,
  formatDuration,
  isAnimatedImage,
  isFourK,
  isGif,
  type MediaItem,
} from '@luma/core'
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

/**
 * How wide an animated tile may be drawn when the grid does not say.
 *
 * Animated tiles ignore the size slider and take their own pixel size, so they
 * need a ceiling that the slider no longer provides. Only a backstop — the grid
 * passes its real width — and 1200 comes from the library this was written
 * against: 99% of its 2,396 GIFs are shorter than that on the longest edge, so
 * the cap binds on the two dozen that would otherwise break the wall and on
 * nothing else.
 */
export const MAX_ANIMATED_SIZE = 1200

/** The date on the DeviantArt badge's tooltip. Locale order, no time of day. */
function formatPostedAt(postedAt: number): string {
  return new Date(postedAt).toLocaleDateString()
}

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
  /**
   * Longest edge, in CSS pixels. See {@link DEFAULT_TILE_SIZE}.
   *
   * Animated tiles ignore it — see {@link maxTileWidth}.
   */
  size: number
  /**
   * The widest a tile may be drawn, for the animated ones that ignore `size`.
   *
   * The grid passes its own usable width so that a single oversized GIF cannot
   * push the wall past the window. Defaults to {@link MAX_ANIMATED_SIZE} for
   * callers that have no width to give.
   */
  maxTileWidth?: number
  /** Drawn as picked. Only meaningful while the grid is selecting. */
  selected?: boolean
  /**
   * The folder-search term this tile is a result of, when the grid is in that
   * mode. Empty otherwise, and the overlay is not drawn.
   *
   * A string rather than a precomputed label because the tile is memoized on
   * its props: the term changes once per search, the derivation is a substring
   * scan, and passing an object would give every tile a new prop identity on
   * every render of the grid.
   */
  folderTerm?: string
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
  maxTileWidth = MAX_ANIMATED_SIZE,
  selected = false,
  folderTerm = '',
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

  // Two different questions, and only one of them is this one. Rendering the
  // original is cheap to get wrong — a static WebP drawn from its source looks
  // the same — so it takes the generous test above. Ignoring the size slider is
  // not: on the generous test every static WebP in the library would take a
  // cell the slider cannot reach.
  const naturalSize = item.kind === 'image' && isGif(item.path)

  // Measured from whichever file will actually be drawn: the source for an
  // animated tile, the thumbnail otherwise — falling back to the source while
  // one is still being made, so a mid-scan tile still gets a correctly-shaped
  // placeholder. The two agree on aspect ratio, but not on pixels, and pixels
  // are what an animated tile is sized in.
  const intrinsicWidth = (naturalSize ? item.width : (item.thumbWidth ?? item.width)) || 1
  const intrinsicHeight = (naturalSize ? item.height : (item.thumbHeight ?? item.height)) || 1

  // A GIF ignores the size slider and is drawn at its own pixel size.
  // Shrinking an animation into a uniform cell is what a thumbnail already
  // does; the whole reason this tile renders the original instead is to see the
  // file as it is, and in the library this was written against 44% of GIFs are
  // larger than the default cell.
  //
  // Costs no memory that was not already being spent: the original is fetched
  // and decoded either way, and CSS size does not change decode size. This is a
  // layout change, not a load one.
  //
  // The cap is a guard rail rather than a layout. Tiles are `shrink-0`, so one
  // 2508px-wide GIF would push the wall past the window and give the whole page
  // a horizontal scrollbar — one file spoiling every other. Clamping the
  // *longest* edge is what keeps a tall picture inside it too: 2508x3456 capped
  // at 1200 comes out 871 wide.
  const bound = naturalSize
    ? Math.min(Math.max(intrinsicWidth, intrinsicHeight), maxTileWidth)
    : size
  const { width, height } = fitWithin(intrinsicWidth, intrinsicHeight, bound)

  const verdict = item.verdict
  const rating = effectiveRating(item)
  // Why this tile is in these results. Only in folder-search mode, where the
  // reason is in a path the tile otherwise shows nothing of — the picture and
  // its filename both look the same whether the folder matched or not.
  const folderHit = folderTerm ? folderMatch(item.path, folderTerm) : null
  const isVideo = item.kind === 'video'
  // The source's own size, never the thumbnail's — the badge is a claim about
  // the file, and every thumbnail in the library is 512px.
  const fourK = isFourK(item.width, item.height)
  // Clamped rather than trusted: `stars` is a nullable number on the wire, and
  // `'★'.repeat(n)` throws on a negative and hangs the tile on a large one.
  const stars = Math.min(5, Math.max(0, Math.round(item.stars ?? 0)))

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

          {/* Bottom-left, stacked, and each part only as wide as it needs to
              be: the picture is what the grid is for, and a full-width bar
              over every tile at once would cost more of it than the answers
              are worth. Stacked rather than side by side because the folder
              path truncates to the tile width and would leave the score no
              room at all. */}
          {folderHit || stars ? (
            <span className="pointer-events-none absolute bottom-1 left-1 flex max-w-[calc(100%-0.5rem)] flex-col items-start gap-1">
              {/* The matched run is picked out inside the surrounding path,
                  because the path is context and the match is the point. */}
              {folderHit ? (
                <span
                  className="max-w-full truncate rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] leading-none text-zinc-300"
                  title={displayPath(item.path)}
                >
                  {folderHit.text.slice(0, folderHit.from)}
                  <span className="rounded-sm bg-indigo-500/40 text-indigo-100">
                    {folderHit.text.slice(folderHit.from, folderHit.to)}
                  </span>
                  {folderHit.text.slice(folderHit.to)}
                </span>
              ) : null}

              {/* The score. Filled stars only, and nothing at all when unrated:
                  drawing the empty ones would make it a widget on every tile in
                  the grid, where what is wanted is a glance. A shadow rather
                  than the black pill the other badges wear — the pill is what
                  makes them read as badges, and this one should sit under the
                  picture rather than on top of it. Indented past the selection
                  tick, which shares this corner. */}
              {stars > 0 ? (
                <span
                  className={cn(
                    // 13px against the badges' 10px, which is not the
                    // inconsistency it looks like: a star glyph carries far
                    // less ink than a latin glyph at the same size, so matching
                    // the number would leave it visibly smaller than everything
                    // around it.
                    'text-[13px] leading-none tracking-tight text-amber-300/85',
                    '[text-shadow:0_1px_2px_rgb(0_0_0/0.95)]',
                    selected && 'ml-5',
                  )}
                  aria-label={`${stars} of 5 stars`}
                  title={`${stars} of 5 stars`}
                >
                  {'★'.repeat(stars)}
                </span>
              ) : null}
            </span>
          ) : null}

          {showBoxes && verdict?.sexy
            ? verdict.topLabel && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/70 px-1.5 py-0.5 text-[10px] text-amber-200">
                  {verdict.topLabelTitle} · {Math.round(verdict.topScore * 100)}%
                </span>
              )
            : null}

          {/* One row, so a 4K video does not stack two badges on one corner. */}
          {isVideo ||
          fourK ||
          item.generation?.needsSourceImage ||
          item.generation?.postprocessed ||
          item.deviantArt ? (
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
              {/* Already on DeviantArt. Solid green once it is public; hollow
                  while it is only staged, which means there is something
                  waiting in Studio rather than something finished. */}
              {item.deviantArt ? (
                <span
                  className={cn(
                    'rounded px-1 py-0.5 text-[10px] font-semibold tracking-wide',
                    item.deviantArt.published
                      ? 'bg-emerald-500/90 text-black'
                      : 'bg-black/70 text-emerald-300 ring-1 ring-inset ring-emerald-400/60',
                  )}
                  title={
                    item.deviantArt.published
                      ? `Posted to DeviantArt on ${formatPostedAt(item.deviantArt.postedAt)}`
                      : `Uploaded to Sta.sh on ${formatPostedAt(item.deviantArt.postedAt)} — not posted yet, it is waiting in your Studio`
                  }
                >
                  d
                </span>
              ) : null}
            </span>
          ) : null}

          {/* The effective rating, so a correction made in the lightbox shows
              on the tile too. Reading `verdict.rating` here would leave a
              corrected picture wearing a red dot while the grid files it as
              safe — the dot and the filter disagreeing about the same row. */}
          {rating === 'explicit' ? (
            <span
              className="pointer-events-none absolute right-1.5 top-1.5 size-2 rounded-full bg-red-400"
              title={item.ratingOverride ? 'explicit — your correction' : 'explicit'}
            />
          ) : rating === 'suggestive' ? (
            <span
              className="pointer-events-none absolute right-1.5 top-1.5 size-2 rounded-full bg-amber-400"
              title={item.ratingOverride ? 'suggestive — your correction' : 'suggestive'}
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
