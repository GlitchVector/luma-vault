/**
 * Taking the credentials out of a HAR.
 *
 * A HAR of a logged-in session is a session. It carries the cookies that *are*
 * the login, plus presigned URLs whose signature is a bearer token for a
 * storage bucket. Anything that leaves the machine — committed, shared, pasted
 * into a chat window — goes through here first, and `findSecrets` is the
 * check that refuses to write one that did not.
 *
 * Note the two places people miss: HAR keeps a parallel `cookies[]` array
 * beside the headers, and a presigned URL hides its signature in the query
 * string of a request that is not to patreon.com at all.
 */

const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf-signature|x-csrf-token|x-xsrf-token|x-api-key)$/i

/** Query parameters that are, in effect, credentials. Presigned URLs are the reason. */
const SECRET_PARAM =
  /^(x-amz-signature|x-amz-credential|x-amz-security-token|signature|policy|googleaccessid|x-goog-signature|sig|token|access_token|id_token|key)$/i

const SECRET_FIELD = /^(password|passwd|secret|token|access_token|refresh_token|session|csrf|api_key)$/i

const REDACTED = '[scrubbed]'

/** A signature that survived, wherever it is written — raw, or percent-encoded by URL.toString(). */
const SIGNED_IN_TEXT =
  /(x-amz-signature|x-amz-credential|x-goog-signature)=(?!%5Bscrubbed%5D|\[scrubbed\])[^&"'\s]+/i

export interface ScrubResult {
  /** The cleaned HAR. `object` rather than a HAR type: this only ever rewrites values, it does not model the format. */
  readonly har: object
  readonly redactions: number
}

/**
 * Redact rather than delete.
 *
 * A missing header and a redacted one look the same to a reader but not to the
 * person trying to work out whether the request carried anti-CSRF at all —
 * which is exactly the question the capture exists to answer. So the names
 * survive and only the values go.
 */
export function scrubHar(source: string | object): ScrubResult {
  const har = (typeof source === 'string' ? JSON.parse(source) : structuredClone(source)) as {
    log?: { entries?: unknown[] }
  }
  let redactions = 0
  const redact = () => {
    redactions++
    return REDACTED
  }

  const entries: unknown[] = har.log?.entries ?? []
  for (const raw of entries) {
    const entry = raw as HarEntry
    for (const side of [entry.request, entry.response]) {
      if (side === undefined) continue
      for (const header of side.headers ?? []) {
        if (SECRET_HEADER.test(header.name)) header.value = redact()
      }
      // The parallel array. Scrubbing only the headers leaves the whole jar here.
      for (const cookie of side.cookies ?? []) {
        if (cookie.value !== undefined && cookie.value !== '') cookie.value = redact()
      }
    }

    if (typeof entry.request?.url === 'string') {
      entry.request.url = scrubUrl(entry.request.url, redact)
    }
    for (const param of entry.request?.queryString ?? []) {
      if (SECRET_PARAM.test(param.name)) param.value = redact()
    }

    const post = entry.request?.postData
    if (post !== undefined && typeof post.text === 'string') {
      post.text = scrubBodyText(post.text, redact)
    }
    for (const param of entry.request?.postData?.params ?? []) {
      if (SECRET_FIELD.test(param.name)) param.value = redact()
    }

    const content = entry.response?.content
    if (content !== undefined && typeof content.text === 'string') {
      content.text = scrubBodyText(content.text, redact)
    }
  }

  return { har, redactions }
}

/** Presigned URLs are the point: the signature in the query is a bearer token for the bucket. */
export function scrubUrl(url: string, redact: () => string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  let touched = false
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) {
      parsed.searchParams.set(name, redact())
      touched = true
    }
  }
  return touched ? parsed.toString() : url
}

/**
 * Bodies are scrubbed by field name, on the JSON when it parses and by regex
 * when it does not — a login form post is urlencoded, and the one thing that
 * must never survive is the password field in it.
 */
function scrubBodyText(text: string, redact: () => string): string {
  if (text === '') return text
  try {
    const json: unknown = JSON.parse(text)
    const scrubbed = scrubJson(json, redact)
    return JSON.stringify(scrubbed)
  } catch {
    return text.replace(
      /\b(password|passwd|secret|token|access_token|refresh_token|api_key|x-amz-signature|x-amz-credential|x-goog-signature|signature|policy)=([^&\s]+)/gi,
      (_whole, name: string) => `${name}=${redact()}`,
    )
  }
}

function scrubJson(value: unknown, redact: () => string): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, redact))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_FIELD.test(key) && typeof item === 'string' ? redact() : scrubJson(item, redact)
    }
    return out
  }
  // A signed URL is most often a *value in a body*, not a request URL: the
  // media-create response hands back the presigned upload target, and that
  // response is precisely what a capture is taken for. Scrubbing only request
  // URLs would leave the bucket credential in the one entry that matters.
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return scrubUrl(value, redact)
  return value
}

/**
 * The gate. Nothing writes a HAR to a tracked path without passing this.
 *
 * Returns the offending locations rather than a boolean, because "this HAR
 * still has secrets in it" is only actionable if it says where.
 */
export function findSecrets(source: string | object): string[] {
  const har = (typeof source === 'string' ? JSON.parse(source) : source) as { log?: { entries?: unknown[] } }
  const found: string[] = []
  const entries: unknown[] = har.log?.entries ?? []

  entries.forEach((raw, index) => {
    const entry = raw as HarEntry
    for (const [side, part] of [
      ['request', entry.request],
      ['response', entry.response],
    ] as const) {
      for (const header of part?.headers ?? []) {
        if (SECRET_HEADER.test(header.name) && header.value !== REDACTED) {
          found.push(`entry ${index}: ${side} header ${header.name}`)
        }
      }
      for (const cookie of part?.cookies ?? []) {
        if (cookie.value !== undefined && cookie.value !== '' && cookie.value !== REDACTED) {
          found.push(`entry ${index}: ${side} cookie ${cookie.name}`)
        }
      }
    }
    const url = entry.request?.url
    if (typeof url === 'string' && scrubUrl(url, () => REDACTED) !== url) {
      found.push(`entry ${index}: signed query string in ${url.split('?')[0]}`)
    }
    // The gate has to look where the scrubber looks. A presigned upload target
    // arrives as a *value in a response body*, and a check that only read
    // request URLs would pass the one entry worth worrying about.
    for (const [side, text] of [
      ['request body', entry.request?.postData?.text],
      ['response body', entry.response?.content?.text],
    ] as const) {
      if (typeof text === 'string' && SIGNED_IN_TEXT.test(text)) {
        found.push(`entry ${index}: signed URL in the ${side}`)
      }
    }
  })

  return found
}

interface HarSide {
  url?: string
  headers?: { name: string; value: string }[]
  cookies?: { name: string; value?: string }[]
  queryString?: { name: string; value: string }[]
  postData?: { text?: string; params?: { name: string; value: string }[] }
  content?: { text?: string }
}

interface HarEntry {
  request?: HarSide
  response?: HarSide
}
