# Luma Vault

A local media vault. Point it at folders of images and videos; it indexes them,
builds thumbnails, classifies everything on your own machine, watches the
folders for changes, and renders the whole library in one very fast grid.

Nothing is uploaded. Nothing is moved or renamed. The index is a cache — delete
it and a rescan rebuilds it.

```
┌──────────────┐   luma://   ┌───────────────────────────────┐
│  React SPA   │ ◀────────── │  Tauri 2 / Rust               │
│  (apps/web)  │   invoke    │  index · scan · thumbs · ffmpeg│
└──────────────┘ ──────────▶ └──────────────┬────────────────┘
                                            │ stdin/stdout JSON lines
                                   ┌────────▼─────────┐
                                   │ NudeNet workers  │
                                   │ (Python sidecar) │
                                   └──────────────────┘
```

## Quick start

```bash
pnpm install
pnpm setup:python      # creates venv-classifier and verifies the model loads
pnpm dev:desktop       # builds the Rust shell and opens the app
```

`setup:python` also downloads a ~378MB Danbooru-trained tagger into `models/`.
NudeNet is trained on photographs and under-fires badly on drawn content, so
that model is a second opinion for it — measured on a real library, it flags 21%
of the illustrated images NudeNet rated SFW, while agreeing with it on 84% of
what it had already flagged. It is optional: a missing model means drawn content
is rated by NudeNet alone, not a broken scan.

That second opinion is a **separate, later pass**, for a measured reason. Run
inline on every file it cost 2.13 files/s against 4.13 for NudeNet alone on the
same 66,000-file library — a 378MB ViT at 448px roughly doubles the price of
rating a file, and paying it up front means *nothing* is rated until everything
is. So phase 4 revisits only what came out SFW, which is the only place the
tagger can change an answer: it raises a rating, never lowers one. The library
is fully usable while it runs, and interrupting it costs accuracy on
illustrations and nothing else.

`setup:python` needs Python 3.11–3.13 and, for video, `ffmpeg` on PATH
(`brew install ffmpeg`, or `winget install Gyan.FFmpeg` on Windows). Both are
checked and reported rather than assumed — if
either is missing the app still indexes and thumbnails, it just does not rate
anything, and says so in the status bar.

## Stable Diffusion integration

Generated images carry their own parameters, and Luma Vault reads them straight
out of the file — prompt, negative prompt, model, seed, sampler, steps, CFG —
for every generator that writes them, not just one install's worth. The prompt
is searchable from the same box as filenames.

Star ratings are the exception: they exist only in a
`stable-diffusion-webui-images-browser` database, because they were never in the
PNG. Any `wib*.sqlite3` found while scanning a folder is read automatically, and
ratings for folders you have not scanned yet are kept until you do.

**Open in Forge** hands a picture's parameters back to a running webui. Forge is
a Gradio app whose component state cannot be set from a URL, so a small
companion extension does the last step:

```bash
pnpm setup:forge                              # finds your webui
pnpm setup:forge "D:\AI\...\webui"            # or say where it is
pnpm setup:forge --uninstall
```

Restart Forge afterwards. The extension is optional — without it the button
still copies the full parameter block and opens the tab, and you paste it in and
press ↙ yourself. Its source lives in `integrations/forge-prefill/` so a webui
reinstall costs one command; see the README there for what it hooks and what to
check if a future Forge renames it.

## How a folder becomes a grid

Adding a folder starts a background pipeline. Each phase's work queue is a
*database query* — "rows with no thumbnail", "rows with no verdict" — so the
whole thing is restartable: quit halfway through a 50,000-file scan, reopen, and
it resumes exactly where it stopped. It is also what makes the CPU throttle
work mid-scan: a phase can abandon its pass and be re-run at a new size,
because re-running costs a query.

1. **Glob.** Walk the tree, skipping VCS directories, dot-files, Synology's
   `@eaDir` mirrors and any folder you excluded. New files are inserted; rows
   whose file has vanished are dropped. Existing rows are left untouched, so a
   rescan is cheap and a backup tool rewriting mtimes cannot wipe your verdicts.
   Any `wib*.sqlite3` seen on the way past is imported for its star ratings.
2. **Measure.** Read each file's dimensions from its header. Its own phase
   because it is what lets a tile be sized before anything is painted.
