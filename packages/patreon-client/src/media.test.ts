import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResolvedMedia } from './manifest.ts'
import { contentTypeOf, multipartBody, pollUntil, type UploadTarget } from './media.ts'

describe('pollUntil', () => {
  const sleeps: number[] = []
  const options = { sleep: async (ms: number) => void sleeps.push(ms), firstDelayMs: 1000, maxDelayMs: 4000 }

  it('asks once immediately — a still image is usually ready before we ask', async () => {
    sleeps.length = 0
    expect(await pollUntil(async () => 'ready', options)).toBe('ready')
    expect(sleeps).toEqual([])
  })

  it('backs off and caps', async () => {
    sleeps.length = 0
    let left = 5
    await pollUntil(async () => (--left === 0 ? 'ready' : null), options)
    expect(sleeps).toEqual([1000, 2000, 4000, 4000])
  })

  // "Poll; never sleep()" cuts both ways: it must also stop, or a stuck
  // transcode hangs the run forever with nothing on screen.
  it('gives up at the deadline instead of polling forever', async () => {
    let clock = 0
    await expect(
      pollUntil(async () => null, {
        ...options,
        now: () => clock,
        sleep: async (ms) => void (clock += ms),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/gave up after/)
  })
})

describe('multipartBody', () => {
  // One call, then consume its stream: the boundary is random per call, so a
  // second call would not be the same body.
  async function bodyText(built: { body: NodeJS.ReadableStream }): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of built.body) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  async function fixture(): Promise<ResolvedMedia> {
    const dir = await mkdtemp(join(tmpdir(), 'patreon-media-'))
    const path = join(dir, '01.png')
    await writeFile(path, 'PNGBYTES')
    return { name: '01.png', path, bytes: 8, modifiedMs: 1, kind: 'image' }
  }

  const target: UploadTarget = {
    url: 'https://storage.example/upload',
    method: 'POST',
    fields: [
      ['key', 'uploads/01.png'],
      ['policy', 'BASE64POLICY'],
      ['x-amz-signature', 'SIG'],
    ],
    fileField: 'file',
  }

  // A presigned POST is signed over the field order. FormData promises nothing
  // about it, which is why this is built by hand — so pin the order.
  it('writes the fields in the order given, with the file last', async () => {
    const text = await bodyText(multipartBody(target, await fixture()))
    // Anchored so `filename="01.png"` does not read as another field.
    const names = [...text.matchAll(/(?:^|[\s;])name="([^"]+)"/g)].map((match) => match[1])
    expect(names).toEqual(['key', 'policy', 'x-amz-signature', 'file'])
    expect(text).toContain('PNGBYTES')
  })

  // Content-Length has to be exact: the body is a stream, so nothing downstream
  // can count it for us, and a presigned POST with the wrong length is a 400
  // after the whole file has been sent.
  it('declares a content length that matches the bytes it emits', async () => {
    const built = multipartBody(target, await fixture())
    const text = await bodyText(built)
    expect(Buffer.byteLength(text, 'utf8')).toBe(built.length)
  })
})

describe('contentTypeOf', () => {
  it('maps the types a set actually contains', () => {
    expect(contentTypeOf('01.PNG')).toBe('image/png')
    expect(contentTypeOf('clip.mp4')).toBe('video/mp4')
    expect(contentTypeOf('notes.bin')).toBe('application/octet-stream')
  })
})
