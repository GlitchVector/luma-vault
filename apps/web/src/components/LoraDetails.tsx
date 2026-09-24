import {
  fillShowcase,
  loraRenderSearch,
  outfitLoraNames,
  outfitRequestPrompt,
  pickShowcase,
  SHOWCASE_SIZE,
  type LoraDataset,
  type LoraEntry,
} from '@luma/core'
import { useEffect, useState } from 'react'

import { fileUrl, loraDataset, loraImagePreview, queryMedia } from '#/lib/native.ts'

/**
 * What a LoRA shows wherever it is shown - the LoRAs page's cards and the Characters page's side panel:
 * its prompt tags, a few of its own renders, what it was trained on, and the way to add an outfit. One
 * module so the two pages cannot drift apart on what a LoRA is.
 */

export const KIND_LABEL: Record<LoraEntry['kind'], string> = {
  full: 'full character',
  body: 'body only',
  face: 'face only',
  outfit: 'outfit',
}

/** One render to show: the thumbnail to load, the original for the viewer, and its shape so the tile is the picture's own. */
export interface Shot {
  path: string
  full: string
  width: number | null
  height: number | null
}

/** What the viewer is showing: `src` now, and where a sharper copy comes from once it exists. */
export interface Viewing {
  src: string
  caption: string
}
export type OpenViewer = (viewing: Viewing) => void

/**
 * The renders for one LoRA, or undefined while they are still being fetched.
 *
 * Keyed by LoRA name rather than held per card so a re-render of the panel does not re-query:
 * two dozen cards fetching on every keystroke would hammer the index for nothing.
 */
export type Showcase = Record<string, Shot[] | undefined>

/** A CSS `aspect-ratio` for a picture, or the portrait default when its size is not known. */
export function ratio(width: number | null | undefined, height: number | null | undefined): string {
  return width && height ? `${width} / ${height}` : '2 / 3'
}

/**
 * How many starred renders a card reads through to fill its three slots. The slots are picked by
 * prompt (`pickShowcase`), so the fetch has to be wide enough to hold a rear cowboy shot and a nude
 * from behind, not merely the three best-scored frames; a character with hundreds of stars still
 * costs one small query.
 */
const SHOWCASE_POOL = 200

/**
 * The renders for each of these LoRAs, keyed by name, filled in as each answer lands. Every LoRA queries
 * at once so the page lays out immediately and never waits on the slowest one.
 */
export function useShowcase(entries: readonly LoraEntry[]): Showcase {
  const [showcase, setShowcase] = useState<Showcase>({})
  const key = entries.map((entry) => entry.name).join(',')
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
    void Promise.all(entries.map(load))
    return () => {
      live = false
    }
    // Keyed by the names, not the array: a parent re-rendering with an equal list must not re-query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return showcase
}

/**
 * The two things a prompt needs, how many older files sit behind this one, and the way into the grid.
 *
 * The way in exists only once there is something to find. A LoRA that has not rendered yet — an
 * outfit whose dataset is prepped and whose stage 1 has not trained — sent the owner to an empty
 * grid with "Nothing matches" (2026-09-23); the card knows the answer from its own showcase query,
 * so it says so instead. Until that query lands the link is shown as usual.
 */
export function LoraTags({ entry, renders, onShowRenders }: { entry: LoraEntry; renders?: Shot[]; onShowRenders: (search: string) => void }) {
  const none = renders !== undefined && renders.length === 0
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <code className="rounded bg-black/40 px-1.5 py-0.5 text-zinc-300">{`<lora:${entry.name}:${entry.weight ?? 1}>`}</code>
      <code className="rounded bg-black/40 px-1.5 py-0.5 text-zinc-300">{entry.trigger}</code>
      {entry.olderVersions.length > 0 ? (
        <span className="text-zinc-600" title={entry.olderVersions.join(', ')}>
          {entry.olderVersions.length} older
        </span>
      ) : null}
      {none ? (
        <span className="ml-auto text-zinc-600" title="Nothing in the library has used this LoRA yet">
          no renders yet
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onShowRenders(loraRenderSearch(entry.name))}
          title="Show every render that used this LoRA"
          className="ml-auto text-zinc-500 underline decoration-dotted underline-offset-2 hover:text-zinc-200"
        >
          all renders
        </button>
      )}
    </div>
  )
}

/**
 * "Add outfit": the owner names the outfit and, if he has it, the path of his reference image, and
 * gets the message to paste into a Claude Code session - which starts `/character-refs` for the
 * outfit's reference set and carries the whole recipe and the naming rule with it. The app builds
 * the words; the image is the one thing only he can add.
 */
export function AddOutfit({ main, onClose }: { main: LoraEntry; onClose: () => void }) {
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
export function TrainingImages({ dataset, onView }: { dataset: string | null; onView: OpenViewer }) {
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
