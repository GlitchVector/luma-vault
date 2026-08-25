import { Toast } from '@luma/ui'
import { useToasts } from '#/lib/toasts.ts'

/**
 * Renders whatever {@link toast} has queued, bottom right.
 *
 * Mounted once at the app root, above everything including the lightbox — which
 * is the only place these are raised from, and which covers the whole window.
 *
 * Sat clear of the bottom edge rather than against it, because there is a
 * footer there in both contexts: the status bar in the grid, and the lightbox's
 * own footer over it. One offset clears both, and it is measured in the same
 * direction from the same edge either way.
 *
 * **On a phone that offset is not enough, and the number is not free.** The
 * lightbox's touch controls are `md:hidden` circles sitting at
 * `3.25rem + safe-area` and `size-12` tall, so they own the band up to
 * `6.25rem` — and the right-hand one shares this stack's own `right-4`. A
 * toast at `bottom-14` lands on top of them. Clearing it needs both the height
 * *and* the same `env(safe-area-inset-bottom)` those buttons carry, or the
 * offset drifts back into them on a device with a home indicator. Above `md`
 * the buttons do not exist and the original offset is still right.
 *
 * `pointer-events-none` on the stack: these sit over the corner of a picture,
 * and a confirmation that swallows a click on what is underneath it is worse
 * than no confirmation.
 */
export function ToastHost() {
  const toasts = useToasts()
  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-[calc(7rem+env(safe-area-inset-bottom))] right-4 z-[100] flex flex-col items-end gap-1.5 md:bottom-14">
      {toasts.map((entry) => (
        <Toast key={entry.id} tone={entry.tone}>
          {entry.message}
        </Toast>
      ))}
    </div>
  )
}
