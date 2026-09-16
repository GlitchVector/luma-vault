# @luma/comic — prose in, lettered comic pages out

A comic is a folder. Three paragraphs of prose go in; a page PNG, a PDF and a
CBZ come out. Four stages, each its own command, each rerunnable alone, and
nothing in the loop but files:

| Stage | Command | In → Out |
|---|---|---|
| 1 | `pnpm comic script <project>` | `prose.md` → `script.json` |
| 2 | `pnpm comic panels <project>` | `script.json` → `panels/<id>.png` (+ `.json` sidecar) |
| 4 | `pnpm comic qa <project>` | panels → `qa/<id>.json`, failures re-rendered at the next seed |
| 3 | `pnpm comic assemble <project>` | panels + script → `out/page-NN.png`, `out/book.pdf`, `out/book.cbz` |

`pnpm comic all <project>` runs them in order. The desktop app's **Comics**
button (in the filter bar) drives the same commands with a form in front of
`script.json`; its projects live under the app's data directory.

## What you write

`prose.md`. That is it. Stage 1 hands it to a language model with the brief
in `src/writer/brief.ts` and gets back pages, panels, camera words, scenes,
balloons and sound effects as `script.json`. Edit that file — or the form in
the app — when a panel needs a different camera or a line needs cutting.
Nothing in it is a prompt; the prompt is built from it every time.

The cast is configuration, not something the model invents:
`comic.config.json` names each character's LoRA, trigger, look and seed
family. The model only chooses who is in a panel; the look is restated in
full, mechanically, in every panel she is in.

## The rules the pipeline enforces

- **Every panel restates the whole character** — `<lora:…>`, trigger, look —
  from the config, never from the model's memory (`src/prompt.ts`).
- **Dialogue never enters a prompt.** The prompt builder does not receive it.
  There is a test that fails if it ever does.
- **Lettering space is asked for.** A panel with balloons reserves a corner;
  the prompt ends with a clause asking for empty space there, and QA checks
  it is actually empty.
- **Seeds are arithmetic.** `seed = family + page·100 + panel·10 + attempt`.
  Nothing is stored to get back to a picture: `pnpm comic render <project>
  --page 4 --panel 2 --seed 8812` computes the same request a month from now.
  The bytes match as long as Forge does — same build, same GPU, same
  checkpoint file.
- **The cache is the request.** A panel's PNG is keyed by a hash of exactly
  what the renderer received (prompt, negative, seed, size, steps, sampler,
  checkpoint…). Edit a scene and only that panel re-renders; edit the steps
  in the config and all of them do. The sidecar beside every PNG holds the
  request in full.
- **QA is hard failures only.** Blank output, the wrong number of figures, a
  turnaround instead of a scene, an anatomy tag, or no usable space at the
  balloon's corner. Nothing about taste. A failed panel is rendered again at
  the next seed in its family, up to `qa.max_attempts`, and the pipeline's
  exit code says whether anything is still failing.

## Rendering

Stage 2 speaks to Stable Diffusion WebUI Forge over `/sdapi/v1/txt2img`. The
checkpoint goes in `override_settings` per request, the LoRA rides in the
prompt, and `GET /sdapi/v1/loras` is read first so a misspelt LoRA name fails
loudly instead of rendering without her. Progress comes from
`/sdapi/v1/progress`. `save_to_forge` keeps Forge's own copy in its outputs
folder, which is how a panel reaches the vault's library.

The renderer is an interface (`src/render/renderer.ts`): `prepare` and
`render`. Forge is the only implementation that draws; `mock` draws a
placeholder so layouts, lettering and QA can be worked on without a GPU
(`"renderer": "mock"` in a project's `comic.config.json`, or
`COMIC_RENDERER=mock`). A hosted API would be a third file and nothing else.

Panel sizes come from the layout: the grid cell's aspect picks the nearest
SDXL bucket (`src/layouts.ts`), so a wide establishing panel renders
landscape and a tall one portrait.

## Assembling

Stage 3 is HTML and CSS, screenshotted by Chrome through Playwright. A page
is a CSS grid; a panel is a `<figure>` with a span; a balloon is an inline
SVG — rounded rectangle or burst, with a tail toward the speaker — sized by
`assets/balloons.js` once the fonts are in. **Restyling the whole book is an
edit to `assets/theme.css`** and nothing else: gutters, borders, balloon
shapes, the fonts. Diagonal gutters are a `clip` polygon on the panel.

