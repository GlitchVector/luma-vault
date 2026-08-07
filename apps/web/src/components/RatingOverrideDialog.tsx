import { titleOf, type MediaItem, type Rating } from '@luma/core'
import { Button, cn } from '@luma/ui'
import { useEffect, useRef, useState } from 'react'

/**
 * Correcting the detector, on one picture.
 *
 * NudeNet is wrong often enough that living with it is not an option — a bare
 * shoulder reads as `FEMALE_BREAST_EXPOSED` at 0.42 and the picture is filed
 * as explicit forever, which puts it behind the sexy-only filter and sends it
 * to DeviantArt flagged mature. This is the way out, and it is deliberately a
 * *correction* rather than an edit: the model's verdict is shown, kept, and
 * restorable, because "the model said explicit and I disagree" is a different
 * and more useful thing to record than "this is sfw".
 *
 * Its own component rather than the shared {@link Dialog}, which is a
 * confirm — one message and two buttons. This one has to show the evidence
 * (what was detected, and how confidently) beside the choice, because that
 * evidence is how somebody decides whether the model was actually wrong.
 */

/** What a person can mean. `unrated` is absence of a verdict, never a choice. */
const CHOICES: Array<{ value: Exclude<Rating, 'unrated'>; label: string; hint: string }> = [
  { value: 'sfw', label: 'SFW', hint: 'Nothing sexual here' },
  { value: 'suggestive', label: 'Suggestive', hint: 'Suggestive, but not explicit' },
  { value: 'explicit', label: 'Explicit', hint: 'Explicit — the model missed it' },
]

interface RatingOverrideDialogProps {
  item: MediaItem
  /** `null` clears the correction and hands the row back to the model. */
  onApply: (rating: Exclude<Rating, 'unrated'> | null) => void
  onCancel: () => void
}

export function RatingOverrideDialog({ item, onApply, onCancel }: RatingOverrideDialogProps) {
  const panel = useRef<HTMLDivElement>(null)
  const modelRating = item.verdict?.rating ?? 'unrated'
  // Opens on what the row currently says, so the dialog is a correction of
  // something rather than a blank form. `unrated` is filtered out of both
  // sources: the schema allows it, nothing can mean it, and a preselected
  // choice the buttons do not offer would leave nothing highlighted.
  const current = item.ratingOverride ?? modelRating
  const [picked, setPicked] = useState<Exclude<Rating, 'unrated'> | null>(
    current === 'unrated' ? null : current,
  )

  useEffect(() => {
    // Capture phase, and nothing is allowed through — the same rule the shared
    // Dialog follows, and here it is not optional. The lightbox underneath
    // binds 1-5 to stars and the arrows to stepping between files, so a
    // keystroke that leaked would rate or navigate *while a dialog about this
    // picture is open*, and the correction would land on a different one.
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector('button')?.focus()
    return () => previous?.focus?.()
  }, [])

  const detected = item.verdict?.topLabel
    ? `${item.verdict.topLabelTitle ?? titleOf(item.verdict.topLabel)} · ${Math.round(
        item.verdict.topScore * 100,
      )}%`
    : null

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Correct the rating"
        className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-zinc-100">Correct the rating</p>
          <p className="text-xs leading-relaxed text-zinc-400">
            {/* The evidence, in the words the model used. Someone deciding
                whether it got this wrong needs to know what it thought it
                saw — "explicit" alone is not reviewable. */}
            NudeNet rated this <span className="font-medium text-zinc-300">{modelRating}</span>
            {detected ? (
              <>
                {' '}
                from <span className="font-medium text-zinc-300">{detected}</span>
              </>
            ) : null}
            . Your correction is kept separately, so re-running the rules never undoes it.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          {CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              onClick={() => setPicked(choice.value)}
              aria-pressed={picked === choice.value}
              className={cn(
                'flex items-baseline gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
                picked === choice.value
                  ? 'border-indigo-400/60 bg-indigo-500/15'
                  : 'border-white/10 bg-white/5 hover:bg-white/10',
              )}
            >
              <span className="text-xs font-medium text-zinc-100">{choice.label}</span>
              <span className="text-[11px] text-zinc-500">{choice.hint}</span>
              {choice.value === modelRating ? (
                <span className="ml-auto shrink-0 text-[10px] text-zinc-600">what the model said</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          {/* Only when there is one to clear. Offering "use the model's" on a
              row nobody has corrected is a button that does nothing. */}
          {item.ratingOverride ? (
            <Button size="sm" onClick={() => onApply(null)}>
              Use the model&apos;s
            </Button>
          ) : null}
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => picked && onApply(picked)}
            disabled={picked === null || picked === item.ratingOverride}
          >
            Correct it
          </Button>
        </div>
      </div>
    </div>
  )
}
