import { describe, expect, it } from 'vitest'
import { isPausedStatus } from './gpu.ts'

describe('isPausedStatus', () => {
  it('is paused only when every trainer process is stopped', () => {
    expect(isPausedStatus('  71808  stopped    python sdxl_train_network.py\n  25040  stopped    python worker\n')).toBe(true)
    expect(isPausedStatus('  71808  stopped    python sdxl_train_network.py\n  25040  running    python worker\n')).toBe(false)
  })

  it('reads nothing as not paused', () => {
    expect(isPausedStatus('')).toBe(false)
    expect(isPausedStatus('no kohya training is running\n')).toBe(false)
  })
})
