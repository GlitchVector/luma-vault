/**
 * The capture matrix.
 *
 * One HAR tells you what happened. Two that differ in exactly one dimension
 * tell you what a field *means* — which is why this is a matrix and not a
 * single "make a post" recording. Every fixture below is the baseline plus one
 * change, so `diff` has something to subtract.
 *
 * Every step is a human step. Nothing here clicks anything: the operator drives
 * the browser, the harness only records. That is deliberate and not a stopgap.
 *
 * Note that merely opening the editor creates a draft — the first capture showed
 * `GET /posts/new` answering 302 to `/<page>/posts/<id>/edit`, with no POST
 * anywhere. So every capture leaves a draft behind whether or not anything is
 * typed, which is why `CLEANUP` exists and why the delete step matters.
 *
 * Every fixture ends by deleting its own draft, and that deletion is itself
 * part of the capture — it is where the delete endpoint comes from. Everything
 * stays a draft throughout, so nothing can reach a patron even if a teardown is
 * forgotten, and `CLEANUP` at the bottom of this file is the sweep for when one
 * is.
 */

export interface Fixture {
  readonly name: string
  /** What this one adds over the baseline — the axis `diff` is meant to isolate. */
  readonly varies: string
  /** Which fixture to diff it against. `null` for the baseline itself. */
  readonly baseline: string | null
  readonly steps: readonly string[]
  /** Where to open the browser. Defaults to the post editor; cleanup starts at the front door instead. */
  readonly startUrl?: string
  /** Why this one may not be capturable on a given account. Printed by `fixtures`. */
  readonly blockedBy?: string
}

/**
 * Where the delete lives is not something this file should assert.
 *
 * The first attempt at this said "open the draft list and delete it", which
 * assumes the operator knows where that is — and the first real capture went out
 * without a delete in it for exactly that reason. So the step now names the
 * route that needs no list, and explicitly permits giving up: a forgotten draft
 * is untidy, not dangerous, and the `cleanup` fixture below sweeps it up later
 * *and* is where `POST_DELETE` comes from.
 */
const COMMON_TAIL = [
  'Leave it as a DRAFT. Do not publish.',
  'Delete it while it is still open: the ⋯ / overflow menu by the save controls has Delete.',
  'Cannot find it? Leave the draft. Nothing can reach a patron, and `capture cleanup` handles it.',
  'Come back to the terminal and press Enter.',
]

export const FIXTURES: readonly Fixture[] = [
  {
    name: 'text-only',
    varies: 'baseline: a post with nothing but a title and a body',
    baseline: null,
    steps: [
      'The editor is already open on a fresh draft — opening it is what creates one.',
      'Title it "harness text-only" and type two short paragraphs into the body.',
      'Type a bold word and a link, so the body format shows its structure.',
      'Save the draft.',
      ...COMMON_TAIL,
    ],
  },
  {
    name: 'image-1',
    varies: 'one image — shows the media create/upload/attach shape',
    baseline: 'text-only',
    steps: [
      'The editor opens on a fresh draft. Title it "harness image-1", same body text as text-only.',
      'Attach exactly one image and wait until the editor shows it as ready.',
      'Save the draft.',
      ...COMMON_TAIL,
    ],
  },
  {
    name: 'image-2',
    varies: 'a second image — shows whether attachment order is an array and where',
    baseline: 'image-1',
    steps: [
      'The editor opens on a fresh draft. Title it "harness image-2", same body text.',
      'Attach two images, in a deliberate order you can recognise later.',
      'Reorder them once, so the reorder call is in the capture too.',
      'Save the draft.',
      ...COMMON_TAIL,
    ],
  },
  {
    name: 'video',
    varies: 'a video — shows the transcoding states, which images hide',
    baseline: 'image-1',
    // Patreon gates video uploads on account eligibility, and this account does
    // not have it yet (2026-09-10). Left in the matrix rather than deleted: the
    // fixture is correct, it is the account that cannot run it, and the day it
    // can is the day `waitUntilReady` stops being guesswork.
    blockedBy: 'needs video-upload eligibility on the account — not available here yet',
    steps: [
      'The editor opens on a fresh draft. Title it "harness video", same body text.',
      'Attach one short video — 10-20 seconds is plenty, and keeps the upload quick.',
      'Wait, without clicking anything, until the editor stops saying it is processing.',
      'That waiting is the point: the polling calls in between are what this fixture is for.',
      'Save the draft.',
      ...COMMON_TAIL,
    ],
  },
  {
    name: 'tier-locked',
    varies: 'access control — diff against text-only to find the tier fields',
    baseline: 'text-only',
    steps: [
      'The editor opens on a fresh draft. Title it "harness tier-locked", same body text.',
      'Set the audience to a paid tier rather than public.',
      'Save the draft.',
      ...COMMON_TAIL,
    ],
  },
  {
    name: 'adult-on',
    varies: 'the adult content flag — diff against text-only to find its field',
    baseline: 'text-only',
    steps: [
      'The editor opens on a fresh draft. Title it "harness adult-on", same body text.',
      'Turn the adult / mature content flag ON and nothing else.',
      'Save the draft.',
      ...COMMON_TAIL,
    ],
  },
]

/**
 * Not a matrix row: it varies nothing and creates nothing.
 *
 * It exists because deleting a draft is the one step of the matrix that is
 * easy to skip — you have to find the control before you can use it — and a
 * skipped delete costs twice: a draft left lying around, and no capture of the
 * delete call. Sweeping up is therefore also how `POST_DELETE` is captured, so
 * the tidying is not busywork.
 *
 * Kept out of `FIXTURES` so `diff` is never offered a baseline it cannot mean
 * anything against.
 */
export const CLEANUP: Fixture = {
  name: 'cleanup',
  varies: 'deletes leftover harness drafts — and captures the delete call while doing it',
  baseline: null,
  startUrl: 'https://www.patreon.com/',
  steps: [
    'Find your drafts: creator dashboard -> Posts (or Library) -> the Drafts tab.',
    'No luck? Open a draft and use the ⋯ menu by the save controls. Or try patreon.com/manageposts.',
    'Delete every draft whose title starts with "harness". Leave all your other drafts alone.',
    'One at a time, not a bulk select — a batch delete is very likely a different call.',
    'Come back to the terminal and press Enter.',
  ],
}

export function fixtureByName(name: string): Fixture | undefined {
  if (name === CLEANUP.name) return CLEANUP
  return FIXTURES.find((fixture) => fixture.name === name)
}
