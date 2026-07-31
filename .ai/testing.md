# Testing

Four layers, each answering a different question.

## 1. Unit — the pure core

`packages/core/src/*.test.ts`, vitest. Fast because the domain has no I/O:
`rateFrame` takes detections and returns a verdict, so every rule is testable
without a scan, a model, or a file.

Covers the label weights, the thresholds, video rollup, poster selection, the
sampling plan, and the path/format helpers.

## 2. Contract — the FFI boundary

Two halves that must agree:

| Half | File | Check |
|---|---|---|
| Rust | `apps/desktop/src/contract_tests.rs` | deserialize the fixture → re-serialize → assert byte-identical |
| TypeScript | `packages/core/src/contracts.test.ts` | `schema.parse(fixture)` → assert `toEqual(fixture)` |

The `toEqual` half is the one that earns its keep: zod's `parse` **strips**
unknown keys, so a schema missing a field the fixture carries would pass a bare
`parse()` without complaint.

## 3. Shared vectors — logic that exists twice

`contracts/classify-vectors.json` drives **both**
`apps/desktop/src/contract_tests.rs` and `packages/core/src/vectors.test.ts`.

This is the mitigation for the deliberate duplication described in
`.ai/architecture.md`. The Rust and TypeScript suites build the same stub frames
from the same rating names and assert the same outcomes. A rule change should
fail both; if it only fails one, the vectors do not cover it yet.

## 4. Rust unit — the parts with real I/O

`apps/desktop/src/{db,scan,thumbs,protocol}.rs`, `#[cfg(test)] mod tests`.

- **`db`** runs against an in-memory SQLite, so the query builder, the LIKE
  escaping, the cascade deletes and the pipeline's work queues are all covered
  without touching disk.
- **`scan`** builds a real temp tree, including an `@eaDir` and a `._` sidecar,
  and asserts only the media comes back.
- **`protocol`** covers the allowlist — including a `..` traversal that must be
  collapsed by canonicalization — and the percent-decoding of non-ASCII and
  emoji paths.

## Component tests

`apps/web/src/components/MediaTile.test.tsx`, jsdom. These pin the two
properties the grid's performance rests on, both easy to break with an
innocent-looking refactor:

1. a tile occupies its final size **before** any image loads,
2. an offscreen tile mounts **no `<img>` at all**.

They stub `IntersectionObserver` and must call `resetInViewRegistry()` in
`afterEach` — see `.ai/gotchas.md` for why.

## The bar for a regression test

**Fail, then pass.** Temporarily reintroduce the bug and watch the new test go
red. A test that passes against both the broken and fixed code is testing
something else.

## The local gate

```bash
pnpm lint && pnpm -r typecheck && pnpm -r test
cargo clippy --manifest-path apps/desktop/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/Cargo.toml
```

This is exactly what CI runs. Nothing is checked in CI that cannot be run here.

## What is deliberately not tested automatically

The classifier itself. Asserting model *outputs* would pin NudeNet's weights
rather than our code, and would break on every upstream model revision for
reasons that are not regressions. What is tested is everything around it: the
protocol framing, index alignment on failure, timeout and respawn behaviour, and
the rules applied to whatever the model returns.

Verify the model end-to-end by hand instead:

```bash
printf '{"id":1,"cmd":"classify","paths":["/some/image.jpg"]}\n{"cmd":"shutdown"}\n' \
  | ./venv-classifier/bin/python sidecar/classifier/classify_worker.py
```

On Windows the venv puts the interpreter under `Scripts/`, so run the same thing
from **Git Bash**:

```bash
printf '{"id":1,"cmd":"classify","paths":["D:/some/image.jpg"]}\n{"cmd":"shutdown"}\n' \
  | ./venv-classifier/Scripts/python.exe sidecar/classifier/classify_worker.py
```

Not from PowerShell: piping strings to a native command there prepends a UTF-8
BOM to the stream, and the worker answers every request with `malformed request:
Unexpected UTF-8 BOM`. Neither `$OutputEncoding` nor `[Console]::OutputEncoding`
suppresses it. Nothing sends a BOM in production — the Rust side writes the pipe
itself — so this is a shell artifact, not a bug worth working around in the
worker.
