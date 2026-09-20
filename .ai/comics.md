# Comics

Everything built for comics, 2026-09-17 to 2026-09-20, in two packages and one
panel of the app. Read this before touching any of it; each package has its
own README for the command reference.

```
packages/studio      before any picture: characters, canon, story, scenes,
                     panel specs. Content lives OUTSIDE this repo.
packages/comic       pictures: prose → script → panels (Forge) → QA → lettered pages.
apps/web Comics      the app's workspace over packages/comic (Rust bridge in
                     apps/desktop/src/comic.rs, projects under app data).
```

The two are joined by `pnpm studio export <comic> [dir]`, which writes a comic
project the renderer understands. Neither package imports the other; the
bridge is a generated `script.json`. That was Milestone 4 of the owner's
stage-1 plan and it is done.

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
3. **RETIRED 2026-09-19.** The rule was "the hosted image model draws the
   place; the local model draws the people", with OpenAI seeing `locations`,
   `setting`, `pose` and `camera` and never `scene`. The split was sound and
   the schema still carries those fields, but the mannequin mechanism that
   implemented it failed live (see the plates section). Everything is Forge.
   If a hosted model is ever brought back, keep the field split: it is what
   lets a comic go where a hosted model will not.
4. **Dialogue never enters an image prompt.** Lettering is deterministic
   HTML/CSS, never generated.
5. **No ControlNet, no pose conditioning.** Camera and pose are words.
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
| 2 | `panels` | `script.json` → `panels/<id>.png` + `.json` sidecar (Forge txt2img) |
| 4 | `qa` | panels → `qa/<id>.json`; hard failures re-rendered at the next seed |
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
- **Plates are OFF, and that is a verdict, not a default.** (`plates/`,
  `stages/plates.ts`, `plates.backend: "none"`.) The idea was: OpenAI draws
  the location with a flat coloured mannequin where each character goes, a
  colour threshold makes a mask, Forge inpaints the character into it.
  **Tried live against gpt-image-1 on 2026-09-19 and it failed.** Numbers,
  so nobody re-runs the experiment by accident:
  - **The mannequin is drawn about half the time.** 5 panels of 11 got one.
    The other 6 died after three attempts each. An awkward pose or a tight
    crop makes the model draw a real person, or nobody.
  - **The mannequin's silhouette is not the character's.** It is bald and
    smooth; Ari has a bob. The inpaint cannot paint outside the mask, so her
    crown came out sliced flat. `mask_grow` 24 clipped her, 96 repainted so
    much background that a dusk sky grew daylight clouds, 56 was the narrow
    window that worked. Tuning a dilation is treating the symptom.
  - **A plate style that suits the character fights the mannequin.** Asking
    for "painterly, no outlines" to match delburry75 made the model refuse to
    draw a flat matte silhouette at all. Cel shading plus linework
    (`plates.style`, still in the config) both matched delburry75 well and
    kept the mannequin drawable, but that is a narrow corridor.
  - **A retry redrew the location master too**, roughly doubling the spend on
    every failure. `ensurePlate` passes `force` down to `ensureMaster`. Fix
    that before any revival.

  One part genuinely worked and is worth remembering: **the empty location
  master was excellent.** Drawing a place with nobody in it is what these
  models are good at. If plates are ever revisited, the design to try is:
  hosted model draws the location EMPTY, and the character mask is generated
  by us from the panel's `screen_position`, sized for the character. No
  mannequin to fail, no silhouette mismatch. The owner's verdict on the
  mannequin version was "this approach is bullshit, the first way without
  openai was working", and he is right on the evidence.

- **QA** (`qa/`): pixels (blank, and edge energy in the reserved corner) plus
  the vault's wd-vit-tagger-v3 on the CPU through `venv-classifier`
  (`qa/tagger.py`): figure count (`solo`/`2girls`/`no humans`), `multiple
  views`, the few anatomy tags. It cannot see a subtly wrong hand; say so
  rather than promising it.

  **Room for the lettering is a note, never a gate** (changed 2026-09-19).
  It used to fail and retry, and that was wrong twice over. Prompt wording
  cannot deliver empty space on this checkpoint: four wordings, weighted and
  moved to the front, all scored 4.8-5.3 against a limit of 3.4. And it does
  not matter, because the balloons are opaque with a black stroke and read
  fine over sky, brick and clothing. What the gate actually did was discard
  each panel's first render and keep its third, which was no better. On the
  worked example it failed 8 of 11 and turned a 10-second QA pass into 3
  minutes 11. `Verdict.failures` is retried; `Verdict.notes` is not.
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

