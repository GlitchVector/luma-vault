import {
  CUSTOM_LORAS,
  fillShowcase,
  loraGroupsByStatus,
  loraRenderSearch,
  loraCards,
  outfitLoraNames,
  outfitRequestPrompt,
  pickShowcase,
  SHOWCASE_SIZE,
  type LoraDataset,
  type LoraEntry,
  type LoraGroup,
  type LoraStatus,
} from '@luma/core'
import { memo, useEffect, useState } from 'react'

import { Viewer } from '#/components/Viewer.tsx'
import { fileUrl, loraDataset, loraImagePreview, queryMedia } from '#/lib/native.ts'

interface LorasPanelProps {
  onClose: () => void
  /** On a phone the sidebar is a drawer; this opens it, since the filter bar that usually does is not on this page. */
  onOpenLibrary?: () => void
  /** Show this LoRA's renders in the grid and close the panel. */
  onShowRenders: (search: string) => void
}

/**
 * How many starred renders a card reads through to fill its three slots. The slots are picked by
 * prompt (`pickShowcase`), so the fetch has to be wide enough to hold a rear cowboy shot and a nude
 * from behind, not merely the three best-scored frames; a character with hundreds of stars still
 * costs one small query.
 */
const SHOWCASE_POOL = 200

const KIND_LABEL: Record<LoraEntry['kind'], string> = {
  full: 'full character',
  body: 'body only',
  face: 'face only',
  outfit: 'outfit',
}

/** One render to show: the thumbnail to load, the original for the viewer, and its shape so the tile is the picture's own. */
interface Shot {
  path: string
  full: string
  width: number | null
  height: number | null
}

/** What the viewer is showing: `src` now, and where a sharper copy comes from once it exists. */
interface Viewing {
  src: string
  caption: string
}
type OpenViewer = (viewing: Viewing) => void

/**
 * The renders for one LoRA, or undefined while they are still being fetched.
 *
 * Keyed by LoRA name rather than held per card so a re-render of the panel does not re-query:
 * two dozen cards fetching on every keystroke would hammer the index for nothing.
 */
type Showcase = Record<string, Shot[] | undefined>

/** A CSS `aspect-ratio` for a picture, or the portrait default when its size is not known. */
function ratio(width: number | null | undefined, height: number | null | undefined): string {
  return width && height ? `${width} / ${height}` : '2 / 3'
}

/**
 * The custom LoRA catalogue, as a page: one card per character, the LoRA to reach for on top with
 * three of her starred renders, and every other LoRA of hers - outfits, a body or face half, a
 * line still in training - listed under it with one render each.
 *
 * The split is the owner's (2026-09-21): **final** passed the acceptance test on both checkpoints and
 * he said so; **wip** is everything else, which doubles as the rebuild queue. It mirrors the folders
 * under `models/Lora/`, and because Forge resolves a LoRA by filename, neither the folders nor this
 * page can change what a prompt does.
 *
 * It renders in the main column, beside the sidebar, not over the whole window: the sidebar is the
 * navigation, and a page that covers it has no way out but its own button.
 */
