import { Button, EmptyState } from '@luma/ui'
import {
  hasRecycleBin,
  isFourK,
  rangeBetween,
  retainVisible,
  toggleSelected,
  type MediaItem,
} from '@luma/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilterBar } from '#/components/FilterBar.tsx'
import { FolderSidebar } from '#/components/FolderSidebar.tsx'
import { Lightbox } from '#/components/Lightbox.tsx'
import { MediaGrid } from '#/components/MediaGrid.tsx'
import { DEFAULT_TILE_SIZE, MAX_TILE_SIZE, MIN_TILE_SIZE } from '#/components/MediaTile.tsx'
import { SearchBar } from '#/components/SearchBar.tsx'
import { DeviantArtPanel } from '#/components/DeviantArtPanel.tsx'
import { DialogHost } from '#/components/DialogHost.tsx'
import { RemoteDialog } from '#/components/RemoteDialog.tsx'
import { StatusBar } from '#/components/StatusBar.tsx'
import { TimelinePanel } from '#/components/TimelinePanel.tsx'
import { ToastHost } from '#/components/ToastHost.tsx'
import { toast } from '#/lib/toasts.ts'
import { UpscaleResults } from '#/components/UpscaleResults.tsx'
import { askConfirm, showMessage } from '#/lib/dialogs.ts'
import {
  deleteMedia,
  forgeStatus,
  isTauri,
  onUpscaleProgress,
  setStarsMany,
  upscaleMedia,
  type ForgeStatus,
  type UpscaleProgress,
  type UpscaleSummary,
} from '#/lib/native.ts'
import { useLibrary } from '#/lib/useLibrary.ts'
import { useRemote } from '#/lib/useRemote.ts'

const TILE_SIZE_KEY = 'luma.tileSize'

/**
 * How long a second bare tap of Ctrl has to arrive to count as a double tap.
 *
 * The way out of selecting mode by keyboard. 500ms is the interval Windows
 * itself uses for a double click, so it is the one already in everybody's
 * hands — long enough to be comfortable, short enough that two deliberate
 * presses a moment apart are not mistaken for one gesture.
 */
export const DOUBLE_TAP_MS = 500

/**
 * How often the background upscale queue asks Forge whether it has finished.
 *
 * A generation ending is not something this app is told about, so the only way
 * to know is to keep asking. Three seconds is slow enough to be nothing next to
 * a generation and fast enough that a queued picture starts while you are still
 * in the folder you asked from.
 */
export const FORGE_RETRY_MS = 3000

/**
 * The tile size to open with.
 *
 * Remembered, unlike the view toggles beside it: those answer a question you
 * have right now — is this one flagged, what made it — and default off on
 * purpose. How big you like the grid is not a question, it is how you use the
 * app, and having to set it again every launch would make it feel broken.
 *
 * Clamped rather than trusted, because it comes back as whatever is in storage:
 * a stale value from an older range, or something hand-edited, must not be able
 * to render a wall of 4000px tiles.
 */
function storedTileSize(): number {
  const raw = Number(globalThis.localStorage?.getItem(TILE_SIZE_KEY))
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TILE_SIZE
  return Math.min(MAX_TILE_SIZE, Math.max(MIN_TILE_SIZE, Math.round(raw)))
}

