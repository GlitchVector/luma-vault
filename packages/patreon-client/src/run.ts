/**
 * Executing a plan.
 *
 * `plan.ts` works out what a run would do; this does it, and writes
 * `.state.json` after every step that produced something Patreon now holds. The
 * dry run and the real run share the plan, so what you were shown is what runs.
 *
 * Two orderings here are load-bearing rather than incidental:
 *
 *   1. the campaign check happens **before** anything creates a draft. Creating
 *      one is a navigation with a side effect, so a run that would be refused
 *      must be refused while refusing is still free.
 *   2. state is saved after each media, not at the end. The whole point is that
 *      a run dying at 90% of a large upload keeps the nine files before it.
 */

import { assertAdultMatchesCampaign, readCampaign, type Campaign } from './campaign.ts'
import type { ResolvedPost } from './manifest.ts'
import { createMedia, uploadBytes, waitUntilReady, type PollOptions } from './media.ts'
import { createDraft, updateDraft, type Draft } from './post.ts'
import type { Session } from './session.ts'
import { isCurrent, loadState, pruneState, saveState, type RunState } from './state.ts'

export interface RunOptions {
  readonly session: Session
  readonly post: ResolvedPost
  /** The campaign to post to. Not discoverable from the API — see `.env`. */
  readonly campaignId: string
  readonly onProgress?: (line: string) => void
  readonly poll?: PollOptions
}

export interface RunResult {
  readonly draft: Draft
  readonly campaign: Campaign
  /** Media ids in manifest order — what `image_order` was set to. */
  readonly mediaIds: readonly string[]
  readonly uploaded: number
  readonly reused: number
}

export async function runPost(options: RunOptions): Promise<RunResult> {
  const { session, post, campaignId } = options
  const say = options.onProgress ?? (() => {})

  // Before the draft exists, because creating it is a side effect.
  const campaign = await readCampaign(session, campaignId)
  assertAdultMatchesCampaign(post, campaign)
  say(`campaign ${campaign.name} (${campaign.id})${campaign.isNsfw ? ', adult' : ''}`)

  let state = pruneState(await loadState(post), post)

  const draft = await resumeOrCreateDraft(session, state, say)
  if (state.postId !== draft.id) {
    state = { ...state, postId: draft.id }
    await saveState(post, state)
  }

  const mediaIds: string[] = []
  let uploaded = 0
  let reused = 0

  for (const file of post.media) {
    const recorded = state.media[file.name]
    if (isCurrent(recorded, file) && recorded.phase === 'ready') {
      say(`reuse  ${file.name} -> ${recorded.id}`)
      mediaIds.push(recorded.id)
      reused++
      continue
    }

    // A record whose bytes landed but whose transcode was never confirmed is
    // worth finishing rather than redoing — that is the expensive case.
    if (isCurrent(recorded, file) && recorded.phase === 'uploaded') {
      say(`wait   ${file.name} (already uploaded)`)
      // eslint-disable-next-line no-await-in-loop
      await waitUntilReady(session, recorded.id, options.poll)
      state = withMedia(state, file.name, { ...recorded, phase: 'ready' })
      // eslint-disable-next-line no-await-in-loop
      await saveState(post, state)
      mediaIds.push(recorded.id)
      reused++
      continue
    }

    say(`upload ${file.name} (${(file.bytes / 1_000_000).toFixed(1)} MB)`)
    // Sequential on purpose: these are large files going to one account, and
    // the point of the project is to keep the traffic unremarkable.
    // eslint-disable-next-line no-await-in-loop
    const { id, target } = await createMedia(session, draft.id, file)
    state = withMedia(state, file.name, { id, phase: 'created', bytes: file.bytes, modifiedMs: file.modifiedMs })
    // eslint-disable-next-line no-await-in-loop
    await saveState(post, state)

    // eslint-disable-next-line no-await-in-loop
    await uploadBytes(target, file)
    state = withMedia(state, file.name, { id, phase: 'uploaded', bytes: file.bytes, modifiedMs: file.modifiedMs })
    // eslint-disable-next-line no-await-in-loop
    await saveState(post, state)

    // eslint-disable-next-line no-await-in-loop
    await waitUntilReady(session, id, options.poll)
    state = withMedia(state, file.name, { id, phase: 'ready', bytes: file.bytes, modifiedMs: file.modifiedMs })
    // eslint-disable-next-line no-await-in-loop
    await saveState(post, state)

    mediaIds.push(id)
    uploaded++
  }

  say(`configure ${mediaIds.length} media, access ${post.access}`)
  await updateDraft(session, draft, post, campaign, mediaIds)

  return { draft, campaign, mediaIds, uploaded, reused }
}

/**
 * Reuse the recorded draft if there is one.
 *
 * Not verified against Patreon first: a stale id shows up as a failing PATCH a
 * moment later, and the alternative — a read to check — is another call on
 * every run to catch a case that only happens when somebody deleted the draft
 * by hand.
 */
async function resumeOrCreateDraft(
  session: Session,
  state: RunState,
  say: (line: string) => void,
): Promise<Draft> {
  if (state.postId !== undefined) {
    say(`resume draft ${state.postId}`)
    return { id: state.postId, url: `${session.origin}/posts/${state.postId}/edit` }
  }
  const draft = await createDraft(session)
  say(`draft  ${draft.id}`)
  return draft
}

function withMedia(state: RunState, name: string, entry: RunState['media'][string]): RunState {
  return { ...state, media: { ...state.media, [name]: entry } }
}
