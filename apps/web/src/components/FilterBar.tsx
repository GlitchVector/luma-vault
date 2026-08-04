import { FOUR_K_EDGE, type MediaQuery, type Rating, type SortOrder } from '@luma/core'
import { Pill } from '@luma/ui'

interface FilterBarProps {
  query: MediaQuery
  onFindDuplicates: () => void
  total: number
  shown: number
  showBoxes: boolean
  onToggleBoxes: () => void
  selecting: boolean
  onToggleSelecting: () => void
  onChange: (patch: Partial<MediaQuery>) => void
}

const RATINGS: Array<{ value: Rating; label: string }> = [
  { value: 'sfw', label: 'SFW' },
  { value: 'suggestive', label: 'Suggestive' },
  { value: 'explicit', label: 'Explicit' },
  { value: 'unrated', label: 'Unrated' },
]

/**
 * Structural tags, which answer "what kind of picture is this" rather than
 * "how sexy is it". Each cycles through three states, because both directions
 * are useful: off → only these → hide these.
 */
const TAGS: Array<{ value: string; label: string; title: string }> = [
  {
    value: 'document',
    label: 'Docs',
    title: 'Scans, forms and screenshots of text — detected from the thumbnail',
  },
  {
    value: 'generated',
    label: 'AI',
    title: 'Images whose metadata names the generator that made them',
  },
]

const SORTS: Array<{ value: SortOrder; label: string }> = [
  { value: 'recent', label: 'Newest' },
  // What the recently-added strip used to show, as an ordering rather than a
  // second widget: added-to-the-vault, not written-to-disk.
  { value: 'added', label: 'Recently added' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'name', label: 'Name' },
  { value: 'largest', label: 'Largest' },
  { value: 'random', label: 'Shuffle' },
]

export function FilterBar({
  query,
  onFindDuplicates,
  total,
  shown,
  showBoxes,
  onToggleBoxes,
  selecting,
  onToggleSelecting,
  onChange,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-white/5 bg-zinc-950/40 px-4 py-2">
      {/* No search box here. It lives above the grid, where it is large enough
          to read a prompt fragment back and close enough to the results to be
          obviously about them. Two fields bound to one value is two places to
          look for the text you typed. */}

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

      {TAGS.map((tag) => {
        const only = query.tag === tag.value
        const hidden = query.hideTags.includes(tag.value)
        return (
          <Pill
            key={tag.value}
            active={only || hidden}
            title={
              only
                ? `Showing only: ${tag.title}`
                : hidden
                  ? `Hidden: ${tag.title}`
                  : tag.title
            }
            onClick={() =>
              onChange(
                // off → only → hidden → off. One control, because a separate
                // "show" and "hide" pill per tag would be four more controls
                // for a bar that already has eleven.
                only
                  ? { tag: null, hideTags: [...query.hideTags, tag.value] }
                  : hidden
                    ? { hideTags: query.hideTags.filter((t) => t !== tag.value) }
                    : { tag: tag.value, hideTags: query.hideTags.filter((t) => t !== tag.value) },
              )
            }
          >
            {hidden ? `No ${tag.label}` : tag.label}
          </Pill>
        )
      })}

      {/* Stars are a person's judgement, so the filter is "at least", not
          "exactly" — nobody looks for their 3-star pictures specifically.

          Two settings of one value rather than two filters, so they cannot both
          be on and mean nothing. Each toggles itself off, and picking one
          replaces the other. */}
      <Pill
        active={query.minStars === 4}
        title="Only pictures you rated 4 stars or better, including ratings imported from an Image Browser database"
        onClick={() => onChange({ minStars: query.minStars === 4 ? null : 4 })}
      >
        ★ 4+
      </Pill>

      {/* Five is the top of the scale, so "at least five" is exactly five —
          which is what a favourite is. No separate column and no second
          concept: the heart is a view of the rating already there, so a picture
          becomes a favourite by being rated 5 in the lightbox. */}
      <Pill
        active={query.minStars === 5}
        ariaLabel="Favourites only"
        title="Favourites — only the pictures you rated 5 stars. Rate one with 5 in the lightbox."
        onClick={() => onChange({ minStars: query.minStars === 5 ? null : 5 })}
      >
        ♥
      </Pill>

      {/* The same threshold the grid's badge uses, sent to the index rather
          than named — so the filter cannot come to mean something the badge
          does not, which is the usual way these two drift apart. */}
      <Pill
        active={query.minLongestEdge === FOUR_K_EDGE}
        title={`Only pictures whose longest edge is at least ${FOUR_K_EDGE}px — the ones carrying a 4K badge`}
        onClick={() =>
          onChange({
            minLongestEdge: query.minLongestEdge === FOUR_K_EDGE ? null : FOUR_K_EDGE,
          })
        }
      >
        4K
      </Pill>

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

      {/* A mode, not a modifier. What follows a selection is destructive or
          expensive, so clicking a picture has to keep meaning "open it" the
          rest of the time. */}
      <Pill
        active={selecting}
        onClick={onToggleSelecting}
        title="Pick several pictures. Click to add one, shift-click to take everything between."
      >
        {selecting ? 'Selecting' : 'Select'}
      </Pill>

      {/* Toggling off is a filter change; toggling on runs the search first,
          because the grouping has to exist before it can be shown. */}
      <Pill
        active={query.duplicatesOnly}
        title="Find images that are the same picture — even re-encoded, re-saved or at another resolution. Videos are matched exactly."
        onClick={() => {
          if (query.duplicatesOnly) onChange({ duplicatesOnly: false })
          else onFindDuplicates()
        }}
      >
        Duplicates
      </Pill>

      <span className="ml-auto text-[11px] tabular-nums text-zinc-500">
        {shown.toLocaleString()} / {total.toLocaleString()}
      </span>
    </div>
  )
}
