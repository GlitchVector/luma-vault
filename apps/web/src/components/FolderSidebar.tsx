import {
  basenameOf,
  displayPath,
  type CharacterCount,
  type Folder,
  type LibraryStats,
  type SetSummary,
} from '@luma/core'
import { Button, cn } from '@luma/ui'
import { MAX_TILE_SIZE, MIN_TILE_SIZE } from './MediaTile.tsx'

interface FolderSidebarProps {
  folders: Folder[]
  stats: LibraryStats | null
  /** The most-depicted characters, biggest first. Empty until detection ran. */
  characters: CharacterCount[]
  /** A name was clicked: filter the grid to it. */
  onCharacter: (name: string) => void
  /**
   * The command runs the grid can currently see, newest first.
   *
   * Fetched whether or not the sets list is showing, because the *switch* has
   * to know whether there is anything behind it: a tab that opens onto "no sets
   * yet" reads as broken, and one that is hidden until the first run appears
   * explains itself.
   */
  sets: SetSummary[]
  /** Which list the panel is showing. Characters is the default. */
  listing: 'characters' | 'sets'
  onListing: (listing: 'characters' | 'sets') => void
  /** The run currently filtering the grid, if any. */
  selectedSet: string | null
  /** A set was clicked — or the same one again, which clears it. */
  onSet: (run: string | null) => void
  /** Longest edge of a grid tile, in CSS pixels. */
  tileSize: number
  onTileSize: (size: number) => void
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
  characters,
  onCharacter,
  sets,
  listing,
  onListing,
  selectedSet,
  onSet,
  tileSize,
  onTileSize,
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

      {/* Stats and the size slider share one block, and it is the block that
          takes up the slack — so both sit against the bottom of the sidebar
          however many folders are in the list above. The slider is grouped with
          them rather than with the buttons because it is the same kind of
          thing: a property of the view, not an action on the library. */}
      {/* Who the library is of. Above the stats, because it answers the same
          kind of question they do — what is in here — and clicking through to
          the grid is the point: the name becomes the search term, which works
          because detection found it verbatim in the prompts search runs over. */}
      {characters.length > 0 || sets.length > 0 ? (
        // `min-h-0` + an inner scroll: the list takes whatever height sits
        // between the folders and the stats, so a tall window shows all
        // thirty and a short one shows what fits and scrolls for the rest —
        // CSS adapts, nothing measures.
        <div className="mt-auto flex min-h-0 shrink flex-col border-t border-white/5 pt-3">
          {/* Two answers to "what is in here": who, and which sitting. The
              heading is the switch rather than a control beside it — there is
              one decision, and a separate toggle would be a second place to
              look for it. Sets only offers itself once a run exists, so a
              library that has never been shot in shows exactly what it did
              before. */}
          <div className="mb-1 flex items-baseline gap-2 px-1">
            <SidebarTab
              label="Characters"
              active={listing === 'characters'}
              onClick={() => onListing('characters')}
            />
            {sets.length > 0 ? (
              <SidebarTab
                label="Sets"
                active={listing === 'sets'}
                onClick={() => onListing('sets')}
              />
            ) : null}
          </div>

          {listing === 'characters' ? (
            <ul className="flex min-h-0 flex-col overflow-y-auto">
              {characters.map((entry, index) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    onClick={() => onCharacter(entry.name)}
                    title={`Show only ${entry.name}`}
                    className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-[11px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                  >
                    {/* The rank, fixed-width so the names align in a column —
                        two digits is enough for a top 30. */}
                    <span className="w-5 shrink-0 text-right tabular-nums text-zinc-600">
                      {index + 1}.
                    </span>
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <span className="shrink-0 tabular-nums text-zinc-600">
                      {entry.count.toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <SetList sets={sets} selected={selectedSet} onSet={onSet} />
          )}
        </div>
      ) : null}

      <div
        className={
          characters.length > 0
            ? 'flex flex-col gap-2 border-t border-white/5 pt-3'
            : 'mt-auto flex flex-col gap-2 border-t border-white/5 pt-3'
        }
      >
      {stats ? (
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-zinc-500">
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

        {/* Tiny on purpose. It is set once in a while and then left alone, so
            it should read as a setting sitting under the numbers rather than
            compete with the folder list for attention. */}
        <label className="flex items-center gap-2 text-[11px] text-zinc-500">
          <span className="shrink-0">Size</span>
          <input
            type="range"
            min={MIN_TILE_SIZE}
            max={MAX_TILE_SIZE}
            step={20}
            value={tileSize}
            onChange={(event) => onTileSize(Number(event.target.value))}
            aria-label="Grid image size"
            title="How large each tile is drawn. Thumbnails are 512px whatever this says, so this costs nothing to change."
            className="h-1 min-w-0 flex-1 cursor-pointer accent-indigo-400"
          />
          <span className="w-6 shrink-0 text-right tabular-nums text-zinc-400">{tileSize}</span>
        </label>
      </div>

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

/**
 * One of the two list headings, which double as the switch between them.
 *
 * Styled as a heading rather than as a button on purpose: this is a label that
 * happens to be clickable, and a pair of real buttons up here would compete
 * with the folder list for the eye. The inactive one stays legible — a switch
 * whose other half is invisible is a switch nobody finds.
 */
function SidebarTab({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'text-[10px] font-medium uppercase tracking-wide transition-colors',
        active ? 'text-zinc-300' : 'text-zinc-600 hover:text-zinc-400',
      )}
    >
      {label}
    </button>
  )
}

/**
 * The sets, grouped under the character each run was of.
 *
 * Grouped here rather than by the query, because the grouping is presentation:
 * the backend answers "which runs can the grid see", and which heading a run
 * sits under is a question about this list. Runs come back newest first, so
 * both the groups and the runs inside them are in that order without sorting
 * anything twice — the character you last shot is the one at the top, which is
 * nearly always the one you are looking for.
 *
 * A run that could not name a character still lists, under "Other". Losing a
 * set because the command did not know who was in it would be worse than an
 * untidy heading.
 */
function SetList({
  sets,
  selected,
  onSet,
}: {
  sets: SetSummary[]
  selected: string | null
  onSet: (run: string | null) => void
}) {
  const groups: Array<[string, SetSummary[]]> = []
  for (const set of sets) {
    const name = set.character ?? 'Other'
    const group = groups.find(([existing]) => existing === name)
    if (group) group[1].push(set)
    else groups.push([name, [set]])
  }

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto">
      {groups.map(([name, runs]) => (
        <div key={name} className="mb-2">
          <h4 className="px-1 py-0.5 text-[11px] font-medium text-zinc-500">{name}</h4>
          <ul className="flex flex-col">
            {runs.map((set) => (
              <li key={set.run}>
                <button
                  type="button"
                  // Clicking the open set closes it. The alternative is a
                  // separate "show everything again" control, and the thing you
                  // want to un-press is the thing you pressed.
                  onClick={() => onSet(selected === set.run ? null : set.run)}
                  aria-pressed={selected === set.run}
                  title={`${set.command} · ${new Date(set.createdAt).toLocaleString()} · ${
                    set.count
                  } pictures`}
                  className={cn(
                    'flex w-full items-baseline gap-2 rounded px-1 py-0.5 pl-3 text-left text-[11px]',
                    selected === set.run
                      ? 'bg-indigo-500/20 text-indigo-200'
                      : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {set.title ?? set.command}
                    {/* The date is what tells two runs of the same command
                        apart, and there will be two. */}
                    <span className="ml-1 text-zinc-600">
                      {new Date(set.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-zinc-600">{set.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
