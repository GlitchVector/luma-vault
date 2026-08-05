# Gotchas

Things that look redundant or arbitrary and are not. Most of these are fixes for
bugs the predecessor projects actually shipped.

## Classification

**Label weights are keyed by string, not by a numeric id.** The corn-dog
implementation remapped NudeNet's labels onto a second numeric id space and
looked them up with `classToId[part.class] || -1`, which silently turned id `0`
(`ANUS_EXPOSED`) into `-1` because `0` is falsy in JavaScript. That detection
then matched no composite and was dropped. Strings have no falsy member, so the
whole bug class is gone. Do not reintroduce a numeric id space.

**There is no SFW exclusion list.** corn-dog carried a runtime `SFW_PARTS`
env-configurable list (feet, belly, armpits, faces) to stop a confident foot
detection from flagging an image. Here those labels are simply `neutral` in
`LABEL_WEIGHTS`, so the rule is in one table instead of split between a table
and a list that has to stay in sync with it.

**Detections are sorted before being stored.** NMS output order is not stable.
Without a total order, re-classifying an unchanged file produces a different
JSON blob every time and every row looks dirty. It also makes `rate_frame`
genuinely order-independent, which is the property the tests pin.

**An unknown label degrades to `neutral`, it does not throw.** A newer model
revision adding a class should under-report, not fail every scan.

## Thumbnails

**Every file gets a thumbnail, even when the source is smaller than the target.**
viewer-net only wrote one when the source *exceeded* the size, and the tile fell
back to the full-resolution original when a thumbnail was missing. Two thirds of
that library rendered originals through the protocol handler. A uniform "the
grid always renders a small JPEG" rule is worth the handful of files it
re-encodes pointlessly.

**Animated formats render from the original.** A still thumbnail throws away the
animation, which for a GIF library is the entire point of the file. They still
*get* a thumbnail — that is what the classifier reads.

**JPEG quality is 82, not 100.** viewer-net wrote quality 100 and produced some
thumbnails larger than their sources.

**Thumbnails are content-addressed and sharded two levels.** A flat directory
holding 50,000 files makes every `readdir` on it slow, including the ones the OS
file manager does behind your back.

## The grid

**Offscreen tiles mount no `<img>` — not a lazy `src`, no element at all.** This
is what makes an unvirtualized grid survive a 10,000-file directory: the wrapper
divs are cheap, the decoded bitmaps are not. If you "simplify" this into a lazy
`src`, memory use goes up by orders of magnitude on a large folder.

**The wrapper is sized from the index, before anything loads.** Remove that and
the wall reflows continuously as images arrive, scroll anchoring fights the
user, and the one-pass layout becomes N passes.

**One shared IntersectionObserver, not one per tile.** The registry in
`useInView.ts` is keyed by `rootMargin` and lives for the module's lifetime.
Tests must call `resetInViewRegistry()`, because a suite that swaps the global
`IntersectionObserver` between cases would otherwise keep getting observers
built from the *first* stub. In the app the constructor never changes, which is
why the cache is safe there.

**`rootMargin` defaults to `900px 0px`.** viewer-net used a bare `threshold: 0`
with no margin, so images only began fetching as they crossed the viewport edge
and a fast scroll showed a wall of empty placeholders.

**Random sort is a deterministic shuffle, not `ORDER BY RANDOM()`.** `RANDOM()`
reorders on every query, so page 2 re-shows items from page 1 and silently skips
others.

## The protocol

**Percent-decoding must go through `percent_decode_str`.** viewer-net hand-rolled
a hex decoder that built a `char` from `(high << 4) | low`. A UTF-8 path is a
byte sequence and each byte is not a character, so every non-ASCII filename was
mangled — `Grün.jpg` and anything Japanese or emoji simply 404'd.

**The allowlist is not optional.** viewer-net's handler served any absolute path
on disk to the webview. The `fs` plugin is deliberately not granted either;
granting it would route around this check entirely.

**`Cache-Control: immutable` is safe here** because the watcher deletes both the
row and the derived files when a source changes, so a cached URL can never
outlive its content.

## The pipeline

**A phase's work queue is its loop condition, so anything that gives up on a row
must remove it from that queue.** This cost the first real scan 44 minutes at
40% CPU with zero progress. `pending_thumbnails` selects
`WHERE thumb_path IS NULL AND error IS NULL`; the original failure path called a
`mark_unclassifiable` that set only `classified_at`, leaving `thumb_path` NULL —
so the first unreadable file came back on the very next iteration and the phase
retried it forever, never reaching classification.

