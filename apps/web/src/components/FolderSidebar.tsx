import { basenameOf, displayPath, type Folder, type LibraryStats } from '@luma/core'
import { Button, cn } from '@luma/ui'

interface FolderSidebarProps {
  folders: Folder[]
  stats: LibraryStats | null
  selectedFolderId: number | null
  onSelect: (folderId: number | null) => void
  onAdd: () => void
  onRemove: (id: number) => void
  onRescan: (id: number) => void
  onRetryFailed: () => void
  onImportRatings: () => void
  exclusions: string[]
  onInclude: (path: string) => void
}

export function FolderSidebar({
  folders,
  stats,
  selectedFolderId,
  onSelect,
  onAdd,
  onRemove,
  onRescan,
  onRetryFailed,
  onImportRatings,
  exclusions,
  onInclude,
}: FolderSidebarProps) {
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-3 border-r border-white/5 bg-zinc-950/60 p-3">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold tracking-tight text-zinc-200">Luma Vault</h1>
        <Button size="sm" variant="primary" onClick={onAdd} title="Watch another folder">
          Add
        </Button>
      </div>

      <nav className="flex flex-col gap-0.5">
        {/* The unified view is the default and the point of the app: one grid
            across every watched folder, rather than a folder browser. */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            'rounded px-2 py-1.5 text-left text-xs transition-colors',
            selectedFolderId === null
              ? 'bg-indigo-500/20 text-indigo-200'
              : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
          )}
        >
          All folders
          {stats ? (
            <span className="ml-1.5 tabular-nums text-zinc-500">
              {stats.images + stats.videos}
            </span>
          ) : null}
        </button>

        {folders.map((folder) => (
          <div key={folder.id} className="group relative">
            <button
              type="button"
              onClick={() => onSelect(folder.id)}
              title={folder.path}
              className={cn(
                'w-full truncate rounded px-2 py-1.5 pr-14 text-left text-xs transition-colors',
                selectedFolderId === folder.id
                  ? 'bg-indigo-500/20 text-indigo-200'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
                !folder.available && 'text-zinc-600 italic',
              )}
            >
              {basenameOf(folder.path) || folder.path}
              <span className="ml-1.5 tabular-nums text-zinc-500">{folder.mediaCount}</span>
              {!folder.available ? (
                <span className="ml-1 text-amber-500/70" title="This folder is not reachable">
                  ·
                </span>
              ) : null}
            </button>

            <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
              <button
                type="button"
                onClick={() => onRescan(folder.id)}
                title="Rescan this folder"
                className="rounded px-1 text-[10px] text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
              >
                ⟳
              </button>
              <button
                type="button"
                onClick={() => onRemove(folder.id)}
                title="Stop watching this folder (files are never deleted)"
                className="rounded px-1 text-[10px] text-zinc-500 hover:bg-red-500/20 hover:text-red-300"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </nav>

      {stats ? (
        <dl className="mt-auto grid grid-cols-2 gap-x-2 gap-y-1 border-t border-white/5 pt-3 text-[11px] text-zinc-500">
          <dt>Images</dt>
          <dd className="text-right tabular-nums text-zinc-300">{stats.images.toLocaleString()}</dd>
          <dt>Videos</dt>
          <dd className="text-right tabular-nums text-zinc-300">{stats.videos.toLocaleString()}</dd>
          <dt>Rated</dt>
          <dd className="text-right tabular-nums text-zinc-300">
            {stats.classified.toLocaleString()}
          </dd>
          {stats.pending > 0 ? (
            <>
              <dt>Pending</dt>
              <dd className="text-right tabular-nums text-amber-300">
                {stats.pending.toLocaleString()}
              </dd>
            </>
          ) : null}
          {/* A skipped file is otherwise invisible — the library is just
              quietly smaller than the folder. Say so, and offer a retry, since
              a whole batch can fail for one fixable reason. */}
          {stats.failed > 0 ? (
            <>
              <dt>Skipped</dt>
              <dd className="text-right">
                <button
                  type="button"
                  onClick={onRetryFailed}
                  title="These files could not be read. Click to try them again."
                  className="tabular-nums text-red-300 underline decoration-dotted underline-offset-2 hover:text-red-200"
                >
                  {stats.failed.toLocaleString()}
                </button>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {/* Excluded folders are otherwise invisible: the library is simply
          smaller than the folder, with nothing saying why. Listing them is what
          makes the exclusion undoable rather than a thing you did once. */}
      {exclusions.length > 0 ? (
        <details className="border-t border-white/5 pt-2 text-[11px]">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
            Excluded ({exclusions.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {exclusions.map((path) => (
              <li key={path} className="group flex items-center gap-1">
                <span
                  className="min-w-0 flex-1 truncate text-zinc-600"
                  title={displayPath(path)}
                >
                  {basenameOf(path) || displayPath(path)}
                </span>
                <button
                  type="button"
                  onClick={() => onInclude(path)}
                  title={`Scan ${displayPath(path)} again`}
                  className="shrink-0 rounded px-1 text-zinc-600 opacity-0 hover:bg-white/10 hover:text-zinc-200 group-hover:opacity-100"
                >
                  undo
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Ratings from a previous life. Deliberately at the bottom and quiet:
          it is a one-off migration, not something anyone does twice. */}
      <button
        type="button"
        onClick={onImportRatings}
        title="Import 1-5 star ratings from a Stable Diffusion Image Browser database (wib.sqlite3). Ratings for folders you have not scanned yet are kept and attach when you do."
        className="text-left text-[11px] text-zinc-600 underline decoration-dotted underline-offset-2 hover:text-zinc-400"
      >
        Import ratings…
      </button>
    </aside>
  )
}