Fonts are bundled (`assets/fonts`, SIL Open Font License): Comic Neue for
balloons, Bangers for sound effects. Nothing is fetched at build time.

The PDF is the page PNGs placed at 6.625 in wide, one per sheet. The CBZ is
the same PNGs zipped, stored not deflated, with a fixed date — so the archive
bytes depend on the pages alone.

## QA in detail

Pixels first (`src/qa/pixels.ts`): a picture whose luminance barely varies is
blank; the reserved region is usable when its edge energy is a fraction of the
whole picture's (`qa.space_edge_ratio`) or it is nearly flat (`qa.space_std`).

Then the tagger (`src/qa/tagger.py`): the vault's own wd-vit-tagger-v3, on the
CPU, through `venv-classifier`. It counts people — `solo`, `2girls`,
`multiple girls`, `no humans` — and flags `multiple views` (a reference sheet
instead of a scene) and the anatomy tags danbooru has. It runs on the CPU so
it can inspect while the GPU is training. `--no-tagger` inspects pixels only.

What QA cannot see: a subtly wrong hand the tagger does not flag. That is the
honest limit of a local, model-free gate; a vision-model inspector would slot
in beside the tagger under the same `Tagger`-shaped interface.

## Layout

```
packages/comic/
  comic.config.json        renderer, Forge settings, prompt words, QA knobs, the cast
  assets/                  theme.css, balloons.js, fonts/
  src/
    cli.ts                 the commands
    schema.ts              config schema; the script schema is @luma/core's comic.ts
    layouts.ts             presets → grid geometry → SDXL bucket
    prompt.ts  seed.ts  cache.ts
    render/                renderer.ts (the seam), forge.ts, mock.ts
    writer/                writer.ts (the seam), claude-cli.ts, anthropic.ts, brief.ts
    stages/                script.ts, panels.ts, qa.ts, assemble.ts
    assemble/page.ts       the page HTML
    qa/                    pixels.ts, tagger.ts, tagger.py
  examples/first-light/    the worked example
```

A project folder:

```
<project>/
  prose.md                 what you write
  comic.config.json        optional overrides (a different checkpoint, a different cast)
  script.json              stage 1's output, yours to edit
  panels/<id>.png + .json  stage 2's output and the request that made it
  qa/<id>.json             stage 4's verdicts
  build/                   the page HTML (regenerated)
  out/page-NN.png, book.pdf, book.cbz
```

## Commands

```
pnpm comic init      <project>
pnpm comic script    <project> [--prose file]
pnpm comic panels    <project> [--page N] [--panel ID|N] [--force] [--dry-run] [--attempt N]
pnpm comic render    <project> --page N --panel N [--seed S]
pnpm comic qa        <project> [--page N] [--panel ID|N] [--no-retry] [--no-tagger]
pnpm comic assemble  <project> [--page N] [--format png,pdf,cbz]
pnpm comic all       <project>
pnpm comic doctor    [project]      Forge reachable? checkpoint and LoRAs present? tagger? Chrome?
pnpm comic layouts
```

`<project>` is a folder, relative to where you typed the command. `--json`
turns every line into a JSON event on stdout; that is what the app reads.

## The writer

Stage 1 uses the `claude` CLI already on this machine (`writer.backend:
"claude-cli"`), with every tool off, no settings sources and structured
output enforced by `--json-schema`. `"anthropic"` uses the Messages API with
`ANTHROPIC_API_KEY` from `.env`. Either way the reply is validated against the
script schema and sent back once with the errors if it does not fit.

## The worked example

`examples/first-light`: three paragraphs about Ari on a rooftop at dawn, the
script the writer produced from them (3 pages, 10 panels). The pages join
once Forge has rendered them; until then `renderer: mock` draws the layout.

```
pnpm comic all packages/comic/examples/first-light
```

## Honest notes

- The first real Forge render is the proof of the prompt words. The brief
  asks the model for tag-like phrases; a scene written as prose still renders,
  but a checkpoint trained on booru tags listens better to tags. `pnpm comic
  script` prints the words it could not find in the tagger's vocabulary.
- Byte-identical reproduction is a property of Forge, not of this CLI. The
  CLI guarantees the identical request; Forge on the same machine and build
  has answered identically in practice.
