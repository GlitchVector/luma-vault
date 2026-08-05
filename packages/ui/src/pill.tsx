import type { ReactNode } from 'react'
import { cn } from './cn.ts'

interface PillProps {
  active?: boolean
  onClick?: () => void
  title?: string
  /**
   * A name for a pill whose label is a glyph.
   *
   * `♥` announces as "black heart suit", which says what was drawn rather than
   * what it does. Every pill with words in it needs nothing here.
   */
  ariaLabel?: string
  className?: string
  children: ReactNode
}

/** A filter toggle. Renders as a real button so it is keyboard-reachable. */
export function Pill({
  active = false,
  onClick,
  title,
  ariaLabel,
  className,
  children,
}: PillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400',
        active
          ? 'bg-indigo-500 text-white'
          : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200',
        className,
      )}
    >
      {children}
    </button>
  )
}
