/**
 * Attaching to a browser that is already logged in.
 *
 * There is deliberately no auth module here. No token flow, no login
 * automation, no refresh logic — automating the login form is the highest
 * bot-detection surface on the site. Both modes inherit a session somebody
 * else established:
 *
 *   - the harness loads a `storageState.json` an operator produced by hand;
 *   - the desktop app attaches over CDP to the operator's own Chrome:
 *
 *       chrome --remote-debugging-port=9222 --user-data-dir=%LOCALAPPDATA%\patreon-automation
 *
 * Either way this file only ever *checks* that the session is good and fails
 * loudly when it is not.
 */

import { SessionError } from './errors.ts'

/**
 * The slice of Playwright's `Page` this library uses. Structural, so the client
 * has no Playwright dependency and the desktop app can hand in whatever it has.
 *
 * The generic order on `evaluate` is `<Result, Arg>` to match Playwright's own
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

/** How we decide the browser is logged in. See `assertLoggedIn`. */
export interface LoginProbe {
  /** A page that only a signed-in account can open. */
  readonly url: string
  /** If the browser ends up somewhere matching this, we were bounced to a login wall. */
  readonly bouncedTo: RegExp
}

/**
 * Deliberately *not* an internal API call.
 *
 * A settings page redirecting to the login wall is observable behaviour anyone
 * can confirm by hand in ten seconds, and it survives an API reshuffle. An
 * identity endpoint would be a guessed path — the one thing constraint 4
 * forbids — and would be the first thing to break.
 */
export const DEFAULT_LOGIN_PROBE: LoginProbe = {
  url: 'https://www.patreon.com/settings/profile',
  bouncedTo: /patreon\.com\/(login|signup)|\/oauth2\/authorize/i,
}

export interface Session {
  readonly page: PageLike
  readonly origin: string
}

export interface AttachOptions {
  /** Which already-open page to use. Defaults to the first one, or a new one. */
  readonly page?: PageLike
  readonly probe?: LoginProbe
  readonly origin?: string
}

/**
 * Take a browser handle that somebody else connected, find a page on it and
 * prove the session is live.
 *
 * `connectOverCDP` itself is not here: it is Playwright's, and Playwright
 * belongs to the harness. The caller connects; this takes the result.
 */
export async function attach(browser: BrowserLike, options: AttachOptions = {}): Promise<Session> {
  const origin = options.origin ?? 'https://www.patreon.com'
  const page = options.page ?? (await firstPage(browser))
  await assertLoggedIn(page, options.probe ?? DEFAULT_LOGIN_PROBE)
  return { page, origin }
}

async function firstPage(browser: BrowserLike): Promise<PageLike> {
  const contexts = browser.contexts()
  const context = contexts[0]
  if (context === undefined) {
    throw new SessionError(
      'the browser has no contexts — is this a real Chrome started with --remote-debugging-port, or a bare launch?',
    )
  }
  return context.pages()[0] ?? (await context.newPage())
}

/**
 * Navigate to a page only a logged-in account can see and refuse to continue if
 * we get bounced.
 *
 * Failing here is the cheap failure. The expensive one is a half-finished draft
 * with three of five videos uploaded because the session quietly expired.
 */
export async function assertLoggedIn(page: PageLike, probe: LoginProbe = DEFAULT_LOGIN_PROBE): Promise<void> {
  await page.goto(probe.url, { waitUntil: 'domcontentloaded' })
  const landed = page.url()
  if (probe.bouncedTo.test(landed)) {
    throw new SessionError(
      `not logged in: ${probe.url} bounced to ${landed}.\n` +
        'Sign in to Patreon in that Chrome window by hand, then run this again.',
    )
  }
}
