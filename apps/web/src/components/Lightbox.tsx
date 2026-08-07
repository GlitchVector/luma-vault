import {
  ancestorsOf,
  clampView,
  dirnameOf,
  displayPath,
  effectiveRating,
  fitInside,
  fitView,
  highlight,
  isOverPicture,
  isZoomed,
  toParameterBlock,
  formatBytes,
  formatDuration,
  hasRecycleBin,
  zoomAbout,
  type MediaFrame,
  type MediaItem,
  type Rating,
  type SourceOrigin,
  type View,
} from '@luma/core'
import { Button, cn } from '@luma/ui'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteItem,
  extrasOriginal,
  fileUrl,
  forgeSelectCheckpoint,
  forgeUrl,
  generationParameters,
  mediaById,
  mediaByPath,
  mediaFrames,
  openExternal,
  revealInFileManager,
  setRatingOverride,
  setStars,
  sourceOrigin,
} from '#/lib/native.ts'
import { RatingOverrideDialog } from '#/components/RatingOverrideDialog.tsx'
import { askConfirm, askToEdit, showMessage } from '#/lib/dialogs.ts'
import { preloadImages } from '#/lib/preload.ts'
import { toast } from '#/lib/toasts.ts'

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
   * The model's rating on this row was corrected by hand.
   *
   * The grid has to re-query rather than patch a row in place: a correction
   * moves the picture between the rating pills and in or out of the sexy-only
   * filter, so the list it belongs to may no longer be the list it is in.
   */
  onCorrected: () => void
  /**
   * Whether the row on screen is currently picked.
   *
   * The lightbox used to fire {@link onToggleSelect} blind, which is fine for a
   * key that means "flip this" and useless for one that means "take it out" —
   * a blind toggle on an unpicked row would *add* it. It also gives the header
   * something to say, which matters as soon as stepping back to reconsider is
   * part of the pass.
   */
  selected: boolean
  /**
   * Show a different row, by id.
   *
   * Distinct from `onStep`, which walks the filtered list. This reaches a
   * picture that is deliberately *not* in it — the original behind an
   * upscaled variant.
   */
  onOpenId: (id: number) => void
  /**
   * Ask for this picture at 4K, in the background.
   *
   * Queued rather than run: the app decides when the GPU is free. Refusing a
   * picture that is already 4K is the app's job too — this component knows the
   * row but not what else is in flight.
   */
  onUpscale: (item: MediaItem) => void
}

/**
 * A prompt with the characters it names picked out.
 *
 * These prompts run to two hundred tags and the character is the one thing you
 * scan for — it is what the picture is *of*, and it is buried somewhere in the
 * middle wearing the same colour as `masterpiece` and `blurry`.
 *
 * The names arrive already detected, from the Rust side. Nothing here decides
 * what a character is; this only finds the words it was handed. Matching is
 * literal and case-insensitive, so `Aqua (Konosuba)` is picked out by the
 * normalised `aqua (konosuba)` — but a prompt that spells it with escaped
 * parentheses or doubled spaces simply will not light up, which is the right
 * way to fail. A missed highlight costs a glance; a wrong one says a picture is
 * of somebody it is not.
 */
function PromptText({ prompt, characters }: { prompt: string; characters: string[] }) {
  // `aqua \(konosuba\)` is the same tag wearing the prompt-level spelling of
  // literal parens — detection already peels it, so the display has to know it
  // too or the one form this library actually contains never highlights.
  const spellings = characters.flatMap((name) =>
    name.includes('(')
      ? [name, name.replace('(', String.raw`\(`).replace(')', String.raw`\)`)]
      : [name],
  )
  // Keyed by where each run starts, which is unique within a prompt and stable
  // across re-renders — the position is the one thing about a part that cannot
  // collide with another part.
  let offset = 0
  const parts: Array<{ text: string; match: boolean; at: number }> = []
  for (const part of highlight(prompt, spellings)) {
    parts.push({ text: part.text, match: part.match, at: offset })
    offset += part.text.length
  }
  return (
    <>
      {parts.map((part) =>
        part.match ? (
          <span key={part.at} className="font-medium text-pink-400">
            {part.text}
          </span>
        ) : (
          <Fragment key={part.at}>{part.text}</Fragment>
        ),
      )}
    </>
  )
}

