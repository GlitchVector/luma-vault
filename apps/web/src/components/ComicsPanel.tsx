import { Button, ProgressBar, Spinner, cn } from '@luma/ui'
import {
  COMIC_ANCHORS,
  COMIC_BALLOON_KINDS,
  COMIC_LAYOUTS,
  comicScriptSchema,
  type ComicDialogue,
  type ComicEvent,
  type ComicPageSpec,
  type ComicPanelSpec,
  type ComicPanelState,
  type ComicProject,
  type ComicRunOptions,
  type ComicScript,
  type ComicStatus,
  type ComicSummary,
} from '@luma/core'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  comicCancel,
  comicCreate,
  comicList,
  comicRead,
  comicRun,
  comicSave,
  comicStatus,
  fileUrl,
  forgeStatus,
  type ForgeStatus,
} from '#/lib/native.ts'
import { showMessage } from '#/lib/dialogs.ts'
import { toast } from '#/lib/toasts.ts'

interface ComicsPanelProps {
  onClose: () => void
}

type Step = 'story' | 'script' | 'panels' | 'pages'

const STEPS: Array<{ key: Step; label: string; hint: string }> = [
  { key: 'story', label: '1 · Story', hint: 'Prose in. Three paragraphs make a page.' },
  { key: 'script', label: '2 · Script', hint: 'What each panel shows and says. Edit anything.' },
  { key: 'panels', label: '3 · Panels', hint: 'One picture per panel, from Forge, checked by QA.' },
  { key: 'pages', label: '4 · Pages', hint: 'Lettered pages, a PDF and a CBZ.' },
]

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

