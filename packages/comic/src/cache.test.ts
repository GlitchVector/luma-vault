import { describe, expect, it } from 'vitest'
import { canonical, requestHash, type RenderRequest } from './cache.ts'

const request: RenderRequest = {
  prompt: 'p',
  negative: 'n',
  seed: 8812,
  width: 832,
  height: 1216,
  steps: 28,
  cfg: 5,
  sampler: 'Euler a',
  scheduler: 'Automatic',
  checkpoint: 'delburry75.safetensors',
  backend: 'forge',
}

describe('the render cache key', () => {
  it('does not depend on key order or on undefined fields', () => {
    const reordered = { ...Object.fromEntries(Object.entries(request).reverse()), clip_skip: undefined } as RenderRequest
    expect(canonical(reordered)).toBe(canonical(request))
    expect(requestHash(reordered)).toBe(requestHash(request))
  })

  it('changes with anything that changes the picture', () => {
    const base = requestHash(request)
    expect(requestHash({ ...request, seed: 8813 })).not.toBe(base)
    expect(requestHash({ ...request, steps: 30 })).not.toBe(base)
    expect(requestHash({ ...request, prompt: 'p2' })).not.toBe(base)
    expect(requestHash({ ...request, checkpoint: 'nova' })).not.toBe(base)
    expect(requestHash({ ...request, clip_skip: 2 })).not.toBe(base)
  })

  it('is stable across runs', () => {
    expect(requestHash(request)).toBe(requestHash({ ...request }))
    expect(requestHash(request)).toMatch(/^[0-9a-f]{16}$/)
  })
})
