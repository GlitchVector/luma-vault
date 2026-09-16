/**
 * How a call reaches Patreon. Two ways, and the cheap one turned out to work.
 *
 * The whole client was built on the brief's claim that a Node client has a
 * different TLS and HTTP/2 fingerprint from Chrome and gets challenged by
 * Cloudflare even with correct cookies — so every call was issued from inside a
 * logged-in page via `page.evaluate`. That claim was inherited and never
 * tested, which is a bad state for something the architecture rests on.
 *
 * Tested, on 2026-09-16: a plain Node GET to `/api/current_user`, carrying the
 * cookies a headed login had already produced and an honest `luma-vault-probe`
 * user-agent, answered **200 with JSON and no challenge**. Cloudflare is in
 * front of the host and let it through.
 *
 * So Chrome leaves the posting path. That matters well beyond tidiness: "start
 * Chrome with a remote debugging port first" is a miserable thing to require of
 * a desktop app, and it was about to shape the whole UI integration.
 *
 * The page transport stays, because it costs one small file to keep and it is
 * the escape hatch if Cloudflare ever tightens. What is *not* kept is the
 * pretence that it is necessary.
 *
 * Still unproven, and worth saying plainly: the probe was a GET. Writes carry a
 * CSRF ticket and may be treated differently. The first real post is the test
 * of that, and if it comes back as an HTML interstitial the page transport is
 * one line away.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SessionError } from './errors.ts'

export interface TransportRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly bodyText: string | null
  /** Do not follow a 3xx — the create step reads the redirect target for the post id. */
  readonly manualRedirect?: boolean
}

export interface TransportResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly text: string
}

/** Everything the client needs of a way to talk to Patreon. */
export interface Transport {
  send(request: TransportRequest): Promise<TransportResponse>
  /** For the create step, which is a navigation rather than an API call. */
  readonly origin: string
}

interface StorageState {
  cookies?: { name?: string; value?: string; domain?: string }[]
}

/**
 * Read the cookie jar a headed `patreon auth` dumped.
 *
 * Only patreon.com cookies: a storage state can carry others, and sending an
 * unrelated site's cookie to Patreon would be both pointless and rude.
 */
export async function cookiesFrom(statePath: string): Promise<string> {
  let text: string
  try {
    text = await readFile(resolve(statePath), 'utf8')
  } catch {
    throw new SessionError(
      `no saved session at ${statePath}.\nRun \`pnpm patreon auth\` — it opens a browser for you to sign in once.`,
    )
  }
  const state = JSON.parse(text) as StorageState
  const jar = (state.cookies ?? []).filter((cookie) => (cookie.domain ?? '').includes('patreon.com'))
  if (jar.length === 0) {
    throw new SessionError(`${statePath} holds no patreon.com cookies — run \`pnpm patreon auth\` again.`)
  }
  return jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

/**
 * Talk to Patreon from Node, with a saved cookie jar.
 *
 * No user-agent spoofing. The probe passed without pretending to be Chrome, and
 * a borrowed UA string would not change a TLS fingerprint anyway — it would only
 * make a future failure harder to read.
 */
export function cookieTransport(cookie: string, origin = 'https://www.patreon.com'): Transport {
  return {
    origin,
    async send(request) {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers, cookie },
        ...(request.bodyText === null ? {} : { body: request.bodyText }),
        ...(request.manualRedirect === true ? { redirect: 'manual' as const } : {}),
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })
      return { status: response.status, headers, text: await response.text() }
    },
  }
}

/**
 * The original: issue the call from inside a logged-in page.
 *
 * Kept as the fallback. The function below is serialised to source and runs in
 * a context where this module does not exist, so everything it needs travels in
 * its argument.
 */
export interface PageLikeTransport {
  evaluate<Result, Arg>(fn: (arg: Arg) => Result | Promise<Result>, arg: Arg): Promise<Result>
}

export function pageTransport(page: PageLikeTransport, origin = 'https://www.patreon.com'): Transport {
  return {
    origin,
    async send(request) {
      return page.evaluate(
        async (spec: TransportRequest) => {
          const inPage = globalThis as unknown as {
            fetch: (
              url: string,
              init: { method: string; credentials: string; headers: Record<string, string>; body?: string; redirect?: string },
            ) => Promise<{
              status: number
              headers: { forEach(visit: (value: string, key: string) => void): void }
              text(): Promise<string>
            }>
          }
          const response = await inPage.fetch(spec.url, {
            method: spec.method,
            credentials: 'include',
            headers: { ...spec.headers },
            ...(spec.bodyText === null ? {} : { body: spec.bodyText }),
            ...(spec.manualRedirect === true ? { redirect: 'manual' } : {}),
          })
          const headers: Record<string, string> = {}
          response.headers.forEach((value, key) => {
            headers[key] = value
          })
          return { status: response.status, headers, text: await response.text() }
        },
        request,
      )
    },
  }
}
