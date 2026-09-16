# patreon-client

Turns a set directory into a Patreon **draft**. Never publishes.

This is the library the desktop app depends on, so it has no Playwright
dependency and no browser of its own: it is handed a page and it uses it. See
`session.ts`.

## Why it is shaped like this

Patreon's public API is read-only for posts. There is no endpoint for creating
one and none for uploading media — that is not a scope problem to solve with
better OAuth, it does not exist. The only route is the site's own internal API,
which is undocumented, unversioned and will break without notice. Everything
here exists to make that breakage cheap:

- **Every endpoint is captured, never guessed.** `endpoints.generated.ts` is
  written from a HAR. Anything not captured yet is `null`, and the code path
  that would need it throws `NotCapturedError` naming the fixture that fills it.
  A plausible-looking guessed endpoint is worse than no code, because it fails
  silently against a live account.
- **Calls run inside the page.** Patreon is behind Cloudflare, and a Node
  fetch/axios client has a different TLS and HTTP/2 fingerprint from Chrome — it
  gets challenged even with correct cookies. `call.ts` issues everything through
  `page.evaluate`, so it is real Chrome, real cookies, same origin. `page.request`
  looks like it would do and does not: it shares the cookie jar but uses Node's
  network stack.
- **The binary upload is the one exception.** It goes to a storage host with a
  presigned URL, from Node, as a stream — a 400MB video must not be marshalled
  through the CDP bridge as an array of numbers.

## The manifest

`post.json`, beside the media:

```jsonc
{
  "title": "...",
  "body": "...",            // or the name of a .md file in the same directory
  "media": ["01.png", "02.png", "clip.mp4"],
  "teaser": "01.png",
  "access": "tier",         // "public" | "tier"
  "tiers": ["<tier-id>"],
  "adult": true             // REQUIRED. No default.
}
```

`adult` has no default on purpose. The content is NSFW; a missing flag falling
back to `false` is an account-level problem, so an absent field is a hard error.

Every other problem in a manifest is reported at once rather than one per run —
a set is edited by hand, and three round trips to fix three typos is two too
many.

## Resume

`.state.json` sits next to the set and records what already exists on Patreon's
side: media ids, the draft post id, how far each file got. A run that dies at 90%
of a 400MB video resumes.

A recorded upload is reused only if the file on disk still has the size **and**
mtime it had then — a re-rendered frame gets re-uploaded, and shipping the
previous version of a picture is not a failure anyone would catch before it was
public.

`created`, `uploaded` and `ready` are three different states. A video is
uploaded long before it is usable; attaching it in between produces a draft with
a broken attachment and no error anywhere. `plan.ts` encodes that: resuming at
`uploaded` still waits.

## What is not here

- **No auth module.** No token flow, no login automation, no refresh. Sessions
  are inherited from a browser a human signed into.
- **No publish.** The last step prints a draft URL. A person presses the button.
