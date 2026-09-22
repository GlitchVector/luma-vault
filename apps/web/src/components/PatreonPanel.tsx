import { Button, Spinner } from '@luma/ui'
import {
  actLabelOf,
  isFourK,
  moveRows,
  reverseRows,
  type MediaItem,
  type PatreonAccessRule,
  type PatreonSummary,
  type SetMemberRow,
} from '@luma/core'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fileUrl,
  mediaByPath,
  onPatreonProgress,
  onUpscaleProgress,
  openExternal,
  patreonPost,
  patreonTiers,
  reorderSet,
  reorderSets,
  upscaleMedia,
  type PatreonProgress,
  type UpscaleProgress,
} from '#/lib/native.ts'

interface PatreonPanelProps {
  /** In post order — the merged, collated order the grid already shows. */
  items: MediaItem[]
  /** The runs those items came from, in selection order. Empty for a loose selection. */
  sets: string[]
  /** Label and position per picture, for the group headings. May be empty. */
  members: SetMemberRow[]
  /** What the first selected set was called, to start the title from. */
  setTitle: string | null
  onClose: () => void
  /**
   * The rows were dragged into a new order and it has been written back. The
   * grid re-reads so it shows the same order the manifest now holds.
   */
  onReordered: () => void
}

/**
 * Whether a picture still needs a 4K version made before it can go up.
 *
 * Three ways to already be fine: it is 4K itself, it *is* a 4K variant, or a
 * variant of it exists. Videos are left alone — the upscaler does stills.
 */
export function needsFourK(item: MediaItem): boolean {
  return (
    item.kind === 'image' &&
    !isFourK(item.width, item.height) &&
    item.upscaledFrom === null &&
    item.upscaledTo === null
  )
}

/** What has been decided about the pictures that have no 4K version. */
type FourKDecision = 'pending' | 'upscale' | 'as-is'

/**
 * Who a post is for, as the editor's own three choices: everyone, every paid
 * member, or the tiers picked by hand. Each is an access rule on the campaign
 * — public and "paid members" are rules with ids of their own, not the absence
 * of one, which is why the request carries ids for all three.
 */
type Audience = 'public' | 'patrons' | 'tiers'

/** "Supporter · $10.00", or the id when the reward gave no name. */
function ruleLabel(rule: PatreonAccessRule): string {
  const name = rule.title ?? rule.id
  if (rule.amountCents === null) return name
  const amount =
    rule.currency === null
      ? (rule.amountCents / 100).toFixed(2)
      : // Pinned to en-US: it is what the editor shows for a USD campaign, and a
        // label that reads differently per machine would be a test that cannot pin it.
        new Intl.NumberFormat('en-US', { style: 'currency', currency: rule.currency }).format(rule.amountCents / 100)
  return `${name} · ${amount}`
}

/** How long to wait for the watcher to index a fresh 4K file. */
const INDEX_WAIT_MS = 45_000
const INDEX_POLL_MS = 1_000

/**
 * Compose a Patreon draft from a selection, and reorder it by hand.
 *
 * The order shown is the order posted, and it starts as the collation the grid
 * worked out — every set's stage 1 before any set's stage 2. A reorder here is
 * the final word: with one set showing the new order is written straight back
 * to that set's manifest, and with several each set gets its own members' new
 * relative order while the interleaving stays with the post. That split is not
 * a compromise; a manifest cannot express where another set's frame sits.
 *
 * Three ways to reorder, because a post of eighty-seven is not reordered one
 * drag at a time: a row drags on its own; rows ticked together move as one
 * block when any of them is dragged, keeping their order; and the whole list
 * flips with one button (the runs come out newest-first and a story reads the
 * other way). The drag carries a payload on `dataTransfer` because WebKit does
 * not start a drag without one — the panel is used from the Mac over the LAN.
 *
 * What goes up is 4K. The grid shows originals and hides their 4K variants, so
 * a selection is always originals; the panel swaps each for its variant where
 * one exists, and asks about the rest before doing anything. Only a picture
 * with no variant at all needs the model — and the ask is one question for the
 * batch, because a set of forty is not forty decisions.
 *
 * Everything ends as a draft. The client has no publish path, and the last
 * thing this panel shows is the editor URL, for a person to open and press the
 * button themselves.
 *
 * The adult box is required rather than defaulted, even though every set in
 * this library is adult, because the client checks it against the campaign and
 * a checkbox someone ticked is a fact; a default is a guess.
 */
