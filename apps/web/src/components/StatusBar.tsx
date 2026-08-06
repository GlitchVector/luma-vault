import {
  basenameOf,
  type RemoteStatus,
  type ScanProgress,
  type ShareStatus,
  type ThrottleLevel,
} from '@luma/core'
import { cn, ProgressBar, Spinner } from '@luma/ui'
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
  remote: RemoteStatus | null
  share: ShareStatus | null
  onOpenRemote: () => void
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

export function StatusBar({
  progress,
  environment,
  onSetThrottle,
  remote,
  share,
  onOpenRemote,
}: StatusBarProps) {
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

  const connected = remote?.connected === true

  return (
    <footer
      className={cn(
        'border-t px-4 py-1.5',
        // The whole bar changes colour while a session is live, not just the
        // button. Delete means "delete on that machine" from here, and one badge
        // among nine other pieces of text is not enough of a reminder.
        connected ? 'border-indigo-400/30 bg-indigo-500/10' : 'border-white/5 bg-zinc-950/70',
      )}
    >
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

        {/* Always here, in both states. A button that only appears once you are
            connected would be one you could not use to connect. */}
        <button
          type="button"
          onClick={onOpenRemote}
          title={
            connected
              ? `Showing ${remote?.host || remote?.address}. Everything you do here happens on that machine.`
              : share?.sharing
                ? `Sharing this library on ${share.addresses[0] ?? `port ${share.port}`}. Click to browse another machine, or to stop.`
                : 'Browse another machine on this network, or share this one.'
          }
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
            connected
              ? 'bg-indigo-500/25 text-indigo-200 hover:bg-indigo-500/35'
              : share?.sharing
                ? 'bg-white/5 text-zinc-300 hover:bg-white/10'
                : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300',
          )}
        >
          {connected ? `Remote · ${remote?.host || remote?.address}` : share?.sharing ? 'Sharing' : 'Local'}
        </button>
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
