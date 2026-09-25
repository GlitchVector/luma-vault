import {
  basenameOf,
  CUSTOM_LORAS,
  displayPath,
  type CharacterCount,
  type Folder,
  type LibraryStats,
  type SetSummary,
} from '@luma/core'
import { Button, cn } from '@luma/ui'
import { useEffect, useState, type ReactNode } from 'react'

import { MAX_TILE_SIZE, MIN_TILE_SIZE } from './MediaTile.tsx'

/**
 * The `--set` command that a LoRA training round queues under, and therefore
 * the only thing that separates working material from a shoot. It is the first
 * segment of `--set lora/<character>-r1/<stamp>`.
 */
export const LORA_COMMAND = 'lora'
/** A comic's own set: eleven panels and three pages of one book, which is a
 *  different thing to look at from a shoot and does not belong beside one. */
export const COMIC_COMMAND = 'comic'

/**
 * The app's pages. The library is the grid and everything that filters it; the
 * other two are workspaces that have nothing to do with the grid. Owner's rule
 * (2026-09-21): a pill in the filter bar is a filter or a grid tool, never a
 * page — pages are navigation, and navigation lives here.
 */
export type Page = 'library' | 'loras' | 'comics' | 'chat'

interface FolderSidebarProps {
  folders: Folder[]
  stats: LibraryStats | null
  /** Which page is showing; the navigation highlights it. */
  page: Page
  onPage: (page: Page) => void
  /** The most-depicted characters, biggest first. Empty until detection ran. */
  characters: CharacterCount[]
  /** A name was clicked: filter the grid to it. */
  onCharacter: (name: string) => void
  /**
   * The command runs the grid can currently see, newest first.
   *
   * Fetched whether or not a sets section is open, because a section only
   * offers itself once there is something behind it: one that opens onto "no
   * sets yet" reads as broken, and one that is absent until the first run
   * appears explains itself.
   */
  sets: SetSummary[]
  /**
   * Every run the grid is showing. One entry is the ordinary case; more than
   * one is two shoots of the same character being read — and posted — as one
   * set. Order is selection order, which is what the merge tie-breaks on.
   */
  selectedSets: string[]
  /** The new selection, whole. Empty clears it. */
  onSets: (runs: string[]) => void
  /**
   * The title was clicked: go home — every folder, no set, no search.
   *
   * A wordmark that does nothing is a dead end on a phone, where the sidebar is
   * a drawer and there is no other obvious way back to "show me everything"
   * once a set is filtering the grid.
   */
  onHome: () => void
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
  /**
   * Receives the node the Comics page renders its comics list into, while that
   * page is open. The list belongs to the page's state; the sidebar only lends
   * it a section, so the section is here and the content arrives by portal.
   */
  comicsSlot?: (node: HTMLDivElement | null) => void
  /** The same for the Chat page's list of conversations. */
  chatSlot?: (node: HTMLDivElement | null) => void
}

