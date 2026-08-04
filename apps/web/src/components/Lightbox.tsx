import {
  dirnameOf,
  displayPath,
  toParameterBlock,
  formatBytes,
  formatDuration,
  hasRecycleBin,
  type MediaFrame,
  type MediaItem,
} from '@luma/core'
import { Button, cn } from '@luma/ui'
import { Fragment, useEffect, useState } from 'react'
import {
  deleteItem,
  fileUrl,
  forgeSelectCheckpoint,
  forgeUrl,
  generationParameters,
  mediaById,
  mediaFrames,
  openExternal,
  revealInFileManager,
  setStars,
} from '#/lib/native.ts'
import { askConfirm, showMessage } from '#/lib/dialogs.ts'

interface LightboxProps {
  mediaId: number
  onClose: () => void
  onStep: (delta: number) => void
  /** Owned by the app, not this component — it is mounted per-item. */
  showBoxes: boolean
  onToggleBoxes: () => void
  /** Given the folder to stop scanning. Closes the lightbox — the item is gone. */
  onExcludeFolder: (folder: string) => void
  /**
   * Owned by the app, like `showBoxes`: stepping through a folder of
   * generations with the panel open should keep it open, not close it on every
   * arrow key.
   */
  showGeneration: boolean
  onToggleGeneration: () => void
  /** Called once the file is gone, so the grid can move on. */
  onDeleted: (id: number) => void
}

