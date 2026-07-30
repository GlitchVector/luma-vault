import { Button, EmptyState } from '@luma/ui'
import { useCallback, useMemo, useState } from 'react'
import { FilterBar } from '#/components/FilterBar.tsx'
import { FolderSidebar } from '#/components/FolderSidebar.tsx'
import { Lightbox } from '#/components/Lightbox.tsx'
import { MediaGrid } from '#/components/MediaGrid.tsx'
import { RecentStrip } from '#/components/RecentStrip.tsx'
import { StatusBar } from '#/components/StatusBar.tsx'
import { isTauri } from '#/lib/native.ts'
import { useLibrary } from '#/lib/useLibrary.ts'

export function App() {
  const library = useLibrary()
  const [openId, setOpenId] = useState<number | null>(null)
  const [showBoxes, setShowBoxes] = useState(false)

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

  const recentRevision = useMemo(
    // Refetch the strip when a scan settles, not on every progress tick.
    () => (progress.phase === 'done' || progress.phase === 'idle' ? folders.length + items.length : 0),
    [progress.phase, folders.length, items.length],
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
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <FilterBar
            query={query}
            total={library.total}
            shown={items.length}
            showBoxes={showBoxes}
            onToggleBoxes={() => setShowBoxes((previous) => !previous)}
            onChange={setQuery}
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
                <RecentStrip revision={recentRevision} onOpen={setOpenId} />

                <div className="p-4">
                  {items.length === 0 && !library.loading ? (
                    <EmptyState
                      title="Nothing matches these filters"
                      hint="Clear a filter, or wait for the scan to finish if it is still running."
                    />
                  ) : (
                    <MediaGrid
                      items={items}
                      onOpen={setOpenId}
                      onReachEnd={library.loadMore}
                      showBoxes={showBoxes}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      <StatusBar progress={progress} environment={library.environment} />

      {openId !== null ? (
        <Lightbox mediaId={openId} onClose={() => setOpenId(null)} onStep={step} />
      ) : null}
    </div>
  )
}