3. **Thumbnail.** Every file gets a 512px JPEG — unconditionally, even when the
   source is smaller. Videos are probed with `ffprobe`, sampled on an interval,
   and their frames extracted with `ffmpeg`; the middle frame becomes a
   provisional poster so the video appears in the grid immediately.
4. **Classify.** Thumbnails (never the multi-megapixel originals) go to a pool
   of persistent Python workers running NudeNet. Images get one verdict. Videos
   get one per sampled frame, rolled up.
5. **Fingerprint.** A perceptual hash per image, for finding duplicates. Taken
   from the thumbnail, which is why resolution stops mattering: both sides of
   any comparison were already reduced to 512px before a bit was computed.
6. **Label.** What *kind* of picture each row is, independent of its rating —
   a scan, a generated image — plus the generation parameters read out of the
   file itself.
7. **Review.** The anime tagger re-examines everything phase 4 called SFW, and
   only that. It runs last and on its own so the library is fully rated before
   the expensive model starts — see below.

### How a video is rated

Sampled on a 10-second interval, clamped to 60 frames, skipping the first 60 and
last 45 seconds of anything longer than 7 minutes — logos and credits are
representative of nothing.

**If any sampled frame is sexy, the whole video is sexy.** A max, not a vote: one
explicit frame in an hour still makes the video explicit, because the flag
answers "can this be on screen", not "how much of it".

The poster follows the same rule — the **first** sexy frame if there is one, so
the tile shows what earned the flag; otherwise the **middle** frame, so an SFW
video still gets a representative tile.

## Why the grid is fast

No virtualization, no masonry library, no windowing. Three structural choices do
the work:

- **Tiles are sized before anything loads.** Dimensions come from the index,
  recorded at scan time, so the whole wall lays out in one pass and nothing
  shifts as images arrive.
- **Offscreen tiles mount no `<img>` at all** — not a lazy `src`, no element.
  Ten thousand empty sized divs are cheap; ten thousand decoded bitmaps are not.
  A single shared `IntersectionObserver` drives every tile.
- **Local files stream through a custom `luma://` scheme.** No base64 (33%
  inflation, a JSON parse and a React state update per image, and no browser
  cache), no local HTTP server, no blob URLs.

Layout itself is `flex-wrap`: the browser's line-breaking algorithm places every
tile in one C++ pass, which is what a JavaScript masonry would do in many.

## Security posture

- The `luma://` handler serves a file only if it is inside a **watched folder**
  or the app's own derived-data directories. Both sides are canonicalized, so
  `..` and symlinks cannot escape.
- The CSP forbids the page from reaching any remote origin. That is what makes
  the allowlist meaningful: even a compromised page has nowhere to send what it
  reads.
- The `fs` plugin is **not** granted to the webview. Its only native file access
  is the folder picker. Granting it would route around the allowlist.
- Every `ffmpeg`/`ffprobe` invocation passes an argv array, never an
  interpolated shell string.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Pure domain: zod schemas, label weights, rating rules. No I/O, no DOM (enforced by its tsconfig). |
| `packages/ui` | App-agnostic React kit. No Tauri, no native imports. |
| `apps/web` | The SPA. All native access confined to `src/lib/native.ts`. |
| `apps/desktop` | Tauri 2 shell: index, scanner, thumbnails, ffmpeg, classifier pool, protocol, watcher. |
| `sidecar/classifier` | The persistent NudeNet worker and its pinned requirements. |
| `integrations` | Things that live inside *other* applications. Kept here so a reinstall of the host does not lose them — see `pnpm setup:forge`. |
| `contracts` | Golden fixtures that *are* the wire format, checked from both languages. |

Libraries are consumed as source (`exports: "./src/index.ts"`, no build step), so
there is no build graph to orchestrate and no stale `dist` to debug.

## Checks

```bash
pnpm lint && pnpm -r typecheck && pnpm -r test   # TypeScript
cargo clippy --manifest-path apps/desktop/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/Cargo.toml
```

The rating rules exist in **two** languages — Rust runs them during a scan, the
UI re-derives them without a round trip. Both are driven by
`contracts/classify-vectors.json`, so changing a rule fails two suites at once.
That is deliberate; see `.ai/architecture.md`.

## Prior art

This is the successor to a long line of attempts at the same idea. The
architecture and monorepo conventions come from `dth-character-studio`, the
Python/NudeNet integration from `corn-dog`, and the grid from `viewer-net`. What
changed, and why, is written down in `.ai/gotchas.md`.
