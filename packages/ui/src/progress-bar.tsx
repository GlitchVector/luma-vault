import { cn } from './cn.ts'

interface ProgressBarProps {
  done: number
  total: number
  /** Renders a moving stripe instead of a fill, for work with no known total. */
  indeterminate?: boolean
  className?: string
}

export function ProgressBar({ done, total, indeterminate = false, className }: ProgressBarProps) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <div
      className={cn('h-1 w-full overflow-hidden rounded-full bg-white/10', className)}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          'h-full rounded-full bg-indigo-400',
          indeterminate ? 'w-1/3 animate-[luma-slide_1.4s_ease-in-out_infinite]' : 'transition-[width] duration-300',
        )}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  )
}
