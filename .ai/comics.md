# Comics

Everything built for comics, 2026-09-17 to 2026-09-18, in two packages and one
panel of the app. Read this before touching any of it; each package has its
own README for the command reference.

```
packages/studio      before any picture: characters, canon, story, scenes,
                     panel specs. Content lives OUTSIDE this repo.
packages/comic       pictures: prose → script → plates → panels → QA → lettered pages.
apps/web Comics      the app's workspace over packages/comic (Rust bridge in
                     apps/desktop/src/comic.rs, projects under app data).
```

The two packages are not yet joined: a studio panel spec (`panel_017.yaml`)
does not render, and a comic script (`script.json`) knows nothing about canon.
Joining them is Milestone 4 of the owner's stage-1 plan (below), not done.

## The rules the owner set

These are decisions, not defaults. Do not re-litigate them.

1. **The person is the creative director.** The model proposes, translates,
   executes and checks; a person approves. Nothing becomes canon, a scene,
   or an approved panel on its own. (Stage-1 plan, 2026-09-18.) In the
   studio: `approve` is the only door into canon; `state` is the only way a
   panel moves; REVIEW → APPROVED is a person. Never approve proposals into
   canon on the owner's behalf — the first brainstorm on Ari sits unapproved
   for exactly that reason.
2. **Canon never changes silently.** A contradiction is flagged
   (`studio continuity`), then the person keeps the canon, changes the
   document, or changes the canon on purpose.
3. **The hosted image model draws the place; the local model draws the
   people.** OpenAI's image model sees `locations`, `setting`, `pose` and
   `camera` and never `scene`, the field the explicit local prompt is built
   from. That split is what lets a comic go where a hosted model will not.
4. **Dialogue never enters an image prompt.** Lettering is deterministic
   HTML/CSS, never generated.
5. **No ControlNet, no pose conditioning.** Camera and pose are words; with
   plates, the stand-in mannequin's silhouette is the pose guide.
6. **Deterministic CLI, no agent in the render loop.** Seeds are
   arithmetic, requests are hashed, sidecars hold every parameter.
7. **The content root is private.** luma-vault on GitHub is public; the
   canon (which includes sexuality) is not. `D:\Development\comic-studio`,
   its own git, never pushed anywhere.
8. Owner's picks when asked (2026-09-17): checkpoint **delburry75**, lettering
   **Comic Neue + Bangers** (OFL, bundled), example character **ari_adopt_v1**.

## packages/comic — the picture pipeline

Prose in, lettered pages out. Four stages, each a command, each rerunnable
alone, plus the plate pass. `pnpm comic <stage> <project-folder>`; `--json`
turns output into one event per line, which is what the app reads.

| Stage | Command | Reads → writes |
|---|---|---|
| 1 | `script` | `prose.md` → `script.json` (writer: claude CLI with `--json-schema`, or Anthropic API) |
| 2a | `plates` | `script.json` → `plates/<id>.png` + master plates per location (OpenAI; run by `panels` when missing) |
| 2 | `panels` | script (+ plates) → `panels/<id>.png` + `.json` sidecar (Forge txt2img, or img2img inpaint into the plate) |
| 4 | `qa` | panels → `qa/<id>.json`; failures re-rendered at the next seed |
| 3 | `assemble` | panels + script → `out/page-NN.png`, `book.pdf`, `book.cbz` (Chrome via Playwright) |

`all` runs them in order. `doctor` says what is reachable. `render --page N
--panel N --seed S` is stage 2 for one panel, always rendered.

### What to know

- **The script schema and the layout presets live in `@luma/core`**
  (`packages/core/src/comic.ts`) so the app's editor and the pipeline cannot
  disagree. `packages/comic/src/schema.ts` re-exports them under the names
  the stages use and adds the config schema.
- **Config**: `packages/comic/comic.config.json` (renderer, Forge settings,
  prompt words, QA knobs, plates, writer, the cast). A project folder may
  carry its own `comic.config.json`; it overrides by top-level key,
  characters merge by id.
- **The cast is config, not something the writer invents.** Each character
  has `lora`, `trigger`, `look`, `subject`, `seed_family`. The prompt builder
  (`prompt.ts`) restates the whole character in every panel; the writer only
  chooses who is in a panel.
- **Seeds**: `family + page·100 + panel·10 + attempt` (`seed.ts`). Retries
  step within the family. `--seed` overrides for one panel.
- **Cache**: a panel's hash is over the exact request (`cache.ts`); with a
  plate, the plate's hash and the inpaint settings are inside it. Sidecar
  `hash` ≠ plan hash → re-render.
- **Renderer seam** (`render/renderer.ts`): `prepare`, `render`, `inpaint`.
  Forge is the only one that draws. `mock` draws deterministic placeholders
  (`COMIC_RENDERER=mock` or `"renderer": "mock"`) so layout, lettering and
  QA can be worked on while the GPU is busy.
