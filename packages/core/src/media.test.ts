import { describe, expect, it } from 'vitest'
import {
  basenameOf,
  extensionOf,
  fitWithin,
  formatBytes,
  formatDuration,
  isAnimatedImage,
  kindOf,
} from './media.ts'

describe('extensionOf / basenameOf', () => {
  it('reads posix and windows paths alike', () => {
    expect(extensionOf('/a/b/c.JPG')).toBe('jpg')
    expect(extensionOf('C:\\a\\b\\c.MP4')).toBe('mp4')
    expect(basenameOf('/a/b/c.jpg')).toBe('c.jpg')
    expect(basenameOf('C:\\a\\b\\c.jpg')).toBe('c.jpg')
  })

  it('treats a dotfile as having no extension', () => {
    expect(extensionOf('/a/.hidden')).toBe('')
    expect(extensionOf('/a/no-extension')).toBe('')
  })
})

describe('kindOf', () => {
  it('classifies images and videos, and ignores everything else', () => {
    expect(kindOf('/x/a.png')).toBe('image')
    expect(kindOf('/x/a.gif')).toBe('image')
    expect(kindOf('/x/a.mkv')).toBe('video')
    expect(kindOf('/x/a.mov')).toBe('video')
    expect(kindOf('/x/a.txt')).toBeNull()
    expect(kindOf('/x/a.nfo')).toBeNull()
    expect(kindOf('/x/README')).toBeNull()
  })
})

describe('isAnimatedImage', () => {
  it('flags the formats whose animation a still thumbnail would destroy', () => {
    expect(isAnimatedImage('/x/a.gif')).toBe(true)
    expect(isAnimatedImage('/x/a.webp')).toBe(true)
    expect(isAnimatedImage('/x/a.jpg')).toBe(false)
  })
})

describe('fitWithin', () => {
  it('never scales an already-small image up', () => {
    expect(fitWithin(100, 80, 320)).toEqual({ width: 100, height: 80 })
  })

  it('fits a landscape image by its width', () => {
    expect(fitWithin(1600, 900, 320)).toEqual({ width: 320, height: 180 })
  })

  it('fits a portrait image by its height', () => {
    expect(fitWithin(900, 1600, 320)).toEqual({ width: 180, height: 320 })
  })

  it('returns whole pixels, so tiles cannot leave subpixel seams', () => {
    const { width, height } = fitWithin(1023, 767, 320)
    expect(Number.isInteger(width)).toBe(true)
    expect(Number.isInteger(height)).toBe(true)
  })

  it('degrades to a square for a degenerate size rather than dividing by zero', () => {
    expect(fitWithin(0, 0, 320)).toEqual({ width: 320, height: 320 })
  })
})

describe('formatBytes / formatDuration', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(-1)).toBe('—')
  })

  it('formats durations, omitting an empty hour segment', () => {
    expect(formatDuration(59)).toBe('0:59')
    expect(formatDuration(247)).toBe('4:07')
    expect(formatDuration(3792)).toBe('1:03:12')
    expect(formatDuration(null)).toBe('—')
  })
})
