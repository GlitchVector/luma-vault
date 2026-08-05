import { describe, expect, it } from 'vitest'
import { excerpt, highlight, searchTerms } from './highlight.ts'

describe('highlight', () => {
  it('splits text into plain and matching parts', () => {
    expect(highlight('moona hoshinova', ['moona'])).toEqual([
      { text: 'moona', match: true },
      { text: ' hoshinova', match: false },
    ])
  })

  it('matches regardless of case', () => {
    expect(highlight('Moona Hoshinova', ['moona'])).toEqual([
      { text: 'Moona', match: true },
      { text: ' Hoshinova', match: false },
    ])
  })

  it('treats terms literally, not as patterns', () => {
    // Straight from a prompt. Compiled as a regex this is an unterminated
    // group and throws, taking the whole overlay down with it.
    const parts = highlight('a (wide hips:1.3) pose', ['(wide'])
    expect(parts.some((part) => part.match && part.text === '(wide')).toBe(true)
  })

  it('prefers the longer term where two overlap', () => {
    const parts = highlight('hoshinova', ['hos', 'hoshinova'])
    expect(parts).toEqual([{ text: 'hoshinova', match: true }])
  })

  it('finds every occurrence, not just the first', () => {
    const parts = highlight('girl, 1girl, 2girls', ['girl'])
    expect(parts.filter((part) => part.match)).toHaveLength(3)
  })

  it('returns the text unchanged when nothing is searched for', () => {
    expect(highlight('anything', [])).toEqual([{ text: 'anything', match: false }])
    expect(highlight('anything', ['  '])).toEqual([{ text: 'anything', match: false }])
  })
})

describe('excerpt', () => {
  // A prompt in this library runs to 200 tags. The match is often 300
  // characters in, so an excerpt from the front shows nothing relevant.
  const long = 'a, '.repeat(80) + 'moona hoshinova' + ', b'.repeat(80)

  it('centres on the match rather than starting at the beginning', () => {
    const text = excerpt(long, ['hoshinova'], 30)
    expect(text).toContain('hoshinova')
    expect(text.startsWith('…')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
  })

  it('falls back to the head when nothing matches', () => {
    // A result matched on its filename has no match in its prompt at all.
    expect(excerpt('a short prompt', ['nothing'])).toBe('a short prompt')
  })

  it('collapses the whitespace a multi-line prompt carries', () => {
    expect(excerpt('a\n\nb   c', ['b'])).toBe('a b c')
  })

  it('does not mark a short prompt as truncated', () => {
    const text = excerpt('moona hoshinova', ['moona'], 60)
    expect(text).toBe('moona hoshinova')
  })
})

describe('searchTerms', () => {
  it('splits on whitespace and drops the gaps', () => {
    expect(searchTerms('  moona   hoshinova ')).toEqual(['moona', 'hoshinova'])
    expect(searchTerms('   ')).toEqual([])
  })
})
