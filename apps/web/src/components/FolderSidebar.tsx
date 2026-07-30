import { basenameOf, type Folder, type LibraryStats } from '@luma/core'
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
    </aside>
  )
}