- **Plates** (`plates/`, `stages/plates.ts`): one master per script
  `location` (`images/generations`), each panel an `images/edits` view of its
  master (`input_fidelity: high`). Stand-ins are matte mannequins in fixed
  colours — magenta, cyan, yellow, one per character in `characters` order —
  posed by the panel's `pose`. Mask = colour threshold + dilation
  (`plates/mask.ts`); inpaint = Forge img2img, `inpainting_fill: 1`,
  `inpaint_full_res`, denoise 0.9, one character at a time, each with a prompt
  naming only her. A plate with no stand-in is re-asked as a variation twice,
  then the panel fails and the run continues. Plates have no seed: they are
  files to keep (`plates/` in a project is not regenerable). `COMIC_PLATES=mock`
  for tests. Default `plates.backend` is `openai`; `none` renders directly.
- **QA** (`qa/`): pixels (blank, and edge energy in the reserved corner) plus
  the vault's wd-vit-tagger-v3 on the CPU through `venv-classifier`
  (`qa/tagger.py`): figure count (`solo`/`2girls`/`no humans`), `multiple
  views`, the few anatomy tags. Hard failures only. It cannot see a subtly
  wrong hand; say so rather than promising it.
- **Assembly** (`assemble/page.ts`, `assets/theme.css`, `assets/balloons.js`):
  CSS grid page, `<figure>` per panel with a span, balloons as inline SVG
  sized in the browser after fonts load, tails toward `tail_to` (default:
  the panel's middle). Files are served to Chrome by a Playwright route on
  `http://comic.local/` — no file:// rules, no server. Restyling the book is
  an edit to `theme.css` only. PDF = the page PNGs at 6.625 in wide; CBZ = the
  PNGs stored uncompressed with a fixed date.
- **The writer's brief** (`writer/brief.ts`) asks for booru-style tag scenes,
  locations, per-panel `setting`/`pose` (the SFW fields), a layout preset
  whose cell count matches. `script` prints how many scene terms are not in
  the tagger vocabulary — a high count means the writer drifted into prose.

### State of verification (2026-09-18)

- Proven end to end on the **mock** renderer and **mock** plates, including
  the worked example `packages/comic/examples/first-light` (its `panels/`,
  `plates/`, `out/` are gitignored until real ones exist).
- Stage 1 proven with the real claude CLI (about 20–50 s a call).
- **Never rendered with Forge**: the GPU has been in kohya runs the whole
  time (`never-render-while-training`). The first real render is the test of
  the prompt words and of the plate/character style match.
- **Never called OpenAI**: `OPENAI_API_KEY` is not in `.env`. The request
  shapes are unit-tested against the API reference (`generations` JSON,
  `edits` multipart with `image[]`).

## The Comics panel in the app

- Rust: `apps/desktop/src/comic.rs`. Projects live under
  `%LOCALAPPDATA%\net.glitchvector.luma-vault\comics\<name>` (never beside
  media: the watcher would index every attempt). `comic_list`, `comic_read`,
  `comic_create`, `comic_save`, `comic_run`, `comic_status`, `comic_cancel`,
  in both the Tauri handler list and the `api::dispatch` table, so the iPad
  gets them over `/luma/v1/rpc`.
- A run spawns `node --experimental-strip-types packages/comic/src/cli.ts
  <stage> <dir> --json` on the host, reads its JSON lines into a static
  `Runner` (one run at a time) and the panel **polls** `comic_status(since)`
  every second — the same path for the window and for a LAN browser, where
  there are no Tauri events.
- `ProtocolRoots.comic_root` puts the comics folder on the `luma://`
  allowlist so panel and page PNGs render in the grid.
- Wire types: `ComicSummary`, `ComicProject` (script as an opaque value),
  `ComicRunOptions`, `ComicEvent`, `ComicStatus` — types.rs, schemas.ts,
  `contracts/comic-*.json`, both contract test tables.
- SPA: `apps/web/src/components/ComicsPanel.tsx`, opened by the **Comics**
  pill in the filter bar. Four steps (story, script form or raw JSON, panel
  grid with QA badges / next-seed / plate chip, pages with PDF and CBZ).
  Errors go to `showMessage`, confirmations to `toast`. The LAN serves
  `apps/web/dist` from disk: `pnpm build` after a UI change, then reload the
  iPad tab.
- The app's demo comic `first-light` is a copy of the example with mock
  panels; "Render all again" turns it real once Forge is up.

## packages/studio — the creative side

Stage 1 of the owner's plan. `pnpm studio <command>`; content root
`STUDIO_ROOT` (default `D:\Development\comic-studio`).

```
characters/<id>/   core, appearance, personality, history, interests,
                   relationships, sexuality, humor, speech, boundaries,
                   outfits, current_state (.md); generation.yaml;
                   outfits/<id>.yaml; proposals/
world/             canon.md, timeline.md, rules.md
locations/<id>.md
comics/<id>/       comic.yaml, concept/outline/story/continuity.md,
                   scenes/scene_NNN.yaml, panels/panel_NNN.yaml, proposals/,
                   generations/ (gitignored), approved/, final/
```

- **Model seam** (`model/`): `StoryModel.complete(messages, {json?})`.
  `openai-compatible` (Ollama, LM Studio, llama.cpp: one URL, one model name)
  and `claude-cli` (tools off, no settings sources, no session; flattens the
  turns; refuses explicit material). A `ScriptedModel` for tests. JSON is
  parsed leniently (`extractJson`). `studio.config.json` picks the backend.
- **Context assembly** (`context.ts`): a table per task kind — which
  character files, which comic docs, the scene, the previous three panels —
  and stubs ("_Nothing established yet_") are skipped so the model is never
  shown an invitation to invent. `pnpm studio context <task> …` prints it.
- **Proposals versus canon** (`canon.ts`): a brainstorm writes
  `proposals/<stamp>-<ask>.md` as a tickable list; `approve <file|latest>
  <n,n> --into <file>` appends the picked items under a dated heading and
  ticks them; `pass` marks declines. Approved twice is refused.
- **Specs** (`spec.ts`): `comic.yaml`, scenes and panels in the plan's shape,
  loose objects so a director can add fields, states enumerated
  (`IDEA PLANNED GENERATING REVIEW CORRECTION APPROVED LETTERED FINAL`).
- **Director** (`director.ts`): an instruction → JSON `{patch, lock, unlock,
  note}` from the model; the tool enforces locks (dot paths, or the plan's
  short names `location`, `lighting`, `background`, `<char>`,
  `<char>_outfit`), applies, prints a diff, appends to `history`. `id`,
  `status`, `history`, `locked` are never directable.
- **Briefs** (`briefs.ts`): every prompt the studio sends, in one file.
- `continuity` and `cliches` report and never edit; `status` reads the files
  and names the panel directed three or more times without approval.
- Ari is seeded from the LoRA work (`seed-ari.ts`): appearance, generation
  config, default outfit. Nothing about who she is.

### State (2026-09-18)

- Milestones 1–3 tooling done and run end to end with the claude CLI: a
  brainstorm on Ari (unapproved, the owner's call), `comic_001` "First Light",
  `scene_001` drafted with "(needs canon: …)" flags, five panels planned,
  three directions on `panel_002` including a lock the model then honoured.
- **No local LLM server on this PC** (no Ollama, LM Studio, GGUF). Suggested
  when the owner wants the explicit facets: Ollama + a 12B Mistral-Nemo
  roleplay finetune at Q4 (~8 GB), not beside a kohya run.
- Milestones 4–7 (image backend from a panel spec, correction loop, dialogue
  and lettering, the first real comic) are not started. The pieces are in
  `packages/comic`; the join is a panel spec → render request adapter.

## Gotchas met along the way

- **`--experimental-strip-types` rejects TypeScript parameter properties**
  (`constructor(private x)`) and `enum`. Declare fields explicitly. Vitest
  does not catch this; running the CLI does.
- **zod 4**: `.default({})` on an object with required-by-default fields
  fails to type; use `.prefault({})`. `z.looseObject` keeps unknown keys.
  `z.toJSONSchema(schema, { target: 'draft-7' })` and strip `$schema` before
  handing it to `claude --json-schema`, whose validator rejects the 2020-12
  URL.
- **`claude -p --json-schema`** returns the object in `structured_output`;
  `--tools ""`, `--setting-sources ""`, `--no-session-persistence` keep the
  repo's CLAUDE.md and memory out of the call. Spawn `claude.exe` on Windows.
- **oxlint** flags `await` in loops (`no-await-in-loop`), index keys, map
  spreads and re-thrown errors without `cause`. Sequential awaits are
  intentional wherever one GPU or one browser tab is shared; waive per line
  with `// eslint-disable-next-line …` and a comment saying why.
  `import/no-cycle` bit `stages/panels.ts` ↔ `stages/plates.ts`: panel
  selection moved to `stages/select.ts`.
- **The LAN serves a stale `dist`**: only `pnpm build` writes it; `tauri dev`
  never does. The dev app rebuilds itself on Rust changes but can skip one
  while `cargo clippy` holds the target lock — check the exe's mtime.
- **Playwright**: `playwright-core` with `channel: 'chrome'` uses the
  installed Chrome; nothing is downloaded. Serve files through `page.route`
  rather than file://.
- **Git**: `docs/loras.md` carries another session's uncommitted edit —
  commit with `git add -A -- . ':!docs/loras.md'`, merge `main` through a
  worktree. When the 1Password SSH agent is not answering, push over HTTPS:
  `git -c credential.helper='!gh auth git-credential' push https://github.com/GlitchVector/luma-vault.git main`.
- **Windows shells from this tooling**: heredocs mangle backslashes; write
  patch scripts to the scratchpad with the Write tool and run `python <file>`.
  Regexes in heredocs will come out broken.

## Where to look

- `packages/comic/README.md` — every command and flag, the plate pass, QA.
- `packages/studio/README.md` — the loop, the content root, the model.
- `packages/core/src/comic.ts` — the script schema and layouts, shared.
- `apps/desktop/src/comic.rs` — projects, the runner, the event parser.
- `apps/web/src/components/ComicsPanel.tsx` — the workspace.
- Memories: `comic-pipeline-in-the-app`, `comic-plates-hosted-place-local-people`,
  `comic-studio-stage-1`, `ari-character`.
