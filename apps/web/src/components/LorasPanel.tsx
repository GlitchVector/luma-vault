import {
  CUSTOM_LORAS,
  loraGroupsByStatus,
  loraCards,
  SHOWCASE_SIZE,
  type LoraEntry,
  type LoraGroup,
  type LoraStatus,
} from '@luma/core'
import { memo, useEffect, useState } from 'react'

import {
  AddOutfit,
  KIND_LABEL,
  LoraTags,
  ratio,
  TrainingImages,
  useShowcase,
  type OpenViewer,
  type Shot,
  type Showcase,
  type Viewing,
} from '#/components/LoraDetails.tsx'
import { Viewer } from '#/components/Viewer.tsx'
import { fileUrl } from '#/lib/native.ts'

interface LorasPanelProps {
  onClose: () => void
  /** On a phone the sidebar is a drawer; this opens it, since the filter bar that usually does is not on this page. */
  onOpenLibrary?: () => void
  /** Show this LoRA's renders in the grid and close the panel. */
  onShowRenders: (search: string) => void
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

  const showcase = useShowcase(CUSTOM_LORAS)

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

      <LoraTags entry={main} renders={renders} onShowRenders={onShowRenders} />

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
          <LoraTags entry={entry} renders={renders} onShowRenders={onShowRenders} />
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

