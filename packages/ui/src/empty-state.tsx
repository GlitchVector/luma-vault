import type { ReactNode } from 'react'

interface EmptyStateProps {
  title: string
  hint?: string
  action?: ReactNode
}

export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {hint ? <p className="max-w-md text-xs leading-relaxed text-zinc-500">{hint}</p> : null}
      {action}
    </div>
  )
}