### The prompt, and why it looks the way it does

Every number here was measured on this house's own LoRAs and checkpoint. None
of it is taste, and re-deriving any of it costs an afternoon.

- **Framing words are weighted, angle words are not** (`prompt.camera_weight`
  1.35, `prompt.angle_weight` 1.1). Unweighted framing loses to a character
  LoRA and `wide shot` renders as a cowboy shot — which was already written
  down for boards as "weight every framing word". But weighting the ANGLE the
  same way is how the owner's first studio page came back with a forty-metre
  Ari: `from below` at 1.35 stops meaning "a low camera" and starts meaning
  "look up at something enormous".
- **Wide shots ease the LoRA** (`prompt.wide_lora_scale` 0.6, applied when
  the camera says `wide shot`, `scenery` or `establishing`). A character LoRA
  at full strength fills whatever frame it is given, so a wide shot becomes a
  close-up of a giant. Also the house rule already: "try a lower LoRA weight,
  not negatives".
- **Negating the giantess genre does nothing.** Four renders at one seed with
  `giantess`, `giant`, `size difference`, `minigirl`, `soles` and
  `foreshortening` in the negative at rising weights were indistinguishable
  from the original. It is geometry, not genre bleed. Do not try this again.
- **Reserving lettering space by prompt is impossible on this checkpoint.**
  Four wordings, weighted and moved to the front, all scored 4.8-5.3 against
  a limit of 3.4. The assembler works around it instead (below).

### Lettering

`assets/theme.css` is the whole look; `assets/balloons.js` places and draws.

- **A balloon goes where the art is quiet.** `assemble/energy.ts` reduces each
  panel to a 16x24 grid of mean luminance gradient, scaled to that panel's own
  busiest cell so a night scene still has a quiet corner, and passes it on the
  panel element as `data-energy`. The script's anchor is still what the writer
  asked for; drifting from it is charged for, so a balloon only moves when
  what it would have covered is genuinely busy. It also avoids sound effects
  and balloons already placed.
- **The balloon and its tail are ONE path.** The tail is spliced into whichever
  edge faces the speaker and curves to the tip. Drawing a separate triangle
  and hiding the join under a second fill is what made the old tails look
  stuck on.
- **A tail's length is a property of the balloon**, a little under its own
  height, never the distance to the speaker. Interpolating toward the target
  was fine while balloons sat at fixed corners and absurd once they could
  move: on a close-up the tail ran the length of the panel.

### Page geometry, and retina

- **The page is print size already.** 2000x3000 CSS pixels is 6.67 x 10
  inches at 300 DPI, essentially a US comic trim, and the PDF is laid out at
  that width.
- **A panel renders at its cell's TRUE aspect** (`sizeForCellBox`), which is
  the page minus `page.margin` and minus `page.gutter` between tracks — 926 x
  1426 on a 2x2, not 1000 x 1500. Measuring off the raw grid leaves a couple
  of percent for `object-fit: cover` to shave, and that is a face on a wide
  panel. `cellPixels` in `layouts.ts` is the one place this is computed, and
  `page.ts` injects the margin and gutter into the stylesheet from the same
  config so the two cannot drift.
- **`object-position` is anchored to the top**, so any residual crop takes the
  floor rather than a head.
- **`page.scale: 2` is a retina page**: the layout is unchanged and the
  screenshot is taken at twice the density, so lettering is redrawn sharp
  rather than enlarged. 4000x6000, about 600 DPI across a comic trim.
