import type { ReactNode } from 'react'
import { cn } from './cn.ts'

const TONES = {
  neutral: 'bg-zinc-800/95 text-zinc-200 ring-white/10',
  picked: 'bg-indigo-500/90 text-white ring-indigo-300/30',
  muted: 'bg-zinc-800/95 text-zinc-400 ring-white/10',
} as const

export type ToastTone = keyof typeof TONES

interface ToastProps {
  tone?: ToastTone
  children: ReactNode
}

/**
 * A single line of "that worked", for an action with no other visible result.
 *
 * Deliberately not a notification system: no title, no icon, no dismiss button
 * and nothing to click. Picking a picture with a key in the lightbox changes
 * something on a screen you cannot see, and the whole job here is to say so
 * without interrupting the pass — anything with a control on it invites you to
 * stop and use it.
 *
 * `aria-live="polite"` rather than `alert`: this is confirmation of something
 * the person just did, so it should be announced when convenient rather than
 * cutting off whatever a screen reader was mid-sentence on.
 */
export function Toast({ tone = 'neutral', children }: ToastProps) {
  return (
    <output
      aria-live="polite"
      className={cn(
        'pointer-events-none select-none rounded-md px-3 py-1.5 text-xs shadow-lg ring-1',
        'motion-safe:animate-[toast-in_120ms_ease-out]',
        TONES[tone],
      )}
    >
      {children}
    </output>
  )
}
