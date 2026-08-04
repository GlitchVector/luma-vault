import { Button, EmptyState } from '@luma/ui'
import { hasRecycleBin, rangeBetween, retainVisible, toggleSelected } from '@luma/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilterBar } from '#/components/FilterBar.tsx'
import { FolderSidebar } from '#/components/FolderSidebar.tsx'
import { Lightbox } from '#/components/Lightbox.tsx'
import { MediaGrid } from '#/components/MediaGrid.tsx'
import { DEFAULT_TILE_SIZE, MAX_TILE_SIZE, MIN_TILE_SIZE } from '#/components/MediaTile.tsx'
import { SearchBar } from '#/components/SearchBar.tsx'
import { DialogHost } from '#/components/DialogHost.tsx'
import { StatusBar } from '#/components/StatusBar.tsx'
import { UpscaleResults } from '#/components/UpscaleResults.tsx'
import { askConfirm, showMessage } from '#/lib/dialogs.ts'
import {
  deleteMedia,
  isTauri,
  onUpscaleProgress,
  upscaleMedia,
  type UpscaleProgress,
  type UpscaleSummary,
} from '#/lib/native.ts'
import { useLibrary } from '#/lib/useLibrary.ts'

const TILE_SIZE_KEY = 'luma.tileSize'

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
  // The batch in flight, and what it produced. Two pieces of state rather
  // than one: the progress has to keep updating while the run is going, and
  // the summary only exists once it has finished.
  const [upscaling, setUpscaling] = useState<UpscaleProgress | null>(null)
  const [upscaleResults, setUpscaleResults] = useState<UpscaleSummary | null>(null)
  const [showBoxes, setShowBoxes] = useState(false)
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
  const [showGeneration, setShowGeneration] = useState(false)
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
  useEffect(() => {
    // Not while the lightbox is up: it owns the keyboard there, and Ctrl is
    // held for its own shortcuts.
    if (openId !== null) return

    let down = false
    let opened = false

    const revert = () => {
      if (!opened) return
      opened = false
      setSelecting(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Control') {
        // Auto-repeat fires keydown over and over while the key is held.
        if (down) return
        down = true

        const target = event.target as HTMLElement | null
        const tag = target?.tagName
        if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          return
        }
        opened = !selectingRef.current
        if (opened) setSelecting(true)
        return
      }
      if (down) revert()
    }
    // A Ctrl-click is a combination too, even though the second half is not a key.
    const onPointerDown = () => {
      if (down) revert()
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Control') return
      down = false
      opened = false
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [openId])

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

          <SearchBar
            value={query.search}
            onChange={(search) => setQuery({ search })}
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
                disabled={selected.size === 0 || upscaling !== null}
                onClick={runUpscale}
                title="Run each through a local upscale model and resample to 3840px on the long edge. Results are written beside the originals."
                className="ml-auto mr-2 rounded-full bg-indigo-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-400 disabled:cursor-default disabled:bg-indigo-500/30 disabled:text-white/50"
              >
                {upscaling
                  ? `Upscaling ${upscaling.done}/${upscaling.total}…`
                  : `Upscale ${selected.size.toLocaleString()} to 4K`}
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
      />

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
          onToggleSelect={toggleSelect}
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

      <DialogHost />
    </div>
  )
}
