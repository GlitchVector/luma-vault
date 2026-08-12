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

**`verdict.rating` is the model's opinion, never the answer.** A person can
correct a false positive, and the correction lives in `ratingOverride` — so
`effectiveRating(item)` is what everything draws, filters and uploads from.
Reading the verdict directly is the bug this arrangement exists to make
visible: a tile would wear a red dot while the grid filed the picture as safe,
and a corrected picture would still go to DeviantArt flagged mature.

**A correction is a separate column for the same reason `stars` is.**
`rerate_phase` rewrites every verdict whenever `RATING_VERSION` moves, so a
correction stored inside one would be undone by the next threshold tweak —
silently, and at exactly the moment a wrongly-explicit picture would be
expected to change anyway. `update_verdict` therefore always writes
`verdict_json` and skips `rating`/`is_sexy` on a corrected row. Keeping the
verdict intact is also what makes "use the model's" cost no inference.

**The effective rating is mirrored into `rating` and `is_sexy`.** Those two
columns are what every filter, index and count reads, and they were not taught
about corrections — a correction that only lived in `rating_override` would
move the badge and nothing else. `set_rating_override` writes all three.

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

**Two sorts lean on NULL ordering, in opposite directions, and both are
deliberate.** SQLite sorts NULL smallest. `lowest` (stars ascending) therefore
opens on the unstarred, which is the pile the order exists to reach; `score`
(strongest detection, descending) sends the unclassified to the end, because a
row nothing has looked at has not earned the top of a confidence ranking. Adding
`NULLS LAST` to both would break one of them. `aspect` divides by `height`, so
it needs `NULLIF(height, 0)`: a row is 0×0 until the measure phase reaches it,
and integer division by zero is an error mid-query rather than a NULL.

## The search index

**`media_fts` has three columns and every query names the ones it means.** A
bare `MATCH "moona"` searches `name`, `prompt` *and* `dir` — so dropping the
`{name prompt}` filter would quietly fold folder names into the ordinary search,
and dropping `{dir}` would make the folder toggle do nothing visible. Both are
built in `fts_expression`.

**FTS5 binds a column filter to the first term only.** `{dir} : "a" AND "b"`
restricts `"a"` and lets `"b"` match anything, which is why the whole
conjunction is parenthesised. The failure is invisible on one-word searches and
appears only once somebody types two, which is why there is a test for it.

**`media.dir` is a VIRTUAL generated column, and `PRAGMA table_info` cannot see
it.** `table_info` lists only columns whose hidden flag is 0; a generated
column's is 2. Every other migration in `db.rs` checks with `table_info`, so
matching them here is the natural mistake — and it makes the "does this column
exist" check permanently false, which means the `ALTER` runs on every launch and
fails on the second one with "duplicate column name", taking every migration
after it down with it. Use `table_xinfo`.

**Changing what is indexed means bumping `FTS_VERSION`.** The version does not
just trigger a rebuild — it is also what drops the old table and triggers.
`CREATE VIRTUAL TABLE IF NOT EXISTS` cannot add a column to an index that
already exists, and neither can `CREATE TRIGGER IF NOT EXISTS`, so without the
bump an upgraded library keeps the old shape and answers new queries with
nothing.

## Finding what an img2img was made from

**Two perceptual thresholds exist, and they are not the same question.**
`dupes` asks "is this the same picture" at **3** bits. `origin` asks "was this
made from that picture" at **8**, and *excludes* everything at 3 or under.
Unifying them looks like an obvious simplification and breaks both: a re-encode
would be offered as a picture's own source, and a genuine init image five bits
away would be invisible. The exclusion is the point — a duplicate is not what
anything was generated from.

**The thresholds are measured, not chosen.** txt2img rows are the negative
control: with no init image, any link found for one is wrong by construction.
At 8 bits and colour 16, 65% of img2img rows link against 4% of the control.
Widening to 12 bits and colour 25 buys five points of recall and multiplies the
false rate by two and a half. `contracts/origin-vectors.json` pins the rule in
both languages; changing a constant should fail two suites.

**`reachedRoot` is not decoration.** 28% of img2img rows walk back to a real
txt2img, 40% stop on another img2img with no findable source of its own, 33%
have no link at all. The middle case is still worth showing — its prompt may
name the character — but presenting it as the original is a claim the data does
not support, and the UI keeps "still looking", "found nothing" and "found"
visually distinct for the same reason.

**An ancestor's prompt is evidence, never an input.** The whole point of an
img2img chain is often to keep a composition and change the subject, so an
ancestor can confidently name a character who is no longer in the picture.
Nothing auto-merges it — not the panel, not `migrate-prompt`. Measured: one
chain's parent describes Kiryu Coco where the child is Misty.

**The walk cannot cycle, and there is no visited set.** Every hop is strictly
older than the last, so time is the guard. `MAX_HOPS` is a backstop against a
pathological chain, not a tuning knob — the median walk is two hops.

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

