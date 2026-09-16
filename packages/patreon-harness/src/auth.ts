/**
 * "Auth", which is not an auth module.
 *
 * There is no token flow here, no refresh logic and no automated login. This
 * opens a real Chrome, waits for a human to sign in, and writes the resulting
 * cookies to `storageState.json` so a later headed run starts already signed
 * in. When it expires, run it again.
 *
 * `storageState.json` is a live session in a text file. It is gitignored, and
 * it should be treated like the password it stands in for.
 */

import { createInterface } from 'node:readline/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { openOperatorBrowser } from './browser.ts'

export interface AuthOptions {
  readonly userDataDir: string
  readonly statePath: string
  readonly log?: (line: string) => void
}

export async function captureLogin(options: AuthOptions): Promise<string> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const statePath = resolve(options.statePath)
  await mkdir(dirname(statePath), { recursive: true })

  log(
    [
      '',
      '  A Chrome window is opening on the Patreon login page.',
      '  Sign in by hand — including any two-factor step — then come back here.',
      '',
      '  This tool will not type anything into that form. Automating a login is',
      '  the single most detectable thing you can do to an account.',
      '',
    ].join('\n'),
  )

  const context = await openOperatorBrowser({
    userDataDir: options.userDataDir,
    startUrl: 'https://www.patreon.com/login',
  })

  const input = createInterface({ input: process.stdin, output: process.stdout })
  await input.question('Press Enter once you are signed in and can see your creator page… ')
  input.close()

  // Record the browser's own user-agent beside the cookies.
  //
  // Not for disguise. Cloudflare binds `__cf_bm` to the user-agent that
  // obtained it, so replaying that cookie under a different one — or under none
  // at all, which is what Node sends — invalidates it and earns a "Just a
  // moment..." challenge on page routes. Presenting the identity the session was
  // actually issued to is what makes the jar usable, and it is the difference
  // between using a session and faking one.
  const page = context.pages()[0] ?? (await context.newPage())
  const userAgent = await page
    .evaluate(() => (globalThis as unknown as { navigator: { userAgent: string } }).navigator.userAgent)
    .catch(() => null)

  await context.storageState({ path: statePath })
  if (typeof userAgent === 'string') {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    state['userAgent'] = userAgent
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
    log(`recorded the browser's user-agent, which __cf_bm is bound to`)
  }
  await context.close()

  log(`\nwrote ${statePath} — treat it as a password, it is gitignored for that reason.`)
  return statePath
}
