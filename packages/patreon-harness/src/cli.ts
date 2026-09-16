#!/usr/bin/env node
/**
 * The operator's entry point.
 *
 *   pnpm patreon fixtures                     what can be captured, and why each one exists
 *   pnpm patreon auth                         sign in by hand once, dump storageState.json
 *   pnpm patreon capture text-only            headed browser + checklist overlay; you drive
 *   pnpm patreon calls capture.har            the request list, for writing endpoints.map.json
 *   pnpm patreon diff a.har b.har             what one dimension changed
 *   pnpm patreon generate --har a.har --map m.json
 *   pnpm patreon scrub raw.har                take the credentials out of a HAR
 *   pnpm patreon post ./sets/042 --dry-run    the plan, without touching the network
 *
 * `capture`, `auth` and a non-dry `post` are the only commands that open a
 * browser, and all three are things a person starts and watches.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { captureLogin } from './auth.ts'
import { probe } from './probe.ts'
import { CLEANUP, FIXTURES, fixtureByName } from './capture/fixtures.ts'
import { runCapture } from './capture/run.ts'
import { diffHars, renderReport } from './diff.ts'
import { generateEndpoints, type EndpointMap } from './generate.ts'
import { readHar } from './har.ts'
import { findSecrets, scrubHar } from './scrub.ts'

const HARNESS_DIR = resolve(import.meta.dirname, '..')
const CAPTURE_DIR = resolve(HARNESS_DIR, 'captures')
const PROFILE_DIR = resolve(CAPTURE_DIR, 'profile')

const argv = process.argv.slice(2)
const command = argv[0]
const positionals = argv.slice(1).filter((argument) => !argument.startsWith('--'))
const flag = (name: string): boolean => argv.includes(`--${name}`)
const option = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}
/** Every occurrence of a repeatable flag. `--har` is given once per fixture. */
const options = (name: string): string[] => {
  const found: string[] = []
  argv.forEach((argument, at) => {
    if (argument !== `--${name}`) return
    const value = argv[at + 1]
    if (value !== undefined && !value.startsWith('--')) found.push(value)
  })
  return found
}

/**
 * Resolve a path argument against the directory the operator actually typed it
 * in, not the package directory.
 *
 * `pnpm patreon …` runs the script with cwd set to this package, so a perfectly
 * ordinary `captures/x.har` typed at the repo root resolved to
 * `packages/patreon-harness/packages/patreon-harness/captures/x.har`. pnpm puts
 * the real invocation directory in INIT_CWD; npm does the same.
 */
function fromCwd(path: string): string {
  return resolve(process.env['INIT_CWD'] ?? process.cwd(), path)
}

