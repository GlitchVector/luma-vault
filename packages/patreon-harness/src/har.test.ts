import { describe, expect, it } from 'vitest'
import { maskPath, readHar } from './har.ts'
import { makeHar } from './testing.ts'

describe('maskPath', () => {
  it('masks the ids that differ between two runs', () => {
    expect(maskPath('/api/posts/141592653')).toBe('/api/posts/{id}')
    expect(maskPath('/api/media/8f14e45fceea167a5a36dedd4bea2543')).toBe('/api/media/{id}')
    expect(maskPath('/api/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/api/x/{id}')
  })

  it('leaves a version segment alone — it is not all digits', () => {
    expect(maskPath('/api/oauth2/v2/campaigns')).toBe('/api/oauth2/v2/campaigns')
  })
})

describe('readHar', () => {
  // A real HAR is thousands of entries of which a dozen are the protocol.
  // Dropping the rest is what makes the digest and the diff readable at all.
  it('drops assets and third parties, keeps the api calls', () => {
    const har = makeHar([
      { url: 'https://www.patreon.com/api/posts', method: 'POST' },
      { url: 'https://c10.patreonusercontent.com/img/x.png', mimeType: 'image/png' },
      { url: 'https://www.google-analytics.com/collect', method: 'POST' },
      { url: 'https://www.patreon.com/static/bundle.js' },
    ])
    expect(readHar(har, { host: 'patreon.com' }).map((request) => request.path)).toEqual(['/api/posts'])
  })

  it('keeps everything when asked, for when the filter ate the answer', () => {
    const har = makeHar([{ url: 'https://www.patreon.com/static/bundle.js' }])
    expect(readHar(har, { all: true })).toHaveLength(1)
  })

  it('parses the JSON bodies, which are the part that matters', () => {
    const har = makeHar([
      { url: 'https://www.patreon.com/api/posts', method: 'POST', request: { data: { type: 'post' } }, response: { data: { id: '1' } } },
    ])
    const [request] = readHar(har, { host: 'patreon.com' })
    expect(request?.requestBody?.json).toEqual({ data: { type: 'post' } })
    expect(request?.responseBody?.json).toEqual({ data: { id: '1' } })
  })

  it('keeps header names lowercase so lookups do not depend on the browser', () => {
    const har = makeHar([
      { url: 'https://www.patreon.com/api/posts', requestHeaders: { 'X-CSRF-Signature': 'abc' } },
    ])
    expect(readHar(har, { host: 'patreon.com' })[0]?.requestHeaders['x-csrf-signature']).toBe('abc')
  })
})

// Both of these were learned from a real capture rather than guessed, and both
// changed what `calls` reports — so they are pinned.
describe('what counts as protocol on patreon.com', () => {
  // The draft is created by *navigating* to the editor: GET /posts/new answers
  // 302 to /<page>/posts/<id>/edit, and there is no POST anywhere. Filtering
  // text/html as "not protocol" hid the create step completely.
  it('keeps document navigations, because that is where the create step is', () => {
    const har = makeHar([
      { url: 'https://www.patreon.com/posts/new', status: 302, mimeType: 'text/html' },
      { url: 'https://www.patreon.com/jebaz/posts/169146351/edit', mimeType: 'text/html' },
    ])
    expect(readHar(har, { host: 'patreon.com' }).map((request) => request.signature)).toEqual([
      'GET www.patreon.com/posts/new',
      'GET www.patreon.com/jebaz/posts/{id}/edit',
    ])
  })

  // 15 of the 23 non-GET calls in the first text-only capture were tracking
  // beacons. They are on patreon.com and they POST, so nothing else excludes them.
  it('drops tracking beacons, which are POSTs on patreon.com and still noise', () => {
    const har = makeHar([
      { url: 'https://www.patreon.com/api/tracking', method: 'POST' },
      { url: 'https://www.patreon.com/api/posts/169146351', method: 'PATCH' },
    ])
    expect(readHar(har, { host: 'patreon.com' }).map((request) => request.method)).toEqual(['PATCH'])
  })
})
