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

/**
 * One row of the campaign's access control.
 *
 * `public` is a rule like any other — not the absence of one — which is why the
 * post PATCH always carries an `access_rules` relationship even for a post
 * everybody can see. The `tier` rows are what a manifest's `tiers` names.
 */
export interface AccessRule {
  readonly id: string
  readonly type: 'public' | 'patrons' | 'non_member' | 'tier' | (string & {})
}

export interface Campaign {
  readonly id: string
  readonly name: string
  /** Whether the page as a whole is marked as adult. Every post inherits it. */
  readonly isNsfw: boolean
  /** Every access rule on the page, so "public" can be resolved rather than hardcoded. */
  readonly accessRules: readonly AccessRule[]
}

interface CampaignResponse {
  data?: { id?: string; attributes?: { name?: string; is_nsfw?: boolean } }
  included?: { type?: string; id?: string; attributes?: { access_rule_type?: string } }[]
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
  const accessRules: AccessRule[] = []
  for (const entry of result.json.included ?? []) {
    if (entry.type !== 'access-rule' || entry.id === undefined) continue
    accessRules.push({ id: entry.id, type: entry.attributes?.access_rule_type ?? 'unknown' })
  }

  return {
    id: result.json.data.id ?? campaignId,
    name: attributes.name ?? '(unnamed)',
    // Absent is not false. A response shape that changed under us must not read
    // as "this page is safe for work" — that is the direction that does damage.
    isNsfw: attributes.is_nsfw === true,
    accessRules,
  }
}

/**
 * The access-rule ids a post should carry, for the access a manifest asked for.
 *
 * Public is looked up rather than written down: the id is per-campaign, and a
 * constant here would be one account's number baked into a shared library.
 */
export function accessRulesFor(post: ResolvedPost, campaign: Campaign): string[] {
  if (post.access === 'public') {
    const rule = campaign.accessRules.find((each) => each.type === 'public')
    if (rule === undefined) {
      throw new Error(
        `campaign ${campaign.id} has no public access rule, so a public post cannot be expressed.\n` +
          `It has: ${campaign.accessRules.map((each) => `${each.type}=${each.id}`).join(', ') || '(none)'}`,
      )
    }
    return [rule.id]
  }

  const known = new Set(campaign.accessRules.map((each) => each.id))
  const missing = post.tiers.filter((id) => !known.has(id))
  if (missing.length > 0) {
    throw new Error(
      `${post.manifestPath}: tiers ${missing.join(', ')} are not access rules on campaign ${campaign.id}.\n` +
        'Run `pnpm patreon tiers` to list the ids this page actually has.',
    )
  }
  return [...post.tiers]
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