/** The campaign is configuration, not something the API hands back. See `.env.example`. */
function requireCampaignId(): string {
  const id = process.env['PATREON_CAMPAIGN_ID']
  if (id === undefined || id.trim() === '') {
    fail(
      'PATREON_CAMPAIGN_ID is not set.\n' +
        'It is needed for the delete payload and for the campaign-level adult check, and it is not\n' +
        'discoverable from the API. Put it in .env — see .env.example.',
    )
  }
  return id.trim()
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const usage = [
  'patreon <command>',
  '',
  '  fixtures                       what can be captured, and why each one exists',
  '  auth                           sign in by hand once, dump storageState.json',
  '  capture <fixture>              headed browser + checklist; you drive, it records',
  '  calls <har>                    request list, for writing endpoints.map.json',
  '  diff <a.har> <b.har>           what one changed dimension did to the protocol',
  '  generate --har <har> --map <m> rewrite endpoints.generated.ts from a capture',
  '  scrub <har>                    take the credentials out of a HAR',
  '  tiers                          list the campaign access rules a manifest can name',
  '  probe                          does a plain Node request work, or is Chrome really needed?',
  '  post <set> [--dry-run]         the plan, then the draft (never published)',
  '  post --job <file>              the same, from a job the desktop app assembled',
  '',
  '  Everything ends in a draft. Nothing here publishes.',
  '',
].join('\n')

/** Flags each command understands. Anything else is a typo, and a typo must not run. */
const ACCEPTS: Record<string, readonly string[]> = {
  fixtures: [],
  auth: [],
  capture: ['keep-raw'],
  calls: ['host'],
  diff: ['out', 'volatile', 'host'],
  generate: ['har', 'map', 'out', 'host'],
  scrub: ['out'],
  post: ['dry-run', 'job'],
  tiers: [],
  probe: ['url'],
}

/**
 * `capture cleanup --help` once fell straight through to opening a browser,
 * because an unrecognised flag was simply ignored. On a project whose first
 * rule is that nothing automated visits patreon.com unasked, quietly discarding
 * an argument the operator clearly meant something by is not good enough.
 */
function refuseUnknownFlags(): void {
  const accepted = command === undefined ? undefined : ACCEPTS[command]
  if (accepted === undefined) return
  const unknown = argv
    .filter((argument) => argument.startsWith('--'))
    .map((argument) => argument.slice(2))
    .filter((name) => !accepted.includes(name))
  if (unknown.length > 0) {
    fail(
      `${command}: ${unknown.map((name) => `--${name}`).join(', ')} is not a flag this command takes.\n` +
        `It accepts: ${accepted.length === 0 ? '(none)' : accepted.map((name) => `--${name}`).join(', ')}\n` +
        'Nothing was run.',
    )
  }
}

if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  process.stdout.write(usage)
  process.exit(0)
}
refuseUnknownFlags()

/**
 * A manifest problem is not a crash, and a stack trace is not an explanation.
 *
 * The client's errors are written for a person reading a terminal — which is
 * wasted if Node prints them with twenty lines of frames on top. Anything
 * unrecognised still gets the full trace, because that one is a bug.
 */
const KNOWN = new Set(['ManifestError', 'SessionError', 'NotCapturedError', 'BodyError', 'ApiError'])
process.on('uncaughtException', (error: Error) => {
  if (!KNOWN.has(error.name)) throw error
  process.stderr.write(`\n${error.message}\n`)
  process.exit(1)
})