- **A panel is RENDERED at the size its cell will show it at**
  (`forge.hires`, `targetForCell`). It composes at the checkpoint's
  comfortable megapixel and is re-sampled up to the cell's device pixels in
  the same `txt2img` call: `enable_hr` with `hr_resize_x/y` set to the exact
  target, which A1111 honours to the pixel when the two sizes share an
  aspect, as these do. Nothing is left for the page to stretch.
- This matters at **`scale: 1` too**, which was missed for two days. The
  assembler only ever enlarged panels when `scale > 1`, so at scale 1 the
  browser was quietly stretching every one of them. Measured, on a 2000x3000
  page:

  | cell | its size | composed at | stretch |
  |---|---|---|---|
  | half-width (2x2, hero-top's lower row) | 926x1426 | 816x1256 | 1.14x |
  | full-width hero | 1880x1426 | 1160x880 | 1.62x |
  | splash | 1880x2880 | 816x1248 | 2.30x |

  `hires.min_factor` is 1.15, so the half-width cell at scale 1 is the one
  case left alone — 14% is under the bar and a second pass on every small
  panel of every page is not worth the minutes.
- **The ceiling bites on big cells.** `hires.max_megapixels` is 6, and a
  splash cell at `scale: 1.5` wants 12.2 MP. It is capped to 5.99 and the
  assembler's upscaler covers the remainder, which is the one place an
  ESRGAN pass still touches a face. Raise the ceiling if the card can take
  it, or accept that full-page splashes are the weak case.
- **The second pass has to be the sampler, not the extras endpoint.**
  Enlarging finished panels with an anime ESRGAN was the first attempt and it
  is what the owner rejected: an upscaler sharpens the face that is there and
  cannot draw the one that isn't, so at scale 1.5 the eyes and mouths came
  back crisp and wrong, and worse the bigger the page got. The sampler
  redraws at the target size. `hires.denoise` 0.45 is the dial — below about
  0.35 it only sharpens, above about 0.55 it starts changing the picture QA
  already passed.
- The ESRGAN path is still in `assemble.ts` and now runs only for a panel
  that is *still* short of its cell: one rendered before this change, or one
  capped by `hires.max_megapixels` (6). A panel already at size is skipped,
  so a re-assemble of a hires page touches the GPU not at all.
- Cost: not measured yet — the change was made on a day the GPU was not to be
  used. The second pass is an img2img at the target size for `hires.steps`
  (14) on top of the 28 that compose it, so expect a panel to cost something
  like half again to double what it did, and `build/retina` to stay empty.
  Measure it on the next full run and replace this sentence.

### State of verification (2026-09-19)

Forge, live, on the worked example `packages/comic/examples/first-light`:

| | |
|---|---|
| 11 panels, all at their first seed | 2 min 10 s |
| QA, tagger included | 10 s |
| Assemble at `page.scale: 2` | 40 s, all of it the upscaler that is now gone |

Identity and outfit hold on every panel; the lettering reads; the tails point
at the right person; QA passes all eleven with notes and no re-renders. Stage
1 is proven with the real claude CLI (20-50 s a call). **This is the path that
works and the one to build on.**

The studio bridge is proven too: `studio export comic_001` then `comic panels`
renders the owner's own panel specs, 5 panels on 2 pages, in about 50 s.

OpenAI: called live, and the plate pass failed as described above. The API
shapes in `plates/openai.ts` are correct; the *method* is what failed.

Known, still open:

- **`forge.hires` has not been run on Forge.** It is written, typechecked and
  unit-tested against the payload, and the owner asked for it on a day the
  card was off limits. The first run will re-render every panel, because the
  hires block is part of the request hash.

- The checkpoint renders her considerably bustier than her references,
  because these prompts carry no body block. Creative, not technical.
- A wide shot with the subject near the camera still reads large even with
  the LoRA eased; `prompt.wide_lora_scale` is the dial, and identity starts
  softening below about 0.4.
- Panels are 1.0 MP single-pass with no hires and no face pass, which is why
  a whole comic costs less GPU time than one candidate round. Faces at small
  sizes are softer than a board render. Adding a hires or ADetailer pass to
  `comic.config.json` is where the time would go back.

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
- `comic_inspect` is the exception to all of that: it runs the CLI
  **synchronously**, outside the `Runner`, and returns one JSON object. It
  answers while a render is in progress on purpose, and needs neither Forge
  nor the GPU. `comic_save_settings` writes the four editable settings into
  the project's own `comic.config.json`.
- Wire types: `ComicSummary`, `ComicProject` (script as an opaque value),
  `ComicRunOptions`, `ComicEvent`, `ComicStatus`, `ComicInspection` —
  types.rs, schemas.ts, `contracts/comic-*.json`, both contract test tables.
- SPA: `apps/web/src/components/ComicsPanel.tsx`, opened by the **Comics**
  pill in the filter bar. Errors go to `showMessage`, confirmations to
  `toast`. The LAN serves `apps/web/dist` from disk: `pnpm build` after a UI
  change, then reload the iPad tab.

### The layout, after the owner's mockup (2026-09-20)

Three columns under a step rail, which is what he drew:

- **The rail** across the top is the four stages as numbered pills, each with
  a caption, and a tick when that stage is finished. Finished means nothing
  missing AND nothing stale — a page assembled before its panels were
  redrawn loses its tick, which is the point.
- **The left column** is the comic list: a thumbnail (`ComicSummary.thumb`,
  the first assembled page else the first rendered panel), the page and panel
  counts, and a standing — Draft, In progress, Completed — computed from
  those counts rather than stored, because a folder is the truth and a stored
  status is one more thing that can disagree with it. A search box filters
  it. The bottom three items are Library (closes the panel, back to the
  vault), Characters (the cast, which comes from `comic.config.json`) and
  Settings (shows or hides the right column).
- **The middle** is the comic: title with a rename pencil, the first real
  line of the prose as a logline, the cast, and the step's own actions.
  There is no `logline` field in the script and none was added — inventing
  one would mean the writer stage had to fill it.
- **The right column** is Comic Settings, and every control in it is a real
  field: Style is `prompt.style`, Global tags is `prompt.quality`, Aspect
  ratio is `page.width`/`page.height`, Model is `forge.checkpoint`, and the
  output block is `page.scale` and `forge.hires`. Saving writes the
  PROJECT's `comic.config.json`, never the package's.

Two controls in the mockup were deliberately not built, for the same reason
the plate fields are hidden: **Narrator style** and **Add sound effect
hints** map to nothing in the pipeline, and a control that reads nothing is
the thing this whole day was spent removing. **Pose / Action** is in the
mockup and is in the code, but only appears when the plate pass is on — it
is read by `plates/prompt.ts` and by nothing else.

The camera field is free text with a datalist of framings that are known to
work, not a dropdown: the words reach the prompt as words, and the right one
is sometimes not on any list.

### What step 3 is for, and what it now tells you

The panel grid is the only place the **art** can be changed. Step 4 lays
panels out and letters them; it never redraws one. So step 3 is where a bad
panel is reseeded or redrawn, one at a time, against its QA verdict and its
seed — not a preview of a later render, because there is no later render.

Four things were added on 2026-09-20 after the owner found the app claiming
more than the pipeline's files supported:

- **QA notes reach the person.** `ComicVerdict` carries `notes` beside
  `failures` now. Since lettering space moved to notes, a panel with nowhere
  to put its balloon passed with a plain green tick and the observation died
  in `qa/<id>.json`. The card shows a blue note chip.
- **A stale panel says so.** Every read also calls `comic inspect`, and a
  panel whose picture no longer matches the script or the settings gets an
  amber "changed" badge whose tooltip names the reason. This is what caught
  the app's demo comic: all eleven panels were `mock` placeholders from the
  plate experiment on 2026-09-17, which is where the magenta blobs came from,
  and nothing had ever said so.
- **A stale page says so.** `ComicPage.stale` is pure mtime on the host: a
  page laid out before one of its own panels was drawn.
- **The settings that change output are on screen**, above the panel grid:
  checkpoint, page scale, the hires pass and its denoise are editable, and
  the renderer, page size and plate state are shown. Everything else is still
  a file edit, deliberately.

The plate fields in the panel editor (`setting`, the per-character `pose`
lines) and the plate chip on a card are now hidden unless
`plates.backend` is on. They were collecting words nothing read. `figures`,
which is what QA counts against, is editable in the form at last rather than
only in the JSON view.

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
- **`export` is the bridge to the renderer** (`export.ts`). Panels group by
  scene into pages, the layout follows the count, a character's LoRA, trigger
  and weight come from her `generation.yaml` and never from a panel, her
  outfit's words go in the scene rather than her `look` (because `look` is one
  string for a whole script and she changes clothes), and a balloon is
  anchored and aimed from where its speaker was staged. A character with no
  `generation.yaml` is refused rather than guessed at; a panel nobody has
  staged is skipped by name.
