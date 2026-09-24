import { CUSTOM_LORAS, loraCards, type CustomCharacter, type LoraEntry } from '@luma/core'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'

import {
  AddOutfit,
  KIND_LABEL,
  LoraTags,
  ratio,
  TrainingImages,
  useShowcase,
  type OpenViewer,
  type Showcase,
  type Viewing,
} from '#/components/LoraDetails.tsx'
import { Viewer } from '#/components/Viewer.tsx'
import { customCharacters, fileUrl, removeCustomCharacter, saveCustomCharacter } from '#/lib/native.ts'

interface CharactersPanelProps {
  onClose: () => void
  /** On a phone the sidebar is a drawer; this opens it, since the filter bar that usually does is not on this page. */
  onOpenLibrary?: () => void
  /** Show a LoRA's renders in the grid and close the page. */
  onShowRenders: (search: string) => void
}

/**
 * A name as the catalogue knows it now. A character names a LoRA by the file it had when she was made;
 * once that file is superseded it sits in the current entry's `olderVersions`, and she follows the line
 * to the current one rather than showing a LoRA that is gone.
 */
function catalogueIndex(entries: readonly LoraEntry[]): Map<string, LoraEntry> {
  const byName = new Map<string, LoraEntry>()
  for (const entry of entries) for (const name of [...entry.olderVersions, entry.name]) byName.set(name, entry)
  return byName
}

const CATALOGUE = catalogueIndex(CUSTOM_LORAS)

/** How a LoRA reads in a picker: its name, then whose it is and what of her it holds. */
function loraLabel(entry: LoraEntry): string {
  const what = entry.outfit ?? KIND_LABEL[entry.kind]
  return `${entry.name} - ${entry.character}, ${what}${entry.status === 'final' ? '' : ' (wip)'}`
}

/**
 * Characters, as a page: one card per character the owner created by hand, with her example picture from
 * the LoRA that renders her by default and every LoRA of hers listed under it. A LoRA opens in a side
 * panel with everything the LoRAs page shows about it.
 *
 * The owner's call (2026-09-24): "LoRA" is the wrong thing to organise by. A character is the unit; a LoRA
 * is one of the files that renders her, and an outfit is one more. So characters are made here, through a
 * form, and never inferred from the catalogue - two lines of the same girl, or a LoRA that is only a body,
 * are his to group, not the code's.
 */
