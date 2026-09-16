import { describe, expect, it } from 'vitest'
import { readSet, setLink, writeSet } from './deepLink.ts'

/**
 * These pin the two things that make a deep link worth having: it survives a
 * run id with slashes in it, and it leaves every other parameter alone. The
 * second matters because the hash is already the lightbox's and the search
 * string is where anything else will end up.
 */

describe('readSet', () => {
  it('reads a run id, slashes and all', () => {
    expect(readSet('?set=shotall%2Fari%2F20260914T1730')).toBe('shotall/ari/20260914T1730')
    expect(readSet('?set=lora-audit-20260914t1400')).toBe('lora-audit-20260914t1400')
  })

  it('treats a missing or empty parameter as no set', () => {
    expect(readSet('')).toBeNull()
    expect(readSet('?other=1')).toBeNull()
    // `?set=` would otherwise select a set whose run is '' and show nothing
    expect(readSet('?set=')).toBeNull()
  })

  it('works with or without the leading question mark', () => {
    expect(readSet('set=abc')).toBe('abc')
  })
})

describe('writeSet', () => {
  it('adds, replaces and removes the parameter', () => {
    expect(writeSet('', 'abc')).toBe('?set=abc')
    expect(writeSet('?set=abc', 'def')).toBe('?set=def')
    expect(writeSet('?set=abc', null)).toBe('')
  })

  it('leaves other parameters alone', () => {
    expect(writeSet('?debug=1', 'abc')).toBe('?debug=1&set=abc')
    expect(writeSet('?debug=1&set=abc', null)).toBe('?debug=1')
  })

  it('round-trips a run id containing slashes', () => {
    const run = 'shotall/ari/20260914T1730'
    expect(readSet(writeSet('', run))).toBe(run)
  })
})

describe('setLink', () => {
  it('builds a link that can be pasted somewhere else', () => {
    expect(setLink('http://192.168.1.160', '/', 'lora-audit-20260914t1400')).toBe(
      'http://192.168.1.160/?set=lora-audit-20260914t1400',
    )
  })
})