switch (command) {
  case 'fixtures':
    for (const fixture of [...FIXTURES, CLEANUP]) {
      process.stdout.write(
        `${fixture.name.padEnd(14)} ${fixture.varies}\n` +
          `${''.padEnd(14)} diff against: ${fixture.baseline ?? '(this is the baseline)'}\n` +
          (fixture.blockedBy === undefined ? '' : `${''.padEnd(14)} BLOCKED: ${fixture.blockedBy}\n`),
      )
    }
    break

  case 'auth':
    await captureLogin({ userDataDir: PROFILE_DIR, statePath: resolve(CAPTURE_DIR, 'storageState.json') })
    break

  case 'capture': {
    const name = positionals[0]
    const known = [...FIXTURES, CLEANUP].map((each) => each.name).join(', ')
    if (name === undefined) fail(`usage: patreon capture <fixture>\nfixtures: ${known}`)
    const fixture = fixtureByName(name)
    if (fixture === undefined) fail(`no fixture "${name}". Try: ${known}`)

    const outcome = await runCapture({ fixture, captureDir: CAPTURE_DIR, keepRaw: flag('keep-raw') })
    process.stdout.write(
      `\nwrote ${outcome.harPath}\n` +
        `  ${outcome.apiCalls} api calls recorded, ${outcome.redactions} values redacted\n`,
    )
    if (outcome.leftovers.length > 0) {
      process.stdout.write(`\nSTILL CARRIES SECRETS — do not share this file:\n`)
      for (const leftover of outcome.leftovers) process.stdout.write(`  ${leftover}\n`)
    }
    process.stdout.write(
      fixture.baseline === null
        ? // Nothing to subtract it from, so the useful next move is reading it.
          `\nnext: pnpm patreon calls ${outcome.harPath}\n`
        : `\nnext: pnpm patreon diff captures/<${fixture.baseline}>.scrubbed.har ${outcome.harPath}\n`,
    )
    break
  }

  case 'calls': {
    const path = positionals[0]
    if (path === undefined) fail('usage: patreon calls <har>')
    const requests = readHar(await readFile(fromCwd(path), 'utf8'), { host: option('host') ?? 'patreon.com' })
    // The signature is what endpoints.map.json is keyed on, so print exactly that.
    for (const request of requests) {
      process.stdout.write(`${String(request.status).padEnd(4)} ${request.signature}\n`)
    }
    process.stdout.write(`\n${requests.length} calls. Put the signature of each endpoint into endpoints.map.json.\n`)
    break
  }

  case 'diff': {
    const [a, b] = positionals
    if (a === undefined || b === undefined) fail('usage: patreon diff <a.har> <b.har> [--out report.md] [--volatile]')
    const report = diffHars(await readFile(fromCwd(a), 'utf8'), await readFile(fromCwd(b), 'utf8'), {
      // Basenames: a report headed with two absolute paths is unreadable, and
      // the fixture name is the part that means anything.
      labelA: basename(a),
      labelB: basename(b),
      host: option('host') ?? 'patreon.com',
      includeVolatile: flag('volatile'),
    })
    const rendered = renderReport(report)
    const out = option('out')
    if (out === undefined) process.stdout.write(`${rendered}\n`)
    else {
      await writeFile(fromCwd(out), rendered, 'utf8')
      process.stdout.write(`wrote ${out}\n`)
    }
    break
  }

  case 'generate': {
    const hars = options('har')
    const map = option('map')
    if (hars.length === 0 || map === undefined) {
      fail('usage: patreon generate --har <har> [--har <har> …] --map <endpoints.map.json>')
    }
    const mapping = JSON.parse(await readFile(fromCwd(map), 'utf8')) as EndpointMap
    // Several HARs, because the matrix spreads the protocol across fixtures on
    // purpose — the delete only exists in `cleanup`, the media calls only in
    // `image-1`. One HAR would null out whatever that fixture did not do.
    const requests = (
      await Promise.all(
        hars.map(async (path) =>
          readHar(await readFile(fromCwd(path), 'utf8'), {
            host: option('host') ?? 'patreon.com',
            // Strip the timestamp: the fixture name is the part a reader acts on.
            source: basename(path).replace(/-\d{4}-\d{2}-\d{2}T.*$/, ''),
          }),
        ),
      )
    ).flat()
    // Basenames, not paths: they land in CAPTURED_FROM and in every
    // NotCapturedError, and an absolute path there says nothing useful.
    const result = generateEndpoints({ mapping, requests, source: hars.map((path) => basename(path)).join(', ') })
    for (const problem of result.problems) process.stderr.write(`warning: ${problem}\n`)
    const out = option('out') ?? resolve(HARNESS_DIR, '../patreon-client/src/endpoints.generated.ts')
    await writeFile(fromCwd(out), result.source, 'utf8')
    process.stdout.write(`wrote ${out}\n`)
    break
  }

  case 'scrub': {
    const path = positionals[0]
    if (path === undefined) fail('usage: patreon scrub <har> [--out scrubbed.har]')
    const { har, redactions } = scrubHar(await readFile(fromCwd(path), 'utf8'))
    const out = option('out') ?? path.replace(/\.har$/, '.scrubbed.har')
    await writeFile(fromCwd(out), JSON.stringify(har), 'utf8')
    const leftovers = findSecrets(har)
    process.stdout.write(`wrote ${out} (${redactions} values redacted)\n`)
    for (const leftover of leftovers) process.stdout.write(`  STILL PRESENT: ${leftover}\n`)
    break
  }

  case 'probe': {
    const statePath = resolve(CAPTURE_DIR, 'storageState.json')
    const url = option('url') ?? 'https://www.patreon.com/api/current_user'
    process.stdout.write(`one GET to ${url}, from Node, with the cookies from ${statePath}\n\n`)
    const result = await probe(statePath, url)
    process.stdout.write(
      [
        `  status      ${result.status}`,
        `  server      ${result.server ?? '(none)'}`,
        `  json body   ${result.looksLikeJson}`,
        `  challenged  ${result.challenged}`,
        '',
        `  ${result.bodyHead.split('\n').join(' ')}`,
        '',
      ].join('\n'),
    )
    if (result.looksLikeJson && result.status === 200) {
      process.stdout.write('Node is enough. Chrome could be dropped from the posting path.\n')
    } else if (result.status === 401) {
      process.stdout.write('The stored session has expired. Run `pnpm patreon auth`, then probe again.\n')
    } else if (result.challenged) {
      process.stdout.write('Challenged, as the brief said. The page-evaluate design is doing real work.\n')
    } else {
      process.stdout.write('Neither clearly — read the body above before concluding.\n')
    }
    break
  }

  case 'tiers': {
    const { fromCookies, readCampaign } = await import('@luma/patreon-client')
    const campaignId = requireCampaignId()
    const session = await fromCookies(resolve(CAPTURE_DIR, 'storageState.json'))
    const campaign = await readCampaign(session, campaignId)
    process.stdout.write(`${campaign.name} (${campaign.id})${campaign.isNsfw ? ' — adult' : ''}\n\n`)
    for (const rule of campaign.accessRules) {
      process.stdout.write(`  ${rule.id.padEnd(12)} ${rule.type}\n`)
    }
    process.stdout.write(
      '\nPut the tier ids into a manifest\'s "tiers". "public" is implied by access: "public".\n',
    )
    break
  }

  case 'post': {
    // Imported here, not at the top of the file. `generate` rewrites a module
    // this package would otherwise load on startup, so a client that does not
    // currently compile — which is exactly the state `generate` exists to fix —
    // would take the generator down with it.
    const { fromCookies, CAPTURED_FROM, describePlan, loadJob, loadManifest, loadState, planRun, pruneState, runPost } =
      await import('@luma/patreon-client')
    const job = option('job')
    const dir = positionals[0]
    if (job === undefined && dir === undefined) {
      fail('usage: patreon post <set-dir> [--dry-run]\n   or: patreon post --job <file>')
    }
    // Two front doors onto the same run: a set somebody wrote by hand, and a
    // job the desktop app assembled from a selection. They converge before
    // anything below this line can tell them apart.
    const post = job === undefined ? await loadManifest(fromCwd(dir as string)) : await loadJob(fromCwd(job))
    const state = pruneState(await loadState(post), post)
    process.stdout.write(`${describePlan(post, planRun(post, state))}
`)

    if (flag('dry-run')) break
    // Refuse before opening a browser rather than after: there is nothing to
    // run yet, and a half-run against a live account is the expensive failure.
    if (CAPTURED_FROM === null) {
      fail(
        '\nnothing captured yet, so there is no protocol to run.\n' +
          'Run: patreon capture text-only   (you drive it; it only records)\n' +
          'then: patreon generate --har <har> --map endpoints.map.json',
      )
    }

    const campaignId = requireCampaignId()
    // No browser. The probe showed a plain Node request gets through, so the
    // desktop app will not have to ask anyone to start Chrome with a debugging
    // port. `transport.ts` keeps the page path as the fallback.
    const session = await fromCookies(resolve(CAPTURE_DIR, 'storageState.json'))
    const result = await runPost({
      session,
      post,
      campaignId,
      onProgress: (line) => process.stdout.write(`  ${line}
`),
    })

    process.stdout.write(
      `\nDRAFT: ${result.draft.url}\n` +
        `  ${result.uploaded} uploaded, ${result.reused} reused\n\n` +
        'Open it, check it, and publish it yourself. This tool does not.\n',
    )
    break
  }

  default:
    fail(`no such command: ${command}\n\n${usage}`)
}
