import type { MediaQuery, Rating, SortOrder } from '@luma/core'
import { Pill } from '@luma/ui'

interface FilterBarProps {
  query: MediaQuery
  total: number
  shown: number
  showBoxes: boolean
  onToggleBoxes: () => void
  onChange: (patch: Partial<MediaQuery>) => void
}

const RATINGS: Array<{ value: Rating; label: string }> = [
  { value: 'sfw', label: 'SFW' },
  { value: 'suggestive', label: 'Suggestive' },
  { value: 'explicit', label: 'Explicit' },
  { value: 'unrated', label: 'Unrated' },
]

const SORTS: Array<{ value: SortOrder; label: string }> = [
  { value: 'recent', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'name', label: 'Name' },
  { value: 'largest', label: 'Largest' },
  { value: 'random', label: 'Shuffle' },
]

export function FilterBar({
  query,
  total,
  shown,
  showBoxes,
  onToggleBoxes,
  onChange,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-white/5 bg-zinc-950/40 px-4 py-2">
      <input
        type="search"
        value={query.search}
        onChange={(event) => onChange({ search: event.target.value })}
        placeholder="Search filenames"
        className="h-7 w-48 rounded-full bg-white/5 px-3 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-2 focus:outline-offset-2 focus:outline-indigo-400"
      />

      <span className="mx-1 h-4 w-px bg-white/10" />

      <Pill active={query.kind === null} onClick={() => onChange({ kind: null })}>
        All
      </Pill>
      <Pill active={query.kind === 'image'} onClick={() => onChange({ kind: 'image' })}>
        Images
      </Pill>
      <Pill active={query.kind === 'video'} onClick={() => onChange({ kind: 'video' })}>
        Videos
      </Pill>

      <span className="mx-1 h-4 w-px bg-white/10" />

      <Pill
        active={query.sexyOnly}
        onClick={() => onChange({ sexyOnly: !query.sexyOnly, rating: null })}
        title="Anything the classifier flagged as suggestive or explicit"
      >
        Sexy only
      </Pill>

      {RATINGS.map((rating) => (
        <Pill
          key={rating.value}
          active={query.rating === rating.value}
          onClick={() =>
            onChange({
              rating: query.rating === rating.value ? null : rating.value,
              sexyOnly: false,
            })
          }
        >
          {rating.label}
        </Pill>
      ))}

      <span className="mx-1 h-4 w-px bg-white/10" />

      <select
        value={query.sort}
        onChange={(event) => onChange({ sort: event.target.value as SortOrder })}
        className="h-7 rounded-full bg-white/5 px-2.5 text-xs text-zinc-300 focus:outline-2 focus:outline-offset-2 focus:outline-indigo-400"
      >
        {SORTS.map((sort) => (
          <option key={sort.value} value={sort.value} className="bg-zinc-900">
            {sort.label}
          </option>
        ))}
      </select>

      <Pill active={showBoxes} onClick={onToggleBoxes} title="Show what the classifier found">
        Labels
      </Pill>

      <span className="ml-auto text-[11px] tabular-nums text-zinc-500">
        {shown.toLocaleString()} / {total.toLocaleString()}
      </span>
    </div>
  )
}
