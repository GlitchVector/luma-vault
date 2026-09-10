import { describe, expect, it } from 'vitest'
import type { ResolvedMedia, ResolvedPost } from './manifest.ts'
import { planRun } from './plan.ts'
import { emptyState, type MediaState, type RunState } from './state.ts'

function file(name: string, bytes = 1_000_000, modifiedMs = 1000): ResolvedMedia {
  return { name, path: `/set/${name}`, bytes, modifiedMs, kind: name.endsWith('.mp4') ? 'video' : 'image' }
}

function post(media: ResolvedMedia[]): ResolvedPost {
  return {
    dir: '/set',
    manifestPath: '/set/post.json',
    title: 'Set',
    body: 'body',
    media,
    teaser: null,
    access: 'public',
    tiers: [],
    adult: true,
  }
}

function state(media: Record<string, MediaState>, postId?: string): RunState {
  return { ...emptyState(), postId, media }
}

const kinds = (steps: readonly { kind: string }[]) => steps.map((step) => step.kind)

describe('planRun', () => {
  it('plans a cold run from nothing', () => {
    const plan = planRun(post([file('01.png')]), emptyState())
    expect(kinds(plan.steps)).toEqual([
      'create-draft',
      'create-media',
      'upload-media',
      'await-media',
      'attach-and-configure',
    ])
    expect(plan.bytesToUpload).toBe(1_000_000)
  })

  // The whole point of .state.json: a dead run at 90% of a big video must not
  // start the video again.
  it('reuses media a previous run already got ready', () => {
    const clip = file('clip.mp4', 400_000_000, 5000)
    const plan = planRun(
      post([clip]),
      state({ 'clip.mp4': { id: 'm1', phase: 'ready', bytes: 400_000_000, modifiedMs: 5000 } }, 'p1'),
    )
    expect(kinds(plan.steps)).toEqual(['reuse-draft', 'reuse-media', 'attach-and-configure'])
    expect(plan.bytesToUpload).toBe(0)
    expect(plan.bytesReused).toBe(400_000_000)
  })

  // Uploaded is not usable. Resuming at 'uploaded' must still wait for the
  // transcode, or the draft gets a broken attachment and says nothing.
  it('still waits when the bytes landed but the transcode was not confirmed', () => {
    const clip = file('clip.mp4', 400_000_000, 5000)
    const plan = planRun(
      post([clip]),
      state({ 'clip.mp4': { id: 'm1', phase: 'uploaded', bytes: 400_000_000, modifiedMs: 5000 } }),
    )
    expect(kinds(plan.steps)).toEqual(['create-draft', 'await-media', 'attach-and-configure'])
    expect(plan.bytesToUpload).toBe(0)
  })

  it('re-uploads a file that changed on disk, same name and all', () => {
    const plan = planRun(
      post([file('01.png', 1_000_000, 9999)]),
      state({ '01.png': { id: 'm1', phase: 'ready', bytes: 1_000_000, modifiedMs: 1000 } }),
    )
    expect(kinds(plan.steps)).toContain('create-media')
    expect(plan.bytesReused).toBe(0)
  })

  it('re-creates a media record whose upload never finished', () => {
    const plan = planRun(
      post([file('01.png')]),
      state({ '01.png': { id: 'm1', phase: 'created', bytes: 1_000_000, modifiedMs: 1000 } }),
    )
    expect(kinds(plan.steps)).toEqual([
      'create-draft',
      'create-media',
      'upload-media',
      'await-media',
      'attach-and-configure',
    ])
  })

  it('keeps manifest order, because attachment order is the set order', () => {
    const plan = planRun(post([file('01.png'), file('02.png'), file('clip.mp4')]), emptyState())
    const uploads = plan.steps.filter((step) => step.kind === 'upload-media')
    expect(uploads.map((step) => (step.kind === 'upload-media' ? step.file.name : ''))).toEqual([
      '01.png',
      '02.png',
      'clip.mp4',
    ])
  })
})
