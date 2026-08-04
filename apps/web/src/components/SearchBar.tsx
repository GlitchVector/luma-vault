import { cn } from '@luma/ui'
import { useEffect, useRef } from 'react'

/**
 * The library's search field, above the grid.
 *
 * Deliberately not an overlay. A palette is for jumping to one thing and
 * getting out of the way; this is a filter you leave on — you search "moona",
 * look at all 371 of them, then narrow by rating or folder without losing the
 * search. That composition is the whole point, and a modal cannot do it because
 * the thing it covers is the answer.
 *
 * It sits where the recently-added strip used to. Recency is one question about
 * a library and it had a permanent row; this answers every other question and
 * takes the space.
 */

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  /** Rows the current query matches, shown once there is a query. */
  matches: number
  loading: boolean
}

/** Below this the trigram index cannot answer: it indexes three-character runs. */
const MIN_TERM = 3

export function SearchBar({ value, onChange, matches, loading }: SearchBarProps) {
  const input = useRef<HTMLInputElement>(null)

  // Ctrl/Cmd-K focuses rather than opening anything — the field is always
  // there, so the shortcut's job is to put the cursor in it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const terms = value.split(/\s+/).filter(Boolean)
  const tooShort = terms.length > 0 && terms.every((term) => term.length < MIN_TERM)

  return (
    <div className="border-b border-white/5 px-4 py-3">
      <div
        className={cn(
          'flex items-center gap-3 rounded-lg border bg-zinc-900/60 px-3 py-2 transition-colors',
          'focus-within:border-indigo-400/50 focus-within:bg-zinc-900',
          tooShort ? 'border-amber-500/30' : 'border-white/10',
        )}
      >
        <span aria-hidden className="text-zinc-500">
          ⌕
        </span>
        <input
          ref={input}
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && value) {
              event.preventDefault()
              onChange('')
            }
          }}
          placeholder="Search filenames and prompts — try a character, a tag, a filename"
          aria-label="Search the library"
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
        />

        {value ? (
          <>
            <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
              {loading
                ? 'searching…'
                : tooShort
                  ? `${MIN_TERM} characters minimum`
                  : `${matches.toLocaleString()} ${matches === 1 ? 'match' : 'matches'}`}
            </span>
            <button
              type="button"
              onClick={() => onChange('')}
              className="shrink-0 rounded px-1 text-zinc-500 hover:text-zinc-200"
              aria-label="Clear search"
            >
              ✕
            </button>
          </>
        ) : (
          <kbd className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-600">
            Ctrl K
          </kbd>
        )}
      </div>
    </div>
  )
}
