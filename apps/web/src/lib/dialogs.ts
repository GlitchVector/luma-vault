import { useSyncExternalStore } from 'react'

/**
 * `confirm()` and `alert()`, as the app's own components.
 *
 * The point of the indirection is the call site. Asking before a delete belongs
 * where the delete is, and that code should not have to hold dialog state, own
 * a piece of JSX, or thread a callback up to whatever renders modals. So this
 * keeps the awaited shape of the browser's blocking dialogs — `if (await
 * askConfirm(…))` — and pushes the request onto a queue that {@link DialogHost}
 * renders. Nothing here imports React components or the native seam.
 */

export interface DialogRequest {
  /** Distinguishes two identically-worded requests in a row. */
  id: number
  title: string
  message: string
  confirmLabel: string
  /** Absent on a notice, which has nothing to cancel. */
  cancelLabel?: string
  tone: 'neutral' | 'danger'
  answer: (confirmed: boolean) => void
}

interface AskOptions {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'neutral' | 'danger'
}

let queue: DialogRequest[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function enqueue(request: Omit<DialogRequest, 'id' | 'answer'>): Promise<boolean> {
  return new Promise((resolve) => {
    // A queue rather than a single slot: a scan finishing while a confirm is
    // open would otherwise either replace the question on screen or be dropped.
    queue = [...queue, { ...request, id: nextId++, answer: resolve }]
    emit()
  })
}

/** Ask a yes/no question. Resolves false on cancel, Escape, or a click away. */
export function askConfirm(message: string, options: AskOptions = {}): Promise<boolean> {
  return enqueue({
    title: options.title ?? 'Are you sure?',
    message,
    confirmLabel: options.confirmLabel ?? 'Confirm',
    cancelLabel: options.cancelLabel ?? 'Cancel',
    tone: options.tone ?? 'neutral',
  })
}

/** State something. Resolves once it is dismissed. */
export async function showMessage(message: string, options: AskOptions = {}): Promise<void> {
  await enqueue({
    title: options.title ?? 'Luma Vault',
    message,
    confirmLabel: options.confirmLabel ?? 'OK',
    tone: 'neutral',
  })
}

/** Answers the dialog on screen and moves to the next one waiting. */
export function answerCurrent(confirmed: boolean): void {
  const [current, ...rest] = queue
  if (!current) return
  queue = rest
  emit()
  // After the store update: the resolved promise usually runs the action the
  // dialog was asking about, and that should see the dialog already gone.
  current.answer(confirmed)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): DialogRequest | null {
  return queue[0] ?? null
}

/** The dialog that should be on screen, or null. */
export function useCurrentDialog(): DialogRequest | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Test seam. Drops every pending request without answering it. */
export function resetDialogs(): void {
  queue = []
  emit()
}