export function PatreonPanel({ items, sets, members, setTitle, onClose, onReordered }: PatreonPanelProps) {
  const [rows, setRows] = useState<MediaItem[]>(items)
  const [title, setTitle_] = useState(setTitle ?? '')
  const [body, setBody] = useState('')
  /** The campaign's rules, once read. `null` while reading; an error is shown in their place. */
  const [rules, setRules] = useState<PatreonAccessRule[] | null>(null)
  const [rulesError, setRulesError] = useState<string | null>(null)
  const [audience, setAudience] = useState<Audience | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [adult, setAdult] = useState<boolean | null>(null)
  const [progress, setProgress] = useState<PatreonProgress | null>(null)
  const [summary, setSummary] = useState<PatreonSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  /** The gap (0…rows.length) the drag would drop into, for the insertion line. */
  const [dropGap, setDropGap] = useState<number | null>(null)
  /** Rows ticked to move together, by media id. */
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [writingOrder, setWritingOrder] = useState(false)
  const [decision, setDecision] = useState<FourKDecision>('pending')
  const [upscaling, setUpscaling] = useState<UpscaleProgress | null>(null)
  /** Swapping a row for a 4K that already exists, or waiting for a fresh one to be indexed. */
  const [resolving, setResolving] = useState(0)
  /**
   * The original each 4K row stands in for, so headings and labels — keyed by
   * the original's id, which is what the set knows — survive the swap.
   */
  const originalOf = useRef(new Map<number, number>())
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  /** Label by media id, so a row can carry its stage or act heading. */
  const labelOf = useMemo(() => {
    const byId = new Map<number, string | null>()
    for (const row of members) if (!byId.has(row.mediaId)) byId.set(row.mediaId, row.label)
    return (id: number) => byId.get(originalOf.current.get(id) ?? id) ?? null
  }, [members])

  /** Put a 4K row where its original sits, keeping the order exactly. */
  const swapIn = useCallback((originalPath: string, fourK: MediaItem) => {
    setRows((current) =>
      current.map((row) => {
        if (row.path !== originalPath) return row
        originalOf.current.set(fourK.id, originalOf.current.get(row.id) ?? row.id)
        return fourK
      }),
    )
  }, [])

  // Pictures that already have a 4K version are swapped for it the moment the
  // panel opens, with no question asked: that is what "always 4K" means.
  useEffect(() => {
    const ready = items.filter((item) => item.upscaledTo !== null)
    if (ready.length === 0) return
    setResolving((n) => n + ready.length)
    for (const item of ready) {
      void mediaByPath(item.upscaledTo as string).then(
        (fourK) => {
          if (live.current && fourK !== null) swapIn(item.path, fourK)
          if (live.current) setResolving((n) => n - 1)
        },
        () => {
          if (live.current) setResolving((n) => n - 1)
        },
      )
    }
  }, [items, swapIn])

  const needing = useMemo(() => rows.filter(needsFourK), [rows])

  // The rules are the campaign's, read once per panel: a few seconds through
  // the client, on the cookie jar. Nothing here is guessed — the first draft
  // from this panel went up free because the field asked for ids nobody had.
  useEffect(() => {
    void patreonTiers().then(
      (found) => {
        if (live.current) setRules(found)
      },
      (reason: unknown) => {
        if (live.current) setRulesError(String(reason))
      },
    )
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && progress === null && upscaling === null) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, progress, upscaling])

  const patronsRule = rules?.find((rule) => rule.type === 'patrons') ?? null
  const tierRules = useMemo(() => (rules ?? []).filter((rule) => rule.type === 'tier'), [rules])
  /** The access-rule ids the post carries. Empty means public — the client resolves that rule itself. */
  const tiers =
    audience === 'patrons' && patronsRule !== null
      ? [patronsRule.id]
      : audience === 'tiers'
        ? tierRules.filter((rule) => picked.has(rule.id)).map((rule) => rule.id)
        : []
  /** Somebody has been chosen, and for the two locked choices the choice resolved to at least one rule. */
  const audienceChosen = audience === 'public' || tiers.length > 0

  /**
   * Make the missing 4K versions, then stand them in for their originals.
   *
   * The upscaler writes beside the original and the watcher indexes the file a
   * few seconds later — the index is what turns a path into a row this post
   * can name, so each destination is polled until it appears. A file that never
   * appears keeps its original in the post and is named in the error, rather
   * than the whole post being refused for one stuck file.
   */
  const upscaleFirst = () => {
    setDecision('upscale')
    setError(null)
    const targets = needing
    setUpscaling({
      phase: 'start',
      done: 0,
      total: targets.length,
      current: null,
      destination: null,
      finalWidth: null,
      finalHeight: null,
    })
    void onUpscaleProgress(setUpscaling).then((unlisten) =>
      upscaleMedia(targets.map((item) => item.id)).then(
        async (result) => {
          unlisten()
          setUpscaling(null)
          const missed: string[] = [...result.errors]
          setResolving((n) => n + result.outputs.length)
          await Promise.all(
            result.outputs.map(async (output) => {
              const fourK = await waitForRow(output.destination)
              if (!live.current) return
              if (fourK === null) missed.push(`${output.name}: was made but has not been indexed yet`)
              else swapIn(output.source, fourK)
              setResolving((n) => n - 1)
            }),
          )
          if (!live.current) return
          if (missed.length > 0) {
            setError(
              `${missed.length} of ${targets.length} could not be swapped for a 4K version and will post as they are:\n${missed.join('\n')}`,
            )
          }
        },
        (reason: unknown) => {
          unlisten()
          setUpscaling(null)
          setDecision('pending')
          setError(String(reason))
        },
      ),
    )
  }

  /**
   * Show a new order, then write it back.
   *
   * Written after the local move rather than before, so the list does not
   * snap back while the manifest is being rewritten. If the write fails the
   * rows stay where they were put and the error says the manifest did not
   * follow — which is the truthful state.
   *
   * The paths written are the *originals'*: the set names those, and a 4K
   * variant standing in here is the post's business, not the manifest's.
   */
  const commitOrder = useCallback(
    (next: readonly MediaItem[]) => {
      setRows([...next])
      if (sets.length === 0) return
      setWritingOrder(true)
      const paths = next.map((item) => item.upscaledFrom ?? item.path)
      const write = sets.length === 1 ? reorderSet(sets[0] as string, paths) : reorderSets(sets, paths)
      void write.then(
        () => {
          setWritingOrder(false)
          onReordered()
        },
        (reason: unknown) => {
          setWritingOrder(false)
          setError(`The new order is shown here but could not be written to the set: ${String(reason)}`)
        },
      )
    },
    [sets, onReordered],
  )

  /**
   * Drop the drag into gap `gap`. A dragged row that is ticked takes every
   * ticked row with it, as one block in their current order; an unticked row
   * moves alone even when others are ticked, so a tick is never a trap.
   */
  const dropAt = useCallback(
    (gap: number) => {
      setDragging(null)
      setDropGap(null)
      if (dragging === null) return
      const dragged = rows[dragging]
      const moving =
        dragged !== undefined && checked.has(dragged.id)
          ? rows.flatMap((row, index) => (checked.has(row.id) ? [index] : []))
          : [dragging]
      const next = moveRows(rows, moving, gap)
      if (next !== rows) commitOrder(next)
    },
    [dragging, rows, checked, commitOrder],
  )

  /** The gap a pointer over row `index` means: above its middle is before it, below is after. */
  const gapFor = (index: number, event: React.DragEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return event.clientY - box.top > box.height / 2 ? index + 1 : index
  }

  const toggleChecked = useCallback((id: number) => {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const send = () => {
    if (adult === null) return
    setError(null)
    setProgress({ phase: 'checking', done: 0, total: rows.length, line: 'starting…' })
    void onPatreonProgress(setProgress).then((unlisten) =>
      patreonPost({ ids: rows.map((item) => item.id), title: title.trim(), body, tiers, adult }).then(
        (result) => {
          unlisten()
          setProgress(null)
          setSummary(result)
          if (result.error !== null) setError(result.error)
        },
        (reason: unknown) => {
          unlisten()
          setProgress(null)
          setError(String(reason))
        },
      ),
    )
  }

  const busy = progress !== null || upscaling !== null || resolving > 0
  const undecided = needing.length > 0 && decision === 'pending'
  const canSend =
    !busy && !undecided && summary === null && title.trim().length > 0 && adult !== null && audienceChosen
  const fourKCount = rows.filter((row) => !needsFourK(row)).length

  return (
    <div className="fixed inset-0 z-[95] flex flex-col bg-black/92 backdrop-blur-sm">
      <header className="flex items-center gap-3 border-b border-white/5 px-4 py-2.5 text-sm">
        <span className="font-medium text-zinc-200">
          {summary?.url ? 'Draft created' : `${rows.length.toLocaleString()} to post`}
          {sets.length > 1 ? (
            <span className="ml-2 text-zinc-500">{sets.length} sets, collated by stage</span>
          ) : null}
        </span>
        {progress ? (
          <span className="flex min-w-0 items-center gap-2 text-indigo-300">
            <Spinner />
            <span className="capitalize">{progress.phase}</span>
            <span className="tabular-nums">
              {progress.done}/{progress.total}
            </span>
            <span className="truncate text-zinc-500">{progress.line}</span>
          </span>
        ) : upscaling ? (
          <span className="flex min-w-0 items-center gap-2 text-indigo-300">
            <Spinner />
            Upscaling {Math.min(upscaling.done + 1, upscaling.total)}/{upscaling.total}
            {upscaling.current ? <span className="truncate text-zinc-500">{upscaling.current}</span> : null}
          </span>
        ) : resolving > 0 ? (
          <span className="flex items-center gap-2 text-zinc-400">
            <Spinner /> finding the 4K versions
          </span>
        ) : writingOrder ? (
          <span className="flex items-center gap-2 text-zinc-400">
            <Spinner /> writing the order to the set
          </span>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          onClick={onClose}
          disabled={progress !== null || upscaling !== null}
          title={progress || upscaling ? 'Wait for it to finish' : 'Close (Esc)'}
        >
          Close
        </Button>
      </header>

      {error ? (
        <p className="shrink-0 whitespace-pre-line border-b border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      {/* One question for the batch. Asked before anything else can happen, and
          answered once: forty pictures are not forty decisions. */}
      {undecided && summary === null ? (
        <div
          role="group"
          aria-label="4K check"
          className="flex flex-wrap items-center gap-3 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-sm"
        >
          <span className="text-amber-100">
            {needing.length.toLocaleString()} of {rows.length.toLocaleString()} ha{needing.length === 1 ? 's' : 've'} no
            4K version.
          </span>
          <Button size="sm" variant="primary" onClick={upscaleFirst} disabled={resolving > 0}>
            Upscale {needing.length === rows.length ? 'them' : `the ${needing.length.toLocaleString()}`} first
          </Button>
          <Button size="sm" onClick={() => setDecision('as-is')} disabled={resolving > 0}>
            Post as they are
          </Button>
        </div>
      ) : null}

      {summary?.url ? (
        <Done summary={summary} onClose={onClose} />
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-3 border-b border-white/5 px-4 py-2 text-sm">
            <label className="flex min-w-64 flex-1 items-center gap-2">
              <span className="shrink-0 text-zinc-500">Title</span>
              <input
                value={title}
                onChange={(event) => setTitle_(event.target.value)}
                placeholder="what this post is called"
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-zinc-200 outline-none focus:border-indigo-400/60"
              />
            </label>
            {/* Three states on purpose. Unset is what stops the button; there is
                no default because the client checks this against the campaign
                and a ticked box is a fact where a default would be a guess. */}
            <span className="flex items-center gap-3">
              <span className="text-zinc-500">Adult</span>
              <label className="flex items-center gap-1">
                <input type="radio" name="adult" checked={adult === true} onChange={() => setAdult(true)} />
                <span className={adult === true ? 'text-zinc-200' : 'text-zinc-500'}>yes</span>
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" name="adult" checked={adult === false} onChange={() => setAdult(false)} />
                <span className={adult === false ? 'text-zinc-200' : 'text-zinc-500'}>no</span>
              </label>
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={!canSend}
              onClick={send}
              title={
                undecided
                  ? 'Decide about the pictures with no 4K version first'
                  : adult === null
                    ? 'Say whether this is adult content first'
                    : !audienceChosen
                      ? 'Say who can see it first'
                      : title.trim().length === 0
                        ? 'Give the post a title first'
                        : 'Upload everything and stop at a draft. Nothing is published.'
              }
            >
              Create draft
            </Button>
          </div>

          {/* Chosen, never defaulted, for the same reason as the adult box:
              the one draft this panel made before it existed went up free. */}
          <div
            role="group"
            aria-label="Who can see it"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/5 px-4 py-2 text-sm"
          >
            <span className="text-zinc-500">Who can see it</span>
            <label className="flex items-center gap-1">
              <input type="radio" name="audience" checked={audience === 'public'} onChange={() => setAudience('public')} />
              <span className={audience === 'public' ? 'text-zinc-200' : 'text-zinc-500'}>Everyone</span>
            </label>
            <label className="flex items-center gap-1" title={rules !== null && patronsRule === null ? 'This campaign has no paid-members rule' : undefined}>
              <input
                type="radio"
                name="audience"
                checked={audience === 'patrons'}
                disabled={rules !== null && patronsRule === null}
                onChange={() => setAudience('patrons')}
              />
              <span className={audience === 'patrons' ? 'text-zinc-200' : 'text-zinc-500'}>Paid members</span>
            </label>
            <label className="flex items-center gap-1" title={rules !== null && tierRules.length === 0 ? 'This campaign has no tiers' : undefined}>
              <input
                type="radio"
                name="audience"
                checked={audience === 'tiers'}
                disabled={rules !== null && tierRules.length === 0}
                onChange={() => setAudience('tiers')}
              />
              <span className={audience === 'tiers' ? 'text-zinc-200' : 'text-zinc-500'}>Some tiers</span>
            </label>
            {rules === null && rulesError === null ? (
              <span className="flex items-center gap-2 text-zinc-500">
                <Spinner /> reading the campaign…
              </span>
            ) : null}
            {rulesError !== null ? (
              <span className="text-rose-300" title={rulesError}>
                could not read the campaign's tiers — {rulesError.split('\n')[0]}
              </span>
            ) : null}
            {audience === 'tiers'
              ? tierRules.map((rule) => (
                  <label key={rule.id} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={picked.has(rule.id)}
                      onChange={() =>
                        setPicked((current) => {
                          const next = new Set(current)
                          if (next.has(rule.id)) next.delete(rule.id)
                          else next.add(rule.id)
                          return next
                        })
                      }
                    />
                    <span className={picked.has(rule.id) ? 'text-zinc-200' : 'text-zinc-500'}>{ruleLabel(rule)}</span>
                  </label>
                ))
              : null}
          </div>

          <label className="flex shrink-0 flex-col gap-1 border-b border-white/5 px-4 py-2 text-sm">
            <span className="text-zinc-500">
              Body <span className="text-zinc-600">— paragraphs, **bold**, [links](https://…)</span>
            </span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={3}
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-zinc-200 outline-none focus:border-indigo-400/60"
            />
          </label>

          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-xs text-zinc-500">
            <p className="min-w-0 flex-1">
              {fourKCount === rows.length
                ? 'All 4K. '
                : `${fourKCount.toLocaleString()} of ${rows.length.toLocaleString()} are 4K. `}
              Drag a row to move it; tick several and drag one of them to move them together. The first picture is the
              preview non-patrons see.
              {sets.length > 0
                ? sets.length === 1
                  ? ' Every reorder is written back to the set.'
                  : ' Every reorder is written back to each set; how the sets interleave stays with this post.'
                : ''}
            </p>
            {checked.size > 0 ? (
              <span className="flex items-center gap-2 text-zinc-400">
                {checked.size.toLocaleString()} ticked
                <button
                  type="button"
                  onClick={() => setChecked(new Set())}
                  className="text-indigo-300 underline decoration-dotted hover:text-indigo-200"
                >
                  untick all
                </button>
              </span>
            ) : null}
            <Button size="sm" disabled={busy || rows.length < 2} onClick={() => commitOrder(reverseRows(rows))} title="Last picture first">
              Reverse order
            </Button>
          </div>

          <ol className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
            {rows.map((item, index) => {
              const heading = actLabelOf(labelOf(item.id))
              const previousHeading = index > 0 ? actLabelOf(labelOf(rows[index - 1]?.id ?? -1)) : null
              return (
                <Row
                  key={item.id}
                  item={item}
                  index={index}
                  heading={heading !== null && heading !== previousHeading ? heading : null}
                  label={labelOf(item.id)}
                  fourK={!needsFourK(item)}
                  dragging={
                    dragging !== null &&
                    (dragging === index || (checked.has(item.id) && checked.has(rows[dragging]?.id ?? -1)))
                  }
                  dropLine={dropGap === index ? 'before' : dropGap === index + 1 && index === rows.length - 1 ? 'after' : null}
                  checked={checked.has(item.id)}
                  disabled={busy}
                  onToggle={() => toggleChecked(item.id)}
                  onDragStart={(event) => {
                    // WebKit needs a payload or the drag never starts; the id is as good as any.
                    event.dataTransfer?.setData('text/plain', String(item.id))
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                    setDragging(index)
                  }}
                  onDragOver={(event) => setDropGap(gapFor(index, event))}
                  onDrop={(event) => dropAt(gapFor(index, event))}
                  onDragEnd={() => {
                    setDragging(null)
                    setDropGap(null)
                  }}
                  onDropAfterLast={index === rows.length - 1 ? () => dropAt(rows.length) : undefined}
                  onDragOverAfterLast={index === rows.length - 1 ? () => setDropGap(rows.length) : undefined}
                />
              )
            })}
          </ol>
        </>
      )}
    </div>
  )
}

/**
 * Wait for the watcher to index a file the upscaler just wrote.
 *
 * Polled rather than assumed: the debounce alone is three seconds, and a
 * network share can be slower. Bounded, because a file that never appears has
 * to become an error rather than a spinner.
 */
async function waitForRow(path: string): Promise<MediaItem | null> {
  const deadline = Date.now() + INDEX_WAIT_MS
  for (;;) {
    // Sequential on purpose — this loop *is* the waiting. Parallelising it,
    // which is what the lint rule assumes was meant, would be a tight spin
    // against the index for a file that is not there yet.
    // eslint-disable-next-line no-await-in-loop
    const found = await mediaByPath(path)
    if (found !== null) return found
    if (Date.now() >= deadline) return null
    // eslint-disable-next-line no-await-in-loop
    await new Promise((done) => setTimeout(done, INDEX_POLL_MS))
  }
}

interface RowProps {
  item: MediaItem
  index: number
  /** A stage or act heading, only on the first row of that group. */
  heading: string | null
  label: string | null
  fourK: boolean
  /** Part of the drag in flight — the row itself or a ticked row travelling with it. */
  dragging: boolean
  /** Where the insertion line shows while a drag hovers: above this row, or below the last one. */
  dropLine: 'before' | 'after' | null
  checked: boolean
  disabled: boolean
  onToggle: () => void
  onDragStart: (event: React.DragEvent<HTMLElement>) => void
  onDragOver: (event: React.DragEvent<HTMLElement>) => void
  onDrop: (event: React.DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onDropAfterLast?: () => void
  onDragOverAfterLast?: () => void
}

/** One picture in the post. `memo`, because a drag re-renders the list on every hover. */
const Row = memo(function Row({
  item,
  index,
  heading,
  label,
  fourK,
  dragging,
  dropLine,
  checked,
  disabled,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onDropAfterLast,
  onDragOverAfterLast,
}: RowProps) {
  return (
    <>
      {heading ? (
        <li className="mt-2 px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500" aria-hidden>
          {heading}
        </li>
      ) : null}
      <li
        draggable={!disabled}
        onDragStart={onDragStart}
        onDragOver={(event) => {
          event.preventDefault()
          onDragOver(event)
        }}
        onDrop={(event) => {
          event.preventDefault()
          onDrop(event)
        }}
        onDragEnd={onDragEnd}
        data-testid={`patreon-row-${item.id}`}
        data-drop-line={dropLine ?? undefined}
        className={[
          'relative flex cursor-grab items-center gap-3 rounded px-1 py-1 text-sm',
          dragging ? 'opacity-40' : checked ? 'bg-indigo-500/10 hover:bg-indigo-500/15' : 'hover:bg-white/5',
          // The insertion line lives on the row's edge so the list never reflows under a drag.
          dropLine === 'before' ? 'shadow-[inset_0_2px_0_0_theme(colors.indigo.400)]' : '',
          dropLine === 'after' ? 'shadow-[inset_0_-2px_0_0_theme(colors.indigo.400)]' : '',
        ].join(' ')}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          // A click on the box must not start a drag.
          onPointerDown={(event) => event.stopPropagation()}
          aria-label={`Move ${item.name} together with the other ticked pictures`}
          className="h-3.5 w-3.5 shrink-0 accent-indigo-400"
        />
        <span className="w-6 shrink-0 text-right tabular-nums text-zinc-600">{index + 1}</span>
        {/* Sized before it loads, like a tile: a list that reflows as thumbnails
            arrive is a list you cannot drop into. */}
        <span className="block h-12 w-12 shrink-0 overflow-hidden rounded bg-white/5">
          {item.thumbPath ? (
            <img src={fileUrl(item.thumbPath)} alt="" className="h-full w-full object-cover" />
          ) : null}
        </span>
        <span data-testid="patreon-name" className="min-w-0 flex-1 truncate text-zinc-300">
          {item.name}
        </span>
        {label ? <span className="shrink-0 truncate text-xs text-zinc-500">{label}</span> : null}
        {fourK ? (
          <span className="shrink-0 rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold text-zinc-300" title={`${item.width}×${item.height}`}>
            4K
          </span>
        ) : (
          <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold text-amber-300 ring-1 ring-inset ring-amber-400/50" title="No 4K version yet">
            {item.width}×{item.height}
          </span>
        )}
        {item.patreon ? (
          <span
            className="shrink-0 rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold text-orange-300 ring-1 ring-inset ring-orange-400/60"
            title="Already sent to a Patreon draft"
          >
            p
          </span>
        ) : null}
      </li>
      {onDropAfterLast ? (
        <li
          onDragOver={(event) => {
            event.preventDefault()
            onDragOverAfterLast?.()
          }}
          onDrop={(event) => {
            event.preventDefault()
            onDropAfterLast()
          }}
          className="h-6"
          aria-hidden
        />
      ) : null}
    </>
  )
})

function Done({ summary, onClose }: { summary: PatreonSummary; onClose: () => void }) {
  const url = summary.url as string
  return (
    <div className="flex flex-1 flex-col items-start gap-3 px-4 py-4 text-sm">
      <p className="text-zinc-200">
        The draft is ready — {summary.uploaded.toLocaleString()} uploaded,{' '}
        {summary.reused.toLocaleString()} already there.
      </p>
      <p className="text-zinc-400">Open it, check it, and publish it yourself. This app does not.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={() => void openExternal(url)}>
          Open the draft
        </Button>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <a
        href={url}
        className="break-all text-xs text-indigo-300 underline decoration-dotted"
        onClick={(event) => {
          event.preventDefault()
          void openExternal(url)
        }}
      >
        {url}
      </a>
    </div>
  )
}
