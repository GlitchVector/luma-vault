import { useSyncExternalStore } from 'react'
import type { ToastTone } from '@luma/ui'

/**
 * Transient confirmations, as a module-level queue.
 *
 * The same shape as `dialogs.ts` and for the same reason: the code that knows
 * something happened should be able to say so without holding UI state or
 * threading a callback up to whatever renders overlays. {@link ToastHost}
 * renders whatever is here.
 *
 * Unlike a dialog, a toast answers nothing and nobody waits on it — so `toast()`
 * returns void and each entry removes itself.
 */

export interface ToastEntry {
  /** Distinguishes two identically-worded toasts in a row. */
  id: number
  message: string
  tone: ToastTone
}

/**
 * How long one stays. Short: this confirms something the person did a moment
 * ago and already knows about — it only has to survive long enough to be seen
 * out of the corner of an eye.
 */
const LINGER_MS = 1800

/**
 * How many are shown at once.
 *
 * The keys these confirm are meant to be *held down* through a folder. Without
 * a cap, a fast pass stacks thirty of them up the side of the window and the
 * newest — the only one that matters — ends up off screen. Three is enough to
 * see that a run of picks registered.
 */
const MAX_VISIBLE = 3

let queue: ToastEntry[] = []
let nextId = 1
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function emit() {
  for (const listener of listeners) listener()
}

function drop(id: number) {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
  const next = queue.filter((entry) => entry.id !== id)
  if (next.length === queue.length) return
  queue = next
  emit()
}

/** Say something happened. Disappears on its own. */
export function toast(message: string, tone: ToastTone = 'neutral'): void {
  const id = nextId++
  queue = [...queue, { id, message, tone }]

  // Oldest first, so the newest is always on screen. Their timers are cleared
  // with them — a fired timeout for an entry already gone is harmless, but
  // leaving them queued keeps a handle alive per keypress of a held key.
  while (queue.length > MAX_VISIBLE) {
    const [oldest, ...rest] = queue
    queue = rest
    if (oldest) {
      const timer = timers.get(oldest.id)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(oldest.id)
      }
    }
  }

  timers.set(
    id,
    setTimeout(() => drop(id), LINGER_MS),
  )
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): ToastEntry[] {
  return queue
}

/** Everything that should be on screen, oldest first. */
export function useToasts(): ToastEntry[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Test seam. Drops everything pending and cancels its timers. */
export function resetToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  queue = []
  emit()
}