- **Only words the checkpoint knows cross over** (`vocabulary.ts`). This is
  the whole point of the bridge and it was learned the hard way: the first
  version passed the director's prose through and every panel came back a
  crouching close-up, because `pose: "hanging one-armed from the lowest
  surviving rung, one knee drawn to brace on the rail"` has exactly one word
  a sampler recognises and it is `knee`. Now the tagger's own
  `selected_tags.csv` is the filter, longest match first. Three things
  measurement caught that guessing would not have:
  - `crouching` is not a tag at all (danbooru says `squatting`), so "crouching
    low" silently lost its pose. There is a small synonym table for this.
  - `camera`, `back`, `drone` and `palms` are real tags that mean the wrong
    thing in staging: "back three-quarters to camera" became `back, camera`
    and the render grew a literal camera. Blocked in staging only.
  - Scraping a location's description was worse than useless: "old radio
    building roof, north fire escape, alley below" yields `radio, fire,
    alley`. A place contributes its curated `prompt_words:` line (in
    `locations/<id>.md`, the same bargain outfits strike) or nothing, and the
    export names every place still missing one.
- **The camera is translated by table** (`cameraWords`), both fields through
  both tables, because a director writes "medium close-up over her shoulder"
  in the framing field and "eye level with her hands" in the angle field.

### State (2026-09-19)

- Milestones 1–3 tooling done and run end to end with the claude CLI: a
  brainstorm on Ari (unapproved, the owner's call), `comic_001` "First Light",
  `scene_001` drafted with "(needs canon: …)" flags, five panels planned,
  three directions on `panel_002` including a lock the model then honoured.
- **No local LLM server on this PC** (no Ollama, LM Studio, GGUF). Suggested
  when the owner wants the explicit facets: Ollama + a 12B Mistral-Nemo
  roleplay finetune at Q4 (~8 GB), not beside a kohya run.
- **Milestone 4 is done**: `studio export comic_001` then `comic panels`
  renders the owner's own panel specs end to end, 5 panels on 2 pages in
  about 50 s. Milestones 5-7 (correction loop, dialogue and lettering from
  the studio, the first real comic) are not started; lettering already works
  in `packages/comic` and the studio feeds it dialogue through `export`.

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
  Regexes in heredocs will come out broken. This bites HARD and silently:
  writing a regex table through a heredoc turned every `` into a literal
  backspace (0x08), so the patterns compiled, matched nothing, and the
  translator quietly returned no tags. If a regex mysteriously matches
  nothing, hexdump it before doubting the logic.

## Where to look

- `packages/comic/README.md` — every command and flag, the plate pass, QA.
- `packages/studio/README.md` — the loop, the content root, the model.
- `packages/core/src/comic.ts` — the script schema and layouts, shared.
- `packages/comic/src/prompt.ts` — the weights, and why each one is not 1.
- `packages/comic/src/layouts.ts` — `cellPixels` and `sizeForCellBox`, the one
  place page geometry is computed.
- `packages/comic/assets/balloons.js` — placement and the one-path tail.
- `packages/studio/src/vocabulary.ts` — prose to tags, with the synonym table
  and the staging blocklist.
- `apps/desktop/src/comic.rs` — projects, the runner, the event parser.
- `apps/web/src/components/ComicsPanel.tsx` — the workspace.
- Memories: `comic-pipeline-in-the-app`, `comic-plates-hosted-place-local-people`,
  `comic-studio-stage-1`, `ari-character`.
