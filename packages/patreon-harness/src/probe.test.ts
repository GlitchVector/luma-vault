import { describe, expect, it } from 'vitest'
import { readProbe } from './probe.ts'

describe('readProbe', () => {
  // The whole point: a Cloudflare challenge is an HTML page, not a JSON error.
  it('recognises a challenge', () => {
    const result = readProbe(403, 'cloudflare', '<!DOCTYPE html><title>Just a moment...</title>')
    expect(result.challenged).toBe(true)
    expect(result.looksLikeJson).toBe(false)
  })

  it('recognises a real answer', () => {
    const result = readProbe(200, 'cloudflare', '{"data":{"type":"user","id":"1"}}')
    expect(result.challenged).toBe(false)
    expect(result.looksLikeJson).toBe(true)
  })

  // An expired session says nothing about fingerprinting, and must not be read
  // as "Chrome is required" — that would keep a whole architecture on a
  // misreading.
  it('does not call an expired session a challenge', () => {
    expect(readProbe(401, 'cloudflare', '{"errors":[{"code":1}]}').challenged).toBe(false)
  })

  it('catches a challenge served with a 200', () => {
    expect(readProbe(200, 'cloudflare', '<html>Please enable JavaScript to continue</html>').challenged).toBe(true)
  })
})
