import { Button, Spinner } from '@luma/ui'
import {
  DISPLAY_ORIGINAL,
  DISPLAY_RESOLUTIONS,
  MAX_TAGS,
  POSE_TAGS,
  describeForDeviantArt,
  galleriesForItem,
  poseOf,
  toTag,
  type DeviantArtAccount,
  type DeviantArtDraft,
  type DeviantArtGallery,
  type DeviantArtSummary,
  type DisplayResolution,
  type MatureClassification,
  type MediaItem,
  type Pose,
} from '@luma/core'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DeviantArtSetup } from '#/components/DeviantArtSetup.tsx'
import {
  DEVIANTART_STUDIO_URL,
  deviantArtAccount,
  deviantArtGalleries,
  deviantArtSend,
  fileUrl,
  onDeviantArtProgress,
  openExternal,
  type DeviantArtProgress,
} from '#/lib/native.ts'

/** What the pose control can be set to. `auto` follows the first picture. */
type PoseChoice = 'auto' | Pose | 'none'

const POSE_LABELS: Record<Pose, string> = {
  rear: 'from behind',
  front: 'from the front',
}

const CLASSIFICATIONS: MatureClassification[] = [
  'nudity',
  'sexual',
  'gore',
  'language',
  'ideology',
]

interface Row {
  item: MediaItem
  draft: DeviantArtDraft
  /** Free text while typing. The chips beneath it are what actually gets sent. */
  tagText: string
}

interface DeviantArtPanelProps {
  items: MediaItem[]
  onClose: () => void
}