export function LorasPanel({ onClose, onOpenLibrary, onShowRenders }: LorasPanelProps) {
  const cards = loraCards(CUSTOM_LORAS)
  const groups = loraGroupsByStatus(cards)
  // A character with more than one line shows the line on each of her cards, or two cards read alike.
  const linesOf = new Map<string, number>()
  for (const card of cards) linesOf.set(card.character, (linesOf.get(card.character) ?? 0) + 1)
  const [showcase, setShowcase] = useState<Showcase>({})
  // One viewer for the whole page: a render or a training image at full size, over the cards.
  const [viewing, setViewing] = useState<Viewing | null>(null)

  useEffect(() => {
    // Escape closes the viewer first, and the page only when nothing is open over it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (viewing) setViewing(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, viewing])

  useEffect(() => {
    let live = true
    // Every LoRA queries at once and its card fills in as the answer lands, so the page is laid out
    // immediately and never blocks on the slowest one. The index is local; two dozen small queries
    // against it cost less than the spinner would. The three shown are chosen by what their prompt
    // asked for - dressed cowboy front, dressed cowboy back, nude from behind - so the fetch takes a
    // pool and the pick happens here.
    const renders = (entry: LoraEntry, minStars: number | null) =>
      queryMedia({
        folderId: null,
        kind: 'image',
        rating: null,
        sexyOnly: false,
        search: loraRenderSearch(entry.name),
        searchPaths: false,
        tag: null,
        set: null,
        sets: [],
        minStars,
        maxStars: null,
        unstarred: false,
        hasPrompt: null,
        img2img: null,
        extras: null,
        label: null,
        animated: null,
        greyscale: null,
        minLongestEdge: null,
        duplicatesOnly: false,
        hideTags: [],
        modifiedAfter: null,
        modifiedBefore: null,
        limit: SHOWCASE_POOL,
        offset: 0,
        sort: 'score',
      })
    const load = async (entry: LoraEntry) => {
      const starred = await renders(entry, 1)
      let picked = pickShowcase(starred.items, (item) => item.generation?.prompt)
      if (picked.length < SHOWCASE_SIZE) {
        // Starred renders ran out before the card was full: the owner would rather see a random
        // unstarred render of her than a gap (2026-09-21).
        const any = await renders(entry, null)
        picked = fillShowcase(picked, any.items, (item) => item.id)
      }
      if (!live) return
      setShowcase((current) => ({
        ...current,
        [entry.name]: picked.map((item) => ({
          path: item.thumbPath ?? item.path,
          full: item.path,
          width: item.width,
          height: item.height,
        })),
      }))
    }
    void Promise.all(CUSTOM_LORAS.map(load))
    return () => {
      live = false
    }
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950 text-zinc-200">
      <header className="flex items-center gap-4 border-b border-white/10 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to the library"
          className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
        >
          <span aria-hidden="true">&larr;</span>
          Back
        </button>
        {onOpenLibrary ? (
          <button
            type="button"
            onClick={onOpenLibrary}
            aria-label="Open the library panel"
            className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 md:hidden"
          >
            Library
          </button>
        ) : null}
        <h2 className="text-lg font-semibold">LoRAs</h2>
        <p className="hidden min-w-0 flex-1 truncate text-sm text-zinc-500 md:block">
          The LoRAs trained here, one card per character. Final ones passed the acceptance test on both checkpoints; the rest are the rebuild queue.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
        >
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <Section
          status="final"
          title="Final"
          blurb="The trigger alone renders her, on delburry75 and on plantmilk, verified by a check sheet."
          groups={groups.final}
          showcase={showcase}
          onShowRenders={onShowRenders}
          onView={setViewing}
          showLine={(card) => (linesOf.get(card.character) ?? 0) > 1}
        />
        <Section
          status="wip"
          title="Work in progress"
          blurb="Trained and usable, but not through the acceptance test. Each one is waiting for a rebuild from a generated reference set."
          groups={groups.wip}
          showcase={showcase}
          onShowRenders={onShowRenders}
          onView={setViewing}
          showLine={(card) => (linesOf.get(card.character) ?? 0) > 1}
        />
      </div>

      {viewing ? <Viewer src={viewing.src} caption={viewing.caption} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}

interface SectionProps {
  status: LoraStatus
  title: string
  blurb: string
  groups: LoraGroup[]
  showcase: Showcase
  onShowRenders: (search: string) => void
  onView: OpenViewer
  showLine: (card: LoraGroup) => boolean
}

function Section({ status, title, blurb, groups, showcase, onShowRenders, onView, showLine }: SectionProps) {
  if (groups.length === 0) return null
  return (
    <section className="mb-9" data-testid={`loras-${status}`}>
      <div className="mb-3 flex items-baseline gap-3">
        <h3 className="text-base font-semibold">{title}</h3>
        <span
          className={
            status === 'final'
              ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300'
              : 'rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300'
          }
        >
          {groups.length}
        </span>
        <p className="min-w-0 flex-1 text-sm text-zinc-500">{blurb}</p>
      </div>
      <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {groups.map((group) => (
          <CharacterCard
            key={group.main.name}
            group={group}
            showcase={showcase}
            onShowRenders={onShowRenders}
            onView={onView}
            showLine={showLine(group)}
          />
        ))}
      </ul>
    </section>
  )
}

interface CharacterCardProps {
  group: LoraGroup
  showcase: Showcase
  onShowRenders: (search: string) => void
  onView: OpenViewer
  showLine: boolean
}

/** `memo` because the panel re-renders on every showcase arrival - a couple of dozen LoRAs, one answer at a time. */
const CharacterCard = memo(function CharacterCard({ group, showcase, onShowRenders, onView, showLine }: CharacterCardProps) {
  const { main, variants } = group
  const renders = showcase[main.name]
  const [adding, setAdding] = useState(false)
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-4" data-testid="lora-card">
      <div className="flex items-baseline gap-2">
        <h4 className="text-base font-semibold">{group.character}</h4>
        {showLine ? <code className="text-xs text-zinc-400">{group.line}</code> : null}
        <span className="text-xs text-zinc-500">{KIND_LABEL[main.kind]}</span>
        <button
          type="button"
          onClick={() => setAdding((previous) => !previous)}
          aria-expanded={adding}
          className="ml-auto rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
          title="Build a new outfit of this character as its own LoRA: a message for Claude Code, with your reference image attached"
        >
          + Add outfit
        </button>
      </div>

      {adding ? <AddOutfit main={main} onClose={() => setAdding(false)} /> : null}

      <p className="text-sm leading-relaxed text-zinc-400">{main.description}</p>

      <LoraTags entry={main} onShowRenders={onShowRenders} />

      {main.note ? <p className="text-xs leading-relaxed text-zinc-500">{main.note}</p> : null}

      <div className="grid grid-cols-3 items-start gap-2">
        {renders === undefined
          ? Array.from({ length: SHOWCASE_SIZE }, (_, index) => (
              <div key={index} className="aspect-[2/3] animate-pulse rounded bg-white/[0.04]" />
            ))
          : renders.length === 0
            ? (
                <p className="col-span-3 rounded bg-white/[0.02] px-2 py-3 text-center text-xs text-zinc-600">
                  No renders yet
                </p>
              )
            : renders.map((shot) => (
                <button
                  key={shot.path}
                  type="button"
                  onClick={() => onView({ src: fileUrl(shot.full), caption: `${group.character} · ${main.name}` })}
                  title="Open this render"
                  style={{ aspectRatio: ratio(shot.width, shot.height) }}
                  className="overflow-hidden rounded bg-black/30 hover:ring-2 hover:ring-white/30"
                >
                  <img src={fileUrl(shot.path)} alt="" loading="lazy" className="size-full object-cover" />
                </button>
              ))}
      </div>

      <TrainingImages dataset={main.dataset} onView={onView} />

      {variants.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-2 border-t border-white/5 pt-3" data-testid="lora-variants">
          {variants.map((entry) => (
            <VariantRow key={entry.name} entry={entry} renders={showcase[entry.name]} onShowRenders={onShowRenders} onView={onView} />
          ))}
        </ul>
      ) : null}
    </li>
  )
})

/** The two things a prompt needs, how many older files sit behind this one, and the way into the grid. */
function LoraTags({ entry, onShowRenders }: { entry: LoraEntry; onShowRenders: (search: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <code className="rounded bg-black/40 px-1.5 py-0.5 text-zinc-300">{`<lora:${entry.name}:${entry.weight ?? 1}>`}</code>
      <code className="rounded bg-black/40 px-1.5 py-0.5 text-zinc-300">{entry.trigger}</code>
      {entry.olderVersions.length > 0 ? (
        <span className="text-zinc-600" title={entry.olderVersions.join(', ')}>
          {entry.olderVersions.length} older
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => onShowRenders(loraRenderSearch(entry.name))}
        title="Show every render that used this LoRA"
        className="ml-auto text-zinc-500 underline decoration-dotted underline-offset-2 hover:text-zinc-200"
      >
        all renders
      </button>
    </div>
  )
}

/**
 * One of a character's other LoRAs under her card: an outfit, a body or face half, a line still in
 * training. One render, smaller than the card's three, and the rest folded behind a toggle.
 */
function VariantRow({
  entry,
  renders,
  onShowRenders,
  onView,
}: {
  entry: LoraEntry
  renders: Shot[] | undefined
  onShowRenders: (search: string) => void
  onView: OpenViewer
}) {
  const [open, setOpen] = useState(false)
  const shot = renders?.[0]
  const label = entry.outfit ?? KIND_LABEL[entry.kind]
  return (
    <li className="flex flex-col gap-2" data-testid="lora-variant">
      <div className="flex items-start gap-3">
        {renders === undefined ? (
          <div className="h-20 w-[3.35rem] shrink-0 animate-pulse rounded bg-white/[0.04]" />
        ) : shot ? (
          <button
            type="button"
            onClick={() => onView({ src: fileUrl(shot.full), caption: `${entry.character} · ${entry.name}` })}
            title="Open this render"
            style={{ aspectRatio: ratio(shot.width, shot.height) }}
            className="h-20 shrink-0 overflow-hidden rounded bg-black/30 hover:ring-2 hover:ring-white/30"
          >
            <img src={fileUrl(shot.path)} alt="" loading="lazy" className="size-full object-cover" />
          </button>
        ) : (
          <div className="grid h-20 w-[3.35rem] shrink-0 place-items-center rounded bg-white/[0.02] text-[10px] text-zinc-600">
            none
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button
            type="button"
            onClick={() => setOpen((previous) => !previous)}
            aria-expanded={open}
            className="flex items-baseline gap-2 text-left text-sm"
          >
            <span aria-hidden="true" className="text-xs text-zinc-600">
              {open ? '▾' : '▸'}
            </span>
            <span className="font-medium text-zinc-200">{label}</span>
            <span className="text-xs text-zinc-500">{entry.outfit ? KIND_LABEL[entry.kind] : ''}</span>
          </button>
          <LoraTags entry={entry} onShowRenders={onShowRenders} />
          {!open ? <p className="truncate text-xs text-zinc-500">{entry.description}</p> : null}
        </div>
      </div>
      {open ? (
        <div className="flex flex-col gap-2 pl-[3.35rem]">
          <p className="text-sm leading-relaxed text-zinc-400">{entry.description}</p>
          {entry.note ? <p className="text-xs leading-relaxed text-zinc-500">{entry.note}</p> : null}
          <TrainingImages dataset={entry.dataset} onView={onView} />
        </div>
      ) : null}
    </li>
  )
}

/**
 * "Add outfit": the owner names the outfit and, if he has it, the path of his reference image, and
 * gets the message to paste into a Claude Code session - which starts `/character-refs` for the
 * outfit's reference set and carries the whole recipe and the naming rule with it. The app builds
 * the words; the image is the one thing only he can add.
 */
function AddOutfit({ main, onClose }: { main: LoraEntry; onClose: () => void }) {
  const [label, setLabel] = useState('')
  const [image, setImage] = useState('')
  const [copied, setCopied] = useState(false)
  const ready = label.trim().length > 0
  const names = ready ? outfitLoraNames(main, label) : null
  const prompt = ready ? outfitRequestPrompt(main, label.trim(), image) : ''
  const copy = () => {
    // Optional-chained *and* guarded: `clipboard?.writeText()` yields undefined where the API is
    // missing, and a bare `void` on that hides nothing worth hiding.
    const written = navigator.clipboard?.writeText(prompt)
    if (written) void written.then(() => setCopied(true)).catch(() => setCopied(false))
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-indigo-400/30 bg-indigo-500/5 p-3" data-testid="add-outfit">
      <p className="text-xs text-zinc-400">
        A new outfit of {main.character} becomes its own LoRA, <code className="text-zinc-300">{`${main.name.replace(/_(v|s)\d+[a-z0-9]*$/, '')}_<outfit>`}</code>. Name it,
        then paste the message into Claude Code with your reference image attached.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          value={label}
          onChange={(event) => {
            setLabel(event.target.value)
            setCopied(false)
          }}
          placeholder="outfit, e.g. space suit"
          aria-label="Outfit name"
          className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-zinc-200 placeholder:text-zinc-600"
        />
        <input
          value={image}
          onChange={(event) => {
            setImage(event.target.value)
            setCopied(false)
          }}
          placeholder="reference image path (optional - or attach it)"
          aria-label="Reference image path"
          className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-zinc-200 placeholder:text-zinc-600"
        />
      </div>
      {names ? (
        <p className="text-xs text-zinc-500">
          LoRA <code className="text-zinc-300">{names.base}</code> · trigger <code className="text-zinc-300">{names.trigger}</code> · refs{' '}
          <code className="text-zinc-300">{names.refs}</code>
        </p>
      ) : null}
      {ready ? (
        <textarea
          readOnly
          value={prompt}
          aria-label="Message for Claude Code"
          rows={8}
          className="w-full resize-y rounded border border-white/10 bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-zinc-300"
        />
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={copy}
          disabled={!ready}
          className="rounded-md bg-indigo-500/80 px-3 py-1 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {copied ? 'Copied' : 'Copy message'}
        </button>
        <button type="button" onClick={onClose} className="rounded-md bg-white/10 px-3 py-1 text-xs hover:bg-white/20">
          Close
        </button>
      </div>
    </div>
  )
}

/**
 * What the LoRA was trained on, folded under the card until asked for: every
 * subset of the kohya config with its repeat count, and every image with its
 * caption as the tooltip. Read on first open and kept for the card's life -
 * a dataset has a few hundred files and thumbnailing them is the slow part.
 *
 * Mirrors (`-flip`) are counted, not shown: they say nothing the original does
 * not, and they would double every row.
 */
function TrainingImages({ dataset, onView }: { dataset: string | null; onView: OpenViewer }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<LoraDataset | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Open on the thumbnail at once, then swap in the viewer-sized copy when the
  // machine has made it: the first look is instant and the second is sharp.
  const view = (thumb: string, path: string, caption: string) => {
    onView({ src: fileUrl(thumb), caption })
    if (dataset === null) return
    void loraImagePreview(dataset, path)
      .then((preview) => onView({ src: fileUrl(preview), caption }))
      .catch(() => undefined)
  }

  useEffect(() => {
    if (!open || data !== null || error !== null || dataset === null) return
    let live = true
    loraDataset(dataset)
      .then((found) => {
        if (live) setData(found)
      })
      .catch((failure: unknown) => {
        if (live) setError(String(failure))
      })
    return () => {
      live = false
    }
  }, [open, data, error, dataset])

  if (dataset === null) {
    return <p className="border-t border-white/5 pt-2 text-xs text-zinc-600">Training data is not on this machine.</p>
  }
  return (
    <div className="border-t border-white/5 pt-2">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-xs text-zinc-400 hover:text-zinc-200"
      >
        <span aria-hidden="true" className="text-zinc-600">
          {open ? '▾' : '▸'}
        </span>
        Training images
        <code className="ml-auto text-[11px] text-zinc-600">{dataset}</code>
      </button>

      {!open ? null : error !== null ? (
        <p className="mt-2 text-xs text-red-300">{error}</p>
      ) : data === null ? (
        <p className="mt-2 text-xs text-zinc-500">reading the dataset…</p>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          <p className="text-xs text-zinc-500">
            {data.images.toLocaleString()} files · {data.perEpoch.toLocaleString()} per epoch ·{' '}
            <code className="text-zinc-400">{data.config}</code>
          </p>
          {data.subsets.map((subset) => {
            const shown = subset.images.filter((image) => !image.flipped)
            const mirrored = subset.images.length - shown.length
            return (
              <section key={subset.dir} data-testid="lora-subset">
                <h5 className="mb-1 flex items-baseline gap-2 text-xs">
                  <code className="text-zinc-300">{subset.dir}</code>
                  <span className="text-zinc-500">×{subset.repeats}</span>
                  <span className="ml-auto text-zinc-600">
                    {shown.length} {shown.length === 1 ? 'image' : 'images'}
                    {mirrored > 0 ? ` + ${mirrored} mirrored` : ''}
                  </span>
                </h5>
                {/* Rows of one height, each tile as wide as its picture: a 2:3 reference, a 1:1
                    portrait and a wide detail crop all show whole, nothing cropped to a square. */}
                <div className="flex flex-wrap gap-1">
                  {shown.map((image) =>
                    image.thumbPath ? (
                      <button
                        key={image.path}
                        type="button"
                        onClick={() => view(image.thumbPath!, image.path, image.caption ?? image.path)}
                        title={image.caption ?? image.path}
                        style={{ aspectRatio: ratio(image.width, image.height) }}
                        className="h-24 overflow-hidden rounded bg-black/30 hover:ring-2 hover:ring-white/30"
                      >
                        <img src={fileUrl(image.thumbPath)} alt="" loading="lazy" className="size-full object-cover" />
                      </button>
                    ) : (
                      <div
                        key={image.path}
                        title={image.path}
                        className="grid size-24 place-items-center rounded bg-white/5 text-[10px] text-zinc-600"
                      >
                        no thumb
                      </div>
                    ),
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
