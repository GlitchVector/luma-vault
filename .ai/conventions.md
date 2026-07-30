# Conventions

## The wire-format ritual

A new structured value crossing the FFI boundary needs **three** things, in the
same PR:

1. a zod schema in `packages/core/src/schemas.ts`,
2. a fixture in `contracts/`,
3. a case in the test table on **both** sides —
   `apps/desktop/src/contract_tests.rs` and
   `packages/core/src/contracts.test.ts`.

Fixtures should carry awkward rows deliberately: an unclassified item with
`null` everywhere, a scan carrying a non-fatal error, a video next to an image.
The null-ness and the error channel are part of the contract too.

## The rating-rule ritual

Changing how something is rated means editing **four** places:

1. `contracts/classify-vectors.json` — add or change the case first,
2. `apps/desktop/src/rating.rs`,
3. `packages/core/src/classify.ts`,
4. run both suites and watch them agree.

If only one suite fails, the vectors do not cover the change yet. Fix that
before fixing the code.

## Rust commands

- `#[tauri::command(async)]` on anything that touches the filesystem or the
  index. A synchronous command runs on the **main thread**; a query against a
  200,000-row index — or a `stat` on an unreachable network share — freezes the
  window.
- Return a type that has a zod twin and a contract fixture.
- Errors are `String`, written for a person reading a toast, not a stack trace.
- Long work goes on a spawned thread and reports through `luma://progress`; a
  command that starts a scan returns as soon as the row exists.

## Rust style

- Per-item failures are collected, never propagated. `let _ = …` on a
  best-effort write is correct here and is not laziness — but it should be
  paired with a push onto the error list where the user can see it.
- Prefer a struct over more than a handful of positional parameters.
  `update_thumbnail(id, path, 320, 240, 1600, 1200, None)` is four integers in a
  row that all mean different things, and swapping two typechecks perfectly.
  `ThumbnailUpdate` exists for exactly that reason.
- Never build a shell command by interpolating a path into a string. Always pass
  an argv array. This app points at arbitrary user folders by design.

## TypeScript

- Strictness flags live only in `tsconfig.base.json`. A package tsconfig
  declares **only** its genuine differences (jsx, lib, paths, types).
- `packages/core` has no DOM lib on purpose. If you need `window`, you are in the
  wrong package.
- Nothing outside `apps/web/src/lib/native.ts` imports `@tauri-apps/*`. Every
  function there guards with `isTauri()` and degrades to an empty result, so the
  SPA still runs in a plain browser and callers never need their own guard.
- Parse at the boundary, never cast.

## React

- `memo` any component rendered once per item. Without it, a progress event
  arriving four times a second during a scan re-renders every tile in the grid.
- Pass stable callbacks into memoized children, or the memo chain silently dies.
- Never do real work in render. A hidden `<pre>{JSON.stringify(item)}</pre>` —
  which the previous generation of this app shipped — is a full pretty-print per
  visible tile, thrown away by `display: none`.

## Lint

Categories (`correctness`, `perf`, `suspicious`) sit at **error** and stay there.
Individual rules are pinned back one at a time, never by weakening a category.

Currently pinned, with reasons:

- `react/react-in-jsx-scope` — off globally. It predates the automatic JSX
  runtime this app uses (`jsx: react-jsx`) and would demand a React import in
  every file that renders anything.
- `import/no-unassigned-import` — off for `**/main.tsx` only. A stylesheet
  import is a side effect by definition; it is how Vite is told to emit CSS.

## Comments

Comment the *why*. A comment restating the next line is noise the moment the PR
merges; a comment recording a constraint the code cannot express is why the next
person does not undo your fix. Both `.ai/gotchas.md` and the inline comments in
`pipeline.rs`, `thumbs.rs` and `useInView.ts` are written to that standard —
match it.
