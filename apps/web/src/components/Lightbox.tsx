import {
  formatBytes,
  formatDuration,
  type MediaFrame,
  type MediaItem,
} from '@luma/core'
import { Button, cn } from '@luma/ui'
import { useEffect, useState } from 'react'
import { fileUrl, mediaById, mediaFrames, revealInFileManager } from '#/lib/native.ts'

interface LightboxProps {
  mediaId: number
  onClose: () => void
  onStep: (delta: number) => void
  /** Owned by the app, not this component — it is mounted per-item. */
  showBoxes: boolean
  onToggleBoxes: () => void
}

export function Lightbox({ mediaId, onClose, onStep, showBoxes, onToggleBoxes }: LightboxProps) {
  const [item, setItem] = useState<MediaItem | null>(null)
  const [frames, setFrames] = useState<MediaFrame[]>([])

  useEffect(() => {
    let cancelled = false
    setItem(null)
    setFrames([])

    void mediaById(mediaId).then((next) => {
      if (!cancelled) setItem(next)
    })
    void mediaFrames(mediaId).then((next) => {
      if (!cancelled) setFrames(next)
    })

    return () => {
      cancelled = true
    }
  }, [mediaId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowRight') onStep(1)
      if (event.key === 'ArrowLeft') onStep(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onStep])

  if (!item) return null

  const verdict = item.verdict

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/92 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
    >
      <header className="flex items-center gap-3 px-4 py-2 text-xs text-zinc-400">
        <span className="min-w-0 flex-1 truncate text-zinc-200" title={item.path}>
          {item.name}
        </span>
        <span className="tabular-nums">
          {item.width}×{item.height}
        </span>
        <span className="tabular-nums">{formatBytes(item.sizeBytes)}</span>
        {item.kind === 'video' ? (
          <span className="tabular-nums">{formatDuration(item.durationSec)}</span>
        ) : null}
        <Button size="sm" onClick={onToggleBoxes}>
          {showBoxes ? 'Hide boxes' : 'Show boxes'}
        </Button>
        <Button size="sm" onClick={() => void revealInFileManager(item.path)}>
          Reveal
        </Button>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </header>

      {/* Clicking the backdrop closes. `onClick` on this container rather than
          the overlay root so the header's buttons are not covered, and the
          target check rather than a bare handler so a click that lands on the
          image, the video, a nav arrow or a detection box does not close it —
          only one that hits the empty space around them. */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        {item.kind === 'video' ? (
          // The original file streams straight through the protocol handler;
          // there is no transcode step and no temporary file.
          <video
            key={item.id}
            src={fileUrl(item.path)}
            controls
            autoPlay
            className="max-h-full max-w-full rounded"
          />
        ) : (
          <div className="relative inline-block max-h-full max-w-full">
            <img
              src={fileUrl(item.path)}
              alt={item.name}
              className="max-h-[calc(100vh-9rem)] max-w-full rounded object-contain"
            />
            {/* Boxes are stored as fractions of the classified image, so they
                scale to whatever size the browser chose here with no ratio
                bookkeeping. */}
            {showBoxes && frames[0]
              ? frames[0].verdict.detections.map((detection) => (
                  <span
                    // Position, not array index: detections are stored in a
                    // total order, so this key is stable across re-classification
                    // while an index would silently reuse a box's identity.
                    key={`${detection.label}@${detection.box[0]},${detection.box[1]}`}
                    className="pointer-events-none absolute border border-amber-400/80"
                    style={{
                      left: `${detection.box[0] * 100}%`,
                      top: `${detection.box[1] * 100}%`,
                      width: `${detection.box[2] * 100}%`,
                      height: `${detection.box[3] * 100}%`,
                    }}
                  >
                    {/* The raw label, not the friendly title: a box overlay is a
                        diagnostic view, and `FEMALE_GENITALIA_COVERED 49%` says
                        exactly why a file rated the way it did. Sits above the
                        box, except near the top edge where it would be clipped
                        out of the image and is tucked inside instead. */}
                    <span
                      className="absolute left-0 whitespace-nowrap rounded-sm bg-amber-400/90 px-1 text-[10px] font-medium leading-snug text-black"
                      style={
                        detection.box[1] < 0.05
                          ? { top: 0 }
                          : { bottom: '100%', marginBottom: '1px' }
                      }
                    >
                      {detection.label} {Math.round(detection.score * 100)}%
                    </span>
                  </span>
                ))
              : null}
          </div>
        )}

        <button
          type="button"
          onClick={() => onStep(-1)}
          aria-label="Previous"
          className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/5 px-3 py-6 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => onStep(1)}
          aria-label="Next"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/5 px-3 py-6 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        >
          ›
        </button>
      </div>

      <footer className="border-t border-white/5 px-4 py-2">
        {verdict ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
            <span
              className={cn(
                'rounded-full px-2 py-0.5 font-medium',
                verdict.rating === 'explicit' && 'bg-red-500/20 text-red-300',
                verdict.rating === 'suggestive' && 'bg-amber-500/20 text-amber-300',
                verdict.rating === 'sfw' && 'bg-emerald-500/15 text-emerald-300',
                verdict.rating === 'unrated' && 'bg-white/10 text-zinc-400',
              )}
            >
              {verdict.rating}
            </span>
            {verdict.topLabelTitle ? (
              <span>
                {verdict.topLabelTitle} · {Math.round(verdict.topScore * 100)}%
              </span>
            ) : null}
            {item.kind === 'video' ? (
              <span>
                {verdict.sexyFrameCount} of {verdict.frameCount} sampled frames flagged
              </span>
            ) : null}
          </div>
        ) : (
          <p className="text-[11px] text-zinc-500">Not classified yet.</p>
        )}

        {/* The frame timeline doubles as an explanation: you can see exactly
            which sampled moments earned the video its rating. */}
        {item.kind === 'video' && frames.length > 0 ? (
          <div className="mt-2 flex gap-px overflow-x-auto">
            {frames.map((frame) => (
              <span
                key={frame.id}
                title={`${formatDuration(frame.timestampSec)} — ${frame.verdict.rating}`}
                className={cn(
                  'h-4 min-w-1.5 flex-1 rounded-sm',
                  frame.verdict.rating === 'explicit' && 'bg-red-400/80',
                  frame.verdict.rating === 'suggestive' && 'bg-amber-400/80',
                  frame.verdict.rating === 'sfw' && 'bg-zinc-700',
                  frame.verdict.rating === 'unrated' && 'bg-zinc-800',
                )}
              />
            ))}
          </div>
        ) : null}
      </footer>
    </div>
  )
}
