import { describe, expect, it } from 'vitest'
import { assertAdultMatchesCampaign, type Campaign } from './campaign.ts'
import type { ResolvedPost } from './manifest.ts'

const post = (adult: boolean): ResolvedPost => ({
  dir: '/set',
  manifestPath: '/set/post.json',
  title: 'Set',
  body: 'body',
  media: [],
  teaser: null,
  access: 'public',
  tiers: [],
  adult,
})

const campaign = (isNsfw: boolean): Campaign => ({ id: '16736888', name: 'jebaz', isNsfw })

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
