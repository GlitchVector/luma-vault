import { Button, EmptyState } from '@luma/ui'
import { useCallback, useState } from 'react'
import { FilterBar } from '#/components/FilterBar.tsx'
import { FolderSidebar } from '#/components/FolderSidebar.tsx'
import { Lightbox } from '#/components/Lightbox.tsx'
import { MediaGrid } from '#/components/MediaGrid.tsx'
import { SearchBar } from '#/components/SearchBar.tsx'
import { DialogHost } from '#/components/DialogHost.tsx'
import { StatusBar } from '#/components/StatusBar.tsx'
import { showMessage } from '#/lib/dialogs.ts'
import { isTauri } from '#/lib/native.ts'
import { useLibrary } from '#/lib/useLibrary.ts'

export function App() {
  const library = useLibrary()
  const [openId, setOpenId] = useState<number | null>(null)
  const [showBoxes, setShowBoxes] = useState(false)
  // Lives here rather than in the Lightbox so it survives closing one. The
  // Lightbox is mounted per-item, so local state reset the toggle every time
  // you opened a file. Deliberately separate from `showBoxes` above, which is
  // the grid's label pill and a different question.
  const [showLightboxBoxes, setShowLightboxBoxes] = useState(true)
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
                      onOpen={setOpenId}
                      onReachEnd={library.loadMore}
                      showBoxes={showBoxes}
                      groupDuplicates={query.duplicatesOnly}
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
          onClose={() => setOpenId(null)}
          onStep={step}
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

      <DialogHost />
    </div>
  )
}
