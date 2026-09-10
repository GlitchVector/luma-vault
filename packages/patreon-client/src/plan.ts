/**
 * What a run *would* do, worked out before anything touches the network.
 *
 * This is what `--dry-run` prints, and it is also what the real run executes,
 * so the dry run is not a separate code path that drifts. It is the same plan
 * with the steps not performed.
 *
 * Everything here is pure — manifest plus prior state in, list of steps out —
 * which is why it is the part of the pipeline that can be finished and tested
 * before a single endpoint is known.
 */

import type { ResolvedMedia, ResolvedPost } from './manifest.ts'
import { isCurrent, type MediaPhase, type RunState } from './state.ts'

export type Step =
  | { readonly kind: 'create-draft' }
  | { readonly kind: 'reuse-draft'; readonly postId: string }
  | { readonly kind: 'create-media'; readonly file: ResolvedMedia }
  | { readonly kind: 'upload-media'; readonly file: ResolvedMedia; readonly mediaId: string }
  | { readonly kind: 'await-media'; readonly file: ResolvedMedia; readonly mediaId: string }
  | { readonly kind: 'reuse-media'; readonly file: ResolvedMedia; readonly mediaId: string }
  | { readonly kind: 'attach-and-configure'; readonly count: number }

export interface Plan {
  readonly steps: readonly Step[]
  /** Bytes that would actually go over the wire — what resume is for. */
  readonly bytesToUpload: number
  /** Bytes skipped because a prior run already got them there. */
  readonly bytesReused: number
}

/**
 * Build the plan.
 *
 * The resume rule lives in one place, here: a media file is reused only if the
 * state file records it *and* the file on disk still has the size and mtime it
 * had then. A re-rendered frame gets re-uploaded; nothing else does.
 */
export function planRun(post: ResolvedPost, state: RunState): Plan {
  const steps: Step[] = []
  let bytesToUpload = 0
  let bytesReused = 0

  steps.push(
    state.postId === undefined ? { kind: 'create-draft' } : { kind: 'reuse-draft', postId: state.postId },
  )

  for (const file of post.media) {
    const recorded = state.media[file.name]
    if (!isCurrent(recorded, file)) {
      steps.push({ kind: 'create-media', file })
      // The id is not known until the run happens, so the plan names the file.
      steps.push({ kind: 'upload-media', file, mediaId: '(pending)' })
      steps.push({ kind: 'await-media', file, mediaId: '(pending)' })
      bytesToUpload += file.bytes
      continue
    }

    const phase: MediaPhase = recorded.phase
    if (phase === 'ready') {
      steps.push({ kind: 'reuse-media', file, mediaId: recorded.id })
      bytesReused += file.bytes
      continue
    }
    if (phase === 'uploaded') {
      // Bytes are there, transcoding was not finished (or not confirmed) last time.
      steps.push({ kind: 'await-media', file, mediaId: recorded.id })
      bytesReused += file.bytes
      continue
    }
    // 'created': a media record exists but the upload did not finish. The
    // presigned target may have expired, so the run re-creates rather than
    // resuming a half-written object — that is the only step worth redoing
    // wholesale, because a partial upload cannot be detected from here.
    steps.push({ kind: 'create-media', file })
    steps.push({ kind: 'upload-media', file, mediaId: '(pending)' })
    steps.push({ kind: 'await-media', file, mediaId: '(pending)' })
    bytesToUpload += file.bytes
  }

  steps.push({ kind: 'attach-and-configure', count: post.media.length })
  return { steps, bytesToUpload, bytesReused }
}

/** Human-readable plan, for `--dry-run` and for the line above a real run. */
export function describePlan(post: ResolvedPost, plan: Plan): string {
  const lines = [
    `set        ${post.dir}`,
    `title      ${post.title}`,
    `body       ${post.body.length} chars`,
    `media      ${post.media.length} (${post.media.filter((file) => file.kind === 'video').length} video)`,
    `teaser     ${post.teaser?.name ?? '(none)'}`,
    `access     ${post.access}${post.access === 'tier' ? ` -> ${post.tiers.join(', ')}` : ''}`,
    `adult      ${post.adult}`,
    `upload     ${megabytes(plan.bytesToUpload)} MB new, ${megabytes(plan.bytesReused)} MB already there`,
    '',
    'steps:',
  ]
  for (const step of plan.steps) lines.push(`  ${describeStep(step)}`)
  lines.push('', 'ends as a DRAFT. Nothing here publishes.')
  return lines.join('\n')
}

function describeStep(step: Step): string {
  switch (step.kind) {
    case 'create-draft':
      return 'create draft post'
    case 'reuse-draft':
      return `reuse draft post ${step.postId}`
    case 'create-media':
      return `create media record for ${step.file.name}`
    case 'upload-media':
      return `upload ${step.file.name} (${megabytes(step.file.bytes)} MB)`
    case 'await-media':
      return `wait until ${step.file.name} is usable`
    case 'reuse-media':
      return `reuse ${step.file.name} -> ${step.mediaId}`
    case 'attach-and-configure':
      return `attach ${step.count} media, set access control and the adult flag`
  }
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}
