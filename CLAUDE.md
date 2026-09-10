# CLAUDE.md

Guidance for Claude Code working in this repository.

This file stays **short** on purpose. If something is needed on *every* task it
belongs here; if it is needed only when working *in an area*, it belongs in
`.ai/`.

| Read this when… | File |
|---|---|
| Changing how the pipeline, layers or FFI boundary work | `.ai/architecture.md` |
| Writing code, adding a command, touching the wire format | `.ai/conventions.md` |
| Something behaves unexpectedly, or you are about to "simplify" something | `.ai/gotchas.md` |
| Adding or changing tests | `.ai/testing.md` |
| Touching the Patreon post automation, or capturing anything from patreon.com | `packages/patreon-harness/README.md` |

## The shape, in one paragraph

A Tauri 2 desktop app. `packages/core` is a pure TypeScript domain with no I/O
and no DOM. `apps/desktop` is Rust: the SQLite index, the folder scanner, the
thumbnail and ffmpeg pipelines, a pool of persistent Python NudeNet workers, the
`luma://` protocol handler, the filesystem watcher and the LAN server another
machine browses this library through. `apps/web` is a React SPA
whose only native access is `src/lib/native.ts`. `contracts/` holds golden JSON
fixtures that *are* the wire format, checked from both languages.

## Do not break these

1. **If any sampled frame of a video is sexy, the whole video is sexy**, and the
   poster is the *first* sexy frame (or the middle frame when there is none).
   That rule is the product. It is pinned in `contracts/classify-vectors.json`.
2. **The rating rules exist in two languages** — `apps/desktop/src/rating.rs` and
   `packages/core/src/classify.ts`. Never fix one side alone. Both are driven by
   the shared vectors, so a rule change should fail two suites.
3. **A tile must know its size before its image loads.** That is what makes the
   grid fast without virtualization. Anything that defers dimensions to image
   load undoes it.
4. **The `luma://` allowlist.** A file is served only from inside a watched
   folder or the app's own derived-data directories. Do not add a bypass, and do
   not grant the `fs` plugin to the webview. Remote mode's file route goes
   through the same `protocol::serve` — keep it that way.
5. **Per-item failures are rows, not exceptions.** One corrupt file must never
   abort a scan.
6. **Nothing automated opens patreon.com.** The account is a live creator
   account behind Cloudflare. Every capture is driven by a human through
   `pnpm patreon capture`; endpoints are captured, never guessed; the tool
   produces drafts and never publishes. See `packages/patreon-harness/README.md`.

## Commands

```bash
pnpm install
pnpm setup:python        # venv-classifier + model self-check
pnpm dev:desktop         # the real app
pnpm dev                 # SPA only (shows a "run the desktop app" notice)
pnpm queue --drain       # render everything queued with --queue, when the GPU may be loud
```

The gate that matches CI:

```bash
pnpm lint && pnpm -r typecheck && pnpm -r test
cargo clippy --manifest-path apps/desktop/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/Cargo.toml
```

## Communication

- Always close a response with a `TL;DR:` line (1-3 sentences). Detail and long
  answers are fine — the TL;DR exists so the reader can skim first and read the
  rest only if needed. It goes last, after everything else, and states the
  outcome and anything still open. Skip it only for one-line answers, where it
  would just repeat the response.

## Style

- TypeScript strict; the flags live only in `tsconfig.base.json`.
- Functional React components; `memo` where a parent re-renders often.
- Rust: every I/O-touching command is `#[tauri::command(async)]`.
- Comment the *why*, never the *what*. A comment that restates the next line is
  noise; a comment recording a constraint the code cannot express is the point.
