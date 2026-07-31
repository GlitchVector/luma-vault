import { basenameOf, type ScanProgress } from '@luma/core'
import { ProgressBar, Spinner } from '@luma/ui'
import type { Environment } from '#/lib/native.ts'

const PHASE_LABELS: Record<ScanProgress['phase'], string> = {
  idle: 'Idle',
  globbing: 'Finding files',
  measuring: 'Measuring images',
  thumbnailing: 'Building thumbnails',
  classifying: 'Classifying',
  done: 'Up to date',
}

interface StatusBarProps {
  progress: ScanProgress
  environment: Environment | null
}

export function StatusBar({ progress, environment }: StatusBarProps) {
  const running = progress.phase !== 'idle' && progress.phase !== 'done'
  // Globbing has no meaningful total — the count IS the progress — so the bar
  // must not pretend to know how far along it is.
  const indeterminate = progress.phase === 'globbing'

  const warnings: string[] = []
  if (environment && !environment.classifierAvailable) {
    warnings.push('Classifier unavailable — run `pnpm setup:python`. Files are indexed, not rated.')
  }
  if (environment && !environment.ffmpegAvailable) {
    warnings.push('ffmpeg not found — videos cannot be scanned.')
  }

  return (
    <footer className="border-t border-white/5 bg-zinc-950/70 px-4 py-1.5">
      <div className="flex items-center gap-3 text-[11px] text-zinc-500">
        {running ? <Spinner className="text-indigo-400" /> : null}
        <span className="text-zinc-400">{PHASE_LABELS[progress.phase]}</span>

        {running && progress.total > 0 ? (
          <span className="tabular-nums">
            {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
          </span>
        ) : null}

        {progress.current ? (
          <span className="min-w-0 flex-1 truncate" title={progress.current}>
            {basenameOf(progress.current)}
          </span>
        ) : (
          <span className="flex-1" />
        )}

        {progress.errors.length > 0 ? (
          <span
            className="text-amber-400"
            title={progress.errors.join('\n')}
          >
            {progress.errors.length} skipped
          </span>
        ) : null}
      </div>

      {running ? (
        <ProgressBar
          className="mt-1"
          done={progress.done}
          total={progress.total}
          indeterminate={indeterminate}
        />
      ) : null}

      {warnings.map((warning) => (
        <p key={warning} className="mt-1 text-[11px] text-amber-400/80">
          {warning}
        </p>
      ))}
    </footer>
  )
}