export function FolderSidebar({
  folders,
  stats,
  page,
  onPage,
  characters,
  onCharacter,
  sets,
  selectedSets,
  onSets,
  onHome,
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
  comicsSlot,
  chatSlot,
}: FolderSidebarProps) {
  // Two audiences for the same record. A shoot is something to look at; a LoRA
  // round is working material — forty near-identical candidates that exist to be
  // judged once and then sit in the way. Mixed together the shoots drown, and
  // the owner asked for the split. `lora` is not a guess: `--set` is parsed as
  // <command>/<character>/<stamp>, and every training round is queued under
  // `lora/…`, so the command *is* the flag.
  const loraSets = sets.filter((set) => set.command === LORA_COMMAND)
  const comicSets = sets.filter((set) => set.command === COMIC_COMMAND)
  const shootSets = sets.filter((set) => set.command !== LORA_COMMAND && set.command !== COMIC_COMMAND)
  const holdsSelection = (runs: SetSummary[]) => runs.some((set) => selectedSets.includes(set.run))
  const libraryCount = stats ? stats.images + stats.videos : null

  // Characters, Sets and LoRA sets are an accordion: one open at a time (owner,
  // 2026-09-21), because each is a long list and two open together push the
  // third and the stats off the bottom. Folders and Comics fold on their own.
  // The open one is remembered; a stored choice that has nothing behind it
  // today falls back to the first list that does, while an explicit "all
  // closed" stays closed.
  const available: ListKey[] = [
    ...(characters.length > 0 ? (['characters'] as const) : []),
    ...(shootSets.length > 0 ? (['sets'] as const) : []),
    ...(loraSets.length > 0 ? (['lora'] as const) : []),
    ...(comicSets.length > 0 ? (['comic'] as const) : []),
  ]
  const [openList, setOpenList] = useState<ListKey | null>(() => readOpenList())
  const shownList = openList === null ? null : available.includes(openList) ? openList : (available[0] ?? null)
  const toggleList = (key: ListKey) => {
    const next = shownList === key ? null : key
    setOpenList(next)
    writeOpenList(next)
  }
  // A selection that lives in a closed list opens that list: a deep link into a
  // training round must not land on a folded heading.
  const selectionInSets = holdsSelection(shootSets)
  const selectionInLora = holdsSelection(loraSets)
  const selectionInComics = holdsSelection(comicSets)
  useEffect(() => {
    if (selectionInComics) setOpenList('comic')
    else if (selectionInLora) setOpenList('lora')
    else if (selectionInSets) setOpenList('sets')
  }, [selectionInSets, selectionInLora, selectionInComics])

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-3 border-r border-white/5 bg-zinc-950/60 p-3">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold tracking-tight">
          <button
            type="button"
            onClick={onHome}
            title="Show everything again"
            className="rounded text-zinc-200 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400"
          >
            Luma Vault
          </button>
        </h1>
        <Button size="sm" variant="primary" onClick={onAdd} title="Watch another folder">
          Add
        </Button>
      </div>

      {/* The pages. Always open and never collapsible: this is how you get
          anywhere, so it cannot be folded away by accident. */}
      <nav aria-label="Pages" className="flex flex-col gap-0.5">
        <SectionHeading>Navigation</SectionHeading>
        <NavEntry
          label="Library"
          count={libraryCount}
          active={page === 'library'}
          onClick={() => onPage('library')}
          title="The grid: every picture and video in the watched folders"
        />
        <NavEntry
          label="LoRAs"
          count={CUSTOM_LORAS.length}
          active={page === 'loras'}
          onClick={() => onPage('loras')}
          title="The LoRAs trained here: which version to reach for, what she looks like, and a few of her own renders"
        />
        <NavEntry
          label="Comics"
          count={null}
          active={page === 'comics'}
          onClick={() => onPage('comics')}
          title="Write a story, have it scripted into panels, render them with Forge, and letter the pages"
        />
        <NavEntry
          label="Chat"
          count={null}
          active={page === 'chat'}
          onClick={() => onPage('chat')}
          title="Talk to Claude Code about the vault, from inside it: it runs in the repository and can read and change anything here"
        />
      </nav>

      {/* The library's own sections. They stay in view on every page, because
          a pick in any of them is a way back to the grid — and on the LoRAs
          page that is the way out. `min-h-0` + an inner scroll: the sections
          take whatever height sits between the navigation and the stats, so a
          tall window shows everything and a short one scrolls. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {/* The page's own selection, first, while it is the page. */}
        {page === 'comics' && comicsSlot ? (
          <Section id="comics" label="Comics" count={null} defaultOpen>
            <div ref={comicsSlot} className="flex flex-col" data-testid="comics-slot" />
          </Section>
        ) : null}
        {page === 'chat' && chatSlot ? (
          <Section id="chats" label="Conversations" count={null} defaultOpen>
            <div ref={chatSlot} className="flex flex-col" data-testid="chat-slot" />
          </Section>
        ) : null}

        <Section id="folders" label="Folders" count={null} defaultOpen>
          <nav className="flex flex-col gap-0.5">
            {/* The unified view is the default and the point of the app: one grid
                across every watched folder, rather than a folder browser. */}
            <button
              type="button"
              onClick={() => onSelect(null)}
              className={cn(
                'rounded px-2 py-1.5 text-left text-xs transition-colors',
                selectedFolderId === null && page === 'library'
                  ? 'bg-indigo-500/20 text-indigo-200'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
              )}
            >
              All folders
              {libraryCount !== null ? <span className="ml-1.5 tabular-nums text-zinc-500">{libraryCount}</span> : null}
            </button>

            {folders.map((folder) => (
              <div key={folder.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(folder.id)}
                  title={folder.path}
                  className={cn(
                    'w-full truncate rounded px-2 py-1.5 pr-14 text-left text-xs transition-colors',
                    selectedFolderId === folder.id && page === 'library'
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
        </Section>

        {/* Who the library is of. Clicking through to the grid is the point:
            the name becomes the search term, which works because detection
            found it verbatim in the prompts search runs over. */}
        {characters.length > 0 ? (
          <Section
            id="characters"
            // "Detected", because the Characters page is the owner's own characters (2026-09-24); this
            // list is what the tagger found in prompts, franchise names and all.
            label="Detected characters"
            count={characters.length}
            open={shownList === 'characters'}
            onToggle={() => toggleList('characters')}
          >
            <ul className="flex flex-col">
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
                    <span className="w-5 shrink-0 text-right tabular-nums text-zinc-600">{index + 1}.</span>
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <span className="shrink-0 tabular-nums text-zinc-600">{entry.count.toLocaleString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {shootSets.length > 0 ? (
          <Section id="sets" label="Sets" count={shootSets.length} open={shownList === 'sets'} onToggle={() => toggleList('sets')}>
            <SetList sets={shootSets} selected={selectedSets} onSets={onSets} />
          </Section>
        ) : null}

        {loraSets.length > 0 ? (
          <Section
            id="lora-sets"
            label="LoRA sets"
            count={loraSets.length}
            open={shownList === 'lora'}
            onToggle={() => toggleList('lora')}
          >
            <SetList sets={loraSets} selected={selectedSets} onSets={onSets} />
          </Section>
        ) : null}

        {comicSets.length > 0 ? (
          <Section
            id="comic-sets"
            label="Comic sets"
            count={comicSets.length}
            open={shownList === 'comic'}
            onToggle={() => toggleList('comic')}
          >
            <SetList sets={comicSets} selected={selectedSets} onSets={onSets} />
          </Section>
        ) : null}
      </div>

      {/* Stats and the size slider share one block against the bottom of the
          sidebar however tall the sections above are. The slider is grouped
          with them rather than with the buttons because it is the same kind of
          thing: a property of the view, not an action on the library. */}
      <div className="flex flex-col gap-2 border-t border-white/5 pt-3">
        {stats ? (
          <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-zinc-500">
            <dt>Images</dt>
            <dd className="text-right tabular-nums text-zinc-300">{stats.images.toLocaleString()}</dd>
            <dt>Videos</dt>
            <dd className="text-right tabular-nums text-zinc-300">{stats.videos.toLocaleString()}</dd>
            <dt>Rated</dt>
            <dd className="text-right tabular-nums text-zinc-300">{stats.classified.toLocaleString()}</dd>
            {stats.pending > 0 ? (
              <>
                <dt>Pending</dt>
                <dd className="text-right tabular-nums text-amber-300">{stats.pending.toLocaleString()}</dd>
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
            compete with the sections for attention. */}
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
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">Excluded ({exclusions.length})</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {exclusions.map((path) => (
              <li key={path} className="group flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-zinc-600" title={displayPath(path)}>
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

/** The small caps label every section and the navigation share, so the sidebar reads as one list of sections. */
function SectionHeading({ children }: { children: ReactNode }) {
  return <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">{children}</div>
}

function NavEntry({
  label,
  count,
  active,
  onClick,
  title,
}: {
  label: string
  count: number | null
  active: boolean
  onClick: () => void
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-baseline gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
        active ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== null ? <span className="shrink-0 tabular-nums text-zinc-500">{count.toLocaleString()}</span> : null}
    </button>
  )
}

const SECTION_KEY = 'luma.sidebar.'
const LIST_KEY = SECTION_KEY + 'list'

/** Which of the library lists the accordion has open. */
type ListKey = 'characters' | 'sets' | 'lora' | 'comic'

const LIST_KEYS: ListKey[] = ['characters', 'sets', 'lora', 'comic']

function readOpenList(): ListKey | null {
  try {
    const stored = globalThis.localStorage?.getItem(LIST_KEY)
    if (stored === null || stored === undefined) return 'characters'
    return (LIST_KEYS as string[]).includes(stored) ? (stored as ListKey) : null
  } catch {
    return 'characters'
  }
}

function writeOpenList(key: ListKey | null) {
  try {
    globalThis.localStorage?.setItem(LIST_KEY, key ?? '')
  } catch {
    // A private window or blocked storage: the accordion still moves, it is just not remembered.
  }
}

/**
 * A collapsible section. Given `open` and `onToggle` it is controlled - the
 * accordion above decides - otherwise it keeps its own state, remembered per
 * browser so the sidebar opens the way it was left.
 */
function Section({
  id,
  label,
  count,
  defaultOpen = true,
  open: controlled,
  onToggle,
  children,
}: {
  id: string
  label: string
  count: number | null
  defaultOpen?: boolean
  open?: boolean
  onToggle?: () => void
  children: ReactNode
}) {
  const [own, setOwn] = useState<boolean>(() => {
    try {
      const stored = globalThis.localStorage?.getItem(SECTION_KEY + id)
      return stored === null || stored === undefined ? defaultOpen : stored === '1'
    } catch {
      return defaultOpen
    }
  })
  const open = controlled ?? own
  const toggle =
    onToggle ??
    (() => {
      const next = !own
      setOwn(next)
      try {
        globalThis.localStorage?.setItem(SECTION_KEY + id, next ? '1' : '0')
      } catch {
        // As above: still toggles, just not remembered.
      }
    })
  return (
    <section className="flex flex-col" data-testid={`sidebar-${id}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex items-baseline gap-2 rounded px-1 pb-1 text-left text-[10px] font-medium uppercase tracking-wide text-zinc-600 hover:text-zinc-400"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== null ? <span className="shrink-0 tabular-nums normal-case text-zinc-600">{count.toLocaleString()}</span> : null}
        <span aria-hidden="true" className="shrink-0 text-zinc-700">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? children : null}
    </section>
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
  onSets,
}: {
  sets: SetSummary[]
  selected: string[]
  onSets: (runs: string[]) => void
}) {
  /**
   * A plain click picks one set, or clears the one that is open. A click with
   * ctrl, cmd or shift adds to — or removes from — what is already showing.
   *
   * Additive on a modifier and not on a plain click, because the plain click
   * is what every other list in this sidebar does and a set list that quietly
   * accumulated would be the odd one out. The modifier is the same one the
   * grid uses for the same idea.
   */
  const pick = (run: string, additive: boolean) => {
    if (!additive) {
      onSets(selected.length === 1 && selected[0] === run ? [] : [run])
      return
    }
    onSets(selected.includes(run) ? selected.filter((each) => each !== run) : [...selected, run])
  }
  const groups: Array<[string, SetSummary[]]> = []
  for (const set of sets) {
    const name = set.character ?? 'Other'
    const group = groups.find(([existing]) => existing === name)
    if (group) group[1].push(set)
    else groups.push([name, [set]])
  }

  return (
    <div className="flex flex-col">
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
                  onClick={(event) => pick(set.run, event.ctrlKey || event.metaKey || event.shiftKey)}
                  aria-pressed={selected.includes(set.run)}
                  title={`${set.command} · ${new Date(set.createdAt).toLocaleString()} · ${set.count} pictures`}
                  className={cn(
                    'flex w-full items-baseline gap-2 rounded px-1 py-0.5 pl-3 text-left text-[11px]',
                    selected.includes(set.run)
                      ? 'bg-indigo-500/20 text-indigo-200'
                      : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {set.title ?? set.command}
                    {/* The date is what tells two runs of the same command
                        apart, and there will be two. */}
                    <span className="ml-1 text-zinc-600">{new Date(set.createdAt).toLocaleDateString()}</span>
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
