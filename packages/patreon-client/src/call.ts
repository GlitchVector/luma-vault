/**
 * Every control-plane call goes through here, and every one of them runs
 * *inside the authenticated page*.
 *
 * Patreon sits behind Cloudflare. A Node fetch/axios client has a different TLS
 * and HTTP/2 fingerprint from Chrome and gets challenged even with correct
 * cookies and headers. The fix is not an impersonation library — it is to stop
 * being a second client at all and issue the call from the page that is already
 * trusted: real Chrome fingerprint, real cookies, same origin so anti-CSRF
 * passes.
 *
 * `page.request` looks like it would do, and does not: it shares the cookie jar
 * but uses Node's network stack, so it is fingerprintable exactly like axios.
 * `page.evaluate` for all of it.
 *
 * The one exception is the binary upload leg, which targets a storage host with
 * a presigned URL and is normally not behind the same protection — see
 * `media.ts`, which streams it from Node so a 400MB video is not marshalled
 * through the CDP bridge as a byte array.
 */

import { ApiError, NotCapturedError } from './errors.ts'
import { CSRF, type CsrfTicket, type Endpoint } from './endpoints.generated.ts'
import type { PageLike, Session } from './session.ts'

/** JSON:API. The public API speaks it, so the internal one almost certainly does — but the generator confirms it from the capture. */
export const JSON_API = 'application/vnd.api+json'

export interface CallSpec {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Absolute path on the session origin, or a full same-origin URL. */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  /** Where to get the anti-CSRF token; fetched in the page, not here. Defaults to the captured one. */
  readonly csrf?: CsrfTicket | null
}

export interface CallResult<T = unknown> {
  readonly status: number
  readonly ok: boolean
  readonly headers: Readonly<Record<string, string>>
  readonly text: string
  /** Parsed body, or `null` when it was not JSON — an HTML Cloudflare interstitial, for one. */
  readonly json: T | null
}

/** What crosses into the page. Must be plain data: it is structured-cloned. */
interface Wire {
  url: string
  method: string
  bodyText: string | null
  headers: Record<string, string>
  csrf: CsrfTicket | null
}

/**
 * Issue one call. Does not throw on a non-2xx — callers decide, because a 404
 * while polling a media record means "not ready yet", not "broken".
 */
export async function call<T = unknown>(session: Session, spec: CallSpec): Promise<CallResult<T>> {
  const url = new URL(spec.path, session.origin)
  for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value)

  const wire: Wire = {
    url: url.toString(),
    method: spec.method,
    bodyText: spec.body === undefined ? null : JSON.stringify(spec.body),
    headers: {
      accept: JSON_API,
      ...(spec.body === undefined ? {} : { 'content-type': JSON_API }),
      ...spec.headers,
    },
    csrf: spec.csrf === undefined ? CSRF : spec.csrf,
  }

  const raw = await evaluateFetch(session.page, wire)
  return {
    status: raw.status,
    ok: raw.status >= 200 && raw.status < 300,
    headers: raw.headers,
    text: raw.text,
    json: parseJson<T>(raw.text),
  }
}

/** `call`, but a non-2xx is an `ApiError`. For the steps where there is no sane way to continue. */
export async function callOrThrow<T = unknown>(session: Session, spec: CallSpec): Promise<CallResult<T>> {
  const result = await call<T>(session, spec)
  if (!result.ok) {
    throw new ApiError(
      `${spec.method} ${spec.path} -> ${result.status}`,
      result.status,
      result.text.slice(0, 2000),
    )
  }
  return result
}

/** Fill `{id}`-style holes in a captured path template. */
export function endpointPath(endpoint: Endpoint, params: Readonly<Record<string, string>> = {}): string {
  return endpoint.path.replace(/\{(\w+)\}/g, (_whole, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`${endpoint.path}: no value given for {${name}}`)
    return encodeURIComponent(value)
  })
}

/** Narrow a possibly-uncaptured endpoint, with an error that says how to capture it. */
export function required(endpoint: Endpoint | null, what: string, fixture: string): Endpoint {
  if (endpoint === null) throw new NotCapturedError(what, fixture)
  return endpoint
}

function parseJson<T>(text: string): T | null {
  if (text === '') return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/**
 * The bridge. Everything the page needs travels in `wire`, because the function
 * below is serialised to source and evaluated in a context where this module
 * does not exist — a reference to anything in this file's scope is a
 * ReferenceError in Chrome, not a compile error here.
 */
function evaluateFetch(
  page: PageLike,
  wire: Wire,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  return page.evaluate(async (spec: Wire) => {
    // Runs in the page. The module has no DOM lib, so the two globals used are
    // reached through a local shape rather than by importing lib.dom.
    const inPage = globalThis as unknown as {
      fetch: (
        url: string,
        init: {
          method: string
          credentials: string
          headers: Record<string, string>
          body?: string
        },
      ) => Promise<{
        status: number
        headers: { forEach(visit: (value: string, key: string) => void): void }
        text(): Promise<string>
      }>
    }

    const headers: Record<string, string> = { ...spec.headers }
    const csrf = spec.csrf
    if (csrf !== null) {
      // Fetched here rather than passed in: the token rotates, and one that
      // crossed the bridge a second ago may already be the previous one.
      //
      // One extra GET per control-plane call, and that is a deliberate trade.
      // A whole run makes on the order of ten of these, so the volume is
      // nothing next to a class of bug where a stale token fails a PATCH
      // halfway through a post that is already half-built.
      const ticket = await inPage.fetch(csrf.path, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      const token = (JSON.parse(await ticket.text()) as Record<string, unknown>)[csrf.field]
      if (typeof token === 'string') headers[csrf.header] = token
    }

    const response = await inPage.fetch(spec.url, {
      method: spec.method,
      // Same-origin call from the logged-in page: this is the whole trick.
      credentials: 'include',
      headers,
      ...(spec.bodyText === null ? {} : { body: spec.bodyText }),
    })

    const out: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      out[key] = value
    })
    return { status: response.status, headers: out, text: await response.text() }
  }, wire)
}