/** Split an edited tag field into what DeviantArt will accept. */
function parseTags(text: string): string[] {
  const tags: string[] = []
  for (const part of text.split(',')) {
    const tag = toTag(part)
    if (tag.length > 0 && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}

/**
 * Review a selection, then send it to DeviantArt.
 *
 * The review happens *here* rather than in a browser tab, and that is a
 * deliberate departure from the obvious design. A tab can only show one
 * submission at a time and cannot explain itself; this panel has the verdict,
 * the detections and the generation metadata that produced every suggested tag,
 * so it can show twenty pictures at once and say why each is flagged the way it
 * is. What leaves the machine is what is on this screen.
 *
 * Uploading and posting are two buttons, not one, because they are genuinely
 * different decisions. "Upload" stages everything privately in Sta.sh, where it
 * can be looked at on the site and abandoned by simply never posting it.
 */
export function DeviantArtPanel({ items, onClose }: DeviantArtPanelProps) {
  const [account, setAccount] = useState<DeviantArtAccount | null>(null)
  const [rows, setRows] = useState<Row[]>(() =>
    items.map((item) => {
      const draft = describeForDeviantArt(item)
      return { item, draft, tagText: draft.tags.join(', ') }
    }),
  )
  /**
   * One title for the batch, which is nearly always what is wanted.
   *
   * A set selected together is one shoot, and DeviantArt's own merge makes it
   * one deviation — so per-picture titles are the exception. Typing here
   * overwrites every row's title, and each row's own field still edits it back.
   */
  const [batchTitle, setBatchTitle] = useState('')
  /**
   * Which picture leads. Uploaded first, so it is first in the Sta.sh stack and
   * therefore index 0 — the poster — of a multi-image deviation merged from it.
   */
  const [posterId, setPosterId] = useState<number | null>(() => items[0]?.id ?? null)
  /** How large the deviation page draws it. Original, unless told otherwise. */
  const [displayResolution, setDisplayResolution] = useState<DisplayResolution>(DISPLAY_ORIGINAL)
  /** Merged into every row on send — a series name, a signature. */
  const [sharedTags, setSharedTags] = useState('')
  /**
   * Which way round the set is, read from the **first** picture.
   *
   * One reading for the whole batch rather than one per row, because a batch
   * selected together is one shoot: the first image is the poster, and if these
   * are merged into a multi-image deviation later it is the only one most people
   * will ever see.
   *
   * Straight off the row, with no round trip: the verdict already carries the
   * highest-scoring rated detection, which is exactly what the rule asks for.
   */
  const pose: Pose | null = items[0] ? poseOf(items[0]) : null
  const [poseChoice, setPoseChoice] = useState<PoseChoice>('auto')
  /**
   * Empty rather than seeded from the first filename, which is a counter and a
   * seed — a stack called `00242-3753124055` is no easier to find in Studio
   * than the files themselves. Falls back to the batch title, which is the name
   * the person actually chose for this set.
   */
  const [stack, setStack] = useState('')
  const [progress, setProgress] = useState<DeviantArtProgress | null>(null)
  const [summary, setSummary] = useState<DeviantArtSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * The account's gallery folders. Empty until they arrive, and empty for good
   * when the connection predates the `browse` scope — which the notice below
   * explains rather than leaving as a picker that mysteriously has nothing in
   * it.
   */
  const [galleries, setGalleries] = useState<DeviantArtGallery[]>([])

  useEffect(() => {
    void deviantArtAccount().then(setAccount, () => setAccount(null))
  }, [])

  // Loaded once, then matched against every row. Split from the account call so
  // a gallery list that fails does not cost the panel its connection state —
  // everything except the picker still works without it.
  useEffect(() => {
    void deviantArtGalleries().then((folders) => {
      setGalleries(folders)
      if (folders.length === 0) return
      setRows((previous) =>
        previous.map((row) =>
          // Only rows nobody has touched. The list arrives a moment after the
          // panel opens, and overwriting a choice made in that moment would be
          // the panel editing itself under someone's hands.
          row.draft.galleryIds.length > 0
            ? row
            : { ...row, draft: { ...row.draft, galleryIds: galleriesForItem(row.item, folders) } },
        ),
      )
      // A failure here is not worth a red banner: it costs the picker and
      // nothing else, and the notice already covers the common cause.
    }, () => setGalleries([]))
  }, [])

  // Escape closes, unless something is mid-flight — half an upload batch is
  // exactly when a stray keypress must not take the results away.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && progress === null) {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, progress])

  const update = useCallback((mediaId: number, patch: Partial<DeviantArtDraft>) => {
    setRows((previous) =>
      previous.map((row) =>
        row.draft.mediaId === mediaId ? { ...row, draft: { ...row.draft, ...patch } } : row,
      ),
    )
  }, [])

  /** Put one gallery on every row — a series folder, a catch-all. */
  const addGalleryToAll = useCallback((folderId: string) => {
    setRows((previous) =>
      previous.map((row) =>
        row.draft.galleryIds.includes(folderId)
          ? row
          : { ...row, draft: { ...row.draft, galleryIds: [...row.draft.galleryIds, folderId] } },
      ),
    )
  }, [])

  /** Folder id to name, for rendering a chosen gallery as its name. */
  const galleryNames = useMemo(
    () => new Map(galleries.map((gallery) => [gallery.folderId, gallery.name])),
    [galleries],
  )

  /** How many rows the automatic match actually found a gallery for. */
  const filed = rows.filter((row) => row.draft.galleryIds.length > 0).length

  /** What the pose control resolves to, once the reading has arrived. */
  const effectivePose: Pose | null =
    poseChoice === 'auto' ? pose : poseChoice === 'none' ? null : poseChoice

  /** The shared and pose tags, which every row carries. */
  const common = useMemo(() => {
    const shared = parseTags(sharedTags)
    const posed = effectivePose ? POSE_TAGS[effectivePose].map(toTag) : []
    // Shared first, then the pose set. DeviantArt keeps the order given, and a
    // tag someone typed on purpose should not sit below twenty derived ones.
    return [...shared, ...posed].filter((tag, index, all) => all.indexOf(tag) === index)
  }, [sharedTags, effectivePose])

  /**
   * The drafts as they will be sent, and whatever the tag cap cost.
   *
   * **Thirty is a hard limit, not a soft one** — DeviantArt refuses to publish a
   * submission carrying a thirty-first tag rather than trimming it. A tuned pose
   * list of twenty-odd plus the derived ones clears that comfortably, so the
   * trim is the normal case and has to be visible: a silently dropped tag reads
   * as this app ignoring what was typed.
   */
  const { drafts, dropped } = useMemo(() => {
    const lost: string[] = []
    const title = batchTitle.trim()
    const kept = rows.map((row) => {
      const all = [...common, ...parseTags(row.tagText)].filter(
        (tag, index, entries) => entries.indexOf(tag) === index,
      )
      for (const tag of all.slice(MAX_TAGS)) {
        if (!lost.includes(tag)) lost.push(tag)
      }
      return {
        ...row.draft,
        title: title || row.draft.title,
        tags: all.slice(0, MAX_TAGS),
        displayResolution,
      }
    })
    // The poster goes first, because the upload order *is* the stack order and
    // the stack order is what a Studio merge turns into image 1, 2, 3. Nothing
    // else about the batch can express "this is the one people will see".
    const leader = kept.findIndex((draft) => draft.mediaId === posterId)
    const ordered =
      leader > 0 ? [kept[leader]!, ...kept.slice(0, leader), ...kept.slice(leader + 1)] : kept
    return { drafts: ordered, dropped: lost }
  }, [rows, common, batchTitle, displayResolution, posterId])

  const send = (publish: boolean) => {
    setError(null)
    setProgress({ phase: 'uploading', done: 0, total: drafts.length, current: null })
    void onDeviantArtProgress(setProgress).then((unlisten) =>
      deviantArtSend(drafts, publish, stack.trim() || batchTitle.trim() || null).then(
        (result) => {
          unlisten()
          setProgress(null)
          setSummary(result)
        },
        (reason: unknown) => {
          unlisten()
          setProgress(null)
          setError(String(reason))
        },
      ),
    )
  }

  const unrated = rows.filter((row) => (row.item.verdict?.rating ?? 'unrated') === 'unrated').length
  const posterName =
    rows.find((row) => row.draft.mediaId === posterId)?.item.name ?? 'the first picture'

  return (
    <div className="fixed inset-0 z-[95] flex flex-col bg-black/92 backdrop-blur-sm">
      <header className="flex items-center gap-3 border-b border-white/5 px-4 py-2.5 text-sm">
        <span className="font-medium text-zinc-200">
          {summary ? 'Sent to DeviantArt' : `${rows.length.toLocaleString()} to review`}
        </span>
        {progress ? (
          <span className="flex items-center gap-2 text-indigo-300">
            <Spinner />
            {progress.phase === 'publishing' ? 'Posting' : 'Uploading'} {progress.done + 1}/
            {progress.total}
            {progress.current ? <span className="text-zinc-500">{progress.current}</span> : null}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          onClick={onClose}
          disabled={progress !== null}
          title={progress ? 'Wait for the batch to finish' : 'Close (Esc)'}
        >
          Close
        </Button>
      </header>

      {account ? <DeviantArtSetup account={account} onChange={setAccount} /> : null}

      {error ? (
        <p className="shrink-0 border-b border-red-500/20 bg-red-500/5 px-4 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      {summary ? (
        <Results summary={summary} onClose={onClose} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 border-b border-white/5 px-4 py-2 text-sm">
            <label className="flex min-w-64 flex-1 items-center gap-2">
              <span className="shrink-0 text-zinc-500">Title for all</span>
              <input
                value={batchTitle}
                onChange={(event) => setBatchTitle(event.target.value)}
                placeholder="leave empty to title each from its own prompt"
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-zinc-200 outline-none focus:border-indigo-400/60"
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="shrink-0 text-zinc-500">Shown at</span>
              <select
                value={displayResolution}
                onChange={(event) =>
                  setDisplayResolution(Number(event.target.value) as DisplayResolution)
                }
                title="How wide the deviation page draws the image. DeviantArt's own default downscales to 1280, which throws away the point of uploading a 4K render."
                className="rounded border border-white/10 bg-black/30 px-1 py-1 text-zinc-300 outline-none focus:border-indigo-400/60"
              >
                {DISPLAY_RESOLUTIONS.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-b border-white/5 px-4 py-2 text-sm">
            <label className="flex min-w-64 flex-1 items-center gap-2">
              <span className="shrink-0 text-zinc-500">Tags on all</span>
              <input
                value={sharedTags}
                onChange={(event) => setSharedTags(event.target.value)}
                placeholder="a series name, a signature…"
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-zinc-200 outline-none focus:border-indigo-400/60"
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="shrink-0 text-zinc-500">Pose</span>
              <select
                value={poseChoice}
                onChange={(event) => setPoseChoice(event.target.value as PoseChoice)}
                title="Which set of orientation tags to add. Read from the first picture: whichever anatomy the detector was most confident about decides, and buttocks means from behind."
                className="rounded border border-white/10 bg-black/30 px-1 py-1 text-zinc-300 outline-none focus:border-indigo-400/60"
              >
                <option value="auto">
                  from the first picture{pose ? ` — ${POSE_LABELS[pose]}` : ' — not classified'}
                </option>
                <option value="rear">all from behind</option>
                <option value="front">all from the front</option>
                <option value="none">no pose tags</option>
              </select>
            </label>

            {/* What the choice actually adds, spelled out. The whole control is
                otherwise a word that silently changes eight tags. */}
            <span className="flex flex-wrap gap-1">
              {effectivePose ? (
                POSE_TAGS[effectivePose].map((tag) => (
                  <span key={tag} className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-indigo-200">
                    {toTag(tag)}
                  </span>
                ))
              ) : (
                <span className="text-zinc-600">no orientation tags</span>
              )}
            </span>

            {unrated > 0 ? (
              <span
                className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300"
                title="The classifier has not reached these yet, so nothing is known about them. They default to not-mature, which is the one thing worth checking by hand before posting."
              >
                {unrated} not classified yet — check the mature flags
              </span>
            ) : null}
          </div>

          {/* Never silent. DeviantArt refuses a submission with a thirty-first
              tag outright, so this trim is what keeps the upload possible — but
              a tag someone typed vanishing without a word reads as a bug. */}
          {dropped.length > 0 ? (
            <p className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-sm text-amber-200">
              Over DeviantArt&apos;s limit of {MAX_TAGS} tags, so{' '}
              {dropped.length.toLocaleString()} did not fit and were dropped from the end:{' '}
              <span className="text-amber-100">{dropped.join(', ')}</span>. Shorten the pose list
              or the shared tags to choose differently.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 border-b border-white/5 px-4 py-2 text-sm">
            <span className="shrink-0 text-zinc-500">Galleries</span>
            {galleries.length > 0 ? (
              <>
                <select
                  value=""
                  onChange={(event) => {
                    if (event.target.value) addGalleryToAll(event.target.value)
                  }}
                  title="Add one gallery to every picture in this batch. Each row can still be changed on its own below."
                  className="rounded border border-white/10 bg-black/30 px-1 py-1 text-zinc-300 outline-none focus:border-indigo-400/60"
                >
                  <option value="">add one to all…</option>
                  {galleries.map((gallery) => (
                    <option key={gallery.folderId} value={gallery.folderId}>
                      {gallery.name}
                    </option>
                  ))}
                </select>
                <span className="text-zinc-500">
                  {filed === rows.length
                    ? `all ${rows.length.toLocaleString()} matched a gallery by character`
                    : `${filed.toLocaleString()} of ${rows.length.toLocaleString()} matched a gallery by character — the rest need one picking, or none`}
                </span>
              </>
            ) : account?.connected === true && account.canBrowse !== true ? (
              // The one case that looks like a bug and is not. Publishing into a
              // gallery needs no extra permission; *listing* them does, and this
              // connection was authorized before the app asked for it.
              <span className="text-amber-300">
                This connection cannot read your gallery list — it was made before the app asked
                for the <span className="text-amber-100">browse</span> permission. Disconnect and
                connect again above to pick galleries here.
              </span>
            ) : (
              <span className="text-zinc-600">no galleries to choose from</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-b border-white/5 px-4 py-2 text-sm">
            <label className="flex min-w-64 flex-1 items-center gap-2">
              <span className="shrink-0 text-zinc-500">Group in Sta.sh as</span>
              <input
                value={stack}
                onChange={(event) => setStack(event.target.value)}
                placeholder={batchTitle.trim() || 'leave empty to upload them loose'}
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-zinc-200 outline-none focus:border-indigo-400/60"
              />
            </label>
            {/* The reason this field exists. DeviantArt's API cannot make a
                multi-image deviation — `stash/publish` takes exactly one
                `itemid` and `deviation/edit` cannot attach a second — but
                Studio can merge one out of a selection, and a named stack is
                what makes that selection two clicks instead of hunting twenty
                files out of a flat list. */}
            <span className="text-zinc-500">
              One deviation per picture is all the API can post. Uploading them
              under one name is what makes{' '}
              <span className="text-zinc-400">Studio → Merge into multi-image deviation</span> a
              selection instead of a hunt — {posterName} goes first, so it lands as the poster.
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((row) => (
              <DraftRow
                key={row.draft.mediaId}
                row={row}
                common={common}
                galleries={galleries}
                galleryNames={galleryNames}
                isPoster={row.draft.mediaId === posterId}
                onPoster={() => setPosterId(row.draft.mediaId)}
                onDraft={update}
                onTagText={(text) =>
                  setRows((previous) =>
                    previous.map((entry) =>
                      entry.draft.mediaId === row.draft.mediaId
                        ? { ...entry, tagText: text }
                        : entry,
                    ),
                  )
                }
              />
            ))}
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-white/5 px-4 py-2 text-sm">
            <span className="text-zinc-500">
              Uploading stages everything privately in Sta.sh. Nothing is public until it is
              posted — from here, or from your Studio on the site.
              {/* Not a detail to discover afterwards: galleries are a parameter
                  of publishing, so the button someone picks decides whether the
                  choices above are sent at all. */}
              {filed > 0 ? (
                <>
                  {' '}
                  <span className="text-zinc-400">
                    Galleries are only set when posting — a staged upload carries none, and a
                    batch merged in Studio is filed there.
                  </span>
                </>
              ) : null}
            </span>
            <span className="ml-auto flex gap-2">
              <Button
                size="sm"
                onClick={() => send(false)}
                disabled={progress !== null || account?.connected !== true}
                title="Upload to Sta.sh and leave everything private"
              >
                Upload {rows.length.toLocaleString()} to Sta.sh
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => send(true)}
                disabled={
                  progress !== null || account?.connected !== true || account?.canPublish !== true
                }
                title={
                  account?.canPublish
                    ? 'Upload and post publicly, straight away'
                    : 'This connection was not granted the publish scope'
                }
              >
                Upload and post
              </Button>
            </span>
          </footer>
        </>
      )}
    </div>
  )
}

interface DraftRowProps {
  row: Row
  /** Shared and pose tags, which count against this row's budget too. */
  common: string[]
  /** Every folder the account has, for the picker. */
  galleries: DeviantArtGallery[]
  /** Folder id to name, so a chosen gallery renders as its name. */
  galleryNames: Map<string, string>
  /** Uploaded first, and so the poster of anything merged out of the stack. */
  isPoster: boolean
  onPoster: () => void
  onDraft: (mediaId: number, patch: Partial<DeviantArtDraft>) => void
  onTagText: (text: string) => void
}

function DraftRow({
  row,
  common,
  galleries,
  galleryNames,
  isPoster,
  onPoster,
  onDraft,
  onTagText,
}: DraftRowProps) {
  const { item, draft } = row
  const id = draft.mediaId
  const tags = parseTags(row.tagText)
  /** What the field would read if it were written the way it will be sent. */
  const normalised = tags.join(', ')
  const rating = item.verdict?.rating ?? 'unrated'
  // The whole budget, not just this field's share of it — a row showing "6 tags"
  // while twenty-four more are being added above it is worse than no count.
  const total = [...common, ...tags].filter(
    (tag, index, all) => all.indexOf(tag) === index,
  ).length

  return (
    <article className="group/row flex gap-3 border-b border-white/5 px-4 py-3">
      <div className="relative shrink-0">
        <img
          src={fileUrl(item.thumbPath ?? item.path)}
          alt={item.name}
          loading="lazy"
          decoding="async"
          className="h-32 w-32 rounded-md bg-zinc-800/80 object-cover"
        />
        <button
          type="button"
          onClick={onPoster}
          title={
            isPoster
              ? 'Uploaded first, so it is the poster of a multi-image deviation merged from this batch'
              : 'Upload this one first, so it becomes the poster'
          }
          className={
            isPoster
              ? 'absolute bottom-1 left-1 rounded bg-indigo-500 px-1.5 py-0.5 text-[10px] font-semibold text-white'
              : 'absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-400 opacity-0 transition-opacity hover:text-zinc-100 focus-visible:opacity-100 group-hover/row:opacity-100'
          }
        >
          {isPoster ? 'poster' : 'make poster'}
        </button>
      </div>

      <div className="min-w-0 flex-1 space-y-1.5 text-sm">
        <input
          value={draft.title}
          onChange={(event) => onDraft(id, { title: event.target.value })}
          placeholder="Title"
          className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-base text-zinc-100 outline-none focus:border-indigo-400/60"
        />

        <input
          value={row.tagText}
          onChange={(event) => onTagText(event.target.value)}
          placeholder="tags for this picture, separated by commas"
          className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-zinc-300 outline-none focus:border-indigo-400/60"
        />

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {/* Only when sanitising actually changed something. DeviantArt allows
              letters, digits and underscores only, so `sci-fi!` becomes
              `sci_fi` — worth showing, because rewriting the field under
              someone's cursor is worse. Repeating the field back verbatim the
              rest of the time is just a second copy of what they can already
              read, on every row. */}
          {normalised === row.tagText.trim() ? null : (
            <>
              <span className="text-zinc-600">sent as</span>
              {tags.map((tag) => (
                <span key={tag} className="rounded bg-white/5 px-2 py-0.5 text-zinc-400">
                  {tag}
                </span>
              ))}
            </>
          )}

          {/* The arithmetic, not just the total. Seven tags in the field and a
              count of twenty-four is unexplainable without it. */}
          <span
            className={total > MAX_TAGS ? 'ml-auto text-amber-300' : 'ml-auto text-zinc-600'}
            title={`${tags.length} on this picture plus ${common.length} shared and pose tags above, ${
              tags.length + common.length - total
            } of them the same. DeviantArt refuses more than ${MAX_TAGS}.`}
          >
            {common.length > 0 ? `${tags.length} + ${common.length} above = ` : null}
            {total}/{MAX_TAGS}
          </span>
        </div>

        {galleries.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.galleryIds.map((folderId) => (
              <button
                key={folderId}
                type="button"
                onClick={() =>
                  onDraft(id, {
                    galleryIds: draft.galleryIds.filter((chosen) => chosen !== folderId),
                  })
                }
                title="Remove this gallery"
                className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-indigo-200 hover:bg-indigo-500/30"
              >
                {/* A folder the account no longer has still has to render as
                    something — its id is not a name, but it is not nothing. */}
                {galleryNames.get(folderId) ?? folderId} ×
              </button>
            ))}
            <select
              value=""
              onChange={(event) => {
                if (event.target.value) {
                  onDraft(id, { galleryIds: [...draft.galleryIds, event.target.value] })
                }
              }}
              className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-zinc-400 outline-none focus:border-indigo-400/60"
            >
              <option value="">
                {draft.galleryIds.length > 0 ? 'add a gallery…' : 'no gallery — add one…'}
              </option>
              {galleries
                .filter((gallery) => !draft.galleryIds.includes(gallery.folderId))
                .map((gallery) => (
                  <option key={gallery.folderId} value={gallery.folderId}>
                    {gallery.name}
                  </option>
                ))}
            </select>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-1.5 text-zinc-400">
            <input
              type="checkbox"
              checked={draft.isMature}
              onChange={(event) =>
                onDraft(id, {
                  isMature: event.target.checked,
                  // The API rejects one without the other in both directions,
                  // so they are set together and never drift apart.
                  matureLevel: event.target.checked ? (draft.matureLevel ?? 'strict') : null,
                  matureClassification: event.target.checked ? draft.matureClassification : [],
                })
              }
            />
            Mature
          </label>

          {draft.isMature ? (
            <>
              <select
                value={draft.matureLevel ?? 'strict'}
                onChange={(event) =>
                  onDraft(id, { matureLevel: event.target.value === 'strict' ? 'strict' : 'moderate' })
                }
                className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-zinc-300 outline-none"
              >
                <option value="moderate">moderate (13+)</option>
                <option value="strict">strict (18+)</option>
              </select>

              {CLASSIFICATIONS.map((reason) => {
                const on = draft.matureClassification.includes(reason)
                return (
                  <button
                    key={reason}
                    type="button"
                    onClick={() =>
                      onDraft(id, {
                        matureClassification: on
                          ? draft.matureClassification.filter((entry) => entry !== reason)
                          : [...draft.matureClassification, reason],
                      })
                    }
                    className={
                      on
                        ? 'rounded bg-indigo-500/25 px-1.5 py-0.5 text-indigo-200'
                        : 'rounded bg-white/5 px-1.5 py-0.5 text-zinc-500 hover:text-zinc-300'
                    }
                  >
                    {reason}
                  </button>
                )
              })}
            </>
          ) : null}

          <span className="ml-auto flex items-center gap-3">
            <label
              className="flex items-center gap-1.5 text-zinc-400"
              title="DeviantArt reads this from the file's own metadata as well, so disagreeing with it hides nothing."
            >
              <input
                type="checkbox"
                checked={draft.isAiGenerated}
                onChange={(event) => onDraft(id, { isAiGenerated: event.target.checked })}
              />
              AI
            </label>
            <label
              className="flex items-center gap-1.5 text-zinc-400"
              title="Ask that this not be included in AI training sets"
            >
              <input
                type="checkbox"
                checked={draft.noai}
                onChange={(event) => onDraft(id, { noai: event.target.checked })}
              />
              no AI training
            </label>
            <span
              className={rating === 'unrated' ? 'text-amber-400/80' : 'text-zinc-600'}
              title={item.verdict?.topLabelTitle ?? 'not classified yet'}
            >
              {rating}
            </span>
          </span>
        </div>
      </div>
    </article>
  )
}

function Results({ summary, onClose }: { summary: DeviantArtSummary; onClose: () => void }) {
  return (
    <>
      <div className="flex items-center gap-3 border-b border-white/5 px-4 py-2.5 text-sm">
        <span className="text-zinc-300">{summary.staged.toLocaleString()} uploaded</span>
        {summary.published > 0 ? (
          <span className="text-indigo-300">{summary.published.toLocaleString()} posted</span>
        ) : null}
        {summary.failed > 0 ? (
          <span className="text-red-300">{summary.failed.toLocaleString()} failed</span>
        ) : null}
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => void openExternal(DEVIANTART_STUDIO_URL)}
          title="Staged submissions live here until you post them"
        >
          Open your Studio
        </Button>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-4 py-2 text-sm">
        {summary.results.map((result) => (
          <li
            key={result.mediaId}
            className="flex items-baseline gap-2 border-b border-white/5 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-zinc-300">{result.title}</span>
            {result.error ? (
              <span className="text-red-300">{result.error}</span>
            ) : result.published ? (
              <button
                type="button"
                onClick={() => result.url && void openExternal(result.url)}
                disabled={!result.url}
                className="text-indigo-300 underline decoration-dotted underline-offset-2 hover:text-indigo-100 disabled:no-underline disabled:opacity-50"
              >
                posted
              </button>
            ) : (
              <span className="text-zinc-500">waiting in your Studio</span>
            )}
          </li>
        ))}
      </ul>

      <footer className="flex items-center gap-2 border-t border-white/5 px-4 py-2 text-sm text-zinc-500">
        {summary.published === 0 && summary.staged > 0
          ? 'Nothing is public yet. Open your Studio to look at them and submit.'
          : 'Posted submissions may take a moment to appear on your profile.'}
        <Button size="sm" variant="primary" className="ml-auto" onClick={onClose}>
          Done
        </Button>
      </footer>
    </>
  )
}