`mark_failed` is now the only way out, and it sets `error`. Pinned by
`db::tests::a_file_that_fails_thumbnailing_leaves_the_thumbnail_queue` and
`draining_the_thumbnail_queue_terminates_when_every_file_fails`. If you add a
phase, its "give up" path must clear that phase's queue predicate — and the test
for it should be written by reintroducing the bug and watching it fail.

**Failures are visible and retryable.** A skipped file is otherwise invisible:
the library is simply quieter and smaller than the folder. `LibraryStats.failed`
surfaces the count and `retry_failed` clears the errors and reprocesses, because
a whole batch commonly fails for one fixable reason (an unmounted share, a
missing ffmpeg) rather than for N unrelated ones.

## Scanning

**`@eaDir` is skipped.** Synology's thumbnail sidecar directory mirrors the
entire media tree with small JPEGs. Walking it on a NAS share doubles the file
count and fills the library with 100px duplicates of everything.

**A rescan does not touch existing rows.** Re-upserting on every scan would blow
away thumbnails and verdicts for an entire library the first time a backup tool
rewrites mtimes.

**An unreachable folder must never be pruned from.** `glob_phase` deletes rows
for files the walk did not find, and an unmounted NAS looks exactly like a
folder whose every file was deleted — so without a guard, unplugging a drive
wipes its entire index. Two guards: `root.is_dir()` before any work, and
`is_prune_trustworthy(walked, indexed)`, which refuses to prune when a walk
found nothing but the index holds something. The second catches the cases
`is_dir()` cannot — a share that is mounted but not yet populated, or a
permission failure. The cost of being wrong in one direction is a wiped library;
in the other, some stale rows the next good scan cleans up.

**Startup re-walks every folder, it does not only drain the queues.** The
watcher sees nothing while the app is closed, so a folder that gained or lost
files in the meantime would stay wrong indefinitely. `run_startup` globs every
folder and then drains; `run_pending` (queues only) is for watcher events and
the retry command.

**Symlinks are not followed.** A loop would walk forever.

## Video

**Frame rows are written during extraction, with their true timestamps.**
Recording only the JPEGs and recomputing timestamps at classification time
breaks silently whenever extraction skipped a frame — a seek past the last
keyframe of a truncated file — because frame N on disk is then no longer the Nth
planned timestamp.

**`-ss` goes before `-i`.** That is the fast input seek; ffmpeg jumps to the
nearest keyframe instead of decoding from the start. After `-i` it is accurate
but decodes everything, which on a two-hour file is the difference between
milliseconds and minutes.

**ffmpeg is looked for in Homebrew's directories, not just `PATH`.** A GUI app
launched from Finder or the Dock does not inherit the shell's `PATH`, so a
perfectly working `brew install ffmpeg` is invisible to it. This is the most
common "videos silently do not scan" report.

**Frames are extracted sequentially per video; parallelism is across files.**
Six ffmpeg processes against one file mostly fight over the same disk reads.

## The classifier pool

**Workers are persistent.** corn-dog spawned `python detector.py` per batch,
rebuilding the onnxruntime session (~300–600ms) every time.

**There is a timeout.** corn-dog had none, so a wedged Python process hung the
scan forever. A worker that misses its deadline is killed and respawned, and the
batch is reported as failed per-file rather than lost.

**A worker that cannot be respawned is not returned to the pool.** Returning a
dead slot would deadlock the next caller waiting on `idle.recv()`.

**stdout is the protocol channel.** `classify_worker.py` points `sys.stdout` at
stderr during imports and model load, because nudenet and onnxruntime print
provider warnings on some platforms and a stray line would corrupt the stream.

## DeviantArt

**A DeviantArt error can arrive with HTTP 200.** `stash/submit` switches to
chunked encoding partway through a large upload, by which point the status line
is already on the wire — so it answers 200 and describes the failure in the
body. `interpret_api_body` therefore reads the body *first* and only falls back
to the status. Checking the status first reports failures as successes and then
fails one line later looking for an item id that was never issued.

**The redirect URI must match the registered whitelist character for
character**, which is why the port is a constant and not an ephemeral one. It is
also why the setup panel shows the URI with a copy button rather than hiding it:
a mismatch fails *silently* — the browser lands on DeviantArt's error page and
the app just goes on waiting for a callback that will never arrive.

**The listener is bound before the browser opens.** A port already in use has to
fail before someone logs in, not after they have been redirected into nothing.

**Form booleans are `1`/`0`, not `true`/`false`.** The API is PHP-backed, where
the string `"false"` is truthy — so `noai=false` spelled that way means the
opposite of what it says. Pinned by a unit test because nothing else would
notice.

