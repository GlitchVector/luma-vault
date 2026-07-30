# Architecture

## Layers

```
packages/core     pure domain — zod schemas, label weights, rating rules
                  no I/O, no framework, NO DOM (its tsconfig omits the lib, so
                  an accidental `window` or `fetch` fails to typecheck)
      ▲
      │ workspace:*
apps/web          React 19 SPA. Every native call goes through src/lib/native.ts.
packages/ui       app-agnostic React kit. No Tauri, no router, no fs.
      ▲
      │ frontendDist: ../web/dist  (a build artifact, not an npm edge)
apps/desktop      Tauri 2 / Rust. The index, the pipeline, the protocol, the
                  watcher, and the classifier pool.
      │ stdin/stdout JSON lines
sidecar/classifier  persistent NudeNet workers
```

Both libraries are **consumed as source** — `exports: "./src/index.ts"`, no
build script, no `dist`. Vite and `tsc` compile the TypeScript inline. That
removes the entire build-orchestration problem: there is no build graph, nothing
to sequence, and no stale artifact to debug. The one cost is that Tailwind
cannot auto-detect `packages/ui`'s classes, paid by an explicit `@source` in
`apps/web/src/styles.css`.

## The pipeline

`apps/desktop/src/pipeline.rs`. Three phases, on a background thread.

```
glob ──▶ thumbnail ──▶ classify
 │           │              │
 │           │              └─ pool of persistent Python workers (classifier.rs)
 │           └─ image crate, or ffprobe+ffmpeg for videos (thumbs.rs, video.rs)
 └─ walkdir (scan.rs)
```

**Each phase's work queue is a database query**, not an in-memory list.
`pending_thumbnails` is "rows with no thumbnail"; `pending_classification` is
"rows with a thumbnail and no verdict". This is the single most load-bearing
design decision in the backend, and it buys:

- **Restartability for free.** Quit mid-scan, reopen, and the pipeline resumes
  by asking what still needs doing. There is no journal, no checkpoint, no
  resume logic.
- **Idempotence.** Running a scan twice is harmless, so the watcher, a manual
  rescan and the startup sweep can all call the same code without coordination.
- **A natural bound.** Rows are drained a page at a time, so a million-file
  library never materialises a million-element `Vec`.

Progress is one event shape (`ScanProgress`) for all phases on
`luma://progress`, so the status bar is one component and a new phase costs the
frontend nothing.

### Failure policy

Per-item failures become rows in `ScanProgress.errors` and never propagate. One
corrupt JPEG, one video with no container duration, one permission-denied
directory — none may cost the rest of the library. A file that fails is marked
processed so it is not retried on every future pass. The only fatal condition is
"the classifier will not start at all", and even that degrades: files are still
indexed and thumbnailed, and the status bar says why they are unrated.

### Why videos get a poster twice

During thumbnailing a video is given a **provisional** poster — the middle
frame — so it appears in the grid seconds after a scan starts. Classification
then replaces it with the real poster, the first sexy frame. The tile appears,
then sharpens into the right frame.

## The classifier sidecar

`apps/desktop/src/classifier.rs` + `sidecar/classifier/classify_worker.py`.

A pool of **persistent** processes, one per core minus two, capped at eight. Each
loads the ONNX model once and then serves batches over line-delimited JSON. The
pool hands a worker out and blocks until one is free, which *is* the backpressure
— the scan cannot outrun the classifier and pile up unbounded work.

Protocol: one request per line, one response per line, `id` echoed back. `results`
is always the same length and order as `paths`; a file that fails becomes an
`ok: false` entry rather than shifting every later index. That 1:1 alignment is
load-bearing, because results are mapped back onto database rows positionally.

Boxes are normalised to **fractions of the image** in Python, where the pixel
dimensions are already in hand. Nothing downstream has to remember what
resolution a detection was computed at.

## The FFI boundary

`contracts/*.json` are golden fixtures that **are** the wire format.

- **Rust** — `apps/desktop/src/contract_tests.rs` deserializes each fixture,
  re-serializes, and asserts byte-identical output.
- **TypeScript** — `packages/core/src/contracts.test.ts` runs `schema.parse()`
  and asserts `toEqual(fixture)`. Since zod strips unknown keys, the deep-equal
  also catches a fixture field the schema would silently ignore.

Every call site parses rather than casts. A bare `invoke<T>()` would let a shape
mismatch travel three layers into the UI before surfacing as a confusing
`undefined`.

## Logic that exists twice

The rating rules are in `apps/desktop/src/rating.rs` **and**
`packages/core/src/classify.ts`. Rust needs them because the scan runs there; the
UI needs them to re-derive a verdict without a round trip.

Mirrored logic drifts. The mitigation is `contracts/classify-vectors.json`,
which drives both suites. A rule change means editing that file and watching two
suites fail together. **Never fix one side alone.**

The same applies to `sampling.rs` / `sampling.ts`.

## Storage

Everything lives under the OS app-data directory:

```
index.db      SQLite (WAL). A cache of the filesystem, never the source of truth.
thumbs/       ab/cd/<hash>.jpg — content-addressed on the absolute source path,
              sharded two levels so no directory holds more than a few hundred.
frames/       ab/cdef…/frame_0000.jpg — one directory per video.
```

`rating` and `is_sexy` are denormalised out of the verdict JSON into indexed
columns, because filtering by parsing JSON across 50,000 rows on every keystroke
is the difference between an instant grid and a visibly janky one.

## Security

The `luma://` handler (`apps/desktop/src/protocol.rs`) serves a file only from
inside a watched folder or the app's own derived directories, with both sides
canonicalized so `..` and symlinks cannot escape. The CSP forbids the page from
reaching any remote origin, which is what makes the allowlist meaningful: even a
compromised page has nowhere to send what it reads. The `fs` plugin is **not**
granted to the webview — its only native file access is the folder picker.