/** A new panel with the fields the assembler needs and nothing decided. */
export function blankPanel(pageNumber: number, index: number): ComicPanelSpec {
  return {
    id: `p${pageNumber}-${index}`,
    camera: 'cowboy shot',
    scene: '',
    pose: [],
    characters: [],
    reserve_space: 'none',
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('story')
  const [newName, setNewName] = useState('')

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
  const panelState = useMemo(() => new Map((project?.panels ?? []).map((panel) => [panel.id, panel])), [project])
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
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-2">
        <h1 className="text-sm font-semibold">Comics</h1>
        <span className="text-xs text-zinc-500">prose in, lettered pages out</span>
        {forgeNote ? <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">{forgeNote}</span> : null}
        <div className="ml-auto flex items-center gap-2">
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
        <aside className="flex w-56 shrink-0 flex-col border-r border-white/10">
          <div className="flex gap-1 border-b border-white/10 p-2">
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
              }}
              placeholder="new comic name"
              className={cn(inputClass, 'text-xs')}
            />
            <Button size="sm" variant="primary" onClick={() => void create()} disabled={!newName.trim()}>
              New
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {comics === null ? (
              <div className="p-3 text-xs text-zinc-500">
                <Spinner /> reading…
              </div>
            ) : comics.length === 0 ? (
              <div className="p-3 text-xs text-zinc-500">No comics yet. Name one above.</div>
            ) : (
              comics.map((comic) => (
                <button
                  key={comic.name}
                  type="button"
                  onClick={() => void open(comic.name)}
                  className={cn(
                    'block w-full border-b border-white/5 px-3 py-2 text-left hover:bg-white/5',
                    comic.name === selected && 'bg-indigo-500/15',
                  )}
                >
                  <div className="truncate text-sm">{comic.title ?? comic.name}</div>
                  <div className="text-[11px] text-zinc-500">
                    {comic.hasScript
                      ? `${comic.pages} page${comic.pages === 1 ? '' : 's'} · ${comic.rendered}/${comic.panels} panels · ${comic.assembled} assembled`
                      : comic.hasProse
                        ? 'story only'
                        : 'empty'}
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {!selected ? (
            <div className="p-6 text-sm text-zinc-500">Pick a comic, or name a new one.</div>
          ) : (
            <>
              <nav className="flex items-center gap-1 border-b border-white/10 px-3 py-2">
                {STEPS.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => setStep(entry.key)}
                    title={entry.hint}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium',
                      step === entry.key ? 'bg-indigo-500 text-white' : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200',
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
                <span className="ml-3 text-xs text-zinc-500">{STEPS.find((entry) => entry.key === step)?.hint}</span>
                {proseDirty || scriptDirty ? (
                  <Button size="sm" className="ml-auto" onClick={() => void saveAll().then((ok) => ok && toast('saved'))}>
                    Save
                  </Button>
                ) : null}
              </nav>

              {loadError ? <div className="m-3 rounded-md bg-red-500/10 p-3 text-xs text-red-300">{loadError}</div> : null}

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
                      onToggleRaw={() => {
                        if (rawMode) {
                          try {
                            const parsed = comicScriptSchema.parse(JSON.parse(rawText))
                            setScript(parsed)
                            setScriptError(null)
                            setRawMode(false)
                          } catch (error) {
                            setScriptError(String(error))
                          }
                        } else {
                          setRawText(JSON.stringify(script, null, 2))
                          setRawMode(true)
                        }
                      }}
                      onChange={updateScript}
                      onRender={() => void run({ stage: 'panels', page: null, panel: null, seed: null, attempt: null, force: false, noTagger: false })}
                      busy={busy}
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
                      rendering={rendering}
                      busy={busy}
                      onRender={(options) => void run(options)}
                    />
                  )
                ) : null}

                {step === 'pages' ? (
                  <PagesView project={project} busy={busy} hasScript={hasScript} onAssemble={(page) => void run({ stage: 'assemble', page, panel: null, seed: null, attempt: null, force: false, noTagger: false })} />
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
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — the script

interface ScriptEditorProps {
  script: ComicScript
  cast: string[]
  rawMode: boolean
  rawText: string
  scriptError: string | null
  busy: boolean
  onRaw: (text: string) => void
  onToggleRaw: () => void
  onChange: (update: (previous: ComicScript) => ComicScript) => void
  onRender: () => void
}

function ScriptEditor({ script, cast, rawMode, rawText, scriptError, busy, onRaw, onToggleRaw, onChange, onRender }: ScriptEditorProps) {
  const setPage = (pageIndex: number, update: (page: ComicPageSpec) => ComicPageSpec) =>
    onChange((previous) => ({
      ...previous,
      pages: renumber(previous.pages.map((page, index) => (index === pageIndex ? update(page) : page))),
    }))

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <input
          value={script.title}
          onChange={(event) => onChange((previous) => ({ ...previous, title: event.target.value }))}
          className={cn(inputClass, 'max-w-md text-lg font-semibold')}
          placeholder="Title"
        />
        <span className="text-xs text-zinc-500">
          cast: {cast.length ? cast.join(', ') : 'nobody — add characters in comic.config.json'}
        </span>
        <Button size="sm" className="ml-auto" onClick={onToggleRaw}>
          {rawMode ? 'Back to the form' : 'Edit as JSON'}
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={onRender}>
          Render the panels
        </Button>
      </div>
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
            onChange={(update) => setPage(pageIndex, update)}
            onRemove={() => onChange((previous) => ({ ...previous, pages: renumber(previous.pages.filter((_, index) => index !== pageIndex)) }))}
          />
        ))
      )}
      {!rawMode ? (
        <Button
          size="sm"
          onClick={() =>
            onChange((previous) => ({
              ...previous,
              pages: renumber([...previous.pages, { layout: 'hero-top', panels: [1, 2, 3].map((n) => blankPanel(previous.pages.length + 1, n)) }]),
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
  onChange: (update: (page: ComicPageSpec) => ComicPageSpec) => void
  onRemove: () => void
}

const PageEditor = memo(function PageEditor({ page, pageNumber, cast, onChange, onRemove }: PageEditorProps) {
  const layoutName = typeof page.layout === 'string' ? page.layout : 'custom'
  const cells = typeof page.layout === 'string' ? COMIC_LAYOUTS[page.layout]?.cells.length : undefined
  const mismatch = cells !== undefined && cells !== page.panels.length

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-semibold">Page {pageNumber}</span>
        <select
          value={layoutName}
          onChange={(event) => onChange((previous) => ({ ...previous, layout: event.target.value }))}
          className={selectClass}
          title="The grid the panels sit in. The number in brackets must match the number of panels."
        >
          {Object.entries(COMIC_LAYOUTS).map(([name, layout]) => (
            <option key={name} value={name}>
              {name} ({layout.cells.length})
            </option>
          ))}
          {layoutName === 'custom' ? <option value="custom">custom grid</option> : null}
        </select>
        {mismatch ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
            {page.panels.length} panels on a {cells}-panel layout — pick a layout that fits, or add/remove a panel
          </span>
        ) : null}
        <Button size="sm" className="ml-auto" onClick={() => onChange((previous) => ({ ...previous, panels: [...previous.panels, blankPanel(pageNumber, previous.panels.length + 1)] }))}>
          Add a panel
        </Button>
        <Button size="sm" variant="danger" onClick={onRemove} title="Remove this page and its panels from the script">
          Remove page
        </Button>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {page.panels.map((panel, index) => (
          <PanelEditor
            key={panel.id}
            panel={panel}
            cast={cast}
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
  onChange: (update: (panel: ComicPanelSpec) => ComicPanelSpec) => void
  onRemove: () => void
}

const PanelEditor = memo(function PanelEditor({ panel, cast, onChange, onRemove }: PanelEditorProps) {
  const setLine = (index: number, patch: Partial<ComicDialogue>) =>
    onChange((previous) => ({ ...previous, dialogue: previous.dialogue.map((line, i) => (i === index ? { ...line, ...patch } : line)) }))

  return (
    <div className="rounded-md border border-white/10 bg-black/30 p-2 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-zinc-400">{panel.id}</span>
        <label className="ml-auto flex items-center gap-1 text-zinc-500">
          space for lettering
          <select value={panel.reserve_space} onChange={(event) => onChange((previous) => ({ ...previous, reserve_space: event.target.value as ComicPanelSpec['reserve_space'] }))} className={selectClass}>
            <option value="none">none</option>
            {COMIC_ANCHORS.map((anchor) => (
              <option key={anchor} value={anchor}>
                {anchor}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={onRemove} className="text-zinc-500 hover:text-red-300" title="Remove this panel">
          ✕
        </button>
      </div>
      <input value={panel.camera} onChange={(event) => onChange((previous) => ({ ...previous, camera: event.target.value }))} className={cn(inputClass, 'mb-1')} placeholder="camera: close-up, from below, cowboy shot…" title="Framing words the checkpoint knows" />
      <textarea value={panel.scene} onChange={(event) => onChange((previous) => ({ ...previous, scene: event.target.value }))} className={cn(inputClass, 'mb-1 min-h-14 resize-y')} placeholder="scene: setting, action, light — no names, no words spoken (only the local model reads this)" />
      <input
        value={panel.setting ?? ''}
        onChange={(event) => onChange((previous) => ({ ...previous, setting: event.target.value || undefined }))}
        className={cn(inputClass, 'mb-1')}
        placeholder="setting for the plate: the place and light in this shot, nobody in it (a hosted model reads this — keep it clean)"
        title="Sent to the hosted image model that draws the plate. The place, the light, the props. No nudity, no sexual content, no names."
      />
      <div className="mb-1 flex flex-wrap items-center gap-1">
        <span className="text-zinc-500">in the picture:</span>
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
      </div>
      {panel.characters.map((id, index) => (
        <div key={id} className="mb-1 flex items-center gap-1">
          <span className="w-16 shrink-0 truncate text-zinc-500" title={`${id}'s stand-in in the plate: posture and gesture only, a hosted model reads it`}>
            pose · {id}
          </span>
          <input
            value={panel.pose[index] ?? ''}
            onChange={(event) =>
              onChange((previous) => {
                const pose = [...previous.pose]
                while (pose.length <= index) pose.push('')
                pose[index] = event.target.value
                return { ...previous, pose }
              })
            }
            className={inputClass}
            placeholder="standing at the rail, one hand raised"
          />
        </div>
      ))}
      {panel.dialogue.map((line, index) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className="mb-1 flex items-center gap-1"
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
          <input value={line.text} onChange={(event) => setLine(index, { text: event.target.value })} className={inputClass} placeholder="what is said" />
          <button type="button" onClick={() => onChange((previous) => ({ ...previous, dialogue: previous.dialogue.filter((_, i) => i !== index) }))} className="text-zinc-500 hover:text-red-300" title="Remove this balloon">
            ✕
          </button>
        </div>
      ))}
      {panel.sfx.map((sfx, index) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={`sfx-${index}`}
          className="mb-1 flex items-center gap-1"
        >
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase text-amber-300">sfx</span>
          <select value={sfx.anchor} onChange={(event) => onChange((previous) => ({ ...previous, sfx: previous.sfx.map((s, i) => (i === index ? { ...s, anchor: event.target.value as ComicDialogue['anchor'] } : s)) }))} className={selectClass}>
            {COMIC_ANCHORS.map((anchor) => (
              <option key={anchor} value={anchor}>
                {anchor}
              </option>
            ))}
          </select>
          <input value={sfx.text} onChange={(event) => onChange((previous) => ({ ...previous, sfx: previous.sfx.map((s, i) => (i === index ? { ...s, text: event.target.value } : s)) }))} className={inputClass} placeholder="WHAM" />
          <button type="button" onClick={() => onChange((previous) => ({ ...previous, sfx: previous.sfx.filter((_, i) => i !== index) }))} className="text-zinc-500 hover:text-red-300" title="Remove this sound effect">
            ✕
          </button>
        </div>
      ))}
      <div className="flex gap-2">
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
          + balloon
        </button>
        <button type="button" onClick={() => onChange((previous) => ({ ...previous, sfx: [...previous.sfx, { text: '', anchor: 'bottom-right', rotate: -8 }] }))} className="text-indigo-300 hover:text-indigo-200">
          + sound effect
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
  rendering: ComicEvent | null
  busy: boolean
  onRender: (options: ComicRunOptions) => void
}

const baseRun: ComicRunOptions = { stage: 'panels', page: null, panel: null, seed: null, attempt: null, force: false, noTagger: false }

function PanelsView({ script, state, rendering, busy, onRender }: PanelsViewProps) {
  const total = script.pages.reduce((n, page) => n + page.panels.length, 0)
  const done = script.pages.reduce((n, page) => n + page.panels.filter((panel) => state.get(panel.id)?.path).length, 0)
  const checked = [...state.values()].filter((panel) => panel.verdict).length
  const failing = [...state.values()].filter((panel) => panel.verdict && !panel.verdict.ok).length

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => onRender(baseRun)} title="Render every panel that is missing or whose prompt changed; the rest come from the cache">
          Render {done < total ? `the missing ${total - done}` : 'changed panels'}
        </Button>
        <Button disabled={busy || done === 0} onClick={() => onRender({ ...baseRun, stage: 'qa' })} title="Check every rendered panel for blank output, the wrong number of figures, anatomy tags and no room for the balloon; failures re-render at the next seed">
          Check (QA)
        </Button>
        <Button disabled={busy} onClick={() => onRender({ ...baseRun, force: true })} title="Render every panel again at its current seed, cache or not">
          Render all again
        </Button>
        <span className="text-xs text-zinc-500">
          {done}/{total} rendered · {checked} checked{failing ? ` · ${failing} failing` : ''}
        </span>
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

interface PanelCardProps {
  spec: ComicPanelSpec
  state: ComicPanelState | undefined
  progress: number | null
  busy: boolean
  onNextSeed: () => void
  onAgain: () => void
}

const PanelCard = memo(function PanelCard({ spec, state, progress, busy, onNextSeed, onAgain }: PanelCardProps) {
  const url = state?.path ? `${fileUrl(state.path)}&v=${state.renderedAt ?? 0}` : null
  const verdict = state?.verdict ?? null
  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-white/10 bg-black/30">
      <div className="relative aspect-[3/4] bg-zinc-900">
        {url ? <img src={url} alt={spec.id} className="size-full object-cover" /> : <div className="flex size-full items-center justify-center text-xs text-zinc-600">not rendered</div>}
        {progress !== null ? (
          <div className="absolute inset-x-0 bottom-0 bg-black/60 p-1">
            <ProgressBar done={progress} total={1} />
          </div>
        ) : null}
        {state?.plate ? (
          <a
            href={`${fileUrl(state.plate)}&v=${state.renderedAt ?? 0}`}
            target="_blank"
            rel="noreferrer"
            title="The hosted model's plate this panel was painted into — open it"
            className="absolute bottom-1 right-1 h-12 w-9 overflow-hidden rounded border border-white/40 bg-black/40"
          >
            <img src={`${fileUrl(state.plate)}&v=${state.renderedAt ?? 0}`} alt="plate" className="size-full object-cover" />
          </a>
        ) : null}
        {verdict ? (
          <span className={cn('absolute left-1 top-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium', verdict.ok ? 'bg-emerald-500/80 text-white' : 'bg-red-500/80 text-white')} title={verdict.ok ? 'QA passed' : verdict.failures.join('\n')}>
            {verdict.ok ? 'ok' : verdict.failures.length === 1 ? verdict.failures[0] : `${verdict.failures.length} failures`}
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
}

function PagesView({ project, hasScript, busy, onAssemble }: PagesViewProps) {
  const rendered = project?.panels.filter((panel) => panel.path).length ?? 0
  const total = project?.panels.length ?? 0
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy || !hasScript || rendered < total || total === 0} onClick={() => onAssemble(null)} title={rendered < total ? `${total - rendered} panel(s) still need rendering` : 'Lay out every page, letter it, and write the PDF and CBZ'}>
          Assemble the book
        </Button>
        {project?.pdf ? (
          <a href={fileUrl(project.pdf)} download="book.pdf" className="rounded-md bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10">
            PDF
          </a>
        ) : null}
        {project?.cbz ? (
          <a href={fileUrl(project.cbz)} download="book.cbz" className="rounded-md bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10">
            CBZ
          </a>
        ) : null}
        <span className="text-xs text-zinc-500">
          {rendered}/{total} panels rendered · {project?.pages.length ?? 0} pages assembled
        </span>
      </div>
      {project && project.pages.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {project.pages.map((page) => (
            <figure key={page.number} className="overflow-hidden rounded-md border border-white/10 bg-black/30">
              <img src={`${fileUrl(page.path)}&v=${page.renderedAt}`} alt={`Page ${page.number}`} className="w-full" />
              <figcaption className="flex items-center gap-2 p-2 text-xs text-zinc-400">
                Page {page.number}
                <a href={`${fileUrl(page.path)}&v=${page.renderedAt}`} download={`page-${String(page.number).padStart(2, '0')}.png`} className="text-indigo-300 hover:text-indigo-200">
                  PNG
                </a>
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
