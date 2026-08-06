import {
  ANIME_LABELS,
  FOUR_K_EDGE,
  NUDENET_LABELS,
  titleOf,
  type MediaQuery,
  type Rating,
  type SortOrder,
} from '@luma/core'
import { Pill } from '@luma/ui'
import { useState } from 'react'

interface FilterBarProps {
  query: MediaQuery
  onFindDuplicates: () => void
  total: number
  shown: number
  showBoxes: boolean
  onToggleBoxes: () => void
  selecting: boolean
  onToggleSelecting: () => void
  /** Whether the timeline strip is open under this bar. */
  timeline: boolean
  onToggleTimeline: () => void
  onChange: (patch: Partial<MediaQuery>) => void
}

/**
 * The second resolution rung, beside 4K.
 *
 * "Big enough to be worth looking at" is a different question from "is this
 * 4K", and both send {@link MediaQuery.minLongestEdge} — so the bar can never
 * select something the grid's 4K badge would contradict.
 */
const BIG_EDGE = 1000

/** Everything either model can put a name to, for the "found" picker. */
const DETECTABLE = [...NUDENET_LABELS, ...ANIME_LABELS]

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
 *
 * One of them gains a fourth. See `triage`.
 */
const TAGS: Array<{ value: string; label: string; title: string; triage?: boolean }> = [
  {
    value: 'document',
    label: 'Docs',
    title: 'Scans, forms and screenshots of text — detected from the thumbnail',
  },
  {
    value: 'generated',
    label: 'AI',
    title: 'Images whose metadata names the generator that made them',
    // Adds an "unrated" step between *only these* and *hide these*: generated
    // images nobody has starred yet, which is the pile actually waiting to be
    // gone through. Only here — "documents I have not starred" is not a
    // question anyone has, and a fourth click on every pill to reach the third
    // state would be a worse bar for everyone.
    triage: true,
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
  timeline,
  onToggleTimeline,
  onChange,
}: FilterBarProps) {
  const [more, setMore] = useState(false)
  // Shown on the button so a filter left on inside a collapsed panel cannot
  // quietly explain an empty grid.
  const activeExtras =
    (query.label ? 1 : 0) +
    (query.animated !== null ? 1 : 0) +
    (query.greyscale !== null ? 1 : 0) +
    (query.minLongestEdge !== null ? 1 : 0)

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
        const triaging = only && tag.triage === true && query.unstarred
        const without = query.hideTags.filter((t) => t !== tag.value)

        // off → only → [unrated] → hidden → off. One control, because a
        // separate "show" and "hide" pill per tag would be four more controls
        // for a bar that already has eleven.
        //
        // `unstarred` is cleared on every step that is not the triage one. It
        // is a property of the whole query rather than of this pill, so leaving
        // it set while moving to another tag — or switching this one off —
        // would silently narrow a filter nothing on screen claims to be
        // applying.
        const next = () => {
          if (only && tag.triage === true && !query.unstarred) {
            // `minStars` goes with it: nothing is both unstarred and 4+, and
            // the two star pills already replace each other for the same
            // reason. A filter combination that can only ever be empty is not
            // worth being able to express.
            return { unstarred: true, minStars: null }
          }
          if (only) return { tag: null, unstarred: false, hideTags: [...without, tag.value] }
          if (hidden) return { hideTags: without, unstarred: false }
          return { tag: tag.value, unstarred: false, hideTags: without }
        }

        return (
          <Pill
            key={tag.value}
            active={only || hidden}
            title={
              triaging
                ? `Showing only what you have not starred yet: ${tag.title}`
                : only
                  ? `Showing only: ${tag.title}`
                  : hidden
                    ? `Hidden: ${tag.title}`
                    : tag.title
            }
            onClick={() => onChange(next())}
          >
            {hidden ? `No ${tag.label}` : triaging ? `${tag.label} Unrated` : tag.label}
          </Pill>
        )
      })}

      {/* Whether a stable diffusion prompt was recovered — not the AI pill's
          axis: a re-saved JPEG can keep its generator marker in EXIF while the
          parameter block did not survive, so "generated" and "has a prompt"
          differ on real files. Same off → only → inverse cycle as the tags. */}
      <Pill
        active={query.hasPrompt !== null}
        title={
          query.hasPrompt === true
            ? 'Showing only images with a recovered stable diffusion prompt'
            : query.hasPrompt === false
              ? 'Showing only files without a prompt — where the metadata did not survive'
              : 'Images whose stable diffusion prompt was recovered from the file'
        }
        onClick={() =>
          onChange({
            hasPrompt: query.hasPrompt === null ? true : query.hasPrompt === true ? false : null,
          })
        }
      >
        {query.hasPrompt === false ? 'No Prompt' : 'Prompt'}
      </Pill>

      {/* Made from another image. The same claim the i2i badge and the
          lightbox pill show, filterable — off → only → exclude. */}
      <Pill
        active={query.img2img !== null}
        title={
          query.img2img === true
            ? 'Showing only images made from another image (img2img)'
            : query.img2img === false
              ? 'Hiding images made from another image'
              : 'Images whose parameters say they were made from another image (img2img)'
        }
        onClick={() =>
          onChange({
            img2img: query.img2img === null ? true : query.img2img === true ? false : null,
          })
        }
      >
        {query.img2img === false ? 'No img2img' : 'img2img'}
      </Pill>

      {/* Out of the Extras tab: an upscale of an existing image, not a
          generation. Same claim the "e" badge shows. */}
      <Pill
        active={query.extras !== null}
        title={
          query.extras === true
            ? 'Showing only Extras-tab upscales'
            : query.extras === false
              ? 'Hiding Extras-tab upscales'
              : 'Images whose parameters say they came out of the Extras tab'
        }
        onClick={() =>
          onChange({
            extras: query.extras === null ? true : query.extras === true ? false : null,
          })
        }
      >
        {query.extras === false ? 'No Extras' : 'Extras'}
      </Pill>

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

      <Pill
        active={timeline || query.modifiedAfter !== null || query.modifiedBefore !== null}
        title="When the library is: bars per week, and a draggable selection that narrows the grid to a date range"
        onClick={onToggleTimeline}
      >
        Timeline
      </Pill>

      <Pill
        active={more}
        onClick={() => setMore((previous) => !previous)}
        title="Resolution, colour, animation, and everything the classifier can label"
      >
        More{activeExtras > 0 ? ` · ${activeExtras}` : ''}
      </Pill>

      <span className="ml-auto text-[11px] tabular-nums text-zinc-500">
        {shown.toLocaleString()} / {total.toLocaleString()}
      </span>

      {more ? (
        <div className="flex w-full flex-wrap items-center gap-1.5 border-t border-white/5 pt-2">
          {/* Two rungs of the same filter rather than two filters. 1000px is
              "big enough to be worth looking at", which is a different question
              from "is this 4K", and both send the same field — so the grid's 4K
              badge can never disagree with what the bar selected. */}
          <span className="text-[11px] text-zinc-500">Size</span>
          <Pill
            active={query.minLongestEdge === BIG_EDGE}
            title={`Only pictures whose longest edge is at least ${BIG_EDGE}px`}
            onClick={() =>
              onChange({ minLongestEdge: query.minLongestEdge === BIG_EDGE ? null : BIG_EDGE })
            }
          >
            ≥{BIG_EDGE}px
          </Pill>

          <span className="mx-1 h-4 w-px bg-white/10" />

          <span className="text-[11px] text-zinc-500">Kind</span>
          {/* Animation is not a `kind`: a GIF and a PNG are both images, and
              the container is all the name reveals. Kept separate from the
              video pills above so "stills only" can be both at once. */}
          <Pill
            active={query.animated === true}
            title="Only animated images — GIF, WebP and AVIF"
            onClick={() => onChange({ animated: query.animated === true ? null : true })}
          >
            GIFs
          </Pill>
          <Pill
            active={query.animated === false && query.kind === 'image'}
            title="Only still pictures: no videos, and no GIFs or other animated images"
            onClick={() =>
              onChange(
                query.animated === false && query.kind === 'image'
                  ? { animated: null, kind: null }
                  : { animated: false, kind: 'image' },
              )
            }
          >
            Stills only
          </Pill>

          <span className="mx-1 h-4 w-px bg-white/10" />

          <span className="text-[11px] text-zinc-500">Colour</span>
          {/* Read from the colour signature the duplicate finder already
              stores, so this costs no decoding. Sepia and other tints score
              high and are deliberately excluded — they are not black and
              white in the sense anybody means it. */}
          <Pill
            active={query.greyscale === true}
            title="Black and white only — measured from the picture, not from its name"
            onClick={() => onChange({ greyscale: query.greyscale === true ? null : true })}
          >
            B&amp;W
          </Pill>
          <Pill
            active={query.greyscale === false}
            title="Only pictures that carry colour"
            onClick={() => onChange({ greyscale: query.greyscale === false ? null : false })}
          >
            Colour
          </Pill>

          <span className="mx-1 h-4 w-px bg-white/10" />

          {/* Every label the detector found, not the one the verdict names.
              `topLabel` is picked by rating weight, so the labels carrying
              none — a face, feet — could never be selected here at all, and
              they are on more pictures than most of the ones that can. */}
          <label className="text-[11px] text-zinc-500" htmlFor="label-filter">
            Found
          </label>
          <select
            id="label-filter"
            value={query.label ?? ''}
            onChange={(event) => onChange({ label: event.target.value || null })}
            className="h-7 max-w-[16rem] rounded-full bg-white/5 px-2.5 text-xs text-zinc-300 focus:outline-2 focus:outline-offset-2 focus:outline-indigo-400"
          >
            <option value="" className="bg-zinc-900">
              anything
            </option>
            {DETECTABLE.map((label) => (
              <option key={label} value={label} className="bg-zinc-900">
                {titleOf(label) ?? label}
              </option>
            ))}
          </select>

          {activeExtras > 0 ? (
            <button
              type="button"
              onClick={() =>
                onChange({
                  label: null,
                  animated: null,
                  greyscale: null,
                  minLongestEdge: null,
                })
              }
              className="text-[11px] text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
            >
              clear these
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
