/**
 * Every control-plane call goes through here.
 *
 * *How* it reaches Patreon is `transport.ts`'s business, and that answer
 * changed on 2026-09-16: a plain Node request carrying a saved cookie jar is
 * enough. The whole client had been built on the brief's untested claim that
 * Cloudflare would challenge anything that was not really Chrome. It does not,
 * for this account, so Chrome is no longer required to post.
 *
 * What stays true either way is the anti-CSRF dance. A write needs a token from
 * `/REST/auth/CSRFTicket` in an `x-csrf-signature` header — there is no csrf
 * cookie to mirror, which is what an earlier version of this file assumed.
 *
 * The binary upload leg does not come through here at all. It targets a storage
 * host with a presigned URL and streams from Node — see `media.ts`.
 */

import { ApiError, NotCapturedError } from './errors.ts'
import { CSRF, type CsrfTicket, type Endpoint } from './endpoints.generated.ts'
import type { Session } from './session.ts'

/** JSON:API — confirmed from the captures, not assumed from the public API. */
export const JSON_API = 'application/vnd.api+json'

export interface CallSpec {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Absolute path on the session origin, or a full same-origin URL. */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  /** Where to get the anti-CSRF token. Defaults to the captured one; `null` to skip. */
  readonly csrf?: CsrfTicket | null
  /** Do not follow a 3xx. The create step reads the redirect target for the post id. */
  readonly manualRedirect?: boolean
}

export interface CallResult<T = unknown> {
  readonly status: number
  readonly ok: boolean
  readonly headers: Readonly<Record<string, string>>
  readonly text: string
  /** Parsed body, or `null` when it was not JSON — an HTML Cloudflare interstitial, for one. */
  readonly json: T | null
}

/**
 * Fetch an anti-CSRF token.
 *
 * Fetched per write rather than cached. One extra GET against maybe a dozen
 * calls in a run is nothing next to a stale token failing a PATCH halfway
 * through a post that is already half-built — and the token does rotate.
 */
async function csrfToken(session: Session, ticket: CsrfTicket): Promise<string | null> {
  const response = await session.transport.send({
    url: new URL(ticket.path, session.origin).toString(),
    method: 'GET',
    headers: { accept: 'application/json' },
    bodyText: null,
  })
  try {
    const value = (JSON.parse(response.text) as Record<string, unknown>)[ticket.field]
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/**
 * Issue one call. Does not throw on a non-2xx — callers decide, because a 404
 * while polling a media record means "not ready yet", not "broken".
 */
export async function call<T = unknown>(session: Session, spec: CallSpec): Promise<CallResult<T>> {
  const url = new URL(spec.path, session.origin)
  for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value)

  const headers: Record<string, string> = {
    accept: JSON_API,
    ...(spec.body === undefined ? {} : { 'content-type': JSON_API }),
    ...spec.headers,
  }

  const ticket = spec.csrf === undefined ? CSRF : spec.csrf
  // Only writes need it, and asking for one on every GET would double a run's
  // request count for nothing.
  if (ticket !== null && spec.method !== 'GET') {
    const token = await csrfToken(session, ticket)
    if (token !== null) headers[ticket.header] = token
  }

  const raw = await session.transport.send({
    url: url.toString(),
    method: spec.method,
    headers,
    bodyText: spec.body === undefined ? null : JSON.stringify(spec.body),
    ...(spec.manualRedirect === true ? { manualRedirect: true } : {}),
  })

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
