import { Button, ProgressBar, Spinner, cn } from '@luma/ui'
import {
  COMIC_ANCHORS,
  COMIC_BALLOON_KINDS,
  COMIC_LAYOUTS,
  comicScriptSchema,
  type ComicDialogue,
  type ComicEvent,
  type ComicInspection,
  type ComicPageSpec,
  type ComicPanelSpec,
  type ComicPanelState,
  type ComicProject,
  type ComicPanelStatus,
  type ComicRunOptions,
  type ComicScript,
  type ComicSettings,
  type ComicStatus,
  type ComicSummary,
} from '@luma/core'
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  comicCancel,
  comicCreate,
  comicInspect,
  comicList,
  comicRead,
  comicRun,
  comicSave,
  comicSaveSettings,
  comicStatus,
  fileUrl,
  forgeStatus,
  isTauri,
  revealInFileManager,
  type ForgeStatus,
} from '#/lib/native.ts'
import { showMessage } from '#/lib/dialogs.ts'
import { toast } from '#/lib/toasts.ts'

interface ComicsPanelProps {
  onClose: () => void
}

type Step = 'story' | 'script' | 'panels' | 'pages'

/** `caption` rides under the name in the rail; `hint` is the tooltip. */
const STEPS: Array<{ key: Step; label: string; caption: string; hint: string }> = [
  { key: 'story', label: 'Story', caption: 'Idea & setup', hint: 'Prose in. Three paragraphs make a page.' },
  { key: 'script', label: 'Script', caption: 'Write scenes & prompts', hint: 'What each panel shows and says. Edit anything.' },
  { key: 'panels', label: 'Panels', caption: 'Generate images', hint: 'One picture per panel, from Forge, checked by QA.' },
  { key: 'pages', label: 'Pages', caption: 'Arrange & letter', hint: 'Lettered pages, a PDF and a CBZ.' },
]

/** The camera field's leading mark, so it reads as a control rather than a
 *  box of words. */
function FrameIcon() {
  return (
    <svg viewBox="0 0 16 16" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" aria-hidden>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/**
 * The ⋮ menu on a card header.
 *
 * `<details>` rather than state and a click-away listener: the browser
 * already closes one when another opens inside the same tree, and a menu
 * that survives a re-render of the list it sits in is one less thing to get
 * wrong.
 */
function Kebab({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="relative shrink-0">
      <summary
        aria-label={`${label} menu`}
        className="cursor-pointer list-none rounded px-1 py-0.5 text-zinc-500 hover:text-zinc-200 [&::-webkit-details-marker]:hidden"
      >
        ⋮
      </summary>
      <div className="absolute right-0 z-20 mt-1 min-w-36 rounded-md border border-white/10 bg-zinc-900 p-1 shadow-xl">{children}</div>
    </details>
  )
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.closest('details')?.removeAttribute('open')
        onClick()
      }}
      className={cn(
        'block w-full rounded px-2 py-1 text-left text-xs hover:bg-white/10',
        danger ? 'text-red-300' : 'text-zinc-300',
      )}
    >
      {children}
    </button>
  )
}

/** An id from the config read as a name: `ari` is Ari on screen and stays
 *  `ari` everywhere the pipeline touches it. */
export function titleCase(id: string): string {
  return id.replace(/(^|[\s_-])(\w)/g, (_, lead: string, letter: string) => lead + letter.toUpperCase())
}

/**
 * A page or a panel at full size, over the panel.
 *
 * It exists because the obvious markup does the wrong thing here: an
 * `<a href>` to a `luma://` file NAVIGATES the webview to the image, and the
 * shell has no back button, so the app was simply gone until it was
 * restarted. Nothing in this panel links straight at a file any more.
 */
export function Viewer({ src, caption, onClose }: { src: string; caption: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="presentation"
      data-testid="viewer-backdrop"
      // Only a click on the backdrop itself closes, so the picture needs no
      // handler of its own and stays an ordinary image to a screen reader.
      onClick={(event) => event.target === event.currentTarget && onClose()}
      className="fixed inset-0 z-[120] flex flex-col items-center justify-center gap-3 bg-black/85 p-8"
    >
      <img
        src={src}
        alt={caption}
        className="min-h-0 max-w-full flex-1 object-contain"
      />
      <p className="text-xs text-zinc-400">
        {caption}
        <span className="ml-3 text-zinc-600">Esc, or click outside, to close</span>
      </p>
      <button
        type="button"
        onClick={onClose}
        className="absolute right-5 top-5 rounded-md bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
      >
        Close
      </button>
    </div>
  )
}

/**
 * Put a finished file in front of the person without leaving the app: the
 * file manager in the desktop shell, an ordinary download in a browser on
 * the LAN, where there is no file manager to reveal anything in.
 */
function FileLink({ path, label }: { path: string; label: string }) {
  if (isTauri()) {
    return (
      <button
        type="button"
        onClick={() => void revealInFileManager(path)}
        className="rounded-md bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10"
        title={path}
      >
        {label}
      </button>
    )
  }
  return (
    <a href={fileUrl(path)} download className="rounded-md bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10">
      {label}
    </a>
  )
}

function Tick() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-emerald-400" aria-hidden>
      <path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Where a comic stands, for the list. Read off the counts the host already
 * gathers rather than stored: a folder is the truth, and a stored status
 * would be one more thing that can disagree with it.
 */
export function standing(comic: ComicSummary): { label: string; dot: string } {
  if (!comic.hasScript) return { label: 'Draft', dot: 'bg-zinc-500' }
  if (comic.pages > 0 && comic.assembled >= comic.pages) return { label: 'Completed', dot: 'bg-emerald-400' }
  return { label: 'In progress', dot: 'bg-indigo-400' }
}

/** How often the panel asks the host what the pipeline has said. */
const POLL_MS = 1000

/** Which step the pipeline's stage lands the person on when it finishes. */
function stepAfter(stage: string | null): Step | null {
  switch (stage) {
    case 'script':
      return 'script'
    case 'panels':
    case 'qa':
      return 'panels'
    case 'assemble':
    case 'all':
      return 'pages'
    default:
      return null
  }
}

/** The script as the editor holds it, or why it could not be read. */
export function parseScript(raw: unknown): { script: ComicScript | null; error: string | null } {
  if (raw === null || raw === undefined) return { script: null, error: null }
  const parsed = comicScriptSchema.safeParse(raw)
  if (parsed.success) return { script: parsed.data, error: null }
  return {
    script: null,
    error: parsed.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('\n'),
  }
}

/**
 * Framings the checkpoint reliably knows, offered as a datalist.
 *
 * A list rather than a dropdown: the field is free text on purpose, because
 * the words go into the prompt as words and the right one is sometimes not
 * on any list. What IS on the list is only what has been seen to work.
 */
const CAMERAS = [
  'wide shot',
  'wide shot, from above',
  'wide shot, from below',
  'establishing shot',
  'full body',
  'full body, from behind',
  'cowboy shot',
  'cowboy shot, from side',
  'upper body',
  'upper body, looking away',
  'close-up',
  'close-up, from above',
  'close-up, from side',
  'portrait',
]

