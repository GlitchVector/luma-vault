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
import { CAPTURED_FROM, describePlan, loadManifest, loadState, planRun, pruneState } from '@luma/patreon-client'
import { captureLogin } from './auth.ts'
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
  '  post <set> [--dry-run]         the plan, and eventually the draft',
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
  post: ['dry-run'],
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

  case 'post': {
    const dir = positionals[0]
    if (dir === undefined) fail('usage: patreon post <set-dir> [--dry-run]')
    const post = await loadManifest(fromCwd(dir))
    const state = pruneState(await loadState(post), post)
    process.stdout.write(`${describePlan(post, planRun(post, state))}\n`)

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
    fail('\nthe run path lands here once the captures exist. Nothing was sent.')
  }

  default:
    fail(`no such command: ${command}\n\n${usage}`)
}
