import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './button.tsx'
import { cn } from './cn.ts'

interface DialogProps {
  title: string
  /** Paragraphs. Blank lines in a source string become the gaps between them. */
  message: string
  confirmLabel: string
  /** A question when present, a notice when not: no cancel means one button. */
  cancelLabel?: string
  tone?: 'neutral' | 'danger'
  /**
   * Keys that also confirm, besides Enter.
   *
   * For a question raised *by* a key. Delete in the lightbox opens this, and
   * pressing Delete again is the obvious way to mean yes — without it the
   * gesture is press Delete, then move to Enter, which is two reaches for one
   * decision.
   */
  confirmKeys?: readonly string[]
  /**
   * Turns the dialog into a question with an answer to edit, rather than one to
   * agree with. `onConfirm` is then called with the field's text.
   *
   * `suggestions` fill the field on click. They exist because the values these
   * fields hold are long — a path is the case this was built for — and typing
   * one out to change its last few characters is worse than not offering to
   * change it at all.
   */
  edit?: {
    label: string
    value: string
    suggestions?: readonly { label: string; value: string }[]
  }
  onConfirm: (value: string) => void
  onCancel: () => void
}

/** Shared so the default does not change identity on every render. */
const NO_EXTRA_KEYS: readonly string[] = []

/**
 * The app's own modal, deliberately not the platform's.
 *
 * `window.confirm` is unavailable in parts of the webview stack and the plugin
 * dialogs are OS chrome dropped on top of a dark app. Both also block on the
 * main thread. This one is a component: it matches the app, and it is testable
 * in jsdom, which the native ones are not.
 */
export function Dialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = 'neutral',
  confirmKeys = NO_EXTRA_KEYS,
  edit,
  onConfirm,
  onCancel,
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState(edit?.value ?? '')
  // Read through a ref by the key handler, which is registered once: Enter has
  // to send what is in the field now, not what was there on the render that
  // installed the listener.
  const latest = useRef(value)
  latest.current = value
  const confirmEdited = useCallback(() => onConfirm(latest.current), [onConfirm])

  useEffect(() => {
    // Capture phase, and every key is swallowed. Whatever is behind a modal is
    // still listening on `window` — in this app that is the lightbox, where
    // Escape closes it and the arrows step to another file. A confirm that let
    // its keystrokes through would answer the question about one file and
    // apply it to another.
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        confirmEdited()
        return
      }
      if (confirmKeys.includes(event.key)) {
        // Never on auto-repeat. The key that opened this dialog is usually
        // still held for a moment afterwards, and a repeat arriving here would
        // answer a destructive question the user has not read yet. A real
        // second press always reports `repeat: false`.
        if (event.repeat) return
        event.preventDefault()
        confirmEdited()
        return
      }
      if (event.key === 'Tab') {
        // A trap around whatever this dialog holds, which keeps Tab from
        // walking into the interface underneath — still in the DOM behind it.
        // Inputs are included, or an editable dialog would tab straight off
        // its own field and never come back.
        const focusable = panel.current?.querySelectorAll('button, input')
        if (!focusable || focusable.length === 0) return
        event.preventDefault()
        const list = [...focusable]
        const index = list.indexOf(document.activeElement as HTMLElement)
        const next = event.shiftKey ? index - 1 : index + 1
        ;(list[(next + list.length) % list.length] as HTMLElement | undefined)?.focus()
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel, confirmEdited, confirmKeys])

  useEffect(() => {
    // Restored on close so dismissing a dialog does not dump focus on <body>
    // and cost the lightbox its keyboard handling.
    const previous = document.activeElement as HTMLElement | null
    const field = panel.current?.querySelector('input')
    if (field) {
      // The caret goes to the end rather than selecting the whole value. What
      // is in the field is a starting point to trim, not a placeholder to type
      // over, and select-all makes the first keystroke destroy it.
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
    } else {
      const buttons = panel.current?.querySelectorAll('button')
      // The last button is the confirm, so Enter and the initial focus agree.
      buttons?.[buttons.length - 1]?.focus()
    }
    return () => previous?.focus?.()
  }, [])

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
      // Clicking away is a cancel, which is the safe answer for both a
      // destructive question and a notice.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'w-full max-w-md rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl',
          'flex flex-col gap-4',
        )}
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-zinc-100">{title}</p>
          {message
            .split('\n\n')
            .filter(Boolean)
            .map((paragraph) => (
              <p
                key={paragraph}
                // `break-words` because most of these carry a path or a
                // filename, which has no spaces to wrap at.
                className="break-words text-xs leading-relaxed whitespace-pre-wrap text-zinc-400"
              >
                {paragraph}
              </p>
            ))}
        </div>

        {edit ? (
          <div className="flex flex-col gap-1.5">
            {edit.suggestions && edit.suggestions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1">
                {edit.suggestions.map((suggestion) => (
                  <button
                    key={suggestion.value}
                    type="button"
                    // Highlighted by what the field currently holds rather than
                    // by what was clicked, so typing keeps the row honest.
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                      value === suggestion.value
                        ? 'bg-indigo-500/25 text-indigo-200'
                        : 'text-zinc-500 hover:bg-white/10 hover:text-zinc-200',
                    )}
                    title={suggestion.value}
                    onClick={() => setValue(suggestion.value)}
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
            ) : null}
            <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
              {edit.label}
              <input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                className={cn(
                  'w-full rounded-md border border-white/10 bg-zinc-950/60 px-2 py-1.5',
                  'font-mono text-xs text-zinc-200',
                  'focus:border-indigo-400/60 focus:outline-2 focus:outline-offset-1 focus:outline-indigo-400',
                )}
              />
            </label>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          {cancelLabel ? (
            <Button size="sm" onClick={onCancel}>
              {cancelLabel}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={tone === 'danger' ? 'danger' : 'primary'}
            // Disabled rather than validated: an empty path is the one answer
            // that is certainly wrong, and everything else is the backend's to
            // judge — it holds the allowlist this dialog cannot see.
            disabled={edit ? value.trim().length === 0 : false}
            onClick={() => onConfirm(value)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
