/**
 * The campaign, and the one thing this tool reads from it.
 *
 * `is_nsfw` is a **campaign** attribute, not a post one. The captures settle
 * this: `GET /api/campaigns/{id}` answers `data.attributes.is_nsfw`, and the
 * post payload has no adult, nsfw or mature field anywhere in it. A page is
 * marked once and every post on it inherits that.
 *
 * Which changes what `adult` in the manifest can mean. It cannot be a value we
 * send — there is nowhere to send it. So it becomes a value we *check*, and
 * that turns out to be the more useful of the two: the failure this guards
 * against is not "a post went up with a box unticked", it is "NSFW work went
 * onto a page that is not marked for it", which is the account-level version of
 * the same mistake and the one nobody can undo afterwards.
 */

import { call, endpointPath, required } from './call.ts'
import { CAMPAIGN_GET } from './endpoints.generated.ts'
import type { ResolvedPost } from './manifest.ts'
import type { Session } from './session.ts'

export interface Campaign {
  readonly id: string
  readonly name: string
  /** Whether the page as a whole is marked as adult. Every post inherits it. */
  readonly isNsfw: boolean
}

interface CampaignResponse {
  data?: { id?: string; attributes?: { name?: string; is_nsfw?: boolean } }
}

export async function readCampaign(session: Session, campaignId: string): Promise<Campaign> {
  const endpoint = required(CAMPAIGN_GET, 'the campaign endpoint', 'text-only')
  const result = await call<CampaignResponse>(session, {
    method: endpoint.method,
    path: endpointPath(endpoint, { id: campaignId }),
  })
  if (!result.ok || result.json?.data === undefined) {
    throw new Error(
      `could not read campaign ${campaignId} (${result.status}). ` +
        'Check PATREON_CAMPAIGN_ID names a campaign this account owns.',
    )
  }
  const attributes = result.json.data.attributes ?? {}
  return {
    id: result.json.data.id ?? campaignId,
    name: attributes.name ?? '(unnamed)',
    // Absent is not false. A response shape that changed under us must not read
    // as "this page is safe for work" — that is the direction that does damage.
    isNsfw: attributes.is_nsfw === true,
  }
}

/**
 * Refuse to continue when the set and the page disagree about adult content.
 *
 * Only one direction is fatal. Posting an NSFW set to a page that is not marked
 * NSFW is the account-level problem the manifest's required `adult` field
 * exists to prevent, so it stops the run. The other direction — a tame set on a
 * page that is marked adult — is normal and gets no comment: the page is marked
 * for what it mostly carries, not for each post.
 */
export function assertAdultMatchesCampaign(post: ResolvedPost, campaign: Campaign): void {
  if (post.adult && !campaign.isNsfw) {
    throw new Error(
      `${post.manifestPath} says adult: true, but the campaign "${campaign.name}" is not marked as adult.\n` +
        'Patreon has no per-post adult flag — the page carries it, so this post would go up unmarked.\n' +
        'Mark the page as containing adult content in your creator settings, then run this again.',
    )
  }
}
