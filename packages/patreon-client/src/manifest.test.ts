import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManifestError } from './errors.ts'
import { loadManifest } from './manifest.ts'

async function set(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'patreon-set-'))
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content)))
  return dir
}

const valid = {
  title: 'Set 042',
  body: 'hello',
  media: ['01.png'],
  access: 'tier',
  tiers: ['12345'],
  adult: true,
}

async function problemsOf(manifest: unknown, extra: Record<string, string> = {}): Promise<string[]> {
  const dir = await set({ 'post.json': JSON.stringify(manifest), '01.png': 'x', ...extra })
  try {
    await loadManifest(dir)
    return []
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error
    return [...error.problems]
  }
}

describe('loadManifest', () => {
  it('resolves media against the set directory', async () => {
    const dir = await set({ 'post.json': JSON.stringify(valid), '01.png': 'x' })
    const post = await loadManifest(dir)
    expect(post.media).toHaveLength(1)
    expect(post.media[0]?.name).toBe('01.png')
    expect(post.media[0]?.kind).toBe('image')
    expect(post.media[0]?.bytes).toBe(1)
    expect(post.tiers).toEqual(['12345'])
  })

  // The one rule in the schema that is a safety property rather than a
  // convenience: an NSFW set whose flag defaulted to false is an account
  // problem, so undefined must not parse.
  it('rejects a missing adult flag rather than defaulting it', async () => {
    const { adult: _adult, ...withoutFlag } = valid
    const problems = await problemsOf(withoutFlag)
    expect(problems.join('\n')).toMatch(/adult/)
  })

  it('accepts adult: false — the flag has to be stated, not true', async () => {
    const dir = await set({ 'post.json': JSON.stringify({ ...valid, adult: false }), '01.png': 'x' })
    expect((await loadManifest(dir)).adult).toBe(false)
  })

  it('reads the body from a markdown file when body names one', async () => {
    const dir = await set({
      'post.json': JSON.stringify({ ...valid, body: 'notes.md' }),
      '01.png': 'x',
      'notes.md': '# Set 042\n\nlong body',
    })
    expect((await loadManifest(dir)).body).toContain('long body')
  })

  it('reports every problem at once, not the first one', async () => {
    const problems = await problemsOf({ ...valid, media: ['01.png', 'missing.png', 'notes.txt'], teaser: 'nope.png' })
    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toMatch(/missing\.png/)
    expect(problems.join('\n')).toMatch(/notes\.txt/)
    expect(problems.join('\n')).toMatch(/nope\.png/)
  })

  it('refuses a tier-locked post with no tiers', async () => {
    expect((await problemsOf({ ...valid, tiers: [] })).join('\n')).toMatch(/lock the post to nobody/)
  })

  it('refuses a public post that also lists tiers', async () => {
    expect((await problemsOf({ ...valid, access: 'public' })).join('\n')).toMatch(/one of the two is a mistake/)
  })

  it('refuses a media path that escapes the set', async () => {
    expect((await problemsOf({ ...valid, media: ['../../secrets.png'] })).join('\n')).toMatch(/plain file name/)
  })

  it('refuses a video as the teaser', async () => {
    const problems = await problemsOf({ ...valid, media: ['01.png', 'clip.mp4'], teaser: 'clip.mp4' }, {
      'clip.mp4': 'x',
    })
    expect(problems.join('\n')).toMatch(/still shown to non-patrons/)
  })

  it('says so plainly when there is no post.json', async () => {
    const dir = await set({})
    await expect(loadManifest(dir)).rejects.toThrow(/no post\.json here/)
  })
})