**An excluded folder is a `.lumaignore` on disk and nothing else.** There used to
be a second mechanism — a row in `excluded_folders` that `walk_folder` also
consulted — and the two disagreed in both directions: a folder excluded in the
app came back whenever the index was rebuilt or copied to another machine, and
one marked on disk was never listed as excluded at all. The table still exists,
but only as the record that lets the sidebar list an exclusion and undo it. If
you find yourself teaching the walk about a second source, that is the bug
returning.

**A marker at the top of a watched folder does nothing.** `filter_entry` returns
true unconditionally at depth 0, so the root's own `.lumaignore` is never read —
which is why `can_exclude` refuses a watched root outright and points at
**Remove folder** instead. Honouring it there would mean an empty walk, and an
empty walk is the shape of an unplugged NAS.

**The watcher has to skip what the walk skips, or exclusion lasts until the next
file arrives.** Excluding a folder is something you do *while generating into a
sibling of it*, so the very next file lands with the app open and the watcher —
not the walk — deciding. `MarkerCache` answers per directory rather than per
file, because a debounced batch is thousands of paths sharing a handful of
directories and those stats are the expensive part on SMB.

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

**The API cannot make a multi-image deviation, and no amount of trying will
change that.** `stash/publish` takes exactly one `itemid` — an integer, not a
list — and `deviation/edit` accepts only metadata, with no parameter for
attaching a second image. Multi-image deviations exist on the site and are made
in Studio by selecting several drafts and merging them. So the batch upload
posts one deviation per picture, and everything the panel does around that is
aimed at making the *merge* cheap: one stack, one title, and the chosen poster
uploaded **first**, because upload order is stack order and stack order is what
the merge turns into image 1, 2, 3. Do not remove the ordering pass on the
grounds that the API ignores it — Studio does not.

**`display_resolution` defaults to downscaling.** Left unsent, a 2627x3840
upload displays at 1280 wide, which throws away the reason for uploading a 4K
render at all. The docs give the field as an integer 0-8 and never say what the
numbers mean; the mapping in `DISPLAY_RESOLUTIONS` is read off the submission
form's own dropdown, which lists exactly nine widths with Original first, and
agrees with their one documented constraint — that a value "cannot exceed
original image size".

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

**What has already been posted is keyed on the path, not on `media.id`.** A
row's id does not survive the index being rebuilt, which is something this app
does deliberately — and losing the record would silently un-post pictures that
are demonstrably public, sending someone to upload them a second time. So
`deviantart_posts` has no foreign key and no cascade, and its rows outlive the
media rows they were made for. The trade is that moving the files loses the
badge, which is the rarer half.

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

**An upscaled variant has no frame rows of its own.** It inherits its
original's *verdict* at insert, but `replace_frames` only ever runs during
classification and a variant never goes through it. This is not an edge case:
the grid **hides an original once a variant exists**, so a variant is what most
selections are made of. `media_frames` therefore answers a frameless variant
with its **original's** frames (`frames_for_media_or_original`) — same picture,
and a box is stored as fractions of it, which is what put detection boxes back
on 4K upscales in the lightbox. The raw table is still empty for the variant,
and an original that left the library leaves the answer empty; anything reading
`media_frames` directly in SQL will still find nothing. The pose rule predates
the fallback and reads `verdict.topLabel` instead, which is also the more
correct source — `rateFrame` defines it as the highest-scoring *rated*
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

## Remote mode

**`tiny_http::Server::unblock()` wakes exactly one waiter.** It pushes a single
marker onto the request queue, so with eight worker threads a stop unblocks one
and the other seven sit in `recv` forever — holding the listener, and hanging any
join that waits for them. `Sharing::stop` calls it once per worker.

**A panic in a worker used to kill the whole shared library, silently.** The
worker loop is `for request in server.incoming_requests()`, so an unwind retires
that thread for good — and there are eight. The listener lives in `Running`, not
in the workers, so after the last one has gone the port is *still bound* and
connections are *still accepted*; nothing ever answers them. On the browsing
machine that reads as a grid frozen mid-session: the rows it has stay, filter
changes do nothing, and there is no error anywhere at either end. `answer` is
wrapped in `catch_unwind` for this reason, and a test fires more panics than
there are workers and then asks an ordinary question.

**One panic used to be enough**, because `Db.conn` is a `Mutex` and a panic
while holding it poisons the lock — after which every `lock()` panics, so all
eight workers fall in a row. `Db::connection()` takes the guard back out of a
poisoned lock rather than propagating. Sound here specifically: it guards a
SQLite connection, an unfinished transaction rolls back when the guard drops,
and this index is a rebuildable cache.

**Every remote call needs its own timeout, and the client has no read timeout on
purpose** — it also carries the upscale, which runs for minutes. So `Session::
call` sets a per-request limit: `CALL_TIMEOUT` for ordinary operations, and a
much larger one for the handful in `SLOW_OPERATIONS`. Without it, a peer that
accepts a connection and never answers leaves the future pending for ever, and
every later query queues behind it — a frozen window with an empty log. Add new
long-running operations to that list or they will be cut off at 25 seconds.

