/**
 * A browser, for the one step that needs one.
 *
 * Page routes on patreon.com are Cloudflare-challenged from Node — `/posts/new`
 * answers "Just a moment..." with a 403, with or without the session's own
 * user-agent — while every `/api/*` call goes through fine. Creating a draft is
 * a navigation rather than an API call, so it is the exception.
 *
 * This uses the profile `patreon auth` already signed in, so nothing has to be
 * running and nobody has to start Chrome with a debugging port. It opens,
 * navigates once, reads where it landed, and closes.
 *
 * Headed, not headless: the headless build reports `HeadlessChrome/...` as its
 * user-agent, which is both a different identity from the one the session was
 * issued to and an obvious tell. A window appears for a second or two per post.
 */

import { chromium } from 'playwright-core'

export interface Navigator {
  navigate(path: string): Promise<string>
}

export function profileNavigator(userDataDir: string, origin = 'https://www.patreon.com'): Navigator {
  return {
    async navigate(path) {
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'chrome',
        viewport: null,
      })
      try {
        const page = context.pages()[0] ?? (await context.newPage())
        await page.goto(new URL(path, origin).toString(), { waitUntil: 'domcontentloaded' })
        return page.url()
      } finally {
        await context.close()
      }
    },
  }
}
