import {
  clampView,
  dirnameOf,
  displayPath,
  fitInside,
  fitView,
  isOverPicture,
  isZoomed,
  toParameterBlock,
  formatBytes,
  formatDuration,
  hasRecycleBin,
  zoomAbout,
  type MediaFrame,
  type MediaItem,
  type View,
} from '@luma/core'
import { Button, cn } from '@luma/ui'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteItem,
  fileUrl,
  forgeSelectCheckpoint,
  forgeUrl,
  generationParameters,
  mediaById,
  mediaByPath,
  mediaFrames,
  openExternal,
  revealInFileManager,
  setStars,
} from '#/lib/native.ts'
import { askConfirm, showMessage } from '#/lib/dialogs.ts'
import { preloadImages } from '#/lib/preload.ts'

/**
 * How long a row has to stay on screen before its original is fetched.
 *
 * Arrowing through a folder passes over rows on the way to the one you want. At
 * full resolution every one of those is a multi-megabyte read for the protocol
 * handler to serve and the webview to decode, and they queue — so by the time
 * you stop, the picture you are actually looking at is waiting behind every
 * original you skipped. Holding off means a row passed through costs nothing,
 * and the thumbnail is already on screen while the wait runs.
 *
 * 150ms sits between a deliberate step and a held-down arrow key: stop on
 * something and the original is already on its way before you have focused on
 * it, but sweep past and it is never asked for at all.
 */
const ORIGINAL_DELAY_MS = 150

/**
 * How much one wheel notch magnifies.
 *
 * Small enough that a zoom is something you arrive at rather than land on —
 * doubling per notch overshoots the interesting range in two flicks.
 */
const ZOOM_STEP = 1.15

/**
 * How far the pointer may travel and still count as a click, in pixels.
 *
 * The same gesture starts both panning and zooming, so they are told apart by
 * whether the pointer actually went anywhere. Zero would make a click almost
 * impossible to perform — a mouse moves a pixel or two under a normal press.
 */
const CLICK_SLOP = 4

interface LightboxProps {
  mediaId: number
  /**
   * The grid's own copy of the open row, which it already has.
   *
   * Shown straight away while the full record is fetched. Without it a step
   * blanks the lightbox for a round-trip — `mediaById` has to answer before
   * there is anything at all to draw, including the thumbnail this component
   * leans on to feel instant.
   */
  seed: MediaItem | null
  /**
   * Thumbnail paths for the rows either side, fetched while this one is up.
   *
   * Must be referentially stable across renders that do not change it, or the
   * warming effect re-runs on every keystroke and progress tick.
   */
  preload: readonly string[]
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
  /**
   * Pick this row for the grid's selection, without leaving the lightbox.
   *
   * The point of doing it from here: reviewing a folder is one pass, and
   * stopping to close the lightbox, find the tile and click it turns a
   * judgement into an errand.
   */
  onToggleSelect: (id: number) => void
  /**
   * Show a different row, by id.
   *
   * Distinct from `onStep`, which walks the filtered list. This reaches a
   * picture that is deliberately *not* in it — the original behind an
   * upscaled variant.
   */
  onOpenId: (id: number) => void
}