**A wildcard-bound server does not shut down on Windows without a knock.**
tiny_http's `Drop` wakes its accept thread by connecting to the listener's own
local address, which for a `0.0.0.0` bind *is* `0.0.0.0` — an address Windows
refuses to connect to. The thread stays parked in `accept()`, never sees the
close flag, and keeps the port for the life of the process: sharing could be
switched off but never on again. `stop` therefore connects to `127.0.0.1` on the
same port after dropping the server. Pinned by
`sharing_can_be_stopped_and_started_again_on_the_same_port`, which is the
sequence somebody changing the passphrase performs.

**`start` retries the bind for a second.** Even a clean shutdown hands the port
back on the accept thread's schedule, so stop-then-start can arrive while it is
still held. Failing there would report "something else may already have that
port", which would be a lie and unactionable.

**File URLs carry `&from=<peer>`.** Responses are cached as `immutable` and a
thumbnail is addressed by a hash of its **absolute source path** — so two
machines with the same folder layout produce the identical `luma://` URL for
different pictures, and the grid would serve one machine's thumbnail for the
other's file. The backend reads up to the first `&` and ignores the rest; only
the cache key cares.

**The progress poll must not mark the library dirty when nothing is running.**
The subscription only fires during a scan, but the poll answers forever — and
`dirty` is what the four-second reconcile timer watches, so marking it on an idle
snapshot re-queries the grid every four seconds for the life of the app. It also
keeps the previous `ScanProgress` object when nothing moved, or every idle poll
re-renders the whole window.

**Connecting and disconnecting reload the page.** Folders, the grid and its
paging, the timeline buckets, the character leaderboard and the progress
subscription all describe one library, and a session swaps every one of them at
once. The reload cannot be half-done; reconciling each piece can. The browser
client's login and logout reload for the same reason.

**Tailscale addresses fail `is_lan`, and that is currently deliberate.** The
tailnet hands devices 100.64.0.0/10 — the CGNAT range — which is not in
`is_private()`, so a phone dialing the host's Tailscale IP directly gets a 403
before the passphrase is even read. The way in from outside the LAN is a
**subnet router** advertising 192.168.1.0/24: its default SNAT means the host
sees a LAN source address, and the phone types `192.168.1.160:7870` from
anywhere. Widening `is_lan` to 100.64/10 would also admit every customer of an
ISP that puts its users behind CGNAT, which is why it is not the default —
if that trade is ever wanted, it belongs behind a setting.

**The share server serves whatever `apps/web/dist` held at `cargo build` time.**
`include_dir!` embeds the bundle into the binary; `build.rs` creates the
directory (possibly empty) so a fresh clone or CI compiles, and emits
`rerun-if-changed` so a rebuilt bundle is picked up on the next cargo build.
Two consequences: a host built before ever running `pnpm --filter @luma/web
build` answers phones with a 503 notice, and a freshly rebuilt SPA does not
reach phones until the desktop app is rebuilt too. `pnpm dev` (vite) does not
count — the embedded copy is the built one.

**A browser session dies when sharing restarts, by design.** The cookie token
is minted per `Sharing::start` and lives nowhere else. A phone that suddenly
gets 401s mid-session is not broken — somebody toggled sharing or changed the
passphrase, and the page reloads onto the passphrase screen. Deriving the token
from anything stored would keep old cookies alive across a passphrase change,
which is the exact moment they must die (pinned by
`a_cookie_dies_with_the_server_that_minted_it`).

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
The exact version is pinned in `rust-toolchain.toml`, which rustup reads without
being asked — bumping it re-downloads a toolchain on every machine and costs one
cold CI run.

**Three things key the CI cache, and all three are pinned for the same reason.**
`Swatinem/rust-cache` hashes the compiler's identity, its own version, and the
lockfile; a change in any of them means no cache, and no cache means the whole
graph is compiled twice — once to check, once for the codegen `cargo test`
needs. That is fifteen minutes against two.

- The toolchain is pinned, not `stable`, so a Rust release cannot do it.
- The action is pinned **to a commit**, not to `@v2`. That tag moves: v2.9.2
  landed on the morning of 2026-08-06 and re-keyed everything, orphaning five
  gigabytes of caches with the compiler unchanged at 1.97.1. Both runs that
  morning built from scratch, and the symptom — `No cache found.` — names
  nothing that changed.
- The lockfile is the one that *should* invalidate. A dependency change costs a
  partial rebuild, which is the point.

**The cache is saved on `main` only.** Each run writes over a gigabyte into a
ten-gigabyte budget, and GitHub evicts least-recently-used — so a few
pull-request runs push out the one cache every branch restores from. A branch
that has not touched `Cargo.lock` gets a full hit from main regardless.

**CI builds with `--profile ci`, not `dev`.** It is the dev profile minus the
optimized dependencies (`[profile.dev.package."*"] opt-level = 3`), which exist
so a *scan* is fast and do nothing for a test suite over fixtures a few hundred
pixels wide. Locally the difference is 0.67s of test runtime against 1.24s; on a
cold CI build it is most of the codegen time. Both CI steps use the same profile
so they share one set of artifacts — running one under `dev` and the other under
`ci` would compile the graph twice and cache both.

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
