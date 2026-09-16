import { describe, expect, it } from 'vitest'
import { align, diffHars, diffValue, renderReport } from './diff.ts'
import { readHar } from './har.ts'
import { makeHar } from './testing.ts'

const API = 'https://www.patreon.com/api'

describe('align', () => {
  const of = (har: string) => readHar(har, { host: 'patreon.com' })

  // The whole reason alignment is LCS and not "match the nth to the nth": the
  // image capture has calls the text-only one never makes, and everything after
  // the insertion must still line up.
  it('lines two sequences up across an insertion', () => {
    const textOnly = of(makeHar([{ url: `${API}/posts`, method: 'POST' }, { url: `${API}/posts/9001`, method: 'PATCH' }]))
    const withImage = of(
      makeHar([
        { url: `${API}/posts`, method: 'POST' },
        { url: `${API}/media`, method: 'POST' },
        { url: `${API}/media/77`, method: 'GET' },
        { url: `${API}/posts/9002`, method: 'PATCH' },
      ]),
    )

    const { pairs, onlyInA, onlyInB } = align(textOnly, withImage)
    expect(pairs.map(([one]) => one.signature)).toEqual([
      'POST www.patreon.com/api/posts',
      'PATCH www.patreon.com/api/posts/{id}',
    ])
    expect(onlyInA).toEqual([])
    expect(onlyInB.map((request) => request.signature)).toEqual([
      'POST www.patreon.com/api/media',
      'GET www.patreon.com/api/media/{id}',
    ])
  })

  // Different runs carry different post ids. Unmasked, nothing would ever pair.
  it('pairs the same call across two runs despite different ids', () => {
    const one = of(makeHar([{ url: `${API}/posts/111222`, method: 'PATCH' }]))
    const two = of(makeHar([{ url: `${API}/posts/333444`, method: 'PATCH' }]))
    expect(align(one, two).pairs).toHaveLength(1)
  })
})

describe('diffValue', () => {
  it('finds an added field, however deep', () => {
    const changes = diffValue({ data: { attributes: { title: 'a' } } }, { data: { attributes: { title: 'a', 'is-nsfw': true } } }, '')
    expect(changes).toEqual([{ kind: 'added', path: 'data.attributes.is-nsfw', b: true, volatile: false }])
  })

  it('reports a changed field with both sides', () => {
    const changes = diffValue({ tier: 'public' }, { tier: 'patrons' }, '')
    expect(changes).toEqual([{ kind: 'changed', path: 'tier', a: 'public', b: 'patrons', volatile: false }])
  })

  // Attachment order is data, not presentation: an image set posted in the
  // wrong order is a wrong post. Keying by {type,id} is what makes a pure
  // reorder legible instead of showing up as six unrelated field changes.
  it('calls a pure reorder a reorder', () => {
    const before = { data: [{ type: 'media', id: '1' }, { type: 'media', id: '2' }] }
    const after = { data: [{ type: 'media', id: '2' }, { type: 'media', id: '1' }] }
    const changes = diffValue(before, after, '')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'reordered', path: 'data' })
  })

  it('tells membership changes apart from reordering', () => {
    const before = { data: [{ type: 'media', id: '1' }] }
    const after = { data: [{ type: 'media', id: '1' }, { type: 'media', id: '2' }] }
    const changes = diffValue(before, after, '')
    expect(changes).toEqual([{ kind: 'added', path: 'data[media:2]', b: { type: 'media', id: '2' }, volatile: false }])
  })

  it('marks per-run values volatile so they can be filtered out', () => {
    const changes = diffValue({ id: 'a1', createdAt: '2026-09-10T10:00:00Z' }, { id: 'b2', createdAt: '2026-09-10T11:00:00Z' }, '')
    expect(changes.every((change) => change.volatile)).toBe(true)
  })
})

describe('diffHars', () => {
  const adultOff = makeHar([
    { url: `${API}/posts/1`, method: 'PATCH', request: { data: { attributes: { title: 'x', 'is-nsfw': false } } } },
  ])
  const adultOn = makeHar([
    { url: `${API}/posts/2`, method: 'PATCH', request: { data: { attributes: { title: 'x', 'is-nsfw': true } } } },
  ])

  // This is the point of the whole matrix: two captures differing in one
  // checkbox, and the diff naming the field that checkbox writes.
  it('isolates the one field a single varied dimension changed', () => {
    const report = diffHars(adultOff, adultOn, { host: 'patreon.com', labelA: 'adult-off', labelB: 'adult-on' })
    expect(report.paired).toHaveLength(1)
    expect(report.paired[0]?.request).toEqual([
      { kind: 'changed', path: 'data.attributes.is-nsfw', a: false, b: true, volatile: false },
    ])
  })

  it('hides volatile churn by default and shows it on request', () => {
    const before = makeHar([{ url: `${API}/posts/1`, method: 'PATCH', request: { token: 'aaaaaaaaaaaaaaaaaaaaaa', keep: 1 } }])
    const after = makeHar([{ url: `${API}/posts/2`, method: 'PATCH', request: { token: 'bbbbbbbbbbbbbbbbbbbbbb', keep: 2 } }])
    expect(diffHars(before, after, { host: 'patreon.com' }).paired[0]?.request).toHaveLength(1)
    expect(diffHars(before, after, { host: 'patreon.com', includeVolatile: true }).paired[0]?.request).toHaveLength(2)
  })

  it('renders a report naming the calls the varied dimension introduced', () => {
    const rendered = renderReport(
      diffHars(makeHar([{ url: `${API}/posts`, method: 'POST' }]), makeHar([{ url: `${API}/posts`, method: 'POST' }, { url: `${API}/media`, method: 'POST' }]), {
        host: 'patreon.com',
        labelA: 'text-only',
        labelB: 'image-1',
      }),
    )
    expect(rendered).toContain('# text-only -> image-1')
    expect(rendered).toContain('POST www.patreon.com/api/media')
  })
})
