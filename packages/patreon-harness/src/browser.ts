/**
 * The only file that knows Playwright exists.
 *
 * Two ways in, and neither of them logs anybody in:
 *
 *   - `openOperatorBrowser` launches a headed Chrome against a profile
 *     directory that belongs to this harness, for the operator to drive by
 *     hand. Nothing in this project automates the login form — it is the highest
 *     bot-detection surface on the site, and the account is a real one.
 *   - `attachToRunningChrome` connects to a Chrome the operator already started
 *     with `--remote-debugging-port`. That is how the desktop app will do it:
 *     the session comes along for free and the app never handles credentials.
 *
 * `playwright-core`, not `playwright`: we drive the operator's real Chrome via
 * `channel: 'chrome'`, so downloading a bundled Chromium would be a few hundred
 * megabytes to never use.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright-core'

export interface OpenOptions {
  /** Profile directory. Its own, not the operator's daily Chrome profile. */
  readonly userDataDir: string
  /** Where to write the HAR. Omit for a session that is not being captured. */
  readonly harPath?: string
  readonly startUrl?: string
}

export async function openOperatorBrowser(options: OpenOptions): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(options.userDataDir, {
    headless: false,
    // The operator's real browser build, so the fingerprint is a real Chrome's.
    channel: 'chrome',
    viewport: null,
    ...(options.harPath === undefined
      ? {}
      : {
          recordHar: {
            path: options.harPath,
            // Response bodies are the protocol. Without them a capture answers
            // "which calls" and not "carrying what", which is the whole question.
            content: 'embed' as const,
          },
        }),
  })
  if (options.startUrl !== undefined) {
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(options.startUrl)
  }
  return context
}

/**
 * Attach to a Chrome the operator started themselves:
 *
 *     chrome --remote-debugging-port=9222 --user-data-dir=%LOCALAPPDATA%\patreon-automation
 */
export async function attachToRunningChrome(endpoint = 'http://localhost:9222'): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(endpoint)
  } catch (cause) {
    throw new Error(
      `no Chrome listening on ${endpoint}.\n` +
        'Start one with:\n' +
        '  chrome --remote-debugging-port=9222 --user-data-dir=%LOCALAPPDATA%\\patreon-automation\n' +
        'and sign in to Patreon in it.',
      { cause },
    )
  }
}
