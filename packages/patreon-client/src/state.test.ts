import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResolvedMedia, ResolvedPost } from './manifest.ts'
import { emptyState, isCurrent, loadState, pruneState, saveState, statePath } from './state.ts'

async function set(): Promise<ResolvedPost> {
  const dir = await mkdtemp(join(tmpdir(), 'patreon-state-'))
  return {
    dir,
    manifestPath: join(dir, 'post.json'),
    title: 'Set',
    body: '',
    media: [],
    teaser: null,
    access: 'public',
    tiers: [],
    adult: true,
  }
}

const media = (name: string, bytes: number, modifiedMs: number): ResolvedMedia => ({
  name,
  path: `/set/${name}`,
  bytes,
  modifiedMs,
  kind: 'image',
})

describe('state', () => {
  it('round-trips', async () => {
    const post = await set()
    await saveState(post, {
      ...emptyState(),
      postId: 'p1',
      media: { '01.png': { id: 'm1', phase: 'ready', bytes: 10, modifiedMs: 20 } },
    })
    const back = await loadState(post)
    expect(back.postId).toBe('p1')
    expect(back.media['01.png']?.id).toBe('m1')
  })

  // The state file is a cache of remote facts. Losing it costs an upload;
  // trusting a corrupt one costs a wrong post. So it fails open, to "start over".
  it('treats a corrupt or foreign state file as no state at all', async () => {
    const post = await set()
    await writeFile(statePath(post), '{ this is not json')
    expect((await loadState(post)).postId).toBeUndefined()

    await writeFile(statePath(post), JSON.stringify({ version: 99, media: {} }))
    expect((await loadState(post)).media).toEqual({})
  })

  it('leaves no half-written file behind', async () => {
    const post = await set()
    await saveState(post, emptyState())
    expect(JSON.parse(await readFile(statePath(post), 'utf8')).version).toBe(1)
  })

  it('accepts a recorded upload only when size and mtime both still match', () => {
    const recorded = { id: 'm1', phase: 'ready' as const, bytes: 10, modifiedMs: 20 }
    expect(isCurrent(recorded, media('01.png', 10, 20))).toBe(true)
    expect(isCurrent(recorded, media('01.png', 10, 21))).toBe(false)
    expect(isCurrent(recorded, media('01.png', 11, 20))).toBe(false)
    expect(isCurrent(undefined, media('01.png', 10, 20))).toBe(false)
  })

  it('forgets media the manifest no longer lists', async () => {
    const post = { ...(await set()), media: [media('01.png', 10, 20)] }
    const pruned = pruneState(
      {
        ...emptyState(),
        media: {
          '01.png': { id: 'm1', phase: 'ready', bytes: 10, modifiedMs: 20 },
          'dropped.png': { id: 'm2', phase: 'ready', bytes: 10, modifiedMs: 20 },
        },
      },
      post,
    )
    expect(Object.keys(pruned.media)).toEqual(['01.png'])
  })
})
