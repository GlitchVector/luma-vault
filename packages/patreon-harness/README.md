# patreon-harness

Dev-only. Owns Playwright, owns the captures, and is the half a human drives.
`@luma/patreon-client` must never depend on it.

## The rule this is built around

**Nothing automated ever opens patreon.com.** Not the login, not the fixtures,
not an agent. Every command that touches the site opens a headed browser and
waits for the operator; the harness records, scrubs and reports. The account is
a live creator account behind Cloudflare, and the cost of looking like a bot is
not a failed test, it is a lost account.

That is also why there is no auth module. See `src/auth.ts` for the version of
"auth" that exists: a browser, a human, and a cookie jar dumped afterwards.

## Commands

```bash
pnpm patreon fixtures                    # what can be captured, and why each one exists
pnpm patreon auth                        # sign in by hand once -> captures/storageState.json
pnpm patreon capture text-only           # headed Chrome + checklist overlay; you drive
pnpm patreon calls captures/x.har        # request list, for writing endpoints.map.json
pnpm patreon diff a.har b.har            # what one varied dimension did to the protocol
pnpm patreon generate --har a.har --map endpoints.map.json
pnpm patreon scrub raw.har               # take the credentials out of a HAR
pnpm patreon post ./sets/042 --dry-run   # the plan, without touching the network
```

## Capturing

`pnpm patreon capture <fixture>` opens Chrome against this package's own profile
directory (never your daily one), pins a checklist to the corner of the page,
records a HAR, and waits on Enter in the terminal. Then it scrubs the HAR,
deletes the raw one, and tells you what to diff it against.

Capture the **matrix**, not one post. One HAR says what happened; two that differ
in exactly one dimension say what each field *means*:

| fixture | varies | diff against | |
|---|---|---|---|
| `text-only` | baseline | — |
| `image-1` | media create/upload/attach | `text-only` |
| `image-2` | ordering, array shape | `image-1` |
| `video` | transcoding states | `image-1` | **blocked**: needs video-upload eligibility on the account |
| `tier-locked` | access control fields | `text-only` |
| `adult-on` | the content flag field | `text-only` |
| `cleanup` | not a matrix row: deletes leftover `harness` drafts, capturing the delete call | — |

**Opening the editor is what creates the draft.** The first capture showed
`GET /posts/new` answering 302 to `/<page>/posts/<id>/edit`, with no POST
anywhere — so every capture leaves a draft behind whether or not you type
anything.

Each fixture therefore ends by deleting its own draft, and **that deletion is
part of the capture** — it is where the delete endpoint comes from.

### Where the delete actually is

Easiest route, no list needed: while the draft is still open in the editor, the
`⋯` overflow menu by the save controls has **Delete**.

If that is not there, try the creator dashboard's **Posts** (or **Library**)
section and its **Drafts** tab, or `patreon.com/manageposts`.

Cannot find it at all? Leave the draft — a draft cannot reach a patron — and run
`pnpm patreon capture cleanup` later. That fixture exists precisely for this: it
sweeps up the leftovers *and* is how `POST_DELETE` gets captured, so the tidying
pays for itself.

## HARs are credentials

A HAR of a logged-in session *is* the session: the cookies, the anti-CSRF token,
and any presigned upload URL whose signature is a bearer token for a bucket.

- raw HARs go to `captures/raw/` and are deleted after scrubbing unless you pass
  `--keep-raw`. **The whole `captures/` directory is gitignored** — a scrubbed
  HAR is safe to share but is still tens of megabytes of one person's session,
  and it is regenerable. What gets committed is `endpoints.map.json` and the
  generated file;
- `scrubHar` redacts rather than deletes, so the capture still shows *which*
  headers existed — that is itself part of the protocol;
- `findSecrets` is the gate, and every capture prints its result. If it names
  anything, do not share the file.

Scrub before committing, sharing, or pasting into a chat window.

## From capture to code

1. `pnpm patreon calls <har>` — the signatures.
2. Write `endpoints.map.json`: `{ "POST_CREATE": "POST www.patreon.com/api/..." }`.
   Deciding which call is which is the human step. A generator that guessed
   would produce something that looks right and fails silently.
3. `pnpm patreon generate --har <har> --map endpoints.map.json` — rewrites
   `packages/patreon-client/src/endpoints.generated.ts`.
4. Everything in `media.ts` and `post.ts` stays hand-written. The generator does
   shapes; it does not do the state machine.

## Contract test

`src/contract.spec.ts` runs the real client against a throwaway draft. It is
`.spec.ts` and `vitest.config.ts` includes only `*.test.ts`, so `pnpm -r test`
and CI cannot start it by accident; it also refuses to run without
`PATREON_LIVE=1`. Weekly is the right cadence — drift detection is the daily
benefit, regeneration is the recovery path.

## ToS

Internal endpoints carry no compatibility promise, and automated access is
against Patreon's terms. Keep the volume low, keep it draft-only, keep a human
on the publish button.
