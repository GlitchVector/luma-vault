import { describe, expect, it } from 'vitest'
import { findSecrets, scrubHar } from './scrub.ts'
import { makeHar } from './testing.ts'

const har = () =>
  makeHar([
    {
      url: 'https://www.patreon.com/api/posts',
      method: 'POST',
      requestHeaders: { Cookie: 'session_id=REALSESSION; other=1', 'X-CSRF-Signature': 'REALTOKEN', accept: 'application/json' },
      cookies: { session_id: 'REALSESSION' },
      responseHeaders: { 'Set-Cookie': 'session_id=ROTATED; Path=/' },
      request: { data: { attributes: { title: 'x' } } },
    },
    {
      url: 'https://uploads.example.com/bucket/obj?X-Amz-Signature=DEADBEEF&X-Amz-Credential=AKIA%2Fx&partNumber=3',
      method: 'PUT',
    },
  ])

describe('scrubHar', () => {
  // A HAR of a logged-in session *is* the session. This is the test that stands
  // between a capture and an account.
  it('takes the cookies out of both the headers and the parallel cookies array', () => {
    const { har: clean } = scrubHar(har())
    const text = JSON.stringify(clean)
    expect(text).not.toContain('REALSESSION')
    expect(text).not.toContain('ROTATED')
    expect(text).not.toContain('REALTOKEN')
  })

  it('redacts rather than deletes, so the capture still shows which headers existed', () => {
    const text = JSON.stringify(scrubHar(har()).har).toLowerCase()
    expect(text).toContain('x-csrf-signature')
    expect(text).toContain('cookie')
    expect(text).toContain('[scrubbed]')
  })

  // The presigned URL is the one people miss: it is not on patreon.com, and its
  // signature is a bearer token for somebody's bucket.
  it('strips the signature out of a presigned upload URL and keeps the rest', () => {
    const text = JSON.stringify(scrubHar(har()).har)
    expect(text).not.toContain('DEADBEEF')
    expect(text).toContain('partNumber=3')
  })

  it('leaves the payloads alone — they are the thing being captured', () => {
    const text = JSON.stringify(scrubHar(har()).har)
    expect(text).toContain('title')
  })

  it('counts what it took out', () => {
    expect(scrubHar(har()).redactions).toBeGreaterThan(3)
  })
})

describe('findSecrets', () => {
  it('names what is still in there, and where', () => {
    const found = findSecrets(har())
    expect(found.join('\n')).toMatch(/entry 0: request header Cookie/)
    expect(found.join('\n')).toMatch(/entry 1: signed query string/)
  })

  it('is quiet once the file has been through the scrubber', () => {
    expect(findSecrets(scrubHar(har()).har)).toEqual([])
  })
})

// Found by running the thing: the media-create response hands back the
// presigned upload target, so the signature that matters most is a *value in a
// body*, not a request URL. Scrubbing request URLs alone left it in place.
describe('signed URLs inside bodies', () => {
  const withTarget = () =>
    makeHar([
      {
        url: 'https://www.patreon.com/api/media',
        method: 'POST',
        response: {
          data: { attributes: { 'upload-url': 'https://uploads.example.com/b/o?X-Amz-Signature=DEADBEEF&key=u/01.png' } },
        },
      },
    ])

  it('scrubs a presigned URL carried in a response body', () => {
    expect(JSON.stringify(scrubHar(withTarget()).har)).not.toContain('DEADBEEF')
  })

  it('keeps the rest of the target, which is the part being captured', () => {
    expect(JSON.stringify(scrubHar(withTarget()).har)).toContain('upload-url')
  })

  it('is caught by the gate too, not only by the scrubber', () => {
    expect(findSecrets(withTarget()).join('\n')).toMatch(/signed URL in the response body/)
    expect(findSecrets(scrubHar(withTarget()).har)).toEqual([])
  })
})
