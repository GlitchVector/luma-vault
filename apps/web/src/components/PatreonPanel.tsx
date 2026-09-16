import { Button, Spinner } from '@luma/ui'
import { actLabelOf, type MediaItem, type PatreonSummary, type SetMemberRow } from '@luma/core'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  fileUrl,
  onPatreonProgress,
  openExternal,
  patreonPost,
  reorderSet,
  reorderSets,
  type PatreonProgress,
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
 * Compose a Patreon draft from a selection, and reorder it by hand.
 *
 * The order shown is the order posted, and it starts as the collation the grid
 * worked out — every set's stage 1 before any set's stage 2. Dragging a row is
 * the final word: with one set showing the new order is written straight back
 * to that set's manifest, and with several each set gets its own members' new
 * relative order while the interleaving stays with the post. That split is not
 * a compromise; a manifest cannot express where another set's frame sits.
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
  const [tierText, setTierText] = useState('')
  const [adult, setAdult] = useState<boolean | null>(null)
  const [progress, setProgress] = useState<PatreonProgress | null>(null)
  const [summary, setSummary] = useState<PatreonSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [writingOrder, setWritingOrder] = useState(false)

  /** Label by media id, so a row can carry its stage or act heading. */
  const labelOf = useMemo(() => {
    const byId = new Map<number, string | null>()
    for (const row of members) if (!byId.has(row.mediaId)) byId.set(row.mediaId, row.label)
    return byId
  }, [members])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && progress === null) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, progress])

  const tiers = tierText
    .split(/[,\s]+/)
    .map((each) => each.trim())
    .filter((each) => each.length > 0)

  /**
   * Drop a dragged row before `target`, then write the order back.
   *
   * Written after the local move rather than before, so the list does not
   * snap back while the manifest is being rewritten. If the write fails the
   * rows stay where they were dropped and the error says the manifest did not
   * follow — which is the truthful state.
   */
  const dropAt = useCallback(
    (target: number) => {
      if (dragging === null || dragging === target) {
        setDragging(null)
        return
      }
      const next = [...rows]
      const [moved] = next.splice(dragging, 1)
      if (moved === undefined) return
      next.splice(target > dragging ? target - 1 : target, 0, moved)
      setRows(next)
      setDragging(null)

      if (sets.length === 0) return
      setWritingOrder(true)
      const paths = next.map((item) => item.path)
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
    [dragging, rows, sets, onReordered],
  )

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

  const canSend = progress === null && summary === null && title.trim().length > 0 && adult !== null

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
          disabled={progress !== null}
          title={progress ? 'Wait for the post to finish' : 'Close (Esc)'}
        >
          Close
        </Button>
      </header>

      {error ? (
        <p className="shrink-0 whitespace-pre-line border-b border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-red-200">
          {error}
        </p>
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
            <label className="flex min-w-48 items-center gap-2">
              <span className="shrink-0 text-zinc-500">Tiers</span>
              <input
                value={tierText}
                onChange={(event) => setTierText(event.target.value)}
                placeholder="empty = public"
                title="Access-rule ids, comma separated. `pnpm patreon tiers` lists them. Empty makes the post public."
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-xs text-zinc-200 outline-none focus:border-indigo-400/60"
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
                adult === null
                  ? 'Say whether this is adult content first'
                  : title.trim().length === 0
                    ? 'Give the post a title first'
                    : 'Upload everything and stop at a draft. Nothing is published.'
              }
            >
              Create draft
            </Button>
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

          <p className="shrink-0 px-4 py-1.5 text-xs text-zinc-500">
            Drag to reorder. The first picture is the preview non-patrons see.
            {sets.length > 0
              ? sets.length === 1
                ? ' A drag is written back to the set.'
                : ' A drag is written back to each set; how the sets interleave stays with this post.'
              : ''}
          </p>

          <ol className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
            {rows.map((item, index) => {
              const heading = actLabelOf(labelOf.get(item.id))
              const previousHeading = index > 0 ? actLabelOf(labelOf.get(rows[index - 1]?.id ?? -1)) : null
              return (
                <Row
                  key={item.id}
                  item={item}
                  index={index}
                  heading={heading !== null && heading !== previousHeading ? heading : null}
                  label={labelOf.get(item.id) ?? null}
                  dragging={dragging === index}
                  disabled={progress !== null}
                  onDragStart={() => setDragging(index)}
                  onDrop={() => dropAt(index)}
                  onDropAfterLast={index === rows.length - 1 ? () => dropAt(rows.length) : undefined}
                />
              )
            })}
          </ol>
        </>
      )}
    </div>
  )
}

interface RowProps {
  item: MediaItem
  index: number
  /** A stage or act heading, only on the first row of that group. */
  heading: string | null
  label: string | null
  dragging: boolean
  disabled: boolean
  onDragStart: () => void
  onDrop: () => void
  onDropAfterLast?: () => void
}

/** One picture in the post. `memo`, because a drag re-renders the list on every hover. */
const Row = memo(function Row({
  item,
  index,
  heading,
  label,
  dragging,
  disabled,
  onDragStart,
  onDrop,
  onDropAfterLast,
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
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          onDrop()
        }}
        data-testid={`patreon-row-${item.id}`}
        className={[
          'flex cursor-grab items-center gap-3 rounded px-1 py-1 text-sm',
          dragging ? 'opacity-40' : 'hover:bg-white/5',
        ].join(' ')}
      >
        <span className="w-6 shrink-0 text-right tabular-nums text-zinc-600">{index + 1}</span>
        {/* Sized before it loads, like a tile: a list that reflows as thumbnails
            arrive is a list you cannot drop into. */}
        <span className="block h-12 w-12 shrink-0 overflow-hidden rounded bg-white/5">
          {item.thumbPath ? (
            <img src={fileUrl(item.thumbPath)} alt="" className="h-full w-full object-cover" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1 truncate text-zinc-300">{item.name}</span>
        {label ? <span className="shrink-0 truncate text-xs text-zinc-500">{label}</span> : null}
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
          onDragOver={(event) => event.preventDefault()}
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
      <a href={url} className="break-all text-xs text-indigo-300 underline decoration-dotted" onClick={(e) => { e.preventDefault(); void openExternal(url) }}>
        {url}
      </a>
    </div>
  )
}
