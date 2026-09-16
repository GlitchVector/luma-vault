import { describe, expect, it } from 'vitest'
import { cookieTransport } from './transport.ts'

describe('cookieTransport', () => {
  // The probe passed without pretending to be Chrome. Spoofing a UA would not
  // change a TLS fingerprint anyway, and would make a future failure harder to
  // read — so the transport must not quietly start doing it.
  it('sends the cookie jar and does not spoof a browser', async () => {
    let seen: { headers: Record<string, string>; method: string } | null = null
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = { headers: init.headers as Record<string, string>, method: init.method as string }
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch

    try {
      await cookieTransport('session_id=abc').send({
        url: 'https://www.patreon.com/api/current_user',
        method: 'GET',
        headers: { accept: 'application/json' },
        bodyText: null,
      })
    } finally {
      globalThis.fetch = original
    }

    expect(seen!.headers['cookie']).toBe('session_id=abc')
    expect(Object.keys(seen!.headers).map((key) => key.toLowerCase())).not.toContain('user-agent')
  })

  // The create step reads the 302's Location rather than following it.
  it('can be told not to follow a redirect', async () => {
    let redirect: string | undefined
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      redirect = init.redirect
      return new Response('', { status: 302, headers: { location: '/jebaz/posts/123/edit' } })
    }) as typeof fetch

    try {
      const result = await cookieTransport('a=b').send({
        url: 'https://www.patreon.com/posts/new',
        method: 'GET',
        headers: {},
        bodyText: null,
        manualRedirect: true,
      })
      expect(result.status).toBe(302)
      expect(result.headers['location']).toBe('/jebaz/posts/123/edit')
    } finally {
      globalThis.fetch = original
    }
    expect(redirect).toBe('manual')
  })
})
