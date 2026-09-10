/**
 * The contract test: does the client still work against the real site?
 *
 * This is the ongoing value of the whole project. Internal endpoints carry no
 * compatibility promise, so the question is not "did we get it right" but "is it
 * still right this week". Run on a schedule, it fails the week Patreon changes
 * something rather than the evening somebody is trying to post. The recovery
 * path is a fresh capture and a regeneration, not a debugging session.
 *
 * TWO THINGS KEEP THIS AWAY FROM THE ACCOUNT BY ACCIDENT:
 *
 *   1. the file is `.spec.ts`, and `vitest.config.ts` includes only `*.test.ts`,
 *      so `pnpm -r test` and CI cannot start it;
 *   2. it refuses to run without `PATREON_LIVE=1` and a Chrome the operator
 *      started themselves.
 *
 * Run it deliberately:
 *
 *   chrome --remote-debugging-port=9222 --user-data-dir=%LOCALAPPDATA%\patreon-automation
 *   PATREON_LIVE=1 pnpm vitest run src/contract.spec.ts
 *
 * It creates one draft and deletes it. It never publishes, and it must stay that
 * way — a scheduled job with a publish path in it is a scheduled accident.
 */

import { describe, expect, it } from 'vitest'
import { attach, CAPTURED_FROM } from '@luma/patreon-client'
import { attachToRunningChrome } from './browser.ts'

const live = process.env['PATREON_LIVE'] === '1'

describe.skipIf(!live)('contract', () => {
  it('is attached to a logged-in browser', async () => {
    const browser = await attachToRunningChrome(process.env['PATREON_CDP'] ?? 'http://localhost:9222')
    const session = await attach(browser)
    expect(session.origin).toContain('patreon.com')
  })

  it('has something captured to test against', () => {
    // Until this is non-null there is no protocol to hold Patreon to, and a
    // green contract suite would be saying nothing at all.
    expect(CAPTURED_FROM).not.toBeNull()
  })

  // TODO(capture): once endpoints.generated.ts is filled in —
  //   create a draft, attach one small image, read it back, assert the shapes
  //   the client depends on, then delete the draft in a finally block so a
  //   failing assertion still cleans up.
  it.todo('creates a draft, attaches one image, reads it back and deletes it')
})
