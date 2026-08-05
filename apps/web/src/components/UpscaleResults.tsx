import { Button } from '@luma/ui'
import { useEffect } from 'react'
import { fileUrl, type UpscaleSummary } from '#/lib/native.ts'

interface UpscaleResultsProps {
  summary: UpscaleSummary
  onClose: () => void
}

/**
 * What a batch produced, once it is done.
 *
 * A panel rather than a toast: an upscale is minutes of work over pictures the
 * person chose one by one, and "done" on its own does not answer the question
 * they actually have, which is whether it came out well. So the results are
 * shown, at a size you can judge — the numbers are the caption, not the point.
 */
export function UpscaleResults({ summary, onClose }: UpscaleResultsProps) {
  const each = summary.upscaled > 0 ? summary.seconds / summary.upscaled : 0

  // Escape, a click on the backdrop, and the button. Three ways out rather than
  // one: this panel covers the entire window, so if its single button ever
  // fails to register the app is simply stuck, with no route back to the grid.
  // Every other overlay here already takes Escape, so a person will try it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[90] flex flex-col bg-black/92 backdrop-blur-sm"
      // The target check keeps a click on a result, the header or the scrollbar
      // from closing — only the empty space around them.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <header className="flex items-center gap-3 border-b border-white/5 px-4 py-2 text-xs">
        <span className="font-medium text-zinc-200">
          {summary.upscaled.toLocaleString()} upscaled
        </span>
        {summary.skipped > 0 ? (
          <span className="text-zinc-500" title="A variant already existed beside the original">
            {summary.skipped.toLocaleString()} already had one
          </span>
        ) : null}
        {summary.alreadyLarge > 0 ? (
          <span
            className="text-zinc-500"
            title="Already at or past the target size, so nothing to gain — the model would have produced a copy the mandatory downscale brought straight back to the size it started at."
          >
            {summary.alreadyLarge.toLocaleString()} already 4K
          </span>
        ) : null}
        {summary.failed > 0 ? (
          <span className="text-red-300">{summary.failed.toLocaleString()} failed</span>
        ) : null}

        <span className="ml-auto flex items-center gap-3 tabular-nums text-zinc-500">
          <span title={`${summary.architecture} architecture`}>{summary.model}</span>
          <span>{summary.seconds.toFixed(1)}s total</span>
          <span>{each.toFixed(1)}s each</span>
          <span>{summary.peakVramMb.toLocaleString()}MB peak</span>
        </span>
        <Button size="sm" variant="primary" onClick={onClose} title="Close (Esc)">
          Close
        </Button>
      </header>

      {summary.errors.length > 0 ? (
        <ul className="max-h-24 shrink-0 overflow-y-auto border-b border-red-500/20 bg-red-500/5 px-4 py-2 text-[11px] text-red-200">
          {summary.errors.map((error) => (
            <li key={error} className="break-words">
              {error}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-wrap content-start gap-3">
          {summary.outputs.map((file) => (
            <figure key={file.destination} className="w-52 shrink-0">
              {/* The result itself, not the source. The whole question is what
                  came out, and a thumbnail of the input would answer a
                  different one — these have no thumbnail yet either way, since
                  the scanner has not seen them. */}
              <img
                src={fileUrl(file.destination)}
                alt={file.name}
                loading="lazy"
                decoding="async"
                className="h-52 w-52 rounded-md bg-zinc-800/80 object-cover"
              />
              <figcaption className="mt-1 text-[10px] leading-snug text-zinc-500">
                <span className="block truncate text-zinc-300" title={file.name}>
                  {file.name}
                </span>
                <span className="tabular-nums">
                  {file.sourceWidth}×{file.sourceHeight} → {file.finalWidth}×{file.finalHeight}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>

        {summary.outputs.length === 0 ? (
          <p className="text-xs text-zinc-500">
            Nothing was produced. Every picture selected already had a variant beside it, or
            could not be read.
          </p>
        ) : null}
      </div>

      <footer className="border-t border-white/5 px-4 py-2 text-[11px] text-zinc-500">
        Written beside each original. They join the grid on the next scan of their folder, and
        replace what they were made from once they do.
      </footer>
    </div>
  )
}