**`is_mature` and `mature_level` travel together or not at all.** The API
rejects either one without the other, so the panel's checkbox sets and clears
both, and the derivation returns `matureLevel: null` exactly when `isMature` is
false.

**Nothing derives a submission twice.** `packages/core/src/publish.ts` is the
only place that maps a verdict onto tags and mature flags; Rust uploads what the
panel hands it. This is deliberately *unlike* the rating rules, which genuinely
exist in both languages — there, both sides must compute; here, only one does.
Adding a "sensible default" on the Rust side would silently overwrite the edits
someone just made in the review panel.

**The API cannot make a multi-image deviation.** DeviantArt supports them — 10
images per submission, 100 for Core — but only through the website, or by
selecting files in Studio and choosing *More actions ▸ Merge to multi-image*.
`stash/submit` takes one `file`, and passing an existing `itemid` **replaces**
that file rather than adding to it. `stack`/`stackid` are a Sta.sh folder, not a
slideshow. Hence the stack name on the panel: it is not organisation for its own
sake, it is what turns the merge into two clicks instead of hunting twenty files
out of a flat list.

**An upscaled variant has no frame rows.** It inherits its original's *verdict*
at insert, but `replace_frames` only ever runs during classification and a
variant never goes through it — so `media_frames` is empty for it and
`mediaFrames()` returns nothing. This is not an edge case: the grid **hides an
original once a variant exists**, so a variant is what most selections are made
of. Anything that wants per-detection data for a selected row will find none.
The pose rule reads `verdict.topLabel` for exactly this reason, which is also
the more correct source — `rateFrame` defines it as the highest-scoring *rated*
detection, so a 0.99 face already never beats a 0.6 exposure there.

**Two label families are excluded from the pose rule, and both exclusions are
load-bearing.** `ANIME_*` is a whole-image judgement on a frame-filling
placeholder box — it has no location, so it cannot indicate orientation, and it
routinely outscores every located detection. `FACE_*` appears in both
orientations, and NudeNet scores faces higher than almost anything else; a face
turned back over the shoulder is one of the commonest from-behind poses there
is. Letting either compete would decide nearly every picture "front", which is
the single outcome that makes the feature pointless.

**The refresh token expires after three months**, at which point uploads start
failing for someone who connected once and forgot. The failure path says so
rather than reporting a bare rejection.

## Tooling

**The dev server is pinned to 4340, and the pin matters.** `dth-character-studio`
— which is often running on the same machine — uses 4330, so the two Tauri apps
can be up at once. Two things keep it that way:

- `devUrl` in `tauri.conf.json` hard-codes `http://localhost:4340`, so the port
  is not something vite is free to choose. Changing one without the other gives
  a window pointing at nothing.
- `--strictPort` makes vite **fail** rather than fall back to 4341. A silent
  fallback is the worse outcome: the shell would come up and render a blank
  page, which reads as an app bug rather than a busy port.

The two apps are also on different identifiers — `net.glitchvector.luma-vault`
against `com.polynaut.dthcharacterstudio` — so their indexes, thumbnails and
extracted frames live in separate app-data directories and cannot collide
either.

**Rust 1.88+ is required** by several transitive dependencies (`image`, `time`,
`serde_with`). 1.87 fails with a `rustc is not supported` error listing them.

**Python 3.12 is preferred over 3.13/3.14.** The setup script probes in that
order because onnxruntime and opencv ship wheels for 3.12 everywhere; on 3.14
several of these packages have no wheel and pip tries to build from source.

**`protocol-asset` is deliberately absent from the `tauri` features.** The
built-in `asset://` protocol is switched off in `tauri.conf.json`; enabling both
would leave an unchecked path to the filesystem next to the checked one. Tauri's
build script hard-fails when the Cargo features and the config disagree, which
is how this was caught.

**`tauri.conf.json` rejects `"//"` comment keys** inside typed objects — the
config schema denies unknown fields. Rationale for security settings lives in
`.ai/architecture.md` and `capabilities/default.json`'s `description` instead.
`.oxlintrc.json` rejects them too, at both the top level and inside `rules`.

**`apps/desktop` has no `test` or `typecheck` script, on purpose.** It once had
`"test": "cargo test --locked"`, which meant `pnpm -r test` required a Rust
toolchain. That passes on a dev machine, where cargo is on `PATH`, and fails in
any CI job that only installed Node — which is exactly how the first CI run
broke. The Rust checks are run by cargo directly, in their own job.

**oxlint's `no-unassigned-import` is disabled for `**/main.tsx` via an override,
not an inline comment.** The `// oxlint-disable-next-line` form did not take
effect there; the config override does.