export function CharactersPanel({ onClose, onOpenLibrary, onShowRenders }: CharactersPanelProps) {
  const [characters, setCharacters] = useState<CustomCharacter[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** The form: `new` for a new character, her id for an edit, null when closed. */
  const [editing, setEditing] = useState<string | null>(null)
  /** The LoRA open in the side panel. */
  const [selected, setSelected] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Viewing | null>(null)

  const reload = useCallback(() => {
    customCharacters()
      .then((found) => {
        setCharacters(found)
        setLoadError(null)
      })
      .catch((failure: unknown) => setLoadError(String(failure)))
  }, [])
  useEffect(reload, [reload])

  // Every LoRA any character names, current file, one query each: the example picture, the side panel's
  // renders and a card's LoRA rows all read from the same answers.
  const named = useMemo(() => {
    const seen = new Map<string, LoraEntry>()
    for (const character of characters ?? []) {
      for (const name of [character.defaultLora, ...character.loras]) {
        const entry = CATALOGUE.get(name)
        if (entry) seen.set(entry.name, entry)
      }
    }
    return [...seen.values()]
  }, [characters])
  const showcase = useShowcase(named)

  useEffect(() => {
    // Escape closes what is on top first: the viewer, then the side panel, then the form, then the page.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (viewing) setViewing(null)
      else if (selected) setSelected(null)
      else if (editing) setEditing(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, viewing, selected, editing])

  const saved = (character: CustomCharacter) => {
    setCharacters((current) => {
      const list = current ?? []
      return list.some((c) => c.id === character.id) ? list.map((c) => (c.id === character.id ? character : c)) : [...list, character]
    })
    setEditing(null)
  }

  const selectedEntry = selected === null ? undefined : CATALOGUE.get(selected)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-zinc-950 text-zinc-200">
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
        <h2 className="text-lg font-semibold">Characters</h2>
        <p className="hidden min-w-0 flex-1 truncate text-sm text-zinc-500 md:block">
          Your characters, each with the LoRA that renders her by default and every outfit or variant LoRA of hers.
        </p>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="ml-auto rounded-md bg-indigo-500/80 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 md:ml-0"
        >
          + New character
        </button>
        <button type="button" onClick={onClose} className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {editing === 'new' ? <CharacterForm character={null} onSaved={saved} onCancel={() => setEditing(null)} /> : null}

        {loadError !== null ? (
          <p className="text-sm text-red-300">{loadError}</p>
        ) : characters === null ? (
          <p className="text-sm text-zinc-500">reading the characters…</p>
        ) : characters.length === 0 && editing !== 'new' ? (
          <div className="mx-auto mt-10 max-w-md text-center text-sm text-zinc-500" data-testid="characters-empty">
            <p>No characters yet.</p>
            <p className="mt-1">Create one with a name, a description and the LoRA that renders her; outfits can be added to her later.</p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {characters.map((character) =>
              editing === character.id ? (
                <li key={character.id}>
                  <CharacterForm character={character} onSaved={saved} onCancel={() => setEditing(null)} />
                </li>
              ) : (
                <CharacterCard
                  key={character.id}
                  character={character}
                  showcase={showcase}
                  selected={selected}
                  onSelect={setSelected}
                  onView={setViewing}
                  onEdit={() => setEditing(character.id)}
                  onChanged={saved}
                  onRemoved={() => {
                    setCharacters((current) => (current ?? []).filter((c) => c.id !== character.id))
                    setSelected(null)
                  }}
                />
              ),
            )}
          </ul>
        )}
      </div>

      {selected !== null ? (
        <LoraSidePanel
          name={selected}
          entry={selectedEntry}
          showcase={showcase}
          onClose={() => setSelected(null)}
          onShowRenders={onShowRenders}
          onView={setViewing}
        />
      ) : null}

      {viewing ? <Viewer src={viewing.src} caption={viewing.caption} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}

interface CharacterCardProps {
  character: CustomCharacter
  showcase: Showcase
  selected: string | null
  onSelect: (name: string) => void
  onView: OpenViewer
  onEdit: () => void
  onChanged: (character: CustomCharacter) => void
  onRemoved: () => void
}

/** `memo` because the page re-renders on every showcase arrival, one LoRA's answer at a time. */
const CharacterCard = memo(function CharacterCard({
  character,
  showcase,
  selected,
  onSelect,
  onView,
  onEdit,
  onChanged,
  onRemoved,
}: CharacterCardProps) {
  const main = CATALOGUE.get(character.defaultLora)
  const renders = main ? showcase[main.name] : []
  // The example picture: the first of the default LoRA's own pick - a dressed front when she has one.
  const example = renders?.[0]
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = (loras: string[]) => {
    saveCustomCharacter({ ...character, id: character.id, loras })
      .then((stored) => {
        setError(null)
        onChanged(stored)
      })
      .catch((failure: unknown) => setError(String(failure)))
  }
  const remove = () => {
    removeCustomCharacter(character.id)
      .then(onRemoved)
      .catch((failure: unknown) => setError(String(failure)))
  }

  return (
    <li className="flex gap-4 rounded-lg border border-white/10 bg-white/[0.03] p-4" data-testid="character-card">
      <div className="w-28 shrink-0 sm:w-36">
        {renders === undefined ? (
          <div className="aspect-[2/3] animate-pulse rounded bg-white/[0.04]" />
        ) : example ? (
          <button
            type="button"
            onClick={() => onView({ src: fileUrl(example.full), caption: `${character.name} · ${main?.name ?? ''}` })}
            title="Open her example picture"
            style={{ aspectRatio: ratio(example.width, example.height) }}
            className="w-full overflow-hidden rounded bg-black/30 hover:ring-2 hover:ring-white/30"
          >
            <img src={fileUrl(example.path)} alt={character.name} loading="lazy" className="size-full object-cover" />
          </button>
        ) : (
          <div className="grid aspect-[2/3] place-items-center rounded bg-white/[0.02] px-2 text-center text-[11px] text-zinc-600">
            {main ? 'no renders yet' : 'default LoRA not in the catalogue'}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="truncate text-base font-semibold">{character.name}</h3>
          <div className="ml-auto flex shrink-0 gap-1.5">
            <button type="button" onClick={onEdit} className="rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
              Edit
            </button>
            {confirming ? (
              <>
                <button type="button" onClick={remove} className="rounded-md bg-red-500/70 px-2 py-1 text-xs text-white hover:bg-red-500">
                  Remove her
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                title="Remove this card. Her LoRAs stay in the catalogue."
                className="rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {character.description ? <p className="text-sm leading-relaxed text-zinc-400">{character.description}</p> : null}

        <ul className="flex flex-col gap-1" data-testid="character-loras">
          {[character.defaultLora, ...character.loras].map((name, index) => (
            <LoraRow
              key={name}
              name={name}
              isDefault={index === 0}
              active={selected !== null && CATALOGUE.get(name)?.name === CATALOGUE.get(selected)?.name}
              onSelect={onSelect}
              onRemove={index === 0 ? null : () => save(character.loras.filter((lora) => lora !== name))}
            />
          ))}
        </ul>

        {adding ? (
          <AddLora
            character={character}
            onAdd={(name) => {
              save([...character.loras, name])
              setAdding(false)
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="self-start text-xs text-zinc-500 underline decoration-dotted underline-offset-2 hover:text-zinc-200"
          >
            + Add a LoRA (outfit or variant)
          </button>
        )}
        {error !== null ? <p className="text-xs text-red-300">{error}</p> : null}
      </div>
    </li>
  )
})

/** One LoRA on a card: a button into the side panel, and for anything but the default a way to take it off her. */
function LoraRow({
  name,
  isDefault,
  active,
  onSelect,
  onRemove,
}: {
  name: string
  isDefault: boolean
  active: boolean
  onSelect: (name: string) => void
  onRemove: (() => void) | null
}) {
  const entry = CATALOGUE.get(name)
  const label = entry ? (entry.outfit ?? KIND_LABEL[entry.kind]) : 'not in the catalogue'
  return (
    <li className="flex items-center gap-2" data-testid="character-lora">
      <button
        type="button"
        onClick={() => onSelect(name)}
        aria-pressed={active}
        title="Show everything about this LoRA"
        className={`flex min-w-0 flex-1 items-baseline gap-2 rounded px-2 py-1 text-left text-sm hover:bg-white/10 ${active ? 'bg-white/10' : ''}`}
      >
        <code className="truncate text-xs text-zinc-200">{entry?.name ?? name}</code>
        <span className="truncate text-xs text-zinc-500">{label}</span>
        {isDefault ? <span className="ml-auto shrink-0 rounded-full bg-indigo-500/20 px-1.5 text-[10px] text-indigo-200">default</span> : null}
        {entry && entry.status !== 'final' ? (
          <span className={`${isDefault ? '' : 'ml-auto '}shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-300`}>wip</span>
        ) : null}
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Take ${name} off her card`}
          title="Take this LoRA off her card. It stays in the catalogue."
          className="shrink-0 rounded px-1.5 text-xs text-zinc-600 hover:bg-white/10 hover:text-zinc-300"
        >
          ×
        </button>
      ) : null}
    </li>
  )
}

/**
 * The picker for another LoRA of hers. The catalogue's own outfits and variants of her default LoRA come
 * first - most additions are one of those - then every other LoRA not already on her card.
 */
function AddLora({ character, onAdd, onCancel }: { character: CustomCharacter; onAdd: (name: string) => void; onCancel: () => void }) {
  const [choice, setChoice] = useState('')
  const on = new Set([character.defaultLora, ...character.loras].map((name) => CATALOGUE.get(name)?.name ?? name))
  const main = CATALOGUE.get(character.defaultLora)
  const suggested = main ? (loraCards().find((card) => card.main.name === main.name)?.variants ?? []) : []
  const rest = CUSTOM_LORAS.filter((entry) => !suggested.includes(entry))
  const free = (entries: readonly LoraEntry[]) => entries.filter((entry) => !on.has(entry.name))
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="add-lora">
      <select
        value={choice}
        onChange={(event) => setChoice(event.target.value)}
        aria-label="LoRA to add"
        className="min-w-0 flex-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-sm text-zinc-200"
      >
        <option value="">Pick a LoRA…</option>
        {free(suggested).length > 0 ? (
          <optgroup label={`Outfits and variants of ${main?.name ?? ''}`}>
            {free(suggested).map((entry) => (
              <option key={entry.name} value={entry.name}>
                {loraLabel(entry)}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label="Every other LoRA">
          {free(rest).map((entry) => (
            <option key={entry.name} value={entry.name}>
              {loraLabel(entry)}
            </option>
          ))}
        </optgroup>
      </select>
      <button
        type="button"
        onClick={() => onAdd(choice)}
        disabled={choice === ''}
        className="rounded-md bg-indigo-500/80 px-3 py-1 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
      >
        Add
      </button>
      <button type="button" onClick={onCancel} className="rounded-md bg-white/10 px-3 py-1 text-xs hover:bg-white/20">
        Cancel
      </button>
    </div>
  )
}

/**
 * Create or edit a character: a name, a description and the LoRA that renders her by default. The
 * default is picked from the catalogue's current files; her other LoRAs are kept as they are on an edit.
 */
function CharacterForm({
  character,
  onSaved,
  onCancel,
}: {
  character: CustomCharacter | null
  onSaved: (character: CustomCharacter) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(character?.name ?? '')
  const [description, setDescription] = useState(character?.description ?? '')
  const [defaultLora, setDefaultLora] = useState(
    character ? (CATALOGUE.get(character.defaultLora)?.name ?? character.defaultLora) : '',
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ready = name.trim() !== '' && defaultLora !== '' && !busy
  // A LoRA the catalogue no longer has stays selectable on an edit, so opening the form does not
  // silently change her default.
  const unknown = defaultLora !== '' && !CUSTOM_LORAS.some((entry) => entry.name === defaultLora)

  const submit = () => {
    setBusy(true)
    saveCustomCharacter({
      id: character?.id ?? null,
      name,
      description,
      defaultLora,
      loras: character?.loras ?? [],
    })
      .then((stored) => {
        setError(null)
        onSaved(stored)
      })
      .catch((failure: unknown) => setError(String(failure)))
      .finally(() => setBusy(false))
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) submit()
      }}
      className="mb-5 flex flex-col gap-3 rounded-lg border border-indigo-400/30 bg-indigo-500/5 p-4"
      data-testid="character-form"
    >
      <h3 className="text-sm font-semibold">{character ? `Edit ${character.name}` : 'New character'}</h3>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Ari"
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        Description
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          placeholder="Who she is, in a sentence or two"
          className="resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        Default LoRA - her example picture comes from its renders
        <select
          value={defaultLora}
          onChange={(event) => setDefaultLora(event.target.value)}
          className="rounded border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-zinc-200"
        >
          <option value="">Pick a LoRA…</option>
          {unknown ? <option value={defaultLora}>{`${defaultLora} - not in the catalogue`}</option> : null}
          {(['final', 'wip'] as const).map((status) => (
            <optgroup key={status} label={status === 'final' ? 'Final' : 'Work in progress'}>
              {CUSTOM_LORAS.filter((entry) => entry.status === status).map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {loraLabel(entry)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {error !== null ? <p className="text-xs text-red-300">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!ready}
          className="rounded-md bg-indigo-500/80 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {character ? 'Save' : 'Create'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * Everything about one LoRA, at the right edge over the page: what the LoRAs page shows on a card -
 * the prompt tags, the description and note, her renders, what it trained on - and, for a full
 * character LoRA, the way to add an outfit. The cards stay in view to its left so another LoRA is one
 * click away.
 */
function LoraSidePanel({
  name,
  entry,
  showcase,
  onClose,
  onShowRenders,
  onView,
}: {
  name: string
  entry: LoraEntry | undefined
  showcase: Showcase
  onClose: () => void
  onShowRenders: (search: string) => void
  onView: OpenViewer
}) {
  const renders = entry ? showcase[entry.name] : undefined
  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 flex w-full flex-col border-l border-white/10 bg-zinc-900 shadow-2xl sm:w-[30rem]"
      aria-label={`LoRA ${entry?.name ?? name}`}
      data-testid="lora-side-panel"
    >
      <div className="flex items-baseline gap-2 border-b border-white/10 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-mono text-sm font-semibold text-zinc-100">{entry?.name ?? name}</h3>
          {entry ? (
            <p className="text-xs text-zinc-500">
              {entry.character} · {entry.outfit ?? KIND_LABEL[entry.kind]} ·{' '}
              <span className={entry.status === 'final' ? 'text-emerald-300' : 'text-amber-300'}>
                {entry.status === 'final' ? 'final' : 'work in progress'}
              </span>
              {entry.name !== name ? ` · was ${name}` : ''}
            </p>
          ) : null}
        </div>
        <button type="button" onClick={onClose} aria-label="Close the LoRA panel" className="rounded-md bg-white/10 px-2.5 py-1 text-sm hover:bg-white/20">
          ×
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {entry === undefined ? (
          <p className="text-sm text-zinc-500">
            <code className="text-zinc-300">{name}</code> is not in the LoRA catalogue any more. Edit the character to pick another.
          </p>
        ) : (
          <>
            <LoraTags entry={entry} renders={renders} onShowRenders={onShowRenders} />
            <p className="text-sm leading-relaxed text-zinc-400">{entry.description}</p>
            {entry.note ? <p className="text-xs leading-relaxed text-zinc-500">{entry.note}</p> : null}
            {entry.olderVersions.length > 0 ? (
              <p className="text-xs text-zinc-600">Older files: {entry.olderVersions.join(', ')}</p>
            ) : null}
            <div className="grid grid-cols-3 items-start gap-2">
              {renders === undefined
                ? Array.from({ length: 3 }, (_, index) => <div key={index} className="aspect-[2/3] animate-pulse rounded bg-white/[0.04]" />)
                : renders.length === 0
                  ? <p className="col-span-3 rounded bg-white/[0.02] px-2 py-3 text-center text-xs text-zinc-600">No renders yet</p>
                  : renders.map((shot) => (
                      <button
                        key={shot.path}
                        type="button"
                        onClick={() => onView({ src: fileUrl(shot.full), caption: `${entry.character} · ${entry.name}` })}
                        title="Open this render"
                        style={{ aspectRatio: ratio(shot.width, shot.height) }}
                        className="overflow-hidden rounded bg-black/30 hover:ring-2 hover:ring-white/30"
                      >
                        <img src={fileUrl(shot.path)} alt="" loading="lazy" className="size-full object-cover" />
                      </button>
                    ))}
            </div>
            <TrainingImages dataset={entry.dataset} onView={onView} />
            {entry.kind === 'full' ? <SidePanelAddOutfit entry={entry} /> : null}
          </>
        )}
      </div>
    </aside>
  )
}

/** The LoRAs page's "Add outfit", folded until asked for so the panel opens on the LoRA itself. */
function SidePanelAddOutfit({ entry }: { entry: LoraEntry }) {
  const [open, setOpen] = useState(false)
  return open ? (
    <AddOutfit main={entry} onClose={() => setOpen(false)} />
  ) : (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="self-start rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
      title="Build a new outfit of this character as its own LoRA: a message for Claude Code, with your reference image attached"
    >
      + Add outfit
    </button>
  )
}
