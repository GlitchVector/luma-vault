/**
 * The media state machine: create a record, put the bytes somewhere, wait until
 * Patreon says the thing is usable.
 *
 * Three steps, three different failure modes, and the third one is the one that
 * gets skipped. "Uploaded" and "usable" are different states — a video is
 * transcoded after the bytes land, and attaching it in between produces a draft
 * with a broken attachment and no error anywhere. So: poll. Never `sleep()` a
 * guessed interval and carry on.
 *
 * Hand-written, and it stays hand-written. The generator produces types and
 * endpoint constants; it does not produce a state machine.
 *
 * WHAT IS MISSING: only the shapes. `MEDIA_CREATE`'s request body, the field
 * its response puts the upload target in, and the field carrying the processing
 * state each throw `NotCapturedError` until the `image-1` and `video` fixtures
 * exist. Everything around them — ordering, streaming, backoff, the poll loop —
 * is real and unit-tested now.
 */

import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { MEDIA_CREATE, MEDIA_GET } from './endpoints.generated.ts'
import { NotCapturedError } from './errors.ts'
import type { ResolvedMedia } from './manifest.ts'
import type { Session } from './session.ts'

/** Where the bytes go, as the create response described it. */
export interface UploadTarget {
  readonly url: string
  /**
   * `POST` with a multipart form (an S3-style presigned post) or a plain `PUT`.
   * Which one it is, is a capture question.
   */
  readonly method: 'POST' | 'PUT'
  /**
   * Form fields in the order they must appear in the body. Order is not
   * decoration: a presigned POST rejects a body whose file part is not last,
   * and this array is the only thing carrying that ordering.
   */
  readonly fields: ReadonlyArray<readonly [string, string]>
  /** Name of the part holding the bytes. */
  readonly fileField: string
}

