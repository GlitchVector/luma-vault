import { basenameOf, type ScanProgress, type ThrottleLevel } from '@luma/core'
import { ProgressBar, Spinner } from '@luma/ui'
import type { Environment } from '#/lib/native.ts'

const PHASE_LABELS: Record<ScanProgress['phase'], string> = {
  idle: 'Idle',
  globbing: 'Finding files',
  measuring: 'Measuring images',
  thumbnailing: 'Building thumbnails',
  classifying: 'Classifying',
  hashing: 'Fingerprinting images',
  labelling: 'Detecting documents',
  tagging: 'Reviewing drawn content',
  done: 'Up to date',
}

interface StatusBarProps {
  progress: ScanProgress
  environment: Environment | null
  onSetThrottle: (level: ThrottleLevel) => void
}

/** Ordered slowest-machine-impact last, so the list reads as a dial. */
const THROTTLES: Array<{ value: ThrottleLevel; label: string; title: string }> = [
  {
    value: 'off',
    label: 'Full speed',
    title: 'Use everything available. Right when you are not using the machine for anything else.',
  },
  {
    value: 'background',
    label: 'Background',
    title:
      'About a quarter of the CPU. The desktop stays completely responsive and a large scan still finishes in hours.',
  },
  {
    value: 'idle',
    label: 'Idle',
    title:
      'About a twentieth of the CPU. For when the machine is busy with something that matters more; a big folder will take most of a day.',
  },
]

export function StatusBar({ progress, environment, onSetThrottle }: StatusBarProps) {
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

        {/* Lives here rather than in the filter bar: it governs background work,
            which is what the rest of this bar is about. */}
        <label className="flex select-none items-center gap-1.5 text-zinc-500">
          CPU
          <select
            value={environment?.throttle ?? 'off'}
            onChange={(event) => onSetThrottle(event.target.value as ThrottleLevel)}
            title={THROTTLES.find((t) => t.value === (environment?.throttle ?? 'off'))?.title}
            className="h-5 rounded-full bg-white/5 px-1.5 text-[11px] text-zinc-300 focus:outline-2 focus:outline-offset-2 focus:outline-indigo-400"
          >
            {THROTTLES.map((throttle) => (
              <option key={throttle.value} value={throttle.value} className="bg-zinc-900">
                {throttle.label}
              </option>
            ))}
          </select>
        </label>

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
