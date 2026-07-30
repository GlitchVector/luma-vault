import { fitWithin, formatDuration, type MediaItem } from '@luma/core'
import { useEffect, useState } from 'react'
import { fileUrl, recentMedia } from '#/lib/native.ts'

const STRIP_HEIGHT = 96

interface RecentStripProps {
  /** Bumping this refetches — the caller raises it when a scan finishes. */
  revision: number
  onOpen: (id: number) => void
}

/**
 * Newest arrivals, pinned above the grid.
 *
 * This exists because the main grid is sorted by *file* time, so a folder full
 * of decade-old photos added today would scatter its contents throughout the
 * wall with nothing to show for the scan you just watched run. The strip sorts
 * by when the vault first saw a file, which answers the question you actually
 * have after a scan: what just came in?
 */
export function RecentStrip({ revision, onOpen }: RecentStripProps) {
  const [items, setItems] = useState<MediaItem[]>([])

  useEffect(() => {
    let cancelled = false
    void recentMedia(40).then((next) => {
      if (!cancelled) setItems(next)
    })
    return () => {
      cancelled = true
    }
  }, [revision])

  if (items.length === 0) return null

  return (
    <section className="border-b border-white/5 px-4 py-3">
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        Recently added
      </h2>
      {/* A single scrolling row rather than a wrapping grid: this is a glance,
          not a browse. The main grid below is where browsing happens. */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {items.map((item) => {
          const { width } = fitWithin(
            item.thumbWidth ?? item.width ?? 1,
            item.thumbHeight ?? item.height ?? 1,
            STRIP_HEIGHT,
          )
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item.id)}
              title={item.name}
              style={{ width, height: STRIP_HEIGHT }}
              className="relative shrink-0 overflow-hidden rounded bg-zinc-800/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
            >
              {item.thumbPath ? (
                <img
                  src={fileUrl(item.thumbPath)}
                  alt={item.name}
                  decoding="async"
                  className="size-full object-cover"
                  draggable={false}
                />
              ) : null}
              {item.kind === 'video' ? (
                <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 px-1 py-px text-[9px] tabular-nums text-zinc-100">
                  {formatDuration(item.durationSec)}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </section>
  )
}