export function Lightbox({
  mediaId,
  seed,
  preload,
  onClose,
  onStep,
  showBoxes,
  onToggleBoxes,
  onExcludeFolder,
  showGeneration,
  onToggleGeneration,
  onDeleted,
  onOpenId,
  onToggleSelect,
}: LightboxProps) {
  const [fetched, setFetched] = useState<MediaItem | null>(null)
  const [frames, setFrames] = useState<MediaFrame[]>([])
  // The element the picture has to fit inside, measured rather than assumed.
  // Deriving it from the window would mean restating the header and footer
  // heights here and keeping the two in step; measuring what actually holds it
  // cannot drift.
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null)
  // Whether the original has been asked for yet — see `ORIGINAL_DELAY_MS`.
  const [showOriginal, setShowOriginal] = useState(false)
  // The pan/zoom, or null while the whole picture is being shown. Null rather
  // than the equivalent fitted view so that a window resize re-fits: an
  // explicit view is a place the user chose and is kept, a null one is not.
  const [zoom, setZoom] = useState<View | null>(null)
  // Live drag state. A ref because it changes on every pointer event and none
  // of it belongs on screen — putting it in state would re-render the picture
  // for each mouse move.
  const drag = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    travelled: number
  } | null>(null)
  const [panning, setPanning] = useState(false)
  // Set when a rating is applied locally, so a reply that was already in flight
  // when the key was pressed cannot undo it.
  const rated = useRef(false)

  useEffect(() => {
    let cancelled = false
    rated.current = false
    // Frames are what the detection boxes are drawn from, so the previous row's
    // must go immediately — stale boxes over a new picture point at nothing.
    setFrames([])

    void mediaById(mediaId).then((next) => {
      if (!cancelled && !rated.current) setFetched(next)
    })
    void mediaFrames(mediaId).then((next) => {
      if (!cancelled) setFrames(next)
    })

    return () => {
      cancelled = true
    }
  }, [mediaId])

  // Hold the original back until the row has been looked at for a moment.
  useEffect(() => {
    setShowOriginal(false)
    // Back to fitting on every step. A pan is a position in *this* picture;
    // carrying it to the next one lands you on an arbitrary corner of a
    // different image, with no way to tell that is what happened.
    setZoom(null)
    const timer = setTimeout(() => setShowOriginal(true), ORIGINAL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [mediaId])

  // Warm the neighbours' thumbnails while this row is on screen. Two forwards
  // and one back: stepping is overwhelmingly forwards, and the one backwards
  // covers an overshoot, which is the other thing an arrow key does.
  useEffect(() => {
    preloadImages(preload.map(fileUrl))
  }, [preload])

  useEffect(() => {
    if (!stage || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setStageSize({ width: box.width, height: box.height })
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [stage])

  // `fetched` is preferred only once it is for the row actually on screen: a
  // reply for the row you already stepped past must not replace the one you are
  // looking at. Until it arrives the grid's copy carries the render, which is
  // what lets a step paint on the frame the key was pressed.
  const item = fetched?.id === mediaId ? fetched : seed?.id === mediaId ? seed : null

  // Alt-wheel zooms. A native listener rather than React's `onWheel` because
  // this one has to `preventDefault`, and a passive listener cannot — without
  // it the webview scrolls the page behind the overlay while zooming.
  const naturalWidth = item?.width ?? 0
  const naturalHeight = item?.height ?? 0
  const stageWidth = stageSize?.width ?? 0
  const stageHeight = stageSize?.height ?? 0

  useEffect(() => {
    if (!stage || naturalWidth <= 0 || stageWidth <= 0) return
    const natural = { width: naturalWidth, height: naturalHeight }
    const viewport = { width: stageWidth, height: stageHeight }

    const onWheel = (event: WheelEvent) => {
      // Bare wheel is left alone. Alt is what the user asked for, and claiming
      // the undecorated wheel would take a gesture the page may want later.
      if (!event.altKey) return
      event.preventDefault()

      const rect = stage.getBoundingClientRect()
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      // Sign only. Trackpads report deltas in the hundreds and mice in
      // multiples of 100, so scaling by the magnitude makes one notch mean
      // something different on every device.
      const factor = ZOOM_STEP ** -Math.sign(event.deltaY)

      setZoom((current) => {
        const from = current ?? fitView(natural, viewport)
        const next = zoomAbout(from, natural, viewport, from.scale * factor, at)
        // Back to null at the bottom of the range, so the picture re-fits on a
        // resize again and the cursor stops offering a pan that cannot move.
        return isZoomed(next, natural, viewport) ? next : null
      })
      setShowOriginal(true)
    }

    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [stage, naturalWidth, naturalHeight, stageWidth, stageHeight])

  // Shared by the Delete button and the Delete key, so the two cannot drift
  // into asking differently about the same irreversible thing.
  const confirmDelete = useCallback(() => {
    if (!item) return
    const id = item.id
    // Windows has no Recycle Bin on a network share, and every file in this
    // library is on one. Promising the bin there would be a lie that costs
    // someone a file, so the question changes instead.
    const recyclable = hasRecycleBin(item.path)
    const message = [
      item.name,
      recyclable
        ? 'It leaves the library immediately. You can restore it from the bin.'
        : 'It is on a network drive, where Windows has no Recycle Bin. This cannot be undone.',
    ].join('\n\n')

    return askConfirm(message, {
      title: recyclable ? 'Move to the Recycle Bin?' : 'Delete permanently?',
      confirmLabel: recyclable ? 'Delete' : 'Delete permanently',
      tone: 'danger',
      // Delete again answers it. The dialog swallows keys in the capture phase,
      // so while it is up this is the only thing Delete can reach.
      confirmKeys: ['Delete'],
    }).then((yes) => {
      if (!yes) return
      return deleteItem(id, !recyclable).then(
        () => onDeleted(id),
        (error) => showMessage(String(error), { title: 'Could not delete it' }),
      )
    })
  }, [item, onDeleted])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Never while something is being typed into. The search field lives
      // outside the lightbox, but a stray listener that eats digits is the kind
      // of bug that only shows up when someone searches for "00166".
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      // Escape leaves the zoom before it leaves the picture. Closing outright
      // from a zoom would lose your place in the grid to a keypress that was
      // only meant to undo the last thing you did; a second press still closes.
      if (event.key === 'Escape') {
        if (zoom) setZoom(null)
        else onClose()
      }
      if (event.key === 'ArrowRight') onStep(1)
      if (event.key === 'ArrowLeft') onStep(-1)

      // Up rates, down picks. Both are one-handed on the same key cluster as
      // the arrows that step, because the whole point is going through a
      // folder without moving your hand: look, judge, move on.
      //
      // Four rather than five for Up: five is a favourite and deserves a
      // deliberate keypress, while four is "this one is good" — the
      // judgement you make dozens of times in a pass.
      if (event.key === 'ArrowUp' && item) {
        event.preventDefault()
        rated.current = true
        setFetched({ ...item, stars: 4 })
        void setStars(item.id, 4)
        // On to the next, like the pick below it. Both keys mean "I have decided
        // about this one", and the decision is nearly always followed by moving
        // on — so the pass stays a single repeated key whichever you press.
        // Adjusting a rating you have just given is what 1-5 are for, and they
        // deliberately stay put.
        onStep(1)
        return
      }
      if (event.key === 'ArrowDown' && item) {
        event.preventDefault()
        onToggleSelect(item.id)
        // And on to the next one. Picking is nearly always followed by moving
        // on, so a pass through a folder becomes one key rather than two —
        // which is the difference between reviewing three hundred pictures and
        // deciding not to. Still a toggle: come back to one already picked and
        // the same key takes it out again.
        onStep(1)
        return
      }

      // Bare keys only from here down: Ctrl-0 resets the browser's zoom and
      // Cmd-1 switches tabs, and stealing either would be worse than not having
      // the shortcut.
      if (event.ctrlKey || event.metaKey || event.altKey) return

      // Delete asks the same question the button does. Auto-repeat is ignored
      // so holding the key cannot open a question and answer it in one gesture.
      if (event.key === 'Delete') {
        if (event.repeat) return
        event.preventDefault()
        void confirmDelete()
        return
      }

      // 1-5 rate, 0 clears.
      if (!item || !/^[0-5]$/.test(event.key)) return
      event.preventDefault()

      const digit = Number(event.key)
      const next = digit === 0 ? null : digit
      if (next === item.stars) return
      // Applied locally first: this is meant to be held down through a folder,
      // and waiting for a round-trip per key makes it feel like it missed.
      rated.current = true
      setFetched({ ...item, stars: next })
      void setStars(item.id, next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onStep, item, zoom, confirmDelete, onToggleSelect])

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

  // The other half of an upscale pair, and which half this is.
  //
  // One control that flips rather than two: the pair is one picture at two
  // resolutions, and the question a person has in front of either is the same —
  // "show me the other one". The label says which one they would get, so it
  // reads as a switch rather than as a fact about what is on screen.
  const counterpart = item.upscaledFrom
    ? {
        label: '4K upscaled',
        path: item.upscaledFrom,
        missing: 'original',
        title: `Upscaled from ${displayPath(item.upscaledFrom)} — click to open the original`,
      }
    : item.upscaledTo
      ? {
          label: 'Original',
          path: item.upscaledTo,
          missing: 'variant',
          title: `A 4K version of this exists — click to go back to it`,
        }
      : null

  // The thumbnail, standing in for the picture until the picture arrives.
  //
  // It is already on disk, already local, and at 512px it decodes in a fraction
  // of the time a 3072x4608 original takes — so it is the difference between a
  // step painting something and a step painting nothing. It is the *only*
  // stand-in worth having: the alternative, pointing at the original at a
  // smaller size, is the mistake `MediaTile` documents at length.
  const poster = item.thumbPath ? fileUrl(item.thumbPath) : null

  // The exact rectangle the original will occupy, computed from dimensions the
  // index recorded at scan time rather than waiting to be told by the image.
  //
  // This is the lightbox's version of the rule that makes the grid fast: a tile
  // knows its size before its image loads. Here it earns its keep twice — the
  // poster has somewhere to be painted, and it is painted in the same rectangle
  // the original lands in, so the swap changes the sharpness and nothing else.
  //
  // Null until the stage has been measured, and on a row the scanner has not
  // measured yet. Both fall back to the plain max-* rules, which size the box
  // from the image and therefore only once it has loaded.
  const box =
    stageSize && item.width > 0 && item.height > 0
      ? fitInside(item.width, item.height, stageSize.width, stageSize.height)
      : null

  // Everything the pan/zoom layer needs, in one place. `view` is the fitted one
  // until the user chooses otherwise, so there is a single rendering path
  // rather than a fitted mode and a zoomed mode that can disagree.
  const natural = { width: naturalWidth, height: naturalHeight }
  const viewport = { width: stageWidth, height: stageHeight }
  const canZoom = item.kind === 'image' && box !== null
  const view = zoom ?? fitView(natural, viewport)
  const zoomedIn = canZoom && isZoomed(view, natural, viewport)

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
                rated.current = true
                setFetched({ ...item, stars: next })
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
          title={
            hasRecycleBin(item.path)
              ? 'Move this file to the Recycle Bin (Del)'
              : 'Delete this file permanently (Del)'
          }
          onClick={() => void confirmDelete()}
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
        className="relative flex min-h-0 flex-1 p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
      {/* The padding lives on the parent so that what is *measured* here is
          exactly the box a pan is expressed in. Sharing one element between the
          two put the picture's coordinates a padding-width out from the
          viewport's, which reads as the picture drifting as you drag it. */}
      <div
        ref={setStage}
        className="relative min-h-0 flex-1 overflow-hidden"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        {item.kind === 'video' ? (
          // The original file streams straight through the protocol handler;
          // there is no transcode step and no temporary file. Held back like an
          // image is, and for the same reason only more so: opening a stream per
          // row swept past is the most expensive thing an arrow key can do here.
          //
          // No pan or zoom: a video has its own controls, and a click on one is
          // already play/pause.
          <div className="flex size-full items-center justify-center">
          <video
            key={item.id}
            src={showOriginal ? fileUrl(item.path) : undefined}
            poster={poster ?? undefined}
            controls
            autoPlay
            style={box ? { width: box.width, height: box.height } : undefined}
            className="max-h-full max-w-full rounded"
          />
          </div>
        ) : (
          /* The pan viewport: exactly the measured box, clipping whatever hangs
             outside it. Click and drag live here rather than on the picture,
             because a drag that starts on the picture and leaves it still has
             to keep panning. */
          <div
            className={cn(
              'absolute inset-0 touch-none select-none',
              !canZoom
                ? 'flex items-center justify-center'
                : panning
                  ? 'cursor-grabbing'
                  : zoomedIn
                    ? 'cursor-grab'
                    : 'cursor-zoom-in',
            )}
            onPointerDown={(event) => {
              if (!canZoom || event.button !== 0) return
              drag.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originX: view.x,
                originY: view.y,
                travelled: 0,
              }
              // Captured so a fast drag that outruns the pointer keeps panning
              // instead of stopping dead at the window edge.
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const current = drag.current
              if (!current || current.pointerId !== event.pointerId) return
              const dx = event.clientX - current.startX
              const dy = event.clientY - current.startY
              current.travelled = Math.max(current.travelled, Math.abs(dx) + Math.abs(dy))
              if (!zoomedIn) return
              if (!panning && current.travelled > CLICK_SLOP) setPanning(true)
              setZoom(
                clampView(
                  { scale: view.scale, x: current.originX + dx, y: current.originY + dy },
                  natural,
                  viewport,
                ),
              )
            }}
            onPointerUp={(event) => {
              const current = drag.current
              drag.current = null
              setPanning(false)
              if (!current || current.pointerId !== event.pointerId) return
              // A drag is not a click, however it ends.
              if (current.travelled > CLICK_SLOP) return

              const rect = event.currentTarget.getBoundingClientRect()
              const at = { x: event.clientX - rect.left, y: event.clientY - rect.top }
              // Fitting letterboxes, so most of the viewport is not the picture.
              // A click out there is the backdrop, and still closes.
              if (!isOverPicture(view, natural, at)) {
                onClose()
                return
              }
              if (zoomedIn) {
                setZoom(null)
                return
              }
              // Straight to original size, about the point clicked — so the
              // detail you aimed at is the one you land on.
              setShowOriginal(true)
              setZoom(zoomAbout(view, natural, viewport, 1, at))
            }}
            onPointerCancel={() => {
              drag.current = null
              setPanning(false)
            }}
          >
          <div
            className={cn(
              'rounded bg-contain bg-center bg-no-repeat',
              canZoom ? 'absolute' : 'relative inline-block max-h-full max-w-full',
            )}
            style={{
              ...(canZoom
                ? {
                    left: view.x,
                    top: view.y,
                    width: natural.width * view.scale,
                    height: natural.height * view.scale,
                  }
                : undefined),
              // `fileUrl` percent-encodes the path, so there is nothing left in
              // here that could close the quotes.
              backgroundImage: poster ? `url("${poster}")` : undefined,
            }}
          >
            {/* Mounted only once the row has been dwelt on. Until then the
                element is absent rather than src-less: an <img> with no source
                is a broken-image icon in the middle of the picture. */}
            {showOriginal ? (
              <img
                src={fileUrl(item.path)}
                alt={item.name}
                // Async decode keeps a large JPEG off the main thread, so the
                // poster stays painted until the original is ready to replace it
                // rather than the whole window janking on the swap.
                decoding="async"
                draggable={false}
                className={cn(
                  'rounded object-contain',
                  // With a known box the image fills it exactly, which is what
                  // makes the swap invisible. Without one it sizes itself, as it
                  // always did.
                  canZoom ? 'absolute inset-0 size-full' : 'max-h-[calc(100vh-9rem)] max-w-full',
                )}
              />
            ) : null}
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
          </div>
        )}
        </div>

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
        {/* The verdict grows and wraps; the resolution is a fixed readout
            pinned to the right of it, so it stays in one place rather than
            drifting with the length of a label. */}
        <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
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
        </div>

        {/* The source resolution, not what is on screen. Both the fitted
            view and a zoom are scalings of this, so it is the one number that
            says what there actually is to look at — and the answer to whether
            zooming further can reveal anything. */}
        {/* Only on a variant. The grid shows the upscale in place of what it
            was made from, so without this there is nothing anywhere saying the
            picture on screen is not the file that was generated — and no way
            back to the one that was. */}
        {counterpart ? (
          <button
            type="button"
            className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 hover:bg-sky-500/25 hover:text-sky-200"
            title={counterpart.title}
            onClick={() => {
              void mediaByPath(counterpart.path).then(
                (found) => {
                  if (found) onOpenId(found.id)
                  // One half of the pair outlived the other — the file was
                  // deleted, or its folder is no longer watched. Say so rather
                  // than doing nothing, which reads as a broken button.
                  else
                    void showMessage(displayPath(counterpart.path), {
                      title: `That ${counterpart.missing} is not in the library`,
                    })
                },
                (error) => showMessage(String(error), { title: 'Could not open it' }),
              )
            }}
          >
            {counterpart.label}
          </button>
        ) : null}

        <span
          className="shrink-0 tabular-nums text-[11px] text-zinc-500"
          title="The file's own resolution"
        >
          {item.width > 0 && item.height > 0 ? (
            // Bare digits, no thousands separators. A resolution is written
            // `3840×2160` everywhere it is written at all, and grouping them
            // would also make this read differently on every machine — the
            // separator is whatever the OS locale says it is.
            `${item.width}×${item.height}`
          ) : (
            // A row the measure phase has not reached yet. `0×0` is a number
            // that looks like an answer; a dash says there is not one yet.
            <span title="Not measured yet">—</span>
          )}
        </span>
        </div>

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
