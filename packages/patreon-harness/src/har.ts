/**
 * Reading a HAR down to the part that is protocol.
 *
 * A HAR of one post is a few thousand entries, of which maybe fifteen matter.
 * Everything downstream — the diff, the generator — works on the normalised
 * shape below rather than on HAR's own nesting, so the noise rules and the
 * id-masking live in exactly one place.
 */

export interface Body {
  readonly mime: string
  readonly text: string
  /** Parsed, when it was JSON. `null` for HTML, multipart, or nothing. */
  readonly json: unknown
}

export interface HarRequest {
  /** Position in the original capture. The sequence is part of the protocol. */
  readonly index: number
  readonly startedAt: string
  readonly method: string
  readonly url: string
  readonly host: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly requestHeaders: Readonly<Record<string, string>>
  readonly requestBody: Body | null
  readonly status: number
  readonly responseHeaders: Readonly<Record<string, string>>
  readonly responseBody: Body | null
  /**
   * `METHOD host/masked/path` — the identity used to line two captures up.
   * Concrete ids are masked out, or the same call in two runs would never match.
   */
  readonly signature: string
  /**
   * Which capture this came from, when the caller said.
   *
   * It ends up in the generated `fixture` field, and from there into the text of
   * every `NotCapturedError` — so "image-1" is worth carrying and a list of
   * every HAR that happened to be on the command line is not.
   */
  readonly source: string
}

/**
 * Static assets, analytics, telemetry: most of a HAR and none of the protocol.
 *
 * `/api/tracking` is on patreon.com and looks like an API call, which is why it
 * is named here: a real text-only capture was 23 non-GET calls, and 15 of them
 * were tracking beacons fired between the six that mattered.
 */
const NOISE_URL =
  /\.(js|mjs|css|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|ico|mp4|webm|m3u8|ts|map)(\?|$)|\/(fonts|static|_next\/static)\/|\/api\/tracking|google|gstatic|doubleclick|facebook|segment|sentry|datadog|amplitude|braze|bugsnag|newrelic|hotjar|intercom|recaptcha|cloudflareinsights/i

/**
 * `text/html` is deliberately NOT here.
 *
 * It was, and it hid the answer. In the first real capture nothing ever POSTed
 * to create a post: the draft is minted by *navigating* to the editor, which
 * redirects to `/<page>/posts/<id>/edit`, and that document response is the
 * first place the new post id exists. Filtering page loads as "not protocol"
 * threw away the create step entirely.
 */
const NOISE_MIME = /^(image|font|video|audio)\/|javascript|text\/css/i

export interface ReadOptions {
  /** Keep only requests to this host (substring match). Defaults to keeping everything non-noise. */
  readonly host?: string
  /** Keep the noise too. Only useful when hunting for something that got filtered by mistake. */
  readonly all?: boolean
  /** Name recorded on every request read, so a multi-HAR generation can say which one each came from. */
  readonly source?: string
}

export function readHar(source: string | object, options: ReadOptions = {}): HarRequest[] {
  const har = (typeof source === 'string' ? JSON.parse(source) : source) as {
    log?: { entries?: unknown[] }
  }
  const entries = har.log?.entries ?? []
  const out: HarRequest[] = []

  entries.forEach((raw, index) => {
    const entry = raw as HarEntry
    const url = entry.request?.url
    if (url === undefined) return

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }

    const responseMime = entry.response?.content?.mimeType ?? ''
    if (options.all !== true) {
      if (NOISE_URL.test(url)) return
      if (NOISE_MIME.test(responseMime)) return
      if (options.host !== undefined && !parsed.host.includes(options.host)) return
    }

    out.push({
      index,
      startedAt: entry.startedDateTime ?? '',
      method: (entry.request?.method ?? 'GET').toUpperCase(),
      url,
      host: parsed.host,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      requestHeaders: headerMap(entry.request?.headers),
      requestBody: bodyOf(entry.request?.postData?.mimeType, entry.request?.postData?.text),
      status: entry.response?.status ?? 0,
      responseHeaders: headerMap(entry.response?.headers),
      responseBody: bodyOf(responseMime, entry.response?.content?.text),
      signature: `${(entry.request?.method ?? 'GET').toUpperCase()} ${parsed.host}${maskPath(parsed.pathname)}`,
      source: options.source ?? '',
    })
  })

  return out
}

interface HarEntry {
  startedDateTime?: string
  request?: {
    method?: string
    url?: string
    headers?: { name: string; value: string }[]
    postData?: { mimeType?: string; text?: string }
  }
  response?: {
    status?: number
    headers?: { name: string; value: string }[]
    content?: { mimeType?: string; text?: string }
  }
}

function headerMap(headers: { name: string; value: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const header of headers ?? []) out[header.name.toLowerCase()] = header.value
  return out
}

function bodyOf(mime: string | undefined, text: string | undefined): Body | null {
  if (text === undefined || text === '') return null
  const type = mime ?? ''
  let json: unknown = null
  if (/json/i.test(type) || /^\s*[{[]/.test(text)) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { mime: type, text, json }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_HEX = /^[0-9a-f]{16,}$/i
const NUMERIC = /^\d+$/

/**
 * Replace the concrete ids in a path with `{id}`.
 *
 * Two captures of "the same" call carry different post ids, so an unmasked path
 * never lines up and every request reads as added-and-removed. An all-digit
 * segment is masked whatever its length; a version segment survives because
 * `v2` is not all digits, and that is the only common false positive.
 */
export function maskPath(path: string): string {
  return path
    .split('/')
    .map((segment) => (UUID.test(segment) || LONG_HEX.test(segment) || NUMERIC.test(segment) ? '{id}' : segment))
    .join('/')
}
