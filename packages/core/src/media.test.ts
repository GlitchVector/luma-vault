import { describe, expect, it } from 'vitest'
import {
  basenameOf,
  ancestorsOf,
  dirnameOf,
  toParameterBlock,
  displayPath,
  folderMatch,
  extensionOf,
  hasRecycleBin,
  fitInside,
  fitWithin,
  formatBytes,
  formatDuration,
  isAnimatedImage,
  isFourK,
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

describe('isFourK', () => {
  it('counts UHD and anything larger', () => {
    expect(isFourK(3840, 2160)).toBe(true)
    expect(isFourK(4096, 2160)).toBe(true)
    expect(isFourK(6000, 4000)).toBe(true)
    expect(isFourK(3839, 2160)).toBe(false)
  })

  it('measures the longest edge, not the width', () => {
    // A library is not all landscape, and a portrait shot is the same picture
    // turned ninety degrees. Keying on width would badge one and not the other.
    expect(isFourK(2160, 3840)).toBe(true)
    expect(isFourK(3840, 2160)).toBe(isFourK(2160, 3840))
  })

  it('is not an area test', () => {
    // 9MP, and still unable to fill a 4K display.
    expect(isFourK(3000, 3000)).toBe(false)
  })

  it('says no for a row the scanner has not measured', () => {
    expect(isFourK(0, 0)).toBe(false)
  })
})

describe('fitInside', () => {
  it('fits by whichever axis runs out first', () => {
    // Landscape in a landscape window: width binds.
    expect(fitInside(4000, 3000, 1000, 800)).toEqual({ width: 1000, height: 750 })
    // Portrait in the same window: height binds.
    expect(fitInside(3000, 4000, 1000, 800)).toEqual({ width: 600, height: 800 })
  })

  it('never scales a small picture up to fill the window', () => {
    // The lightbox has always shown a 200px image at 200px. Blowing it up shows
    // its pixels and says nothing the original did not.
    expect(fitInside(200, 150, 1000, 800)).toEqual({ width: 200, height: 150 })
  })

  it('gives the poster and the original the same box', () => {
    // The whole point: the thumbnail is painted into this rectangle and the
    // original lands in it, so the swap changes sharpness and nothing else. A
    // thumbnail is a different size but the same shape, so both must agree.
    const original = fitInside(4000, 3000, 1000, 800)
    const thumbnail = fitInside(512, 384, 1000, 800)
    expect(original.width / original.height).toBeCloseTo(thumbnail.width / thumbnail.height, 5)
  })

  it('returns nothing for a size the scanner has not measured yet', () => {
    // Zero is what an unmeasured row carries, and the caller falls back to
    // letting the image size itself rather than drawing a collapsed box.
    expect(fitInside(0, 0, 1000, 800)).toEqual({ width: 0, height: 0 })
    expect(fitInside(4000, 3000, 0, 0)).toEqual({ width: 0, height: 0 })
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

describe('displayPath', () => {
  // Backslash-heavy, so these use String.raw: writing `\\\\?\\UNC\\` by hand is
  // how the escaping goes wrong, and a path test that tests the wrong string
  // passes for the wrong reason.
  it('strips the extended-length prefix a canonicalized path carries', () => {
    // What the index actually stores for this library: a UNC share reached
    // through the long-path prefix. Shown raw it is unreadable, and it is not
    // a path anyone could paste into Explorer either.
    expect(displayPath(String.raw`\\?\UNC\jebpot\devs\AI\a.png`)).toBe(
      String.raw`\\jebpot\devs\AI\a.png`,
    )
    expect(displayPath(String.raw`\\?\C:\vault\a.png`)).toBe(String.raw`C:\vault\a.png`)
  })

  it('leaves ordinary paths exactly as they are', () => {
    expect(displayPath(String.raw`C:\vault\a.png`)).toBe(String.raw`C:\vault\a.png`)
    expect(displayPath('/Volumes/vault/a.png')).toBe('/Volumes/vault/a.png')
    expect(displayPath('')).toBe('')
  })
})

describe('dirnameOf', () => {
  it('splits a path so the filename can be shown whole', () => {
    // The lightbox truncates the folder and never the name, so these two have
    // to partition the path between them with nothing lost.
    expect(dirnameOf('/Volumes/vault/pics/a.png')).toBe('/Volumes/vault/pics')
    expect(dirnameOf(String.raw`C:\vault\pics\a.png`)).toBe(String.raw`C:\vault\pics`)
    expect(basenameOf(String.raw`C:\vault\pics\a.png`)).toBe('a.png')
  })

  it('has no folder for a bare filename or a root-level file', () => {
    expect(dirnameOf('a.png')).toBe('')
    expect(dirnameOf('/a.png')).toBe('')
  })
})

describe('hasRecycleBin', () => {
  it('says no for a share, in either spelling', () => {
    // Every path in this library is one of these, so the delete confirmation
    // has to say "permanently" rather than offering the bin as a safety net.
    expect(hasRecycleBin(String.raw`\\?\UNC\jebpot\devs\AI\a.jpg`)).toBe(false)
    expect(hasRecycleBin(String.raw`\\jebpot\devs\AI\a.jpg`)).toBe(false)
  })

  it('says yes for a local disk despite the same leading backslashes', () => {
    expect(hasRecycleBin(String.raw`\\?\D:\vault\a.mp4`)).toBe(true)
    expect(hasRecycleBin(String.raw`D:\vault\a.mp4`)).toBe(true)
    expect(hasRecycleBin('/Volumes/vault/a.mp4')).toBe(true)
  })
})

describe('toParameterBlock', () => {
  it('rebuilds the block Forge writes and its paste button parses', () => {
    // Byte-for-byte the shape A1111 produces: prompt, then the negative on its
    // own line, then one comma-separated settings line. Getting this wrong is
    // silent — Forge simply pastes the whole thing into the prompt field.
    expect(
      toParameterBlock({
        tool: 'Stable Diffusion',
        needsSourceImage: false, postprocessed: false, characters: [],
        prompt: 'a girl on a beach, masterpiece',
        negativePrompt: 'bad hands, blurry',
        steps: '28',
        sampler: 'DPM++ 2M Karras',
        cfgScale: '7',
        seed: '12345',
        model: 'someMix_v4',
      }),
    ).toBe(
      [
        'a girl on a beach, masterpiece',
        'Negative prompt: bad hands, blurry',
        'Steps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Model: someMix_v4',
      ].join('\n'),
    )
  })

  it('omits what the file never recorded rather than inventing it', () => {
    // A ComfyUI graph or a stripped JPEG may yield a prompt and nothing else.
    // Filling in a plausible `Steps: 20` would quietly generate something other
    // than the picture on screen.
    expect(toParameterBlock({ tool: 'ComfyUI', needsSourceImage: false, postprocessed: false, characters: [], prompt: 'a castle at dusk' })).toBe(
      'a castle at dusk',
    )
    // An empty first line, because the prompt is where a prompt goes even when
    // there is not one — Forge's parser reads the settings off the last line.
    expect(toParameterBlock({ tool: 'NovelAI', needsSourceImage: false, postprocessed: false, characters: [], seed: '77' })).toBe(['', 'Seed: 77'].join('\n'))
  })
})

describe('folderMatch', () => {
  // `String.raw` so the backslashes are the path's, not escape sequences —
  // this is the extended-length UNC form the index actually stores.
  const path = String.raw`\\?\UNC\jebpot\devs\AI\characters\aqua-konosuba\best\00166-3997412987.png`

  it('shows the folder around the match, not the whole path', () => {
    // The path is why the row is in these results and it is far too long to
    // put on a tile. The window is the readable part of that answer.
    const found = folderMatch(path, 'aqua')
    expect(found).not.toBeNull()
    expect(found!.text).toContain('aqua-konosuba')
    expect(found!.text.length).toBeLessThan(40)
    // Clipped at the front, so the elision has to say so.
    expect(found!.text.startsWith('…')).toBe(true)
    // And the marked run is the term itself.
    expect(found!.text.slice(found!.from, found!.to)).toBe('aqua')
  })

  it('reads the stored path the way a person would', () => {
    // The index keeps Windows' extended-length form. `\?\UNC\` on a tile
    // would be noise in the few characters there is room for.
    expect(folderMatch(path, 'jebpot')!.text).not.toContain('?')
  })

  it('ignores the filename, which is the other mode’s job', () => {
    // Matching here would claim the folder matched when it did not, and the
    // index would disagree — it searches `dir`, with the name cut off.
    expect(folderMatch(path, '00166')).toBeNull()
    expect(folderMatch(path, '3997412987')).toBeNull()
  })

  it('matches case-insensitively, as the trigram index does', () => {
    expect(folderMatch(path, 'AQUA')!.text.toLowerCase()).toContain('aqua')
  })

  it('needs every word, because the index ANDs them', () => {
    expect(folderMatch(path, 'aqua best')).not.toBeNull()
    expect(folderMatch(path, 'aqua moona')).toBeNull()
  })

  it('gives up quietly on a row whose own path does not carry the term', () => {
    // Normal rather than exceptional: a variant stands in for an original
    // filed elsewhere, so a result may genuinely not match in its own path.
    expect(folderMatch(path, 'moona')).toBeNull()
    expect(folderMatch(path, '   ')).toBeNull()
    expect(folderMatch('no-folder.png', 'anything')).toBeNull()
  })

  it('spends the whole window on the side that has path to show', () => {
    // A hit at the very end should not waste half its budget on nothing.
    const found = folderMatch(path, 'best')!
    expect(found.text.endsWith('best')).toBe(true)
    expect(found.text.slice(found.from, found.to)).toBe('best')
  })
})

describe('ancestorsOf', () => {
  // The real path from the case this was built for: a texture pack found from
  // one picture nine levels down a share.
  const deep = String.raw`\\?\UNC\jebpot\devs\_3d\daz3d\_genesis 9\74751_Dimiro\Runtime\Textures\Dimiro\DMR 25`

  it('offers every level between the share and the folder itself', () => {
    const found = ancestorsOf(deep)
    expect(found.map((entry) => entry.label)).toEqual([
      '_3d',
      'daz3d',
      '_genesis 9',
      '74751_Dimiro',
      'Runtime',
      'Textures',
      'Dimiro',
      'DMR 25',
    ])
    // The last one is the folder that was passed in, so the row can show where
    // you already are rather than only where you could go.
    expect(found.at(-1)?.value).toBe(deep)
  })

  it('never offers the root, on either spelling of one', () => {
    // The root is where the filesystem is mounted, and that differs between
    // the two: a UNC root is server *and* share, so neither `jebpot` nor
    // `devs` is a directory anyone could exclude.
    expect(ancestorsOf(deep).some((entry) => entry.label === 'jebpot')).toBe(false)
    expect(ancestorsOf(deep).some((entry) => entry.label === 'devs')).toBe(false)

    // A drive letter is the whole root, so `Users` under it is an ordinary
    // directory and is offered. Far above any watched folder in practice — but
    // that is the allowlist's judgement to make and it has the roots to make
    // it, where this has only the string.
    expect(ancestorsOf(String.raw`\\?\C:\Users\me\Pictures`).map((e) => e.label)).toEqual([
      'Users',
      'me',
      'Pictures',
    ])
  })

  it('slices the input rather than rebuilding it', () => {
    // What comes back is used as an index key, and the index stores whatever
    // the filesystem reported. A path reassembled with the other separator
    // would match nothing and look like the exclusion silently failing.
    for (const entry of ancestorsOf(deep)) {
      expect(deep.startsWith(entry.value)).toBe(true)
    }
    expect(ancestorsOf(String.raw`\\jebpot\devs\a\b`).map((e) => e.value)).toEqual([
      String.raw`\\jebpot\devs\a`,
      String.raw`\\jebpot\devs\a\b`,
    ])
  })

  it('has nothing to offer for a path with no room above it', () => {
    expect(ancestorsOf(String.raw`\\?\UNC\jebpot\devs`)).toEqual([])
    expect(ancestorsOf('')).toEqual([])
  })
})