/**
 * A short string shown as code, which copies itself when clicked.
 *
 * The whole control is the target rather than a separate icon beside it: the
 * only thing anyone wants to do with a line like this is take it, so making the
 * text itself the button removes the step of aiming at something smaller.
 *
 * Confirms in place instead of raising a toast. A toast says *that* something
 * was copied somewhere else on screen; swapping the label says *this* was, which
 * is the question being asked, and it cannot be missed by looking at the thing
 * you just clicked.
 */
function CopyLabel({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <button
      type="button"
      title={`Copy "${value}"`}
      onClick={() => {
        // Optional-chained *and* guarded: `clipboard?.writeText()` yields
        // undefined where the API is absent, and `.then` on that throws.
        const written = navigator.clipboard?.writeText(value)
        if (!written) return
        void written.then(
          () => setCopied(true),
          // A clipboard the browser refused is not worth an error dialog over,
          // but claiming success would be a lie.
          () => setCopied(false),
        )
      }}
      className={cn(
        'mt-1 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left font-mono',
        'transition-colors',
        copied
          ? 'border-indigo-400/40 bg-indigo-500/15 text-indigo-200'
          : 'border-white/10 bg-black/40 text-zinc-400 hover:border-white/20 hover:text-zinc-200',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{value}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-70">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  )
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
  onUpscale,
  onToggleSelect,
  onCorrected,
  selected,
}: LightboxProps) {
  const [fetched, setFetched] = useState<MediaItem | null>(null)
  /**
   * The picture an Extras upscale was made from, once resolved.
   *
   * The panel then shows *that* generation — the prompt someone wants from an
   * upscale is the prompt of the thing that was upscaled — with the extras
   * pass noted after it.
   */
  const [extrasSource, setExtrasSource] = useState<MediaItem | null>(null)
  /**
   * Whether the Extras lookup above has answered yet.
   *
   * Distinct from `extrasSource` being null, which also means "asked and found
   * nothing". The origin walk needs the difference: it must ask about the row
   * whose prompt the panel shows, and starting before this is known asks about
   * the upscale, then asks again about the picture — one wasted scan of the
   * whole library, and a panel that finds an ancestor and then goes back to
   * looking for one.
   */
  const [extrasResolved, setExtrasResolved] = useState(false)
  /**
   * Showing the resolved original *in place of* the extras upscale.
   *
   * A display swap only: the lightbox stays on the extras row — its rating,
   * its neighbours, its footer — and just draws the other file. Clicking the
   * footer pill flips it, which is the fastest possible "what did this look
   * like before the upscale".
   */
  const [showExtrasOriginal, setShowExtrasOriginal] = useState(false)
  /**
   * What an img2img was made from, once the walk has answered.
   *
   * `undefined` while it is still looking, `null` once it has looked and found
   * nothing — a third of the time. The two must not render the same, or a
   * picture whose source is still being searched for reads as one that has none.
   */
  const [origin, setOrigin] = useState<SourceOrigin | null | undefined>(undefined)
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
    // Cleared before asking: a stale source under a new picture would caption
    // the wrong prompt while the lookup runs. The display swap resets with
    // it — stepping to the next picture must show that picture.
    setExtrasSource(null)
    setExtrasResolved(false)
    setShowExtrasOriginal(false)

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

  /**
   * Correcting the detector on the row on screen.
   *
   * Applied locally before the write lands, like the star keys above it: the
   * badge is the feedback, and a badge that waits for a round-trip reads as a
   * click that missed. `onCorrected` tells the app so the grid re-queries —
   * the correction moves the row between the rating filters, so leaving the
   * grid on its old answer would show a picture the current filter excludes.
   */
  const [correcting, setCorrecting] = useState(false)
  const applyCorrection = useCallback(
    (rating: Exclude<Rating, 'unrated'> | null) => {
      if (!item) return
      setCorrecting(false)
      setFetched({ ...item, ratingOverride: rating })
      void setRatingOverride([item.id], rating).then(
        () => onCorrected(),
        (error: unknown) => void showMessage(String(error), { title: 'Could not correct' }),
      )
    },
    [item, onCorrected],
  )

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
    // An upscale pair is one picture kept as two files, and is deleted as one.
    // The question has to say so rather than name a single file and take both.
    const paired = item.upscaledFrom
      ? 'This also removes the original it was made from.'
      : item.upscaledTo
        ? 'This also removes its 4K version.'
        : null
    const message = [
      item.name,
      paired,
      recyclable
        ? 'It leaves the library immediately. You can restore it from the bin.'
        : 'It is on a network drive, where Windows has no Recycle Bin. This cannot be undone.',
    ]
      .filter(Boolean)
      .join('\n\n')

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
        // The two verdict keys are alternatives, so rating takes the row back
        // out of the pile. Stepping back to reconsider something you picked and
        // rating it instead is a *change of mind*, and leaving it picked would
        // mean the batch action later runs over a picture you decided to keep.
        //
        // Guarded rather than toggled: `onToggleSelect` on an unpicked row
        // would add it, so pressing Up on an ordinary picture would silently
        // start a selection.
        if (selected) {
          toast(`Unpicked ${item.name}`, 'muted')
          onToggleSelect(item.id)
        }
        // Shift says "and it is worth the pixels": same verdict, same step, and
        // a 4K upscale queued behind it. On the same key rather than its own
        // because it is the same judgement with one more consequence — you
        // decide a picture is good and that it deserves the resolution in one
        // motion, without stopping the pass to go and find a button.
        if (event.shiftKey) onUpscale(item)
        // On to the next, like the pick below it. Both keys mean "I have decided
        // about this one", and the decision is nearly always followed by moving
        // on — so the pass stays a single repeated key whichever you press.
        // Adjusting a rating you have just given is what 1-5 are for, and they
        // deliberately stay put — but they take the row out of the pile too,
        // because any rating is the verdict that says this one is not a
        // candidate.
        onStep(1)
        return
      }
      if (event.key === 'ArrowDown' && item) {
        event.preventDefault()
        // Said out loud, because there is nothing on this screen to see it
        // happen on — the selection lives in a grid the lightbox is covering.
        // Read before the toggle: `selected` is the state being left.
        toast(
          `${selected ? 'Unpicked' : 'Picked'} ${item.name}`,
          selected ? 'muted' : 'picked',
        )
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

      // Rating takes the row out of the pile, the same as Up does. **Before**
      // the no-op check below, deliberately: pressing 4 on something already
      // rated 4 is still someone saying "this one is decided", and that check
      // exists only to skip a pointless write — it must not also swallow the
      // half of the keypress that has an effect.
      if (selected) {
        toast(`Unpicked ${item.name}`, 'muted')
        onToggleSelect(item.id)
      }

      if (next === item.stars) return
      // Applied locally first: this is meant to be held down through a folder,
      // and waiting for a round-trip per key makes it feel like it missed.
      rated.current = true
      setFetched({ ...item, stars: next })
      void setStars(item.id, next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onStep, item, zoom, confirmDelete, onToggleSelect, onUpscale, selected])

  // Resolve the original behind an Extras upscale, once the row says it is
  // one. Keyed on the id so stepping re-resolves; harmless when the panel is
  // closed, since the row is already in hand either way.
  const isExtras = item?.generation?.postprocessed === true
  useEffect(() => {
    if (!isExtras) return
    let cancelled = false
    void extrasOriginal(mediaId).then((found) => {
      if (cancelled) return
      setExtrasSource(found)
      setExtrasResolved(true)
    })
    return () => {
      cancelled = true
    }
  }, [mediaId, isExtras])

  /**
   * The row the panel talks about — for an Extras upscale, the picture that was
   * upscaled.
   *
   * Computed here rather than beside the panel because the origin lookup has to
   * ask about *that* row. An extras variant of an img2img shows the img2img's
   * generation, so it must show the img2img's source too; keying the lookup on
   * the row on screen instead left that case saying "looking for it" forever,
   * because the extras row is not itself an img2img and nothing was ever asked.
   */
  const panelSource = extrasSource?.generation ? extrasSource : item

  // What this img2img was made from. Only while the panel is open, and only for
  // a row that says it needs a source image: the walk scans every fingerprinted
  // row in the library, and for anything else there is nothing to look for.
  const isImg2img = panelSource?.generation?.needsSourceImage === true
  const originId = panelSource?.id
  // An extras row's own id is not the one to ask about, and which id is only
  // becomes known when the lookup above answers.
  const waitingForExtras = isExtras && !extrasResolved
  useEffect(() => {
    if (!isImg2img || !showGeneration || originId === undefined || waitingForExtras) return
    let cancelled = false
    // Back to "still looking" first, so stepping onto another picture cannot
    // show the previous one's ancestor while this one is being searched for.
    setOrigin(undefined)
    void sourceOrigin(originId).then((found) => {
      if (!cancelled) setOrigin(found)
    })
    return () => {
      cancelled = true
    }
  }, [originId, isImg2img, showGeneration, waitingForExtras])

  if (!item) return null

  // The generation the panel talks about: for an Extras upscale whose source
  // was found, the source's — the prompt someone opens the panel for is the
  // prompt of the thing that was upscaled, not the postprocess line. After the
  // null-guard, so the panel's uses need no chaining of their own.
  const panelItem = panelSource ?? item
  const panelGeneration = panelItem.generation

  const verdict = item.verdict
  // What this row is actually rated. `verdict.rating` stays the model's and is
  // still shown — in the badge's tooltip and in the correction dialog — but
  // nothing draws or decides from it directly.
  const shownRating = effectiveRating(item)
  // Shown rather than the stored path: the index keeps Windows' canonical
  // extended-length form, which nobody can read and nobody can paste anywhere.
  const folder = dirnameOf(displayPath(item.path))
  // The stored spelling of the same folder. Only used to tell "this row has a
  // folder" from "it does not" — what an exclusion is *keyed* on is settled by
  // the backend, which canonicalizes whatever it is handed, because the path it
  // is handed may have been edited by a person who could only read one of the
  // two forms.
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
  // What the stage actually draws: the extras row itself, or — when the
  // footer pill is flipped — the original it was upscaled from. Only the
  // pixels swap; everything else on screen keeps describing the open row.
  const shownImage = showExtrasOriginal && extrasSource ? extrasSource : item

  const poster = shownImage.thumbPath
    ? fileUrl(shownImage.thumbPath)
    : item.thumbPath
      ? fileUrl(item.thumbPath)
      : null

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
        {/* Without this, stepping back to a picture gives no clue whether it is
            already picked — and the decision to reconsider one is exactly when
            that matters. */}
        {selected ? (
          <span
            className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-indigo-200"
            title="Picked for the selection. Rating it with Up takes it back out."
          >
            picked
          </span>
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
            // Says what lands on disk, because something does. A
            // `.lumaignore` is how the scanner is told to skip a folder, and
            // writing one is the whole of what "exclude" means here.
            const message =
              'Its files leave the library and a .lumaignore file is written into it, which is what keeps it out. No media is deleted, and you can undo this from the sidebar.'
            // The folder holding this picture is a *starting point*, not the
            // answer: the thing worth excluding is regularly several levels
            // above it — you find a texture pack from one texture, nine deep.
            // So the path is editable, and every ancestor is one click.
            //
            // Offered in the readable form, not the stored one. Nobody can
            // check `\\?\UNC\server\share\…` at a glance, and an edit is
            // exactly the moment somebody needs to read what they are
            // changing. The backend canonicalizes whatever comes back, so both
            // spellings arrive at the same folder.
            void askToEdit(
              message,
              {
                label: 'Folder to exclude',
                value: folder,
                suggestions: ancestorsOf(folder),
              },
              { title: 'Stop scanning this folder?', confirmLabel: 'Exclude folder' },
            ).then((chosen) => {
              if (chosen) onExcludeFolder(chosen.trim())
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
            src={showOriginal ? fileUrl(shownImage.path) : undefined}
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
                key={shownImage.id}
                src={fileUrl(shownImage.path)}
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
      {showGeneration && item.generation && panelGeneration ? (
        <aside className="absolute inset-y-0 right-0 z-10 w-80 overflow-y-auto border-l border-white/10 bg-zinc-950/95 p-3 text-[11px] shadow-2xl backdrop-blur-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-zinc-300">{panelGeneration.tool}</span>
            {panelGeneration.prompt ? (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(panelGeneration?.prompt ?? '')
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
              if (!panelGeneration) return
              // The file's own text first. `toParameterBlock` rebuilds a block
              // from the seven fields the parser models, which drops schedule
              // type, clip skip, ControlNet and every ADetailer setting — so
              // the regenerated image came out different. It stays only as the
              // fallback for files whose block cannot be re-read.
              const generation = panelGeneration
              void generationParameters(panelItem.id).then((raw) => {
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
          {panelGeneration.needsSourceImage ? (
            <div className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-1.5 text-[10px] leading-snug text-amber-200/90">
              <p>
                <span className="font-medium">Made from another image.</span> These
                parameters describe an img2img pass, so they cannot reproduce it —
                no file records the source image, and Forge&rsquo;s own
                PNG&nbsp;Info tab cannot recover it either. The prompt and
                settings still load.
              </p>
              {/* Nothing records the source, but the library can often
                  *recognise* it: a denoising pass keeps the composition it
                  started from, which is what the perceptual hash measures. The
                  three states are kept distinct on purpose — still looking,
                  looked and found nothing, and found — because rendering the
                  first as the second calls a picture sourceless while its
                  source is still being searched for. */}
              {origin === undefined ? (
                <p className="mt-1 text-amber-200/60">Looking for it in your library…</p>
              ) : origin === null ? (
                <p className="mt-1 text-amber-200/60">
                  Nothing here looks like its source — it was never in this
                  library, or is no longer.
                </p>
              ) : (
                <div className="mt-1.5 border-t border-amber-500/20 pt-1.5">
                  <p>
                    {origin.reachedRoot
                      ? 'The picture this one starts from is '
                      : 'An earlier picture in the same lineage is '}
                    <button
                      type="button"
                      className="font-medium underline underline-offset-2 hover:text-amber-100"
                      title={`Open ${displayPath(origin.item.path)}`}
                      onClick={() => onOpenId(origin.item.id)}
                    >
                      {origin.item.name}
                    </button>
                    {`, ${origin.hops} img2img ${origin.hops === 1 ? 'pass' : 'passes'} back.`}
                    {origin.reachedRoot
                      ? null
                      : ' It was made from something in turn, which is not here.'}
                  </p>
                  {origin.item.generation?.prompt ? (
                    <>
                      {/* The caveat matters more than the prompt does. A pass
                          often keeps a composition and changes the subject, so
                          an ancestor can name a character who is no longer in
                          the picture — this is evidence to read against what is
                          on screen, not a prompt to reuse unread. */}
                      <p className="mt-1 text-amber-200/60">
                        Its prompt, which may describe a subject this picture no
                        longer has — read it against the image:
                      </p>
                      <p className="mt-1 select-text whitespace-pre-wrap break-words text-amber-100/85">
                        <PromptText
                          prompt={origin.item.generation.prompt}
                          characters={origin.item.generation.characters}
                        />
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-amber-200/60">No prompt recorded on it.</p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="mt-1 text-[10px] leading-snug text-zinc-600">
              Fills automatically with the prefill extension — otherwise paste and
              press ↙, the parameters are on your clipboard.
            </p>
          )}

          {panelGeneration.prompt ? (
            // `select-text` because the whole point is getting these words back
            // out — into another tool, or into the same one again.
            <p className="mt-2 select-text whitespace-pre-wrap break-words text-zinc-200">
              <PromptText
                prompt={panelGeneration.prompt}
                characters={panelGeneration.characters}
              />
            </p>
          ) : (
            <p className="mt-2 text-zinc-600">
              No prompt recorded — the file names its generator but not its
              settings.
            </p>
          )}

          {panelGeneration.negativePrompt ? (
            <>
              <h3 className="mt-3 text-zinc-600">Negative</h3>
              <p className="mt-1 select-text whitespace-pre-wrap break-words text-zinc-400">
                {panelGeneration.negativePrompt}
              </p>
            </>
          ) : null}

          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-white/5 pt-2 text-zinc-500">
            {(
              [
                ['Model', panelGeneration.model],
                ['Seed', panelGeneration.seed],
                ['Sampler', panelGeneration.sampler],
                ['Steps', panelGeneration.steps],
                ['CFG', panelGeneration.cfgScale],
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

          {/* Last, because it hands off to something outside this app. The
              panel reads top to bottom as "what this picture is" — the prompt,
              then the settings — and this is what you do about it afterwards.
              Written out rather than run from here: it belongs to a different
              tool, and the useful thing this window can do is give the exact
              string instead of making someone retype a filename of digits. */}
          {item.generation?.postprocessed ? (
            <>
              <h3 className="mt-3 border-t border-white/5 pt-2 text-zinc-600">Extras pass</h3>
              {/* Only a real postprocess line is worth printing. The old-era
                  files carry a COPY of the original's whole block instead, and
                  repeating that prompt under a heading that says "Extras"
                  reads as the pass having had a prompt — it did not. The
                  Extras tab runs no diffusion at all: no prompt, no seed, no
                  denoise, just an upscaler and optional face-restore weights. */}
              {item.generation.prompt?.includes('Postprocess') ? (
                <p className="mt-1 select-text break-words text-zinc-400">
                  {item.generation.prompt}
                </p>
              ) : (
                <p className="mt-1 text-[10px] leading-snug text-zinc-600">
                  Upscaled in the Extras tab, which records no settings of its own — no
                  prompt, no denoise; it is a pure upscaler pass. This file carries a copy
                  of its original&rsquo;s parameters, shown above.
                </p>
              )}
              {extrasSource === null ? (
                <p className="mt-1 text-[10px] leading-snug text-zinc-600">
                  The original file itself was not found in the library. Run Find Duplicates
                  to link upscales to their originals.
                </p>
              ) : null}
            </>
          ) : null}

          {/* Both, because they take the same argument and do different things
              with it: `/sdxl` migrates this block onto a newer checkpoint,
              keeping the sampler, hires pass and ADetailer settings it already
              carries; `/recreate` throws the block away and writes a fresh
              prompt from the picture, keeping only the words. Which one is
              wanted depends on whether the generation was good, and that is a
              judgement made while looking at it — which is here. */}
          <h3 className="mt-3 border-t border-white/5 pt-2 text-zinc-600">Claude Commands</h3>
          <CopyLabel value={`/sdxl ${panelItem.name}`} />
          <CopyLabel value={`/recreate ${panelItem.name}`} />
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
            {/* The *effective* rating, which on a corrected row is the
                person's. The badge is also the button that corrects it: the
                thing you want to change is the thing you are looking at, and a
                separate control elsewhere in the footer would be a second
                place to look for one decision. */}
            <button
              type="button"
              onClick={() => setCorrecting(true)}
              // Labelled by what it does, not by what it reads. The text is
              // the rating — "explicit" — which is a fine thing to *see* and a
              // useless name for a control, because it says nothing about what
              // pressing it will do.
              aria-label="Correct the rating"
              title={
                item.ratingOverride
                  ? `You corrected this to ${item.ratingOverride}; NudeNet rated it ${verdict.rating}. Click to change or restore it.`
                  : `NudeNet rated this ${verdict.rating}. Click to correct it.`
              }
              className={cn(
                'rounded-full px-2 py-0.5 font-medium transition-colors',
                shownRating === 'explicit' && 'bg-red-500/20 text-red-300 hover:bg-red-500/30',
                shownRating === 'suggestive' && 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30',
                shownRating === 'sfw' && 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25',
                shownRating === 'unrated' && 'bg-white/10 text-zinc-400 hover:bg-white/20',
                // A correction is marked, not disguised. A row that silently
                // read "sfw" would be indistinguishable from one the model got
                // right, and the difference is the whole record.
                item.ratingOverride && 'ring-1 ring-inset ring-white/40',
              )}
            >
              {shownRating}
              {item.ratingOverride ? <span className="ml-1 opacity-60">·  yours</span> : null}
            </button>
            {item.generation?.needsSourceImage ? (
              <span
                className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-200/90"
                title="Made from another image (img2img) — its parameters alone cannot reproduce it"
              >
                img2img
              </span>
            ) : null}
            {item.generation?.postprocessed ? (
              <button
                type="button"
                onClick={() => {
                  if (extrasSource) setShowExtrasOriginal((previous) => !previous)
                }}
                title={
                  extrasSource
                    ? showExtrasOriginal
                      ? 'Showing the original — click to show the Extras upscale again'
                      : 'Upscaled in the Extras tab — click to show the original it was made from'
                    : 'Upscaled in the Extras tab — the original was not found in the library'
                }
                className={cn(
                  'rounded-full px-2 py-0.5 font-medium',
                  showExtrasOriginal
                    ? 'bg-emerald-500/15 text-emerald-200/90'
                    : 'bg-sky-500/15 text-sky-200/90',
                  extrasSource ? 'hover:bg-sky-500/25' : 'cursor-default',
                )}
              >
                {showExtrasOriginal ? 'original' : 'extras'}
              </button>
            ) : null}
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

      {/* Last, so it stacks over the stage and the footer both. Mounted only
          while open — it swallows every keystroke in the capture phase, and a
          permanently-mounted one would take the lightbox's own keys with it. */}
      {correcting ? (
        <RatingOverrideDialog
          item={item}
          onApply={applyCorrection}
          onCancel={() => setCorrecting(false)}
        />
      ) : null}
    </div>
  )
}
