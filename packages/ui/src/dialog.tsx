import { useEffect, useRef } from 'react'
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
  onConfirm: () => void
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
  onConfirm,
  onCancel,
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null)

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
        onConfirm()
        return
      }
      if (confirmKeys.includes(event.key)) {
        // Never on auto-repeat. The key that opened this dialog is usually
        // still held for a moment afterwards, and a repeat arriving here would
        // answer a destructive question the user has not read yet. A real
        // second press always reports `repeat: false`.
        if (event.repeat) return
        event.preventDefault()
        onConfirm()
        return
      }
      if (event.key === 'Tab') {
        // A two-button trap. Enough for this dialog, and it keeps Tab from
        // walking into the interface underneath, which is still in the DOM.
        const buttons = panel.current?.querySelectorAll('button')
        if (!buttons || buttons.length === 0) return
        event.preventDefault()
        const list = [...buttons]
        const index = list.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.shiftKey ? index - 1 : index + 1
        list[(next + list.length) % list.length]?.focus()
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel, onConfirm, confirmKeys])

  useEffect(() => {
    // Restored on close so dismissing a dialog does not dump focus on <body>
    // and cost the lightbox its keyboard handling.
    const previous = document.activeElement as HTMLElement | null
    const buttons = panel.current?.querySelectorAll('button')
    // The last button is the confirm, so Enter and the initial focus agree.
    const initial = buttons?.[buttons.length - 1]
    initial?.focus()
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

        <div className="flex justify-end gap-2">
          {cancelLabel ? (
            <Button size="sm" onClick={onCancel}>
              {cancelLabel}
            </Button>
          ) : null}
          <Button size="sm" variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
