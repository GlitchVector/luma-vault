/**
 * A session is a way to reach Patreon as the logged-in creator, and nothing more.
 *
 * There is deliberately no auth module. No token flow, no login automation, no
 * refresh logic — automating the login form is the highest bot-detection
 * surface on the site. A human signs in once, headed, and what comes out is a
 * cookie jar this reuses.
 *
 * Two ways to carry those cookies:
 *
 *   `fromCookies` — a plain Node client. The default, since the probe showed
 *     Cloudflare lets it through. Needs nothing running.
 *   `attach` — inside a page of a browser somebody else connected. The fallback
 *     for the day that stops being true.
 */

import { call } from './call.ts'
import { SessionError } from './errors.ts'
import { cookiesFrom, cookieTransport, pageTransport, type Transport } from './transport.ts'

/**
 * The slice of Playwright's `Page` the fallback uses. Structural, so this
 * library has no Playwright dependency and the desktop app can hand in whatever
 * it has. The generic order is `<Result, Arg>` to match Playwright's own
 * `<R, Arg>`; flipping it breaks assignability of the real Page to this type.
 */
export interface PageLike {
  evaluate<Result, Arg>(fn: (arg: Arg) => Result | Promise<Result>, arg: Arg): Promise<Result>
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'commit' }): Promise<unknown>
  url(): string
}

export interface ContextLike {
  pages(): PageLike[]
  newPage(): Promise<PageLike>
}

export interface BrowserLike {
  contexts(): ContextLike[]
}

export interface Session {
  readonly transport: Transport
  readonly origin: string
}

const DEFAULT_ORIGIN = 'https://www.patreon.com'

/**
 * A session from a saved cookie jar. No browser involved.
 *
 * `assertLoggedIn` is worth the one extra request: the alternative is
 * discovering the session expired halfway through a post that has already
 * created a draft and uploaded four files.
 */
export async function fromCookies(statePath: string, origin = DEFAULT_ORIGIN): Promise<Session> {
  const session: Session = { transport: cookieTransport(await cookiesFrom(statePath), origin), origin }
  await assertLoggedIn(session)
  return session
}

/** A session inside a browser somebody else connected. The fallback path. */
export async function attach(
  browser: BrowserLike,
  options: { page?: PageLike; origin?: string } = {},
): Promise<Session> {
  const origin = options.origin ?? DEFAULT_ORIGIN
  const page = options.page ?? (await firstPage(browser))
  const session: Session = { transport: pageTransport(page, origin), origin }
  await assertLoggedIn(session)
  return session
}

async function firstPage(browser: BrowserLike): Promise<PageLike> {
  const context = browser.contexts()[0]
  if (context === undefined) {
    throw new SessionError(
      'the browser has no contexts — is this a real Chrome started with --remote-debugging-port?',
    )
  }
  return context.pages()[0] ?? (await context.newPage())
}

interface CurrentUser {
  data?: { id?: string; attributes?: { full_name?: string } }
}

/**
 * Prove the session is live before anything with a side effect runs.
 *
 * `/api/current_user` rather than a page load: it answers JSON for a live
 * session and something that is not JSON for a dead one, which is a cheaper and
 * less ambiguous signal than following a redirect to a login wall. It is also
 * exactly the call the probe used, so a failure here and a failing probe mean
 * the same thing.
 */
export async function assertLoggedIn(session: Session): Promise<string> {
  const result = await call<CurrentUser>(session, { method: 'GET', path: '/api/current_user' })
  const id = result.json?.data?.id
  if (!result.ok || id === undefined) {
    throw new SessionError(
      `not signed in to Patreon (${result.status}).\n` +
        (result.json === null
          ? 'The response was not JSON, which usually means a Cloudflare challenge rather than an expired login.\n'
          : 'The saved session has expired.\n') +
        'Run `pnpm patreon auth` to sign in again.',
    )
  }
  return id
}