export function App() {
  const library = useLibrary()
  const remote = useRemote()
  const [showRemote, setShowRemote] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)
  // Read once, on mount — not on every render, and never written back on a
  // render that did not change it.
  const [tileSize, setTileSize] = useState(storedTileSize)
  // Selecting is a mode rather than a modifier, because the actions it leads to
  // are destructive or expensive and "I clicked a picture" must keep meaning
  // "open it" the rest of the time.
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  // Where a shift-click measures from: the last row picked on its own. A ref
  // because it is read inside a handler and never drawn.
  const anchor = useRef<number | null>(null)
  // The latest `selecting`, for the Ctrl handler below: it has to know whether
  // the mode was already on to decide whether taking it back is safe, and the
  // listener is registered once rather than on every toggle.
  const selectingRef = useRef(selecting)
  useEffect(() => {
    selectingRef.current = selecting
  })
  // The latest `openId`, for the background upscale queue: it is read inside a
  // promise that outlives the render which started it, to decide whether a
  // reload can land now or has to wait for the lightbox to close.
  const openIdRef = useRef(openId)
  useEffect(() => {
    openIdRef.current = openId
  })
  // The batch in flight, and what it produced. Two pieces of state rather
  // than one: the progress has to keep updating while the run is going, and
  // the summary only exists once it has finished.
  const [upscaling, setUpscaling] = useState<UpscaleProgress | null>(null)
  const [upscaleResults, setUpscaleResults] = useState<UpscaleSummary | null>(null)
  /**
   * Pictures asked for at 4K from the lightbox, waiting their turn.
   *
   * Separate from the selection's batch button and deliberately quieter: this
   * is fired one key at a time in the middle of a review pass, so it must never
   * take the screen or the GPU away from what is being done. A queue rather
   * than a call per keypress because the upscaler wants the whole card — twenty
   * shift-ups through a folder would otherwise be twenty runs at once.
   */
  const [upscaleQueue, setUpscaleQueue] = useState<readonly number[]>([])
  /** The one background upscale in flight, if any. */
  const [backgroundUpscale, setBackgroundUpscale] = useState<number | null>(null)
  /**
   * A finished background upscale the grid has not been told about yet.
   *
   * Reloading puts the variant in the grid and hides what it was made from —
   * which reorders the list the lightbox is stepping through. Doing that under
   * somebody mid-pass moves the next picture out from under the arrow key, so
   * it waits until the lightbox is closed.
   */
  const pendingReload = useRef(false)
  // The pictures being reviewed for DeviantArt. A snapshot taken when the panel
  // opens rather than a live read of `selected`: the panel holds edited drafts,
  // and a filter change underneath it must not silently drop a row someone has
  // already written a title for.
  const [publishing, setPublishing] = useState<MediaItem[] | null>(null)
  const [forge, setForge] = useState<ForgeStatus | null>(null)
  const [showBoxes, setShowBoxes] = useState(false)
  // The timeline strip under the filter bar. Open/closed is UI state; the
  // range it selects lives in the query like any other filter.
  const [showTimeline, setShowTimeline] = useState(false)
  // Lives here rather than in the Lightbox so it survives closing one. The
  // Lightbox is mounted per-item, so local state reset the toggle every time
  // you opened a file. Deliberately separate from `showBoxes` above, which is
  // the grid's label pill and a different question.
  //
  // Off to begin with. Detection boxes are a diagnostic view — they answer "why
  // did this get rated that way", which is a question you occasionally have and
  // never have by default. Opening a picture should show the picture, not a
  // rectangle over every part of it.
  const [showLightboxBoxes, setShowLightboxBoxes] = useState(false)
  // Here for the same reason, and it matters more: stepping through a folder of
  // generations is exactly when you want the prompt to stay on screen.
  //
  // **On by default**, unlike the two above it. Those answer a question you
  // occasionally have; for a library that is almost entirely generated, the
  // prompt is what the picture *is*, and having to press a key on every file to
  // read it is the wrong way round. It costs nothing on a file that has no
  // parameter block: the lightbox gates the panel on `item.generation`, so a
  // scan or a photo shows no panel and no button either way.
  //
  // Sticky rather than re-opened per picture, deliberately. Forcing it open on
  // every generated file would make the close button useless — one arrow key
  // and it would be back.
  const [showGeneration, setShowGeneration] = useState(true)
  const { items, query, setQuery, actions, folders, progress } = library

  // Stepping through the lightbox walks the *currently filtered* list, which is
  // what "next" means to someone who just narrowed to videos.
  const step = useCallback(
    (delta: number) => {
      setOpenId((current) => {
        if (current === null) return current
        const index = items.findIndex((item) => item.id === current)
        if (index < 0) return current
        const next = items[index + delta]
        return next ? next.id : current
      })
    },
    [items],
  )

  /**
   * A tile was clicked.
   *
   * One handler for both modes, because a tile cannot know which it is in — and
   * because "shift means the run between" is a question only the list can
   * answer, so it has to be resolved here where the order is.
   */
  const openOrSelect = useCallback(
    (id: number, range: boolean) => {
      if (!selecting) {
        setOpenId(id)
        return
      }
      const ids = items.map((item) => item.id)
      if (range && anchor.current !== null) {
        const run = rangeBetween(ids, anchor.current, id)
        // Added to what is already picked rather than replacing it, so two
        // separate runs can be collected. A stale anchor yields nothing, and
        // then this falls through to an ordinary toggle.
        if (run.length > 0) {
          setSelected((previous) => new Set([...previous, ...run]))
          return
        }
      }
      anchor.current = id
      setSelected((previous) => toggleSelected(previous, id))
    },
    [selecting, items],
  )

  /**
   * Pick a row from inside the lightbox.
   *
   * Turns the mode on as a side effect, deliberately: the selection has to be
   * visible and refinable the moment the lightbox closes, and a set of picked
   * pictures with no bar and no way to act on them is worse than none.
   */
  const toggleSelect = useCallback((id: number) => {
    setSelecting(true)
    anchor.current = id
    setSelected((previous) => toggleSelected(previous, id))
  }, [])

  /** Delete everything picked, after saying how many and how permanently. */
  const deleteSelected = useCallback(() => {
    const ids = [...selected]
    if (ids.length === 0) return
    // Windows has no Recycle Bin on a network share, and every file in this
    // library is on one. The question has to change rather than promise a bin
    // that is not there — and at this count the promise matters more.
    const recyclable = items.some(
      (item) => selected.has(item.id) && hasRecycleBin(item.path),
    )
    // Each half of an upscale pair takes the other with it, so the number of
    // files is not the number of pictures. Saying "3 files" and removing six is
    // exactly the surprise a confirmation exists to prevent.
    const paired = items.filter(
      (item) => selected.has(item.id) && (item.upscaledFrom || item.upscaledTo),
    ).length
    void askConfirm(
      [
        paired > 0
          ? `${ids.length.toLocaleString()} picture${ids.length === 1 ? '' : 's'}, ` +
            `${(ids.length + paired).toLocaleString()} files — ${paired.toLocaleString()} ` +
            `of them also have a 4K version, which goes too.`
          : `${ids.length.toLocaleString()} file${ids.length === 1 ? '' : 's'}.`,
        recyclable
          ? 'They leave the library immediately. You can restore them from the bin.'
          : 'They are on a network drive, where Windows has no Recycle Bin. This cannot be undone.',
      ].join('\n\n'),
      {
        title: recyclable ? 'Move to the Recycle Bin?' : 'Delete permanently?',
        confirmLabel: recyclable ? 'Delete' : 'Delete permanently',
        tone: 'danger',
      },
    ).then((yes) => {
      if (!yes) return
      return deleteMedia(ids, !recyclable).then(
        (summary) => {
          setSelected(new Set())
          anchor.current = null
          library.reload()
          if (summary.failed > 0) {
            void showMessage(
              [
                `${summary.deleted.toLocaleString()} deleted, ${summary.failed.toLocaleString()} could not be.`,
                ...summary.errors,
              ].join('\n\n'),
              { title: 'Some files could not be deleted' },
            )
          }
        },
        (error) => showMessage(String(error), { title: 'Could not delete' }),
      )
    })
  }, [selected, items, library])

  /**
   * Open the DeviantArt review panel over the selection.
   *
   * Images only. Sta.sh takes other kinds of file, but everything downstream
   * here — the mime type, the derived tags, the thumbnail in the panel — is
   * written for a still, and quietly uploading a video as `image/jpeg` is worse
   * than declining to.
   */
  const reviewForDeviantArt = useCallback(() => {
    const picked = items.filter((item) => selected.has(item.id) && item.kind === 'image')
    if (picked.length === 0) {
      void showMessage('None of the selected files is an image.', { title: 'Nothing to send' })
      return
    }
    const videos = selected.size - picked.length
    if (videos > 0) {
      void showMessage(
        `${videos.toLocaleString()} video${videos === 1 ? '' : 's'} left out — this posts still images.`,
        { title: 'Videos skipped' },
      )
    }
    setPublishing(picked)
  }, [items, selected])

  /** Upscale everything picked, then show what came out. */
  const runUpscale = useCallback(() => {
    const ids = [...selected]
    if (ids.length === 0) return
    // A starting frame straight away: the model load alone is a second or two
    // before the first per-file event arrives, and a button that looks inert
    // for that long gets pressed twice.
    setUpscaling({
      phase: 'start',
      done: 0,
      total: ids.length,
      current: null,
      destination: null,
      finalWidth: null,
      finalHeight: null,
    })

    void onUpscaleProgress(setUpscaling).then((unlisten) =>
      upscaleMedia(ids).then(
        (summary) => {
          unlisten()
          setUpscaling(null)
          setUpscaleResults(summary)
          // The variants are on disk but not in the index; a rescan is what
          // puts them in the grid and hides what they were made from.
          library.reload()
        },
        (error) => {
          unlisten()
          setUpscaling(null)
          void showMessage(String(error), { title: 'Could not upscale' })
        },
      ),
    )
  }, [selected, library])

  /**
   * Ask for one picture at 4K, from the lightbox, without interrupting anything.
   *
   * Refused for a picture that is already there, and for one that already has a
   * variant — both would spend minutes of GPU to produce a file that exists.
   * The backend refuses the first as well (`already_large`), but a queue that
   * fills with no-ops would still make the ones behind them wait.
   */
  const queueUpscale = useCallback((item: MediaItem) => {
    if (isFourK(item.width, item.height)) {
      toast(`${item.name} is already 4K`, 'muted')
      return
    }
    if (item.upscaledTo) {
      toast(`${item.name} already has a 4K version`, 'muted')
      return
    }
    setUpscaleQueue((current) => {
      if (current.includes(item.id)) return current
      toast(`Queued ${item.name} for 4K`, 'picked')
      return [...current, item.id]
    })
  }, [])

  /**
   * Drain that queue, one picture at a time, whenever the GPU is free.
   *
   * Three things can hold it: a foreground batch from the selection toolbar,
   * another background upscale still running, and Forge generating. The first
   * two are ours and are simply waited for; Forge is asked every few seconds,
   * because a generation finishing is not something this app is told about.
   *
   * An unreachable Forge counts as free, the same as it does for the toolbar
   * button — this is a gate against competing for the card, not against Forge
   * being closed.
   */
  useEffect(() => {
    if (upscaleQueue.length === 0) return
    if (backgroundUpscale !== null || upscaling !== null) return

    let cancelled = false
    const attempt = () => {
      void forgeStatus().then(
        (status) => {
          if (cancelled || status.busy) return
          start()
        },
        () => {
          if (!cancelled) start()
        },
      )
    }
    const start = () => {
      const next = upscaleQueue[0]
      if (next === undefined) return
      setUpscaleQueue((current) => current.slice(1))
      setBackgroundUpscale(next)
      void upscaleMedia([next]).then(
        () => {
          setBackgroundUpscale(null)
          // Held back while the lightbox is up: see `pendingReload`.
          if (openIdRef.current === null) library.reload()
          else pendingReload.current = true
        },
        (error: unknown) => {
          setBackgroundUpscale(null)
          // A toast rather than a dialog. This was asked for with one key in
          // the middle of something else, and a modal over the picture being
          // reviewed is a worse interruption than the failure is a problem.
          toast(`Could not upscale: ${String(error)}`, 'muted')
        },
      )
    }

    attempt()
    const timer = setInterval(attempt, FORGE_RETRY_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [upscaleQueue, backgroundUpscale, upscaling, library])

  // The deferred reload, once the lightbox is out of the way.
  useEffect(() => {
    if (openId !== null || !pendingReload.current) return
    pendingReload.current = false
    library.reload()
  }, [openId, library])

  /**
   * The lightbox's judgement keys, over a selection, from the grid.
   *
   * The same gesture has to mean the same thing in both places. Having Delete
   * and 1-5 work over one picture in the lightbox but do nothing over fifty in
   * the grid is the kind of gap you only notice by pressing a key and watching
   * nothing happen.
   *
   * Only while a selection exists and the lightbox is closed — the lightbox
   * owns the keyboard when it is up, and these must not fire twice.
   */
  useEffect(() => {
    if (openId !== null || selected.size === 0) return

    const onKey = (event: KeyboardEvent) => {
      // Never steal a key from a field. The search box is one Tab away and a
      // stray listener eating digits is exactly how "00166" becomes unsearchable.
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return
      }
      // Bare keys only: Ctrl-0 resets the browser zoom, and stealing that would
      // be worse than not having the shortcut.
      if (event.ctrlKey || event.metaKey || event.altKey) return

      if (event.key === 'Delete') {
        // Auto-repeat ignored, so holding the key cannot open the confirmation
        // and answer it in one gesture.
        if (event.repeat) return
        event.preventDefault()
        deleteSelected()
        return
      }

      if (!/^[0-5]$/.test(event.key)) return
      event.preventDefault()
      const digit = Number(event.key)
      const ids = [...selected]
      void setStarsMany(ids, digit === 0 ? null : digit).then(
        () => library.reload(),
        (error: unknown) => showMessage(String(error), { title: 'Could not rate' }),
      )
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId, selected, deleteSelected, library])

  // Ctrl turns selecting on, from the grid, the moment it goes down.
  //
  // Optimistic rather than patient. Waiting for the key to come back up is
  // correct and feels broken — the mode should be there by the time you have
  // finished pressing. So it switches on immediately and *takes it back* if the
  // Ctrl turns out to have been the first half of a combination: press Ctrl-K
  // and the mode flicks on and straight off again, which is the right trade
  // when the alternative is a shortcut that always lags.
  //
  // Taken back only when this keydown is what turned it on. A mode that was
  // already on is left alone, because leaving it discards the selection and a
  // set assembled by hand must not be destroyed by typing Ctrl-C.
  //
  // The way back *out* by keyboard is a **double tap**: two bare taps of Ctrl
  // inside {@link DOUBLE_TAP_MS} leave the mode exactly like the toolbar button
  // — selection dropped and all.
  //
  // Only *bare* taps count, and that is the whole safety of the thing. A press
  // that had another key with it, or a click while it was held, is not a tap at
  // all: so Ctrl-C followed straight away by Ctrl-V cannot destroy a selection,
  // and neither can holding Ctrl to pick a run of pictures. Whether a press was
  // bare is only known when it comes *up*, which is why the pairing happens on
  // keyup rather than on the way down like the mode itself.
  //
  // This replaced a 1.5-second hold. The hold was unusable in practice: a
  // second and a half is long enough to feel broken, there is nothing on screen
  // counting it down, and letting go a moment early does nothing at all — so
  // the only feedback for getting it wrong is that nothing happened.
  useEffect(() => {
    // Not while the lightbox is up: it owns the keyboard there, and Ctrl is
    // held for its own shortcuts.
    if (openId !== null) return

    let down = false
    let opened = false
    /** Whether the Ctrl now held is still a bare tap: no other key, no click. */
    let bare = false
    /** A first tap is waiting for its partner. */
    let pairing: ReturnType<typeof setTimeout> | undefined

    const forgetFirstTap = () => {
      if (pairing === undefined) return
      clearTimeout(pairing)
      pairing = undefined
    }

    const revert = () => {
      if (!opened) return
      opened = false
      setSelecting(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Control') {
        // Auto-repeat fires keydown over and over while the key is held.
        // The browser's own flag rather than one kept here: a kept flag went
        // stale whenever the keyup landed in another window — press Ctrl,
        // click over into Forge, come back — and then it ate every following
        // press whole. Nothing turned on, nothing timed out, no error.
        if (event.repeat) return
        down = true

        const target = event.target as HTMLElement | null
        const tag = target?.tagName
        if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          // Not a tap either: Ctrl pressed inside the search box is on its way
          // to being Ctrl-A, and must never pair with one pressed outside it.
          bare = false
          return
        }
        bare = true
        opened = !selectingRef.current
        if (opened) setSelecting(true)
        return
      }
      // Anything else pressed between two taps means they were not one
      // gesture. Unconditional, because this is true whether or not a Ctrl is
      // still held: tap Ctrl, type something, tap Ctrl is two separate taps.
      forgetFirstTap()
      if (down) {
        bare = false
        revert()
      }
    }
    // A click while Ctrl is still held is someone *using* the mode they just
    // turned on — hold Ctrl, click several pictures, let go — not the second
    // half of a Ctrl-click combination, and not a tap.
    //
    // So this does not take the mode back; it gives up the right to. Reverting
    // here fired before the click reached the grid, so `selecting` was false by
    // the time the tile was handled and it opened the lightbox instead. And
    // once picking has started the mode has to be safe from a later Ctrl-C,
    // which clearing this achieves.
    const onPointerDown = () => {
      opened = false
      bare = false
      // And it separates two taps for the same reason a keypress does: tap
      // Ctrl, pick a picture, tap Ctrl is somebody using the mode, not asking
      // to leave it.
      forgetFirstTap()
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Control') return
      down = false
      opened = false
      if (!bare) return
      bare = false

      if (pairing !== undefined) {
        forgetFirstTap()
        setSelecting(false)
        setSelected(new Set())
        anchor.current = null
        return
      }
      pairing = setTimeout(() => {
        pairing = undefined
      }, DOUBLE_TAP_MS)
    }
    // Focus left with the key still down: the keyup is going to another
    // window and nothing more is coming. Holding Ctrl across a switch to
    // Forge must not leave a half-pressed state behind — and a tap made before
    // leaving must not pair with one made on the way back.
    const onBlur = () => {
      down = false
      opened = false
      bare = false
      forgetFirstTap()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('blur', onBlur)
    return () => {
      forgetFirstTap()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [openId])

  // Watch Forge while a selection is open, so the upscale button can decline
  // to compete for the GPU.
  //
  // Only while selecting: this is a request per tick to another local process,
  // and there is no reason to make it when the button it guards is not on
  // screen. Stops again the moment a run starts, because by then the answer no
  // longer changes anything.
  useEffect(() => {
    if (!selecting || upscaling !== null) {
      setForge(null)
      return
    }
    let cancelled = false
    const poll = () => {
      void forgeStatus().then(
        (status) => {
          if (!cancelled) setForge(status)
        },
        // A failure here must not disable the button — it is a gate against a
        // busy Forge, not against an unreachable one.
        () => {
          if (!cancelled) setForge(null)
        },
      )
    }
    poll()
    const timer = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [selecting, upscaling])

  // A selection outlives the filter it was made under. Without this, narrowing
  // and then acting would run over rows that left the screen some time ago.
  useEffect(() => {
    const ids = items.map((item) => item.id)
    setSelected((previous) => {
      const next = retainVisible(previous, ids)
      // Identity is kept when nothing was dropped: `items` changes on every
      // page of an infinite scroll, and a fresh Set each time would redraw the
      // whole grid for nothing.
      return next.size === previous.size ? previous : next
    })
  }, [items])

  // Where the open row sits in the filtered list. The lightbox needs its
  // neighbours, and this is the only place that knows them — it is the same
  // list `step` walks, so "next" means the same thing to both.
  const openIndex = openId === null ? -1 : items.findIndex((item) => item.id === openId)

  // Thumbnails to fetch while the current row is on screen. Two forward and one
  // back, which is the shape of how a lightbox is actually walked: mostly
  // onwards, occasionally one step of overshoot.
  const preload = useMemo(() => {
    if (openIndex < 0) return []
    return [1, 2, -1]
      .map((delta) => items[openIndex + delta]?.thumbPath)
      .filter((path): path is string => Boolean(path))
  }, [items, openIndex])

  if (!isTauri()) {
    return (
      <div className="grid h-dvh place-items-center bg-zinc-950 text-zinc-400">
        <EmptyState
          title="Luma Vault runs as a desktop app"
          hint="This page is the UI shell on its own. Start the real thing with `pnpm dev:desktop`, which builds the Rust backend that indexes folders and serves local files."
        />
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-zinc-200">
      <div className="flex min-h-0 flex-1">
        <FolderSidebar
          folders={folders}
          stats={library.stats}
          characters={library.characters}
          // The name is a ready-made search term: detection found it verbatim
          // in the prompt, and search runs over prompts.
          onCharacter={(name) => setQuery({ search: name })}
          tileSize={tileSize}
          onTileSize={(size) => {
            setTileSize(size)
            // Written on change rather than in an effect: an effect would also
            // fire on mount and write back the value it just read.
            globalThis.localStorage?.setItem(TILE_SIZE_KEY, String(size))
          }}
          selectedFolderId={query.folderId}
          onSelect={(folderId) => setQuery({ folderId })}
          onAdd={() => void actions.addFolder()}
          onRemove={(id) => void actions.removeFolder(id)}
          onRescan={(id) => void actions.rescanFolder(id)}
          onRetryFailed={() => void actions.retryFailed(query.folderId)}
          exclusions={library.exclusions}
          onInclude={(path) => void actions.includeFolder(path)}
          onImportRatings={() => {
            void actions.importRatings().then((summary) => {
              if (!summary) return
              // A modal, not a toast: this runs once and the numbers matter
              // enough to be worth reading. `applied` and `staged` differ
              // whenever the folders are not scanned yet, which is the
              // expected order rather than a failure.
              void showMessage(
                [
                  `Imported ${summary.staged.toLocaleString()} of ${summary.found.toLocaleString()} ratings.`,
                  `${summary.applied.toLocaleString()} matched files already in the library; ` +
                    'the rest attach as their folders are scanned.',
                  summary.unrecognised > 0
                    ? `${summary.unrecognised.toLocaleString()} had no recognisable output path and were skipped.`
                    : '',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
                { title: 'Ratings imported' },
              )
            })
          }}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <FilterBar
            query={query}
            total={library.total}
            shown={items.length}
            showBoxes={showBoxes}
            onToggleBoxes={() => setShowBoxes((previous) => !previous)}
            timeline={showTimeline}
            onToggleTimeline={() => {
              setShowTimeline((previous) => {
                // Closing the panel clears its narrowing. A range with no bars
                // on screen would be an invisible filter — the grid quietly
                // small and nothing saying why.
                if (previous) setQuery({ modifiedAfter: null, modifiedBefore: null })
                return !previous
              })
            }}
            selecting={selecting}
            onToggleSelecting={() => {
              // Leaving the mode drops the selection. Keeping it would mean
              // an invisible set of pictures that an action could later run
              // over, which is exactly the surprise this mode exists to
              // avoid.
              setSelecting((previous) => !previous)
              setSelected(new Set())
              anchor.current = null
            }}
            onFindDuplicates={() => {
              void actions.findDuplicates().then((report) => {
                if (report.files === 0) {
                  void showMessage(
                    `No duplicates found across ${report.hashed.toLocaleString()} fingerprinted images.`,
                    { title: 'No duplicates' },
                  )
                  return
                }
                void showMessage(
                  [
                    `${report.files.toLocaleString()} files in ${report.groups.toLocaleString()} groups ` +
                      `(${report.imageGroups.toLocaleString()} image, ${report.videoGroups.toLocaleString()} video).`,
                    report.skippedCommon > 0
                      ? `${report.skippedCommon.toLocaleString()} blank or flat-coloured images were ` +
                        'skipped — they all look alike and are not copies of each other.'
                      : '',
                  ]
                    .filter(Boolean)
                    .join('\n\n'),
                  { title: 'Duplicates found' },
                )
              })
            }}
            onChange={setQuery}
          />

          {showTimeline ? (
            <TimelinePanel
              query={query}
              onRange={(range) =>
                setQuery(
                  range
                    ? { modifiedAfter: range.after, modifiedBefore: range.before }
                    : { modifiedAfter: null, modifiedBefore: null },
                )
              }
            />
          ) : null}

          <SearchBar
            value={query.search}
            onChange={(search) => setQuery({ search })}
            searchPaths={query.searchPaths}
            onSearchPathsChange={(searchPaths) => setQuery({ searchPaths })}
            matches={library.total}
            loading={library.loading}
          />

          {/* Only while selecting, and above the grid rather than floating over
              it: a count that covers pictures is a count you have to move to
              read. */}
          {selecting ? (
            <div className="flex items-center gap-2 border-b border-indigo-400/20 bg-indigo-500/10 px-4 py-1.5 text-xs">
              <span className="tabular-nums text-indigo-200">
                {selected.size === 0
                  ? 'Nothing selected'
                  : `${selected.size.toLocaleString()} selected`}
              </span>
              <span className="text-indigo-300/50">
                Click to pick one, shift-click for everything between
              </span>
              <button
                type="button"
                disabled={selected.size === 0 || upscaling !== null || forge?.busy === true}
                onClick={runUpscale}
                title={
                  forge?.busy
                    ? `Forge is generating${forge.job ? ` — ${forge.job}` : ''}. Both want the whole GPU, so running them together makes each take about twice as long.`
                    : 'Run each through a local upscale model and resample to 3840px on the long edge. Results are written beside the originals.'
                }
                className="ml-auto mr-2 rounded-full bg-indigo-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-400 disabled:cursor-default disabled:bg-indigo-500/30 disabled:text-white/50"
              >
                {upscaling
                  ? `Upscaling ${upscaling.done}/${upscaling.total}…`
                  : forge?.busy
                    ? 'Forge is busy'
                    : `Upscale ${selected.size.toLocaleString()} to 4K`}
              </button>

              <button
                type="button"
                disabled={selected.size === 0 || upscaling !== null}
                onClick={reviewForDeviantArt}
                title="Review titles, tags and mature flags, then upload to DeviantArt. Nothing is posted without a second click."
                className="mr-2 rounded-full bg-white/5 px-3 py-1 text-[11px] font-medium text-zinc-300 hover:bg-white/10 hover:text-zinc-100 disabled:cursor-default disabled:bg-white/5 disabled:text-zinc-600"
              >
                DeviantArt…
              </button>

              <button
                type="button"
                disabled={selected.size === 0 || upscaling !== null}
                onClick={deleteSelected}
                title="Delete every selected file"
                className="rounded-full bg-red-500/15 px-3 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/25 hover:text-red-200 disabled:cursor-default disabled:bg-red-500/5 disabled:text-red-300/30"
              >
                Delete {selected.size.toLocaleString()}
              </button>

              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelected(new Set(items.map((item) => item.id)))
                    anchor.current = items.at(-1)?.id ?? null
                  }}
                  className="text-indigo-300 underline decoration-dotted underline-offset-2 hover:text-indigo-100"
                >
                  Select all {items.length.toLocaleString()}
                </button>
                <button
                  type="button"
                  disabled={selected.size === 0}
                  onClick={() => {
                    setSelected(new Set())
                    anchor.current = null
                  }}
                  className="text-indigo-300 underline decoration-dotted underline-offset-2 hover:text-indigo-100 disabled:cursor-default disabled:text-indigo-300/30 disabled:no-underline"
                >
                  Clear
                </button>
              </span>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {folders.length === 0 ? (
              <EmptyState
                title="No folders watched yet"
                hint="Add a folder and Luma Vault indexes every image and video inside it, builds thumbnails, and classifies everything locally. Nothing is uploaded and nothing is moved."
                action={
                  <Button variant="primary" onClick={() => void actions.addFolder()}>
                    Choose a folder
                  </Button>
                }
              />
            ) : (
              <>
                <div className="p-4">
                  {items.length === 0 && !library.loading ? (
                    <EmptyState
                      title={query.search ? `Nothing matches "${query.search}"` : 'Nothing matches these filters'}
                      hint={
                        query.search
                          ? 'Filenames and prompts are both searched. Three characters minimum, and every word has to appear.'
                          : 'Clear a filter, or wait for the scan to finish if it is still running.'
                      }
                    />
                  ) : (
                    <MediaGrid
                      items={items}
                      onOpen={openOrSelect}
                      onReachEnd={library.loadMore}
                      showBoxes={showBoxes}
                      groupDuplicates={query.duplicatesOnly}
                      tileSize={tileSize}
                      selected={selected}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      <StatusBar
        progress={progress}
        environment={library.environment}
        onSetThrottle={(level) => void actions.setThrottle(level)}
        remote={remote.status}
        share={remote.share}
        onOpenRemote={() => setShowRemote(true)}
      />

      {showRemote ? (
        <RemoteDialog remote={remote} onClose={() => setShowRemote(false)} />
      ) : null}

      {openId !== null ? (
        <Lightbox
          mediaId={openId}
          // The grid already holds this row, so the lightbox has something to
          // draw before `mediaById` answers.
          seed={items[openIndex] ?? null}
          preload={preload}
          onClose={() => setOpenId(null)}
          onStep={step}
          // Reaches a row the grid is not showing — the original behind an
          // upscaled variant — so it sets the open id directly rather than
          // walking the filtered list the way `onStep` does.
          onOpenId={setOpenId}
          onUpscale={queueUpscale}
          onToggleSelect={toggleSelect}
          selected={selected.has(openId)}
          showBoxes={showLightboxBoxes}
          onToggleBoxes={() => setShowLightboxBoxes((previous) => !previous)}
          showGeneration={showGeneration}
          onToggleGeneration={() => setShowGeneration((previous) => !previous)}
          onDeleted={(deletedId) => {
            // Step to the next item rather than closing. Deleting is usually
            // something you do to a run of files — a duplicate set, a bad
            // batch — and closing the lightbox after each one turns that into
            // reopen, look, delete, reopen.
            const index = items.findIndex((entry) => entry.id === deletedId)
            const next = items[index + 1] ?? items[index - 1]
            setOpenId(next && next.id !== deletedId ? next.id : null)
            library.reload()
          }}
          onExcludeFolder={(folder) => {
            // Close first: the item on screen is one of the rows about to be
            // removed, so leaving the lightbox open would have it displaying
            // something the library no longer contains.
            setOpenId(null)
            void actions.excludeFolder(folder).then((removed) => {
              void showMessage(`Removed ${removed.toLocaleString()} files from the library.`, {
                title: 'Folder excluded',
              })
            })
          }}
        />
      ) : null}

      {upscaleResults ? (
        <UpscaleResults summary={upscaleResults} onClose={() => setUpscaleResults(null)} />
      ) : null}

      {publishing ? (
        <DeviantArtPanel items={publishing} onClose={() => setPublishing(null)} />
      ) : null}

      <DialogHost />
      <ToastHost />
    </div>
  )
}