export function Lightbox({
  mediaId,
  onClose,
  onStep,
  showBoxes,
  onToggleBoxes,
  onExcludeFolder,
  showGeneration,
  onToggleGeneration,
  onDeleted,
}: LightboxProps) {
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
      // Never while something is being typed into. The search field lives
      // outside the lightbox, but a stray listener that eats digits is the kind
      // of bug that only shows up when someone searches for "00166".
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowRight') onStep(1)
      if (event.key === 'ArrowLeft') onStep(-1)

      // 1-5 rate, 0 clears. Bare keys only: Ctrl-0 resets the browser's zoom
      // and Cmd-1 switches tabs, and stealing either would be worse than not
      // having the shortcut.
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (!item || !/^[0-5]$/.test(event.key)) return
      event.preventDefault()

      const digit = Number(event.key)
      const next = digit === 0 ? null : digit
      if (next === item.stars) return
      // Applied locally first: this is meant to be held down through a folder,
      // and waiting for a round-trip per key makes it feel like it missed.
      setItem({ ...item, stars: next })
      void setStars(item.id, next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onStep, item])

  if (!item) return null

  const verdict = item.verdict
  // Shown rather than the stored path: the index keeps Windows' canonical
  // extended-length form, which nobody can read and nobody can paste anywhere.
  const folder = dirnameOf(displayPath(item.path))
  // The *stored* folder, which is what an exclusion has to be keyed on: the
  // index matches rows by path prefix and the scanner compares against the
  // canonical form it walks. `folder` above is only ever shown to a person.
  const storedFolder = dirnameOf(item.path)
  const panelOpen = Boolean(showGeneration && item.generation)

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/92 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
    >
      <header className="flex items-center gap-3 px-4 py-2 text-xs text-zinc-400">
        {/* The folder truncates, never the filename.
            `truncate` ellipsises the *end* of a string, which on a path throws
            away the only part anyone is looking for. Splitting them means a
            deep path loses its middle and still shows where the file is and
            what it is called. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-1" title={displayPath(item.path)}>
          {folder ? <span className="truncate text-zinc-500">{folder}</span> : null}
          <span className="shrink-0 text-zinc-200">{item.name}</span>
        </span>
        <span className="tabular-nums">
          {item.width}×{item.height}
        </span>
        <span className="tabular-nums">{formatBytes(item.sizeBytes)}</span>
        {item.kind === 'video' ? (
          <span className="tabular-nums">{formatDuration(item.durationSec)}</span>
        ) : null}
        {/* Clicking the star you already have clears it, so there is no
            separate "unrate" control for a five-way choice. */}
        <span
          className="flex items-center gap-0.5"
          role="group"
          aria-label="Rating"
          title="Rate with the number keys: 1-5, or 0 to clear"
        >
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`${value} star${value === 1 ? '' : 's'}`}
              aria-pressed={(item.stars ?? 0) >= value}
              className={cn(
                'px-0.5 text-sm leading-none transition-colors',
                (item.stars ?? 0) >= value
                  ? 'text-amber-300'
                  : 'text-zinc-600 hover:text-zinc-400',
              )}
              onClick={() => {
                const next = item.stars === value ? null : value
                setItem({ ...item, stars: next })
                void setStars(item.id, next)
              }}
            >
              ★
            </button>
          ))}
        </span>

        {/* Only when the file actually says how it was made. A button that is
            always there and usually does nothing teaches people to ignore it. */}
        {item.generation ? (
          <Button
            size="sm"
            onClick={onToggleGeneration}
            title={`Generated with ${item.generation.tool}`}
          >
            {showGeneration ? 'Hide prompt' : 'Prompt'}
          </Button>
        ) : null}
        <Button size="sm" onClick={onToggleBoxes}>
          {showBoxes ? 'Hide boxes' : 'Show boxes'}
        </Button>
        <Button size="sm" onClick={() => void revealInFileManager(item.path)}>
          Reveal
        </Button>
        {/* Here because this is where you find out you want it: you open
            something, see a normal map, and want the whole pack gone. The
            folder is right there on screen and nothing else has to be found. */}
        <Button
          size="sm"
          onClick={() => {
            if (!storedFolder) return
            const message = [
              folder,
              'Its files leave the library. Nothing on disk is deleted, and you can undo this from the sidebar.',
            ].join('\n\n')
            void askConfirm(message, {
              title: 'Stop scanning this folder?',
              confirmLabel: 'Exclude folder',
            }).then((yes) => {
              if (yes) onExcludeFolder(storedFolder)
            })
          }}
          title={folder ? `Exclude ${folder}` : undefined}
        >
          Exclude folder
        </Button>
        {/* Last in the row and styled apart, because it is the one control
            here that changes something outside the app. Everything else in this
            header is a view toggle. */}
        <Button
          size="sm"
          className="text-red-300 hover:bg-red-500/15 hover:text-red-200"
          title={hasRecycleBin(item.path) ? 'Move this file to the Recycle Bin' : 'Delete this file permanently'}
          onClick={() => {
            const id = item.id
            // Windows has no Recycle Bin on a network share, and every file in
            // this library is on one. Promising the bin there would be a lie
            // that costs someone a file, so the question changes instead.
            const recyclable = hasRecycleBin(item.path)
            const message = [
              item.name,
              recyclable
                ? 'It leaves the library immediately. You can restore it from the bin.'
                : 'It is on a network drive, where Windows has no Recycle Bin. This cannot be undone.',
            ].join('\n\n')
            void askConfirm(message, {
              title: recyclable ? 'Move to the Recycle Bin?' : 'Delete permanently?',
              confirmLabel: recyclable ? 'Delete' : 'Delete permanently',
              tone: 'danger',
            }).then((yes) => {
              if (!yes) return
              return deleteItem(id, !recyclable).then(
                () => onDeleted(id),
                (error) => showMessage(String(error), { title: 'Could not delete it' }),
              )
            })
          }}
        >
          Delete
        </Button>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </header>

      {/* `relative` so the prompt panel can float over this row instead of
          taking width from it. */}
      <div className="relative flex min-h-0 flex-1">
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
              ? frames[0].verdict.detections
                  // The anime tagger judges the whole picture, so its findings
                  // carry a frame-filling placeholder box rather than a located
                  // one. Drawing that would put a rectangle round everything and
                  // say nothing; the rating it produced is shown in the footer.
                  .filter((detection) => !detection.label.startsWith('ANIME_'))
                  .map((detection) => (
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
          className={cn(
            'absolute top-1/2 z-20 -translate-y-1/2 rounded-full bg-white/5 px-3 py-6 text-zinc-400 transition-[right] hover:bg-white/10 hover:text-zinc-100',
            // Steps aside for the panel, which overlays this area rather than
            // taking width from it. Left where it is, it would sit underneath.
            panelOpen ? 'right-[21rem]' : 'right-2',
          )}
        >
          ›
        </button>
      </div>

      {/* An overlay, not a column.
          Taking width from the flex row re-laid-out and re-scaled the picture
          every time the panel opened — so the thing you opened the panel to
          compare against moved and changed size underneath you. Floating it
          keeps the image fixed; it covers a strip of the right-hand side, which
          is a far smaller cost than resizing the whole image. */}
      {showGeneration && item.generation ? (
        <aside className="absolute inset-y-0 right-0 z-10 w-80 overflow-y-auto border-l border-white/10 bg-zinc-950/95 p-3 text-[11px] shadow-2xl backdrop-blur-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-zinc-300">{item.generation.tool}</span>
            {item.generation.prompt ? (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(item.generation?.prompt ?? '')
                }}
                className="shrink-0 text-zinc-500 underline decoration-dotted underline-offset-2 hover:text-zinc-300"
              >
                copy
              </button>
            ) : null}
          </div>

          {/* Both paths at once, because only one of them depends on something
              outside this app. The URL fills the tab when the companion
              extension is installed; the clipboard copy is what makes the
              button still worth pressing when it is not. Neither can detect the
              other, so doing both costs nothing and never leaves you with a
              tab and no parameters. */}
          <Button
            size="sm"
            className="mt-2 w-full"
            onClick={() => {
              if (!item.generation) return
              // The file's own text first. `toParameterBlock` rebuilds a block
              // from the seven fields the parser models, which drops schedule
              // type, clip skip, ControlNet and every ADetailer setting — so
              // the regenerated image came out different. It stays only as the
              // fallback for files whose block cannot be re-read.
              const generation = item.generation
              void generationParameters(item.id).then((raw) => {
                const block = raw ?? toParameterBlock(generation)
                void navigator.clipboard?.writeText(block).catch(() => undefined)
                // Select the checkpoint *first*, then open the tab. Forge reads
                // the setting once while building the page, so a checkpoint set
                // afterwards is genuinely selected but leaves the dropdown
                // showing whatever it rendered with — which reads as the button
                // not having worked. Failure here is not fatal: the tab still
                // opens and the block is on the clipboard.
                void forgeSelectCheckpoint(block)
                  .catch((error) => {
                    console.warn('[luma] could not preselect the checkpoint:', error)
                  })
                  .then(() => forgeUrl())
                  .then((base) => {
                    const url = new URL(base)
                    // A fragment, not a query: the block reaches ~6KB encoded,
                    // which crowds request-header limits, and a fragment never
                    // leaves the browser — so the prompt stays out of Forge's log.
                    url.hash = `luma_params=${encodeURIComponent(block)}`
                    void openExternal(url.toString())
                  })
              })
            }}
            title="Opens Forge with these parameters. With the luma-vault-prefill extension installed they fill in automatically; without it, they are on your clipboard — paste into the prompt box and press ↙."
          >
            Open in Forge ↗
          </Button>
          {/* Said plainly, because the failure it describes is invisible: send
              an img2img result to txt2img and you get a *different picture with
              the same description*, which looks like it worked. The button
              still opens Forge — the prompt and settings are worth having — it
              just does not pretend the image can come back. */}
          {item.generation.needsSourceImage ? (
            <p className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-1.5 text-[10px] leading-snug text-amber-200/90">
              <span className="font-medium">Made from another image.</span> These
              parameters describe an img2img pass, so they cannot reproduce it —
              the source image is not recorded in any file, and Forge&rsquo;s own
              PNG&nbsp;Info tab cannot recover it either. The prompt and settings
              still load.
            </p>
          ) : (
            <p className="mt-1 text-[10px] leading-snug text-zinc-600">
              Fills automatically with the prefill extension — otherwise paste and
              press ↙, the parameters are on your clipboard.
            </p>
          )}

          {item.generation.prompt ? (
            // `select-text` because the whole point is getting these words back
            // out — into another tool, or into the same one again.
            <p className="mt-2 select-text whitespace-pre-wrap break-words text-zinc-200">
              {item.generation.prompt}
            </p>
          ) : (
            <p className="mt-2 text-zinc-600">
              No prompt recorded — the file names its generator but not its
              settings.
            </p>
          )}

          {item.generation.negativePrompt ? (
            <>
              <h3 className="mt-3 text-zinc-600">Negative</h3>
              <p className="mt-1 select-text whitespace-pre-wrap break-words text-zinc-400">
                {item.generation.negativePrompt}
              </p>
            </>
          ) : null}

          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-white/5 pt-2 text-zinc-500">
            {(
              [
                ['Model', item.generation.model],
                ['Seed', item.generation.seed],
                ['Sampler', item.generation.sampler],
                ['Steps', item.generation.steps],
                ['CFG', item.generation.cfgScale],
              ] as const
            )
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <Fragment key={label}>
                  <dt>{label}</dt>
                  <dd className="select-text break-words text-zinc-300">{value}</dd>
                </Fragment>
              ))}
          </dl>
        </aside>
      ) : null}
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
