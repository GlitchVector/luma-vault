import { describe, expect, it } from 'vitest'
import { accessRulesFor, assertAdultMatchesCampaign, type Campaign } from './campaign.ts'
import type { ResolvedPost } from './manifest.ts'

const post = (adult: boolean): ResolvedPost => ({
  dir: '/set',
  manifestPath: '/set/post.json',
  title: 'Set',
  body: 'body',
  media: [],
  preview: null,
  access: 'public',
  tiers: [],
  adult,
})

const campaign = (isNsfw: boolean, accessRules: Campaign['accessRules'] = []): Campaign => ({
  id: '16736888',
  name: 'jebaz',
  isNsfw,
  accessRules,
})

const RULES = [
  { id: '68432072', type: 'public' as const },
  { id: '68475917', type: 'tier' as const },
]

describe('accessRulesFor', () => {
  // Public is a rule with an id, not the absence of one, and the id is
  // per-campaign — so it is looked up rather than written into the library.
  it('resolves public to the campaign own public rule', () => {
    expect(accessRulesFor(post(false), campaign(true, RULES))).toEqual(['68432072'])
  })

  it('passes tier ids through once it has checked they exist', () => {
    const locked = { ...post(true), access: 'tier' as const, tiers: ['68475917'] }
    expect(accessRulesFor(locked, campaign(true, RULES))).toEqual(['68475917'])
  })

  // A tier id from another campaign, or a stale one, would otherwise produce a
  // post locked to a rule this page does not have.
  it('refuses a tier id the campaign does not have, and says how to list them', () => {
    const locked = { ...post(true), access: 'tier' as const, tiers: ['99999'] }
    expect(() => accessRulesFor(locked, campaign(true, RULES))).toThrow(/patreon tiers/)
  })

  it('refuses a public post when the campaign has no public rule', () => {
    expect(() => accessRulesFor(post(false), campaign(true, [RULES[1]!]))).toThrow(/no public access rule/)
  })
})

describe('assertAdultMatchesCampaign', () => {
  // Patreon has no per-post adult flag, so `adult: true` cannot be sent — it can
  // only be checked. This is the check, and it guards the one mistake here that
  // cannot be taken back.
  it('refuses an adult set aimed at a page that is not marked adult', () => {
    expect(() => assertAdultMatchesCampaign(post(true), campaign(false))).toThrow(/not marked as adult/)
  })

  it('says why, and what to do about it', () => {
    expect(() => assertAdultMatchesCampaign(post(true), campaign(false))).toThrow(
      /no per-post adult flag[\s\S]*creator settings/,
    )
  })

  it('allows an adult set on a page marked adult', () => {
    expect(() => assertAdultMatchesCampaign(post(true), campaign(true))).not.toThrow()
  })

  // The other direction is normal: a page is marked for what it mostly carries,
  // not per post, so a tame set on an adult page is not a mismatch to report.
  it('says nothing about a tame set on an adult page', () => {
    expect(() => assertAdultMatchesCampaign(post(false), campaign(true))).not.toThrow()
  })

  it('is quiet when neither is adult', () => {
    expect(() => assertAdultMatchesCampaign(post(false), campaign(false))).not.toThrow()
  })
})
