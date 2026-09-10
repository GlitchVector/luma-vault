import { describe, expect, it } from 'vitest'
import { generateEndpoints, inferType } from './generate.ts'
import { readHar } from './har.ts'
import { makeHar } from './testing.ts'

const requests = readHar(
  makeHar([
    { url: 'https://www.patreon.com/api/posts', method: 'POST' },
    { url: 'https://www.patreon.com/api/posts/141592653', method: 'PATCH' },
  ]),
  { host: 'patreon.com' },
)

describe('generateEndpoints', () => {
  it('writes the masked path, so the constant is a template and not one draft', () => {
    const { source } = generateEndpoints({
      mapping: { POST_UPDATE: 'PATCH www.patreon.com/api/posts/{id}' },
      requests,
      source: 'text-only.har',
    })
    expect(source).toContain("path: \"/api/posts/{id}\"")
    expect(source).toContain('CAPTURED_FROM: string | null = "text-only.har"')
  })

  // Everything not in the mapping stays null, and null is what makes the client
  // throw NotCapturedError instead of sending a guess at a live account.
  it('leaves unmapped endpoints null rather than inventing them', () => {
    const { source } = generateEndpoints({ mapping: {}, requests, source: 'text-only.har' })
    expect(source).toContain('export const MEDIA_CREATE: Endpoint | null = null')
    expect(source).toContain('export const POST_CREATE: Endpoint | null = null')
  })

  it('complains when a mapping names a call the capture does not contain', () => {
    const { problems } = generateEndpoints({
      mapping: { MEDIA_CREATE: 'POST www.patreon.com/api/media' },
      requests,
      source: 'text-only.har',
    })
    expect(problems.join('\n')).toMatch(/no request in the capture matches/)
  })

  it('complains about a constant the client does not declare', () => {
    const { problems } = generateEndpoints({ mapping: { POST_PUBLISH: 'x' }, requests, source: 'a.har' })
    expect(problems.join('\n')).toMatch(/not an endpoint the client declares/)
  })
})

describe('inferType', () => {
  // One sample is a trap: the field that is null in the text-only capture and an
  // object in the image one would be typed `null` from the first alone.
  it('unions across samples instead of trusting the first', () => {
    expect(inferType([{ media: null }, { media: { id: '1' } }])).toBe('{\n  media: null | {\n    id: string\n  }\n}')
  })

  it('marks a key missing from some samples optional', () => {
    expect(inferType([{ a: 1 }, { a: 1, b: 2 }])).toContain('b?: number')
  })

  it('quotes property names that are not identifiers', () => {
    expect(inferType([{ 'is-nsfw': true }])).toContain('"is-nsfw": boolean')
  })

  it('gives an empty capture unknown, not any', () => {
    expect(inferType([])).toBe('unknown')
  })
})