/** `grid-2x2` reads as `Grid 2x2 (4 panels)` in the picker. */
export function layoutLabel(name: string, cells: number): string {
  const words = name.replace(/-/g, ' ')
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${cells} panel${cells === 1 ? '' : 's'})`
}

/** A new panel with the fields the assembler needs and nothing decided. */
export function blankPanel(pageNumber: number, index: number, anchor: ComicPanelSpec['reserve_space'] = 'none'): ComicPanelSpec {
  return {
    id: `p${pageNumber}-${index}`,
    camera: 'cowboy shot',
    scene: '',
    pose: [],
    characters: [],
    reserve_space: anchor,
    dialogue: [],
    sfx: [],
  }
}

/**
 * Ids follow position, so a removed or added panel renumbers the page.
 *
 * Position is also the identity of a page, a balloon and a sound effect in
 * the editor — they have no id of their own — so those lists key by index
 * on purpose, with the lint rule waived at each one.
 */
export function renumber(pages: ComicPageSpec[]): ComicPageSpec[] {
  return pages.map((page, pageIndex) => ({
    ...page,
    panels: page.panels.map((panel, index) => ({ ...panel, id: `p${pageIndex + 1}-${index + 1}` })),
  }))
}

/** The one sentence to show for what the pipeline is doing right now. */
export function describeEvent(event: ComicEvent): string {
  switch (event.event) {
    case 'stage':
      return `${event.stage ?? ''} ${event.status ?? ''}${event.message ? ` — ${event.message}` : ''}`.trim()
    case 'panel': {
      const progress = event.progress !== null ? ` ${Math.round(event.progress * 100)}%` : ''
      const eta = event.eta !== null && event.eta > 0 ? ` (${Math.round(event.eta)}s left)` : ''
      const seed = event.seed !== null ? ` · seed ${event.seed}` : ''
      return `${event.id ?? ''}: ${event.status ?? ''}${progress}${eta}${seed}`
    }
    case 'qa':
      return `${event.id ?? ''}: ${event.status ?? ''}${event.failures?.length ? ` — ${event.failures.join(', ')}` : ''}`
    case 'page':
      return `page ${event.page ?? ''} assembled`
    case 'output':
      return `${event.kind ?? ''} written`
    case 'note':
      return event.message ?? ''
    default:
      return event.message ?? event.event
  }
}

const inputClass =
  'w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-400'
const selectClass =
  'rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-indigo-400'

/**
 * Comics: prose in, lettered pages out, without leaving the app.
 *
 * Four steps that are the pipeline's four stages, in the order they run. The
 * panel does not do any of the work itself — every button starts a stage on
 * the host and then follows it by polling, which is the same path for the
 * desktop window and for a browser on the LAN. What it owns is the editing:
 * the story text and the script, saved before any stage runs so what renders
 * is what is on screen.
 */
export function ComicsPanel({ onClose }: ComicsPanelProps) {
  const [comics, setComics] = useState<ComicSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [project, setProject] = useState<ComicProject | null>(null)
  const [inspection, setInspection] = useState<ComicInspection | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('story')
  const [newName, setNewName] = useState('')
  const [naming, setNaming] = useState(false)
  const [search, setSearch] = useState('')
  const [showSettings, setShowSettings] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [viewing, setViewing] = useState<{ src: string; caption: string } | null>(null)
  /** Where a newly added panel reserves its lettering space. A preference
   *  for this editor, not a setting the pipeline reads — which is why it is
   *  state here and not in `comic.config.json`. */
  const [newPanelAnchor, setNewPanelAnchor] = useState<ComicPanelSpec['reserve_space']>('none')

  const [prose, setProse] = useState('')
  const [proseDirty, setProseDirty] = useState(false)
  const [script, setScript] = useState<ComicScript | null>(null)
  const [scriptError, setScriptError] = useState<string | null>(null)
  const [scriptDirty, setScriptDirty] = useState(false)
  const [rawMode, setRawMode] = useState(false)
  const [rawText, setRawText] = useState('')

  const [status, setStatus] = useState<ComicStatus | null>(null)
  const [events, setEvents] = useState<ComicEvent[]>([])
  const [forge, setForge] = useState<ForgeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const next = useRef(0)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const reloadList = useCallback(async () => {
    try {
      const list = await comicList()
      if (live.current) setComics(list)
      return list
    } catch (error) {
      if (live.current) setLoadError(String(error))
      return []
    }
  }, [])

  const open = useCallback(async (name: string) => {
    setSelected(name)
    setLoadError(null)
    try {
      const loaded = await comicRead(name)
      if (!live.current) return
      setProject(loaded)
      setProse(loaded.prose)
      setProseDirty(false)
      const parsed = parseScript(loaded.script)
      setScript(parsed.script)
      setScriptError(parsed.error)
      setScriptDirty(false)
      setRawText(loaded.script ? JSON.stringify(loaded.script, null, 2) : '')
      // Separate call, separate failure: it starts the CLI, and a machine
      // without the pipeline beside it should still show the comic.
      setInspection(null)
      void comicInspect(name)
        .then((found) => live.current && setInspection(found))
        .catch(() => undefined)
    } catch (error) {
      if (live.current) setLoadError(String(error))
    }
  }, [])

  // The list, Forge, and whatever the pipeline is already doing — a run
  // started from another window is still a run.
  useEffect(() => {
    void reloadList().then((list) => {
      const first = list[0]
      if (first && !selected) void open(first.name)
    })
    void forgeStatus().then((state) => live.current && setForge(state))
    void comicStatus(0).then((state) => {
      if (!live.current) return
      setStatus(state)
      setEvents(state.events)
      next.current = state.next
      if (state.running) setBusy(true)
    })
    // Only on mount: the first comic is a starting point, not a rule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Following a run: poll until it finishes, then re-read the comic so the
  // new panels, verdicts and pages appear.
  useEffect(() => {
    if (!busy) return
    let stopped = false
    const tick = async () => {
      let state: ComicStatus
      try {
        state = await comicStatus(next.current)
      } catch (error) {
        if (!stopped && live.current) {
          void showMessage(String(error), { title: 'Comics' })
          setBusy(false)
        }
        return
      }
      if (stopped || !live.current) return
      if (state.events.length > 0) {
        setEvents((previous) => [...previous, ...state.events].slice(-400))
        next.current = state.next
      }
      setStatus(state)
      if (!state.running) {
        setBusy(false)
        if (state.error) void showMessage(state.error, { title: `${state.stage ?? 'The stage'} did not finish` })
        else toast(`${state.stage ?? 'stage'} done`)
        const landing = stepAfter(state.stage)
        if (landing) setStep(landing)
        if (state.comic) void open(state.comic)
        void reloadList()
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [busy, open, reloadList])

  /** Write what is on screen, so a stage renders what the person sees. */
  const saveAll = useCallback(async (): Promise<boolean> => {
    if (!selected) return false
    const patch: { prose?: string; script?: unknown } = {}
    if (proseDirty) patch.prose = prose
    if (scriptDirty) {
      if (rawMode) {
        try {
          const parsed = comicScriptSchema.parse(JSON.parse(rawText))
          patch.script = parsed
          setScript(parsed)
          setScriptError(null)
        } catch (error) {
          setScriptError(String(error))
          void showMessage('The script JSON does not parse — fix it or switch back to the form.', { title: 'Comics' })
          return false
        }
      } else if (script) {
        patch.script = script
      }
    }
    if (Object.keys(patch).length === 0) return true
    try {
      await comicSave(selected, patch)
      setProseDirty(false)
      setScriptDirty(false)
      return true
    } catch (error) {
      void showMessage(String(error), { title: 'Comics' })
      return false
    }
  }, [selected, prose, proseDirty, script, scriptDirty, rawMode, rawText])

  const run = useCallback(
    async (options: ComicRunOptions) => {
      if (!selected || busy) return
      if (!(await saveAll())) return
      setEvents([])
      next.current = 0
      try {
        await comicRun(selected, options)
        setBusy(true)
      } catch (error) {
        void showMessage(String(error), { title: 'Comics' })
      }
    },
    [selected, busy, saveAll],
  )

  const create = useCallback(async () => {
    const name = newName.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '')
    if (!name) return
    try {
      await comicCreate(name)
      setNewName('')
      await reloadList()
      await open(name)
      setStep('story')
    } catch (error) {
      void showMessage(String(error), { title: 'Comics' })
    }
  }, [newName, reloadList, open])

  const updateScript = useCallback((update: (previous: ComicScript) => ComicScript) => {
    setScript((previous) => (previous ? update(previous) : previous))
    setScriptDirty(true)
  }, [])

  const cast = useMemo(() => Object.keys(script?.characters ?? {}), [script])
  const panelStatus = useMemo(
    () => new Map<string, ComicPanelStatus>((inspection?.panels ?? []).map((panel) => [panel.id, panel])),
    [inspection],
  )
  const saveSettings = useCallback(
    async (settings: ComicSettings) => {
      if (!selected) return
      try {
        await comicSaveSettings(selected, settings)
        toast('settings saved')
        // Changing any of these changes what a render would produce, so the
        // panels that were current a moment ago may not be. Ask again.
        await open(selected)
      } catch (error) {
        void showMessage(String(error), { title: 'Comics' })
      }
    },
    [selected, open],
  )
  /** The JSON view and the form hold the same script; switching back parses
   *  what was typed, and refuses rather than losing it. */
  const toggleRaw = useCallback(() => {
    if (!rawMode) {
      setRawText(JSON.stringify(script, null, 2))
      setRawMode(true)
      return
    }
    try {
      const parsed = comicScriptSchema.parse(JSON.parse(rawText))
      setScript(parsed)
      setScriptError(null)
      setRawMode(false)
    } catch (error) {
      setScriptError(String(error))
    }
  }, [rawMode, rawText, script])

  const panelState = useMemo(() => new Map((project?.panels ?? []).map((panel) => [panel.id, panel])), [project])

  /** Which steps are finished, for the tick in the rail. A step is done when
   *  nothing is missing AND nothing has gone out of date behind it. */
  const finished = useMemo((): Record<Step, boolean> => {
    const total = script?.pages.reduce((n, page) => n + page.panels.length, 0) ?? 0
    const drawn = (project?.panels ?? []).filter((panel) => panel.path).length
    const stale = (inspection?.panels ?? []).filter((panel) => panel.status === 'stale').length
    const pages = project?.pages ?? []
    return {
      story: prose.trim().length > 0,
      script: !!script,
      panels: total > 0 && drawn === total && stale === 0,
      pages: pages.length > 0 && !pages.some((page) => page.stale),
    }
  }, [prose, script, project, inspection])

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return comics ?? []
    return (comics ?? []).filter((comic) => `${comic.title ?? ''} ${comic.name}`.toLowerCase().includes(needle))
  }, [comics, search])

  /** The first real line of the story, as the subtitle. The script has no
   *  logline field and inventing one would mean the writer had to fill it. */
  const logline = useMemo(
    () => prose.split('\n').map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith('#')) ?? '',
    [prose],
  )
  const lastEvent = events.at(-1)
  const rendering = useMemo(() => {
    const active = [...events].reverse().find((event) => event.event === 'panel' && event.status === 'rendering')
    return active && busy ? active : null
  }, [events, busy])
  const canWrite = !!selected && !busy && prose.trim().length > 0
  const hasScript = !!script
  const forgeNote = forge && !forge.reachable ? 'Forge is not running — panels cannot render until it is.' : forge?.busy ? `Forge is busy${forge.job ? ` — ${forge.job}` : ''}; renders will queue behind it.` : null

  return (
    <div className="fixed inset-0 z-[95] flex flex-col bg-zinc-950 text-zinc-200">
      <header className="flex items-center gap-4 border-b border-white/10 bg-zinc-900/50 px-4 py-2">
        <div className="flex shrink-0 items-center gap-2">
          <span className="grid size-7 place-items-center rounded-full ring-2 ring-indigo-400">
            <span className="size-2.5 rounded-full bg-indigo-400" />
          </span>
          <span className="text-sm font-semibold">Luma Vault</span>
        </div>

        <nav className="mx-auto flex min-w-0 items-center gap-0.5">
          {STEPS.map((entry, index) => {
            const active = step === entry.key
            const done = finished[entry.key]
            return (
              <Fragment key={entry.key}>
                {index > 0 ? <span className="px-1 text-zinc-700">&rarr;</span> : null}
                <button
                  type="button"
                  onClick={() => setStep(entry.key)}
                  title={entry.hint}
                  className={cn(
                    'flex items-center gap-2.5 rounded-full py-1 pl-1 pr-3.5 text-left transition',
                    active ? 'bg-indigo-500/20 ring-1 ring-indigo-400/60' : 'hover:bg-white/5',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold',
                      active ? 'bg-indigo-500 text-white' : done ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-zinc-400',
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold leading-tight">{entry.label}</span>
                    <span className="block text-[11px] leading-tight text-zinc-500">{entry.caption}</span>
                  </span>
                  {done && !active ? <Tick /> : null}
                </button>
              </Fragment>
            )
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {forgeNote ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300" title={forgeNote}>
              {forge?.reachable ? 'Forge busy' : 'Forge off'}
            </span>
          ) : null}
          {busy ? (
            <Button size="sm" variant="danger" onClick={() => void comicCancel().then(() => toast('stopping…'))}>
              Stop
            </Button>
          ) : null}
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-white/10 bg-zinc-900/30">
          <div className="p-3">
            {naming ? (
              <input
                value={newName}
                autoFocus
                onChange={(event) => setNewName(event.target.value)}
                onBlur={() => !newName.trim() && setNaming(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void create().then(() => setNaming(false))
                  if (event.key === 'Escape') {
                    setNewName('')
                    setNaming(false)
                  }
                }}
                placeholder="name it, then Enter"
                className={cn(inputClass, 'text-sm')}
              />
            ) : (
              <Button variant="primary" className="w-full justify-center" onClick={() => setNaming(true)}>
                + New Comic
              </Button>
            )}
          </div>

          <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Comics</div>
          <div className="px-3 pb-2">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search…"
              className={cn(inputClass, 'text-xs')}
            />
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
            {comics === null ? (
              <div className="p-3 text-xs text-zinc-500">
                <Spinner /> reading…
              </div>
            ) : shown.length === 0 ? (
              <div className="p-3 text-xs text-zinc-500">
                {comics.length === 0 ? 'No comics yet. Name one above.' : 'Nothing matches that.'}
              </div>
            ) : (
              shown.map((comic) => {
                const state = standing(comic)
                return (
                  <button
                    key={comic.name}
                    type="button"
                    onClick={() => void open(comic.name)}
                    className={cn(
                      'flex w-full gap-2.5 rounded-lg p-2 text-left transition',
                      comic.name === selected ? 'bg-indigo-500/15 ring-1 ring-indigo-400/40' : 'hover:bg-white/5',
                    )}
                  >
                    <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-zinc-800 text-[10px] text-zinc-600">
                      {comic.thumb ? (
                        <img src={fileUrl(comic.thumb)} alt="" className="size-full object-cover" />
                      ) : (
                        'no art'
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{comic.title ?? comic.name}</span>
                      <span className="block truncate text-[11px] text-zinc-500">
                        {comic.hasScript
                          ? `${comic.pages} page${comic.pages === 1 ? '' : 's'} · ${comic.rendered}/${comic.panels} panels`
                          : comic.hasProse
                            ? 'story only'
                            : 'empty'}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
                        <span className={cn('size-1.5 rounded-full', state.dot)} />
                        {state.label}
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>

          <nav className="border-t border-white/10 p-2">
            <button type="button" onClick={onClose} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-400 hover:bg-white/5 hover:text-zinc-200">
              Library
            </button>
            <button
              type="button"
              onClick={() => setStep('script')}
              title={cast.length ? `In this comic: ${cast.join(', ')}. Defined in comic.config.json.` : 'The cast comes from comic.config.json'}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
            >
              Characters
              {cast.length ? <span className="ml-auto text-[11px] text-zinc-600">{cast.length}</span> : null}
            </button>
            <button
              type="button"
              onClick={() => setShowSettings((previous) => !previous)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5',
                showSettings ? 'text-zinc-200' : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              Settings
            </button>
          </nav>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {!selected ? (
            <div className="p-6 text-sm text-zinc-500">Pick a comic, or name a new one.</div>
          ) : (
            <>
              <div className="flex flex-wrap items-start gap-3 border-b border-white/10 px-6 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {renaming && script ? (
                      <input
                        value={script.title}
                        autoFocus
                        onChange={(event) => updateScript((previous) => ({ ...previous, title: event.target.value }))}
                        onBlur={() => setRenaming(false)}
                        onKeyDown={(event) => event.key === 'Enter' && setRenaming(false)}
                        className={cn(inputClass, 'text-2xl font-semibold')}
                      />
                    ) : (
                      <h2 className="truncate text-2xl font-semibold">{script?.title ?? selected}</h2>
                    )}
                    {script ? (
                      <button
                        type="button"
                        onClick={() => setRenaming((previous) => !previous)}
                        title="Rename the comic"
                        className="text-zinc-500 hover:text-zinc-200"
                      >
                        ✎
                      </button>
                    ) : null}
                  </div>
                  {logline ? <p className="mt-1 line-clamp-1 max-w-xl text-sm text-zinc-500">{logline}</p> : null}
                </div>

                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-zinc-500">Cast: {cast.length ? cast.map(titleCase).join(', ') : 'nobody'}</span>
                  {proseDirty || scriptDirty ? (
                    <Button size="sm" onClick={() => void saveAll().then((ok) => ok && toast('saved'))}>
                      Save
                    </Button>
                  ) : null}
                  {step === 'script' && script ? (
                    <>
                      <Button size="sm" onClick={toggleRaw}>
                        {rawMode ? 'Back to the form' : '</> Edit as JSON'}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy}
                        onClick={() => void run({ stage: 'panels', page: null, panel: null, seed: null, attempt: null, force: false, noTagger: false })}
                      >
                        Render all panels &rarr;
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>

              {loadError ? <div className="m-3 rounded-md bg-red-500/10 p-3 text-xs text-red-300">{loadError}</div> : null}

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                {step === 'story' ? (
                  <section className="flex h-full flex-col gap-3">
                    <textarea
                      value={prose}
                      onChange={(event) => {
                        setProse(event.target.value)
                        setProseDirty(true)
                      }}
                      spellCheck
                      className={cn(inputClass, 'min-h-[50vh] flex-1 resize-none font-serif text-base leading-relaxed')}
                      placeholder="# Title&#10;&#10;Write the story as prose. Three paragraphs make a page."
                    />
                    <div className="flex items-center gap-2">
                      <Button variant="primary" disabled={!canWrite} onClick={() => void run({ stage: 'script', page: null, panel: null, seed: null, attempt: null, force: false, noTagger: false })}>
                        {hasScript ? 'Write the script again' : 'Write the script'}
                      </Button>
                      <Button disabled={!canWrite} onClick={() => void run({ stage: 'all', page: null, panel: null, seed: null, attempt: null, force: false, noTagger: false })} title="Script (if there is none), panels, QA and pages in one go">
                        Run everything
                      </Button>
                      <span className="text-xs text-zinc-500">
                        {hasScript ? 'Writing again replaces the script and every edit in it.' : 'A model turns the prose into panels and balloons; you can edit every line after.'}
                      </span>
                    </div>
                  </section>
                ) : null}

                {step === 'script' ? (
                  !script ? (
                    <div className="text-sm text-zinc-500">
                      {scriptError ? (
                        <pre className="whitespace-pre-wrap rounded-md bg-red-500/10 p-3 text-xs text-red-300">{scriptError}</pre>
                      ) : (
                        'No script yet — write the story first, then have the script written.'
                      )}
                    </div>
                  ) : (
                    <ScriptEditor
                      script={script}
                      cast={cast}
                      rawMode={rawMode}
                      rawText={rawText}
                      scriptError={scriptError}
                      onRaw={(text) => {
                        setRawText(text)
                        setScriptDirty(true)
                      }}
                      plates={inspection?.settings.plates ?? false}
                      newPanelAnchor={newPanelAnchor}
                      onChange={updateScript}
                    />
                  )
                ) : null}

                {step === 'panels' ? (
                  !script ? (
                    <div className="text-sm text-zinc-500">No script yet.</div>
                  ) : (
                    <PanelsView
                      script={script}
                      state={panelState}
                      status={panelStatus}
                      settings={inspection?.settings ?? null}
                      rendering={rendering}
                      busy={busy}
                      onRender={(options) => void run(options)}
                      onView={(src, caption) => setViewing({ src, caption })}
                    />
                  )
                ) : null}

                {step === 'pages' ? (
                  <PagesView
                    project={project}
                    busy={busy}
                    hasScript={hasScript}
                    onAssemble={(page) => void run({ stage: 'assemble', page, panel: null, seed: null, attempt: null, force: false, noTagger: false })}
                    onView={(src, caption) => setViewing({ src, caption })}
                  />
                ) : null}
              </div>

              {/* The last run's outcome stays until another comic is opened:
                  a "done" that belongs to a different comic would read as
                  this one's. */}
              {busy || (status?.finished && lastEvent && status.comic === selected) ? (
                <footer className="border-t border-white/10 px-4 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    {busy ? <Spinner /> : null}
                    <span className="font-medium">{status?.stage ?? ''}</span>
                    <span className="truncate text-zinc-400">{lastEvent ? describeEvent(lastEvent) : busy ? 'starting…' : ''}</span>
                    {status?.error ? <span className="ml-auto text-red-300">{status.error}</span> : null}
                  </div>
                  {rendering?.progress !== null && rendering?.progress !== undefined ? (
                    <ProgressBar done={rendering.progress} total={1} className="mt-1" />
                  ) : busy ? (
                    <ProgressBar done={0} total={0} indeterminate className="mt-1" />
                  ) : null}
                </footer>
              ) : null}
            </>
          )}
        </main>

        {viewing ? <Viewer src={viewing.src} caption={viewing.caption} onClose={() => setViewing(null)} /> : null}

        {selected && showSettings ? (
          <ComicSettingsPanel
            settings={inspection?.settings ?? null}
            newPanelAnchor={newPanelAnchor}
            onNewPanelAnchor={setNewPanelAnchor}
            busy={busy}
            onSave={(chosen) => void saveSettings(chosen)}
          />
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — the script

interface ScriptEditorProps {
  script: ComicScript
  cast: string[]
  /** Whether the hosted plate pass is on. Its fields are hidden when it is
   *  not, rather than asking for words nothing reads. */
  plates: boolean
  newPanelAnchor: ComicPanelSpec['reserve_space']
  rawMode: boolean
  rawText: string
  scriptError: string | null
  onRaw: (text: string) => void
  onChange: (update: (previous: ComicScript) => ComicScript) => void
}

function ScriptEditor({ script, cast, plates, newPanelAnchor, rawMode, rawText, scriptError, onRaw, onChange }: ScriptEditorProps) {
  const setPage = (pageIndex: number, update: (page: ComicPageSpec) => ComicPageSpec) =>
    onChange((previous) => ({
      ...previous,
      pages: renumber(previous.pages.map((page, index) => (index === pageIndex ? update(page) : page))),
    }))

  return (
    <section className="flex flex-col gap-4">
      {cast.length === 0 ? (
        <p className="text-xs text-amber-300">
          No cast: add characters to comic.config.json, or every panel renders as scenery.
        </p>
      ) : null}
      {scriptError ? <pre className="whitespace-pre-wrap rounded-md bg-red-500/10 p-3 text-xs text-red-300">{scriptError}</pre> : null}

      {rawMode ? (
        <textarea value={rawText} onChange={(event) => onRaw(event.target.value)} spellCheck={false} className={cn(inputClass, 'min-h-[60vh] font-mono text-xs')} />
      ) : (
        script.pages.map((page, pageIndex) => (
          <PageEditor
            // eslint-disable-next-line react/no-array-index-key
            key={pageIndex}
            page={page}
            pageNumber={pageIndex + 1}
            cast={cast}
            plates={plates}
            newPanelAnchor={newPanelAnchor}
            onChange={(update) => setPage(pageIndex, update)}
            onRemove={() => onChange((previous) => ({ ...previous, pages: renumber(previous.pages.filter((_, index) => index !== pageIndex)) }))}
          />
        ))
      )}
      <datalist id="comic-cameras">
        {CAMERAS.map((camera) => (
          <option key={camera} value={camera} />
        ))}
      </datalist>
      {!rawMode ? (
        <Button
          size="sm"
          onClick={() =>
            onChange((previous) => ({
              ...previous,
              pages: renumber([
                ...previous.pages,
                { layout: 'hero-top', panels: [1, 2, 3].map((n) => blankPanel(previous.pages.length + 1, n, newPanelAnchor)) },
              ]),
            }))
          }
        >
          Add a page
        </Button>
      ) : null}
    </section>
  )
}

interface PageEditorProps {
  page: ComicPageSpec
  pageNumber: number
  cast: string[]
  plates: boolean
  newPanelAnchor: ComicPanelSpec['reserve_space']
  onChange: (update: (page: ComicPageSpec) => ComicPageSpec) => void
  onRemove: () => void
}

const PageEditor = memo(function PageEditor({ page, pageNumber, cast, plates, newPanelAnchor, onChange, onRemove }: PageEditorProps) {
  const layoutName = typeof page.layout === 'string' ? page.layout : 'custom'
  const cells = typeof page.layout === 'string' ? COMIC_LAYOUTS[page.layout]?.cells.length : undefined
  const mismatch = cells !== undefined && cells !== page.panels.length

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold">Page {pageNumber}</span>
        <select
          value={layoutName}
          onChange={(event) => onChange((previous) => ({ ...previous, layout: event.target.value }))}
          className={selectClass}
          title="The grid the panels sit in. The number in brackets must match the number of panels."
        >
          {Object.entries(COMIC_LAYOUTS).map(([name, layout]) => (
            <option key={name} value={name}>
              {layoutLabel(name, layout.cells.length)}
            </option>
          ))}
          {layoutName === 'custom' ? <option value="custom">custom grid</option> : null}
        </select>
        {mismatch ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
            {page.panels.length} panels on a {cells}-panel layout — pick a layout that fits, or add/remove a panel
          </span>
        ) : null}
        <Button size="sm" className="ml-auto" onClick={() => onChange((previous) => ({ ...previous, panels: [...previous.panels, blankPanel(pageNumber, previous.panels.length + 1, newPanelAnchor)] }))}>
          + Add panel
        </Button>
        <Kebab label={`Page ${pageNumber}`}>
          <MenuItem onClick={onRemove} danger>
            Remove page
          </MenuItem>
        </Kebab>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {page.panels.map((panel, index) => (
          <PanelEditor
            key={panel.id}
            panel={panel}
            cast={cast}
            plates={plates}
            onChange={(update) => onChange((previous) => ({ ...previous, panels: previous.panels.map((p, i) => (i === index ? update(p) : p)) }))}
            onRemove={() => onChange((previous) => ({ ...previous, panels: previous.panels.filter((_, i) => i !== index) }))}
          />
        ))}
      </div>
    </div>
  )
})

interface PanelEditorProps {
  panel: ComicPanelSpec
  cast: string[]
  plates: boolean
  onChange: (update: (panel: ComicPanelSpec) => ComicPanelSpec) => void
  onRemove: () => void
}

const PanelEditor = memo(function PanelEditor({ panel, cast, plates, onChange, onRemove }: PanelEditorProps) {
  const setLine = (index: number, patch: Partial<ComicDialogue>) =>
    onChange((previous) => ({ ...previous, dialogue: previous.dialogue.map((line, i) => (i === index ? { ...line, ...patch } : line)) }))
  const setPose = (index: number, value: string) =>
    onChange((previous) => {
      const pose = [...previous.pose]
      while (pose.length <= index) pose.push('')
      pose[index] = value
      return { ...previous, pose }
    })

  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3 text-xs">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="shrink-0 rounded-md bg-white/10 px-2 py-1 font-mono text-[11px] text-zinc-300" title={panel.id}>
          {panel.id.replace(/^p/, '')}
        </span>
        <span className="relative min-w-0 flex-1">
          <FrameIcon />
          <input
            value={panel.camera}
            list="comic-cameras"
            onChange={(event) => onChange((previous) => ({ ...previous, camera: event.target.value }))}
            className={cn(inputClass, 'pl-7')}
            placeholder="close-up, from below, cowboy shot…"
            title="Framing first, then the angle. Weighted into the prompt; the list offers what has been seen to work on this checkpoint, and anything else you type is used as written."
          />
        </span>
        <select
          value={panel.reserve_space}
          onChange={(event) => onChange((previous) => ({ ...previous, reserve_space: event.target.value as ComicPanelSpec['reserve_space'] }))}
          className={cn(selectClass, 'shrink-0')}
          title="Where this panel keeps room clear for its lettering."
        >
          <option value="none">Text anywhere</option>
          {COMIC_ANCHORS.map((anchor) => (
            <option key={anchor} value={anchor}>
              Text {anchor}
            </option>
          ))}
        </select>
        <Kebab label={`Panel ${panel.id}`}>
          <MenuItem onClick={onRemove} danger>
            Remove panel
          </MenuItem>
        </Kebab>
      </div>

      <label className="mb-2 block">
        <span className="mb-1 block text-[11px] text-zinc-500">Scene description</span>
        <textarea
          value={panel.scene}
          onChange={(event) => onChange((previous) => ({ ...previous, scene: event.target.value }))}
          className={cn(inputClass, 'min-h-16 resize-y leading-relaxed')}
          placeholder="setting, action, light — no names, no words spoken (only the local model reads this)"
        />
      </label>

      {plates ? (
        <label className="mb-2 block">
          <span className="mb-1 block text-[11px] text-zinc-500">Setting for the plate</span>
          <input
            value={panel.setting ?? ''}
            onChange={(event) => onChange((previous) => ({ ...previous, setting: event.target.value || undefined }))}
            className={inputClass}
            placeholder="the place and light in this shot, nobody in it"
            title="Sent to the hosted image model that draws the plate. The place, the light, the props. No nudity, no sexual content, no names."
          />
        </label>
      ) : null}

      <div className="mb-2 space-y-1.5">
        <div className="flex items-start gap-2">
          <span className="mt-1 w-20 shrink-0 text-[11px] text-zinc-500">In the picture</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {cast.map((id) => {
              const on = panel.characters.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onChange((previous) => ({ ...previous, characters: on ? previous.characters.filter((c) => c !== id) : [...previous.characters, id] }))}
                  className={cn('rounded-full px-2 py-0.5', on ? 'bg-indigo-500 text-white' : 'bg-white/5 text-zinc-400 hover:bg-white/10')}
                >
                  {id}
                </button>
              )
            })}
            {cast.length === 0 ? <span className="text-zinc-600">nobody</span> : null}
            <label
              className="ml-auto flex items-center gap-1 text-zinc-500"
              title="How many people QA should expect to see. Blank means as many as there are characters; set it when the shot has extras, a crowd, or nobody."
            >
              figures
              <input
                type="number"
                min={0}
                value={panel.figures ?? ''}
                placeholder={String(panel.characters.length)}
                onChange={(event) =>
                  onChange((previous: ComicPanelSpec) => ({
                    ...previous,
                    figures: event.target.value === '' ? undefined : Math.max(0, Number(event.target.value)),
                  }))
                }
                className={cn(inputClass, 'w-12')}
              />
            </label>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <span className="mt-1.5 w-20 shrink-0 text-[11px] text-zinc-500">Pose / Action</span>
          <div className="min-w-0 flex-1 space-y-1">
            {plates ? (
              panel.characters.length > 0 ? (
                panel.characters.map((id, index) => (
                  <input
                    key={id}
                    value={panel.pose[index] ?? ''}
                    onChange={(event) => setPose(index, event.target.value)}
                    className={inputClass}
                    placeholder={`${id}: standing at the rail, one hand raised`}
                    title={`${id}'s stand-in in the plate: posture and gesture only, and a hosted model reads it.`}
                  />
                ))
              ) : (
                <span className="text-[11px] text-zinc-600">nobody in this panel</span>
              )
            ) : (
              // Shown rather than hidden, because the words are still in the
              // script and their absence would read as data loss. Disabled,
              // because `plates/prompt.ts` is the only thing that reads them
              // and the plate pass is off.
              <input
                value={panel.pose.filter(Boolean).join(' · ')}
                readOnly
                disabled
                className={cn(inputClass, 'cursor-not-allowed opacity-50')}
                placeholder="read only by the hosted plate pass, which is off"
                title="The plate pass is off, so nothing reads this. Put what she is doing in the scene description instead."
              />
            )}
          </div>
        </div>
      </div>

      <div className="space-y-1">
        {panel.dialogue.map((line, index) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            className="flex items-center gap-1"
          >
            <select value={line.speaker} onChange={(event) => setLine(index, { speaker: event.target.value })} className={selectClass}>
              <option value="narrator">narrator</option>
              {cast.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <select value={line.kind} onChange={(event) => setLine(index, { kind: event.target.value as ComicDialogue['kind'] })} className={selectClass}>
              {COMIC_BALLOON_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <select value={line.anchor} onChange={(event) => setLine(index, { anchor: event.target.value as ComicDialogue['anchor'] })} className={selectClass}>
              {COMIC_ANCHORS.map((anchor) => (
                <option key={anchor} value={anchor}>
                  {anchor}
                </option>
              ))}
            </select>
            <input
              value={line.text}
              onChange={(event) => setLine(index, { text: event.target.value })}
              className={cn(inputClass, 'rounded-full border-indigo-400/30 bg-indigo-500/10')}
              placeholder="what is said"
            />
            <button type="button" onClick={() => onChange((previous) => ({ ...previous, dialogue: previous.dialogue.filter((_, i) => i !== index) }))} className="shrink-0 text-zinc-500 hover:text-red-300" title="Remove this balloon">
              ✕
            </button>
          </div>
        ))}

        {panel.sfx.map((sfx, index) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={`sfx-${index}`}
            className="flex items-center gap-1"
          >
            <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">sfx</span>
            <select value={sfx.anchor} onChange={(event) => onChange((previous) => ({ ...previous, sfx: previous.sfx.map((entry, i) => (i === index ? { ...entry, anchor: event.target.value as ComicDialogue['anchor'] } : entry)) }))} className={selectClass}>
              {COMIC_ANCHORS.map((anchor) => (
                <option key={anchor} value={anchor}>
                  {anchor}
                </option>
              ))}
            </select>
            <input
              value={sfx.text}
              onChange={(event) => onChange((previous) => ({ ...previous, sfx: previous.sfx.map((entry, i) => (i === index ? { ...entry, text: event.target.value } : entry)) }))}
              className={cn(inputClass, 'font-semibold uppercase tracking-wide text-amber-200')}
              placeholder="WHAM"
            />
            <button type="button" onClick={() => onChange((previous) => ({ ...previous, sfx: previous.sfx.filter((_, i) => i !== index) }))} className="shrink-0 text-zinc-500 hover:text-red-300" title="Remove this sound effect">
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="mt-2 flex gap-4 border-t border-white/5 pt-2">
        <button
          type="button"
          onClick={() =>
            onChange((previous) => {
              const anchor = previous.reserve_space === 'none' ? 'top-right' : previous.reserve_space
              return {
                ...previous,
                reserve_space: anchor,
                dialogue: [...previous.dialogue, { speaker: previous.characters[0] ?? 'narrator', text: '', anchor, kind: 'speech' }],
              }
            })
          }
          className="text-indigo-300 hover:text-indigo-200"
        >
          + Balloon
        </button>
        <button type="button" onClick={() => onChange((previous) => ({ ...previous, sfx: [...previous.sfx, { text: '', anchor: 'bottom-right', rotate: -8 }] }))} className="text-indigo-300 hover:text-indigo-200">
          + Sound effect
        </button>
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Step 3 — the panels

interface PanelsViewProps {
  script: ComicScript
  state: Map<string, ComicPanelState>
  /** Whether each panel on disk is still what the script asks for. Empty
   *  until the pipeline has answered, and on a machine without it. */
  status: Map<string, ComicPanelStatus>
  /** Only `plates` is read here now; the rest of the settings live in the
   *  column on the right. */
  settings: ComicSettings | null
  rendering: ComicEvent | null
  busy: boolean
  onRender: (options: ComicRunOptions) => void
  onView: (src: string, caption: string) => void
}

const baseRun: ComicRunOptions = { stage: 'panels', page: null, panel: null, seed: null, attempt: null, force: false, noTagger: false }

function PanelsView({ script, state, status, settings, rendering, busy, onRender, onView }: PanelsViewProps) {
  const total = script.pages.reduce((n, page) => n + page.panels.length, 0)
  const done = script.pages.reduce((n, page) => n + page.panels.filter((panel) => state.get(panel.id)?.path).length, 0)
  const checked = [...state.values()].filter((panel) => panel.verdict).length
  const failing = [...state.values()].filter((panel) => panel.verdict && !panel.verdict.ok).length
  const noted = [...state.values()].filter((panel) => (panel.verdict?.notes.length ?? 0) > 0).length
  const stale = [...status.values()].filter((panel) => panel.status === 'stale').length

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => onRender(baseRun)} title="Render every panel that is missing or no longer matches the script; the rest come from the cache">
          Render {done < total ? `the missing ${total - done}` : stale > 0 ? `the ${stale} changed` : 'changed panels'}
        </Button>
        <Button disabled={busy || done === 0} onClick={() => onRender({ ...baseRun, stage: 'qa' })} title="Check every rendered panel for blank output and for the wrong number of figures; those re-render at the next seed. Anything else QA sees, such as no empty room where a balloon goes, is reported as a note and never re-renders.">
          Check (QA)
        </Button>
        <Button disabled={busy} onClick={() => onRender({ ...baseRun, force: true })} title="Render every panel again at its current seed, cache or not">
          Render all again
        </Button>
        <span className="text-xs text-zinc-500">
          {done}/{total} rendered · {checked} checked{failing ? ` · ${failing} failing` : ''}
          {noted ? ` · ${noted} with notes` : ''}
        </span>
        {stale > 0 ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
            {stale === 1 ? '1 panel is' : `${stale} panels are`} not what the script now asks for
          </span>
        ) : null}
      </div>
      {script.pages.map((page, pageIndex) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={pageIndex}
        >
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            Page {pageIndex + 1}
            <Button size="sm" disabled={busy} onClick={() => onRender({ ...baseRun, page: pageIndex + 1 })}>
              Render this page
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {page.panels.map((panel) => (
              <PanelCard
                key={panel.id}
                spec={panel}
                state={state.get(panel.id)}
                status={status.get(panel.id)}
                plates={settings?.plates ?? false}
                onView={onView}
                progress={rendering?.id === panel.id ? (rendering.progress ?? 0) : null}
                busy={busy}
                onNextSeed={() => onRender({ ...baseRun, page: pageIndex + 1, panel: panel.id, attempt: (state.get(panel.id)?.attempt ?? 0) + 1, force: true })}
                onAgain={() => onRender({ ...baseRun, page: pageIndex + 1, panel: panel.id, force: true })}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

/** The page shapes worth one click. Anything else is two numbers in the
 *  project's config, which is where the width and height still live. */
const ASPECTS: Array<{ label: string; width: number; height: number }> = [
  { label: '2:3 (vertical)', width: 2000, height: 3000 },
  { label: '3:4 (vertical)', width: 2250, height: 3000 },
  { label: '4:5 (vertical)', width: 2400, height: 3000 },
  { label: '1:1 (square)', width: 2400, height: 2400 },
  { label: '4:3 (landscape)', width: 3000, height: 2250 },
]

function aspectOf(settings: ComicSettings): string {
  const found = ASPECTS.find((a) => a.width === settings.pageWidth && a.height === settings.pageHeight)
  return found?.label ?? 'custom'
}

/**
 * Everything that changes what a render produces, in one column, where it
 * can be read before the render rather than discovered after it.
 *
 * Each control is a real field in `comic.config.json`: the style block, the
 * quality words, the page box and scale, the checkpoint, and the second
 * pass. Saving writes them into the PROJECT's config, never the package's,
 * so one comic's look cannot follow you into the next.
 */
function ComicSettingsPanel({
  settings,
  newPanelAnchor,
  onNewPanelAnchor,
  busy,
  onSave,
}: {
  settings: ComicSettings | null
  newPanelAnchor: ComicPanelSpec['reserve_space']
  onNewPanelAnchor: (anchor: ComicPanelSpec['reserve_space']) => void
  busy: boolean
  onSave: (settings: ComicSettings) => void
}) {
  const [draft, setDraft] = useState(settings)
  useEffect(() => setDraft(settings), [settings])

  if (!settings || !draft) {
    return (
      <aside className="w-72 shrink-0 border-l border-white/10 bg-zinc-900/30 p-4 text-xs text-zinc-500">
        <h3 className="mb-3 text-sm font-semibold text-zinc-200">Comic Settings</h3>
        Reading the project…
      </aside>
    )
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  const set = (patch: Partial<ComicSettings>) => setDraft((previous) => (previous ? { ...previous, ...patch } : previous))
  const tags = draft.globalTags.split(',').map((tag) => tag.trim()).filter(Boolean)
  const setTags = (next: string[]) => set({ globalTags: next.join(', ') })

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-white/10 bg-zinc-900/30">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-semibold">Comic Settings</h3>
        {dirty ? (
          <Button size="sm" variant="primary" className="ml-auto" disabled={busy} onClick={() => onSave(draft)}>
            Save
          </Button>
        ) : null}
      </div>

      <div className="space-y-4 p-4 text-xs">
        <label className="block">
          <span className="mb-1 block font-medium text-zinc-300">Style</span>
          <input
            value={draft.style}
            onChange={(event) => set({ style: event.target.value })}
            placeholder="the checkpoint's own look"
            className={inputClass}
          />
          <span className="mt-1 block text-[11px] text-zinc-500">
            Tags appended to every panel. Empty means the checkpoint decides.
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block font-medium text-zinc-300">Aspect ratio</span>
          <select
            value={aspectOf(draft)}
            onChange={(event) => {
              const found = ASPECTS.find((a) => a.label === event.target.value)
              if (found) set({ pageWidth: found.width, pageHeight: found.height })
            }}
            className={cn(selectClass, 'w-full')}
          >
            {ASPECTS.map((aspect) => (
              <option key={aspect.label} value={aspect.label}>
                {aspect.label}
              </option>
            ))}
            {aspectOf(draft) === 'custom' ? <option value="custom">custom</option> : null}
          </select>
          <span className="mt-1 block text-[11px] text-zinc-500">
            {draft.pageWidth}x{draft.pageHeight} on the page, {Math.round(draft.pageWidth * draft.pageScale)}x
            {Math.round(draft.pageHeight * draft.pageScale)} written out.
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block font-medium text-zinc-300">Model</span>
          <input
            value={draft.checkpoint}
            onChange={(event) => set({ checkpoint: event.target.value })}
            className={inputClass}
            title="Part of the checkpoint's filename. Forge resolves it, and refuses rather than guessing when it matches more than one."
          />
          <span className="mt-1 block text-[11px] text-zinc-500">Drawn by {draft.renderer}{draft.plates ? ', plates on' : ''}.</span>
        </label>

        <div>
          <span className="mb-1 block font-medium text-zinc-300">Global tags</span>
          <span className="mb-1.5 block text-[11px] text-zinc-500">Lead every panel's prompt.</span>
          <div className="mb-1.5 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span key={tag} className="flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[11px]">
                {tag}
                <button type="button" onClick={() => setTags(tags.filter((t) => t !== tag))} className="text-zinc-500 hover:text-red-300">
                  ✕
                </button>
              </span>
            ))}
            {tags.length === 0 ? <span className="text-[11px] text-zinc-600">none</span> : null}
          </div>
          <input
            placeholder="Add a tag, then Enter"
            className={inputClass}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              const value = event.currentTarget.value.trim()
              if (!value || tags.includes(value)) return
              setTags([...tags, value])
              event.currentTarget.value = ''
            }}
          />
        </div>

        <div className="space-y-2 border-t border-white/10 pt-3">
          <span className="block font-medium text-zinc-300">Output</span>
          <label className="flex items-center gap-2" title="Device pixels per page pixel. Above 1 the lettering is redrawn sharp rather than enlarged.">
            <span className="w-24 shrink-0 text-zinc-500">page scale</span>
            <input
              type="number"
              min={1}
              max={4}
              step={0.25}
              value={draft.pageScale}
              onChange={(event) => set({ pageScale: Number(event.target.value) })}
              className={cn(inputClass, 'w-20')}
            />
          </label>
          <label className="flex items-start gap-2" title="Render each panel at the size its cell displays it at, as a second pass of the same render, instead of enlarging it afterwards. Off means the assembler's upscaler does it, which cannot redraw a face.">
            <input
              type="checkbox"
              checked={draft.hiresEnabled}
              onChange={(event) => set({ hiresEnabled: event.target.checked })}
              className="mt-0.5"
            />
            <span className="text-zinc-400">panels at their cell size</span>
          </label>
          {draft.hiresEnabled ? (
            <label className="flex items-center gap-2" title="How much the second pass may redraw. Below about 0.35 it only sharpens; above about 0.55 it starts changing the picture.">
              <span className="w-24 shrink-0 text-zinc-500">denoise</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={draft.hiresDenoise}
                onChange={(event) => set({ hiresDenoise: Number(event.target.value) })}
                className={cn(inputClass, 'w-20')}
              />
            </label>
          ) : null}
        </div>

        <div className="space-y-2 border-t border-white/10 pt-3">
          <span className="block font-medium text-zinc-300">New panels</span>
          <label className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-zinc-500">text placement</span>
            <select
              value={newPanelAnchor}
              onChange={(event) => onNewPanelAnchor(event.target.value as ComicPanelSpec['reserve_space'])}
              className={selectClass}
            >
              <option value="none">none</option>
              {COMIC_ANCHORS.map((anchor) => (
                <option key={anchor} value={anchor}>
                  {anchor}
                </option>
              ))}
            </select>
          </label>
          <span className="block text-[11px] text-zinc-500">
            Where a panel added here reserves room. Only affects new panels.
          </span>
        </div>

        <div className="rounded-lg border border-indigo-400/20 bg-indigo-500/5 p-3 text-[11px] leading-relaxed text-zinc-400">
          <span className="mb-1 block font-medium text-zinc-300">Tip</span>
          A scene reads best as plain tags the checkpoint knows: place, action, light. Framing goes in the camera
          field, never in the scene, and dialogue never reaches the picture at all.
        </div>
      </div>
    </aside>
  )
}

interface PanelCardProps {
  spec: ComicPanelSpec
  state: ComicPanelState | undefined
  status: ComicPanelStatus | undefined
  plates: boolean
  progress: number | null
  busy: boolean
  onNextSeed: () => void
  onAgain: () => void
  onView: (src: string, caption: string) => void
}

const PanelCard = memo(function PanelCard({ spec, state, status, plates, progress, busy, onNextSeed, onAgain, onView }: PanelCardProps) {
  const url = state?.path ? `${fileUrl(state.path)}&v=${state.renderedAt ?? 0}` : null
  const verdict = state?.verdict ?? null
  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-white/10 bg-black/30">
      <div className="relative aspect-[3/4] bg-zinc-900">
        {url ? (
          <img
            src={url}
            alt={spec.id}
            role="presentation"
            onClick={() => onView(url, `${spec.id} · ${spec.camera}`)}
            className="size-full cursor-zoom-in object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-xs text-zinc-600">not rendered</div>
        )}
        {progress !== null ? (
          <div className="absolute inset-x-0 bottom-0 bg-black/60 p-1">
            <ProgressBar done={progress} total={1} />
          </div>
        ) : null}
        {plates && state?.plate ? (
          <button
            type="button"
            onClick={() => onView(`${fileUrl(state.plate!)}&v=${state.renderedAt ?? 0}`, `${spec.id} · the plate`)}
            title="The hosted model's plate this panel was painted into — open it"
            className="absolute bottom-1 right-1 h-12 w-9 overflow-hidden rounded border border-white/40 bg-black/40"
          >
            <img src={`${fileUrl(state.plate)}&v=${state.renderedAt ?? 0}`} alt="plate" className="size-full object-cover" />
          </button>
        ) : null}
        {verdict ? (
          <span className={cn('absolute left-1 top-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium', verdict.ok ? 'bg-emerald-500/80 text-white' : 'bg-red-500/80 text-white')} title={verdict.ok ? 'QA passed' : verdict.failures.join('\n')}>
            {verdict.ok ? 'ok' : verdict.failures.length === 1 ? verdict.failures[0] : `${verdict.failures.length} failures`}
          </span>
        ) : null}
        {/* QA saw something worth saying but not worth re-rendering for.
            Shown because the alternative is what happened before: a green
            badge, and the observation left in a file nobody opens. */}
        {verdict && verdict.notes.length > 0 ? (
          <span className="absolute left-1 top-7 rounded-full bg-sky-500/80 px-1.5 py-0.5 text-[10px] font-medium text-white" title={verdict.notes.join('\n')}>
            {verdict.notes.length === 1 ? '1 note' : `${verdict.notes.length} notes`}
          </span>
        ) : null}
        {status?.status === 'stale' ? (
          <span
            className="absolute right-1 top-1 rounded-full bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-medium text-black"
            title={`This picture is not what the script and settings now ask for: ${status.reason ?? 'the request changed'}. Render it again to catch up.`}
          >
            changed
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 p-2 text-[11px]">
        <div className="flex items-center gap-1 font-mono text-zinc-400" title={state?.prompt ?? undefined}>
          <span>{spec.id}</span>
          {state?.seed !== null && state?.seed !== undefined ? <span className="ml-auto">seed {state.seed}</span> : null}
          {state?.attempt ? <span>· try {state.attempt + 1}</span> : null}
        </div>
        <div className="line-clamp-2 text-zinc-500" title={spec.scene}>
          {spec.camera} · {spec.scene}
        </div>
        <div className="flex gap-1">
          <Button size="sm" disabled={busy} onClick={onNextSeed} title="Render this panel at the next seed in its family">
            Next seed
          </Button>
          <Button size="sm" disabled={busy} onClick={onAgain} title="Render this panel again at the same seed">
            Again
          </Button>
        </div>
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Step 4 — the pages

interface PagesViewProps {
  project: ComicProject | null
  hasScript: boolean
  busy: boolean
  onAssemble: (page: number | null) => void
  onView: (src: string, caption: string) => void
}

function PagesView({ project, hasScript, busy, onAssemble, onView }: PagesViewProps) {
  const rendered = project?.panels.filter((panel) => panel.path).length ?? 0
  const total = project?.panels.length ?? 0
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy || !hasScript || rendered < total || total === 0} onClick={() => onAssemble(null)} title={rendered < total ? `${total - rendered} panel(s) still need rendering` : 'Lay out every page, letter it, and write the PDF and CBZ'}>
          Assemble the book
        </Button>
        {project?.pdf ? <FileLink path={project.pdf} label="PDF" /> : null}
        {project?.cbz ? <FileLink path={project.cbz} label="CBZ" /> : null}
        <span className="text-xs text-zinc-500">
          {rendered}/{total} panels rendered · {project?.pages.length ?? 0} pages assembled
        </span>
      </div>
      {project && project.pages.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {project.pages.map((page) => (
            <figure key={page.number} className="overflow-hidden rounded-md border border-white/10 bg-black/30">
              <img
                src={`${fileUrl(page.path)}&v=${page.renderedAt}`}
                alt={`Page ${page.number}`}
                role="presentation"
                onClick={() => onView(`${fileUrl(page.path)}&v=${page.renderedAt}`, `Page ${page.number}`)}
                className="w-full cursor-zoom-in"
              />
              <figcaption className="flex items-center gap-2 p-2 text-xs text-zinc-400">
                Page {page.number}
                {page.stale ? (
                  <span
                    className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300"
                    title="One of this page's panels was drawn after the page was laid out, so this image is not showing the panels as they are now."
                  >
                    panels newer than this page
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => onView(`${fileUrl(page.path)}&v=${page.renderedAt}`, `Page ${page.number}`)}
                  className="text-indigo-300 hover:text-indigo-200"
                >
                  View
                </button>
                {isTauri() ? (
                  <button type="button" onClick={() => void revealInFileManager(page.path)} className="text-indigo-300 hover:text-indigo-200" title={page.path}>
                    Show file
                  </button>
                ) : (
                  <a href={`${fileUrl(page.path)}&v=${page.renderedAt}`} download={`page-${String(page.number).padStart(2, '0')}.png`} className="text-indigo-300 hover:text-indigo-200">
                    PNG
                  </a>
                )}
                <Button size="sm" className="ml-auto" disabled={busy} onClick={() => onAssemble(page.number)} title="Lay this page out again with the panels as they are now">
                  Assemble again
                </Button>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <div className="text-sm text-zinc-500">No pages yet. Render the panels, then assemble.</div>
      )}
    </section>
  )
}