export interface PollOptions {
  /** Give up after this long. A long video legitimately takes minutes; forever is not a legitimate answer. */
  readonly timeoutMs?: number
  readonly firstDelayMs?: number
  readonly maxDelayMs?: number
  /** Injectable so the tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly onAttempt?: (attempt: number, waitedMs: number) => void
}

const POLL_DEFAULTS = {
  timeoutMs: 30 * 60_000,
  firstDelayMs: 1_000,
  maxDelayMs: 15_000,
  sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
  now: () => Date.now(),
}

/**
 * Call `read` until it returns something other than `null`, backing off.
 *
 * Separate from the media specifics so the loop is testable without a browser,
 * and so the post side can reuse it. The first call happens immediately: a
 * still image is very often ready by the time we ask, and a fixed opening sleep
 * would add a second per file for nothing.
 */
export async function pollUntil<T>(
  read: (attempt: number) => Promise<T | null>,
  options: PollOptions = {},
): Promise<T> {
  const config = { ...POLL_DEFAULTS, ...options }
  const started = config.now()
  let delay = config.firstDelayMs
  for (let attempt = 1; ; attempt++) {
    const waited = config.now() - started
    options.onAttempt?.(attempt, waited)
    // Sequential on purpose — this loop *is* the waiting. Parallelising it,
    // which is what the lint rule assumes was meant, would be a tight spin
    // against Patreon's servers on a live account.
    // eslint-disable-next-line no-await-in-loop
    const value = await read(attempt)
    if (value !== null) return value
    if (config.now() - started + delay > config.timeoutMs) {
      throw new Error(`gave up after ${Math.round((config.now() - started) / 1000)}s and ${attempt} attempts`)
    }
    // eslint-disable-next-line no-await-in-loop
    await config.sleep(delay)
    delay = Math.min(delay * 2, config.maxDelayMs)
  }
}

/**
 * Step 1 — ask Patreon for a media record and an upload target.
 *
 * TODO(capture): the request body and the response shape. Fixture `image-1`
 * gives both; `video` confirms they do not differ by kind.
 */
export function createMedia(_session: Session, _file: ResolvedMedia): Promise<{ id: string; target: UploadTarget }> {
  if (MEDIA_CREATE === null) {
    return Promise.reject(new NotCapturedError('the media-create endpoint and its request body', 'image-1'))
  }
  return Promise.reject(
    new NotCapturedError('the shape of the media-create response (media id + upload target)', 'image-1'),
  )
}

/**
 * Step 2 — the bytes.
 *
 * The one leg that runs from Node rather than from the page. It targets a
 * storage host with a presigned URL, which is normally not behind the same
 * protection as the site, and a 400MB video must not be marshalled through the
 * CDP bridge as an array of numbers.
 */
export async function uploadBytes(target: UploadTarget, file: ResolvedMedia): Promise<void> {
  const { body, headers, length } = target.method === 'PUT' ? rawBody(file) : multipartBody(target, file)

  // `duplex` is not in the DOM RequestInit type, and a streamed body without it
  // is rejected by Node at runtime — so the whole init is asserted once here.
  const init = {
    method: target.method,
    headers: { ...headers, 'content-length': String(length) },
    body: Readable.toWeb(body),
    duplex: 'half',
  } as unknown as RequestInit

  const response = await fetch(target.url, init)

  if (!response.ok) {
    throw new Error(`upload of ${file.name} failed: ${response.status} ${(await response.text()).slice(0, 500)}`)
  }
}

/**
 * Step 3 — wait for usable, not for uploaded.
 *
 * BLOCKED, and it matters. The `video` fixture is the one that would show the
 * processing states, and this account does not have video-upload eligibility
 * yet — so the one case where "uploaded" and "usable" genuinely differ cannot
 * be captured at all right now.
 *
 * That is an argument for keeping the poll, not for dropping it. An image
 * capture showing a media record that is ready the instant it is created proves
 * nothing about video, and the failure mode it hides — a draft with a silently
 * broken attachment — is exactly the one nobody notices until a patron does.
 * So this stays a poll against whatever state field the `image-1` capture
 * reveals, and the ready semantics get confirmed the day video is available.
 *
 * TODO(capture): the state field and its ready value, from `image-1`; the
 * transcoding states themselves, from `video`, when the account can run it.
 */
export function waitUntilReady(session: Session, mediaId: string, options: PollOptions = {}): Promise<string> {
  return pollUntil(() => readMediaState(session, mediaId), options)
}

/** Returns the media id once the record reports ready, `null` while it is still working. */
function readMediaState(_session: Session, _mediaId: string): Promise<string | null> {
  if (MEDIA_GET === null) return Promise.reject(new NotCapturedError('the media-read endpoint', 'video'))
  return Promise.reject(new NotCapturedError('the media state field and its ready value', 'video'))
}

/** A presigned PUT: the file is the whole body. */
function rawBody(file: ResolvedMedia): { body: Readable; headers: Record<string, string>; length: number } {
  return {
    body: createReadStream(file.path),
    headers: { 'content-type': contentTypeOf(file.name) },
    length: file.bytes,
  }
}

/**
 * A presigned POST: fields first, in the order given, then the file.
 *
 * Built by hand rather than with `FormData` because `FormData` would want the
 * whole file in memory and promises nothing about field order — and the order
 * is part of what the policy was signed over.
 */
export function multipartBody(
  target: UploadTarget,
  file: ResolvedMedia,
): { body: Readable; headers: Record<string, string>; length: number } {
  const boundary = `----lumavault${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  const preamble = target.fields
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join('')
  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${target.fileField}"; filename="${file.name}"\r\n` +
    `Content-Type: ${contentTypeOf(file.name)}\r\n\r\n`

  const head = Buffer.from(preamble + fileHeader, 'utf8')
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')

  async function* parts(): AsyncGenerator<Buffer> {
    yield head
    for await (const chunk of createReadStream(file.path)) yield chunk as Buffer
    yield tail
  }

  return {
    body: Readable.from(parts()),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    length: head.length + file.bytes + tail.length,
  }
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
}

export function contentTypeOf(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}
