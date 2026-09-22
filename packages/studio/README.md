# @luma/studio — AI Comic Studio, stage 1

The part of comic production that happens before any picture: characters,
canon, story, scenes and panel specifications, developed with a story model
and approved by a person. Pictures are `@luma/comic`'s job.

The rule the whole package is built around:

> The model proposes, translates, executes and checks. A person approves.

Nothing the model says becomes canon, a scene, or an approved panel on its
own. Every write into canon goes through `approve`; every panel state above
REVIEW is set by hand.

## Where the content lives

Not in this repository, which is public. The content root is a folder of
Markdown and YAML with its own git, `STUDIO_ROOT` or `D:\Development\comic-studio`:

```
comic-studio/
  studio.config.json      which story model
  characters/<id>/        core, appearance, personality, history, interests,
                          relationships, sexuality, humor, speech, boundaries,
                          outfits, current_state (.md); generation.yaml;
                          outfits/<id>.yaml; proposals/
  world/                  canon.md, timeline.md, rules.md
  locations/<id>.md
  comics/<id>/            comic.yaml, concept.md, outline.md, story.md,
                          continuity.md, scenes/*.yaml, panels/*.yaml,
                          proposals/, generations/, approved/, final/
```

`pnpm studio init` lays this out and seeds Ari with what is already known
about her — her appearance and how the image model draws her — and nothing
else. Her personality starts empty, on purpose.

## The story model

`studio.config.json`:

```json
{
  "model": { "backend": "claude-cli", "model": "claude-opus-5" },
  "explicit_model": { "backend": "openai-compatible", "url": "https://api.x.ai/v1", "model": "grok-4.7", "api_key_env": "XAI_API_KEY" }
}
```

Two models, because the facets split that way. `model` answers everything:
`claude-cli` uses the claude CLI on this machine, works without installing
anything, sends nothing to a third party — and refuses explicit material.
`explicit_model`, if set, answers only the facets marked `explicit` in
`facets.ts` (`sexuality`, `boundaries`) and any brainstorm given
`--explicit`. `openai-compatible` there is Ollama, LM Studio or llama.cpp
for a local uncensored model, or a hosted service that speaks the same
protocol — xAI is `https://api.x.ai/v1` with `XAI_API_KEY` in the repo
`.env`. Unset, the everyday model takes the explicit facets too, and
`character next` refuses them when that model is `claude-cli`.

The model's memory is never the source of truth. Every call is assembled
from files (`pnpm studio context <task> …` prints exactly what it sees), and
the answer is a proposal file or a structured document a person can read
and edit.

## The loop

```
pnpm studio init
pnpm studio character brainstorm ari "how she behaves when embarrassed"
pnpm studio character approve ari latest 2,4 --into personality
pnpm studio comic new comic_001 --title "First Light" --characters ari
pnpm studio story brainstorm comic_001 "five ways the first scene could open on the roof"
pnpm studio story approve comic_001 latest 3 --into outline
pnpm studio scene draft comic_001 "Ari finds a broken delivery drone on the roof at dawn"
pnpm studio continuity comic_001 scene_001
pnpm studio panels plan comic_001 scene_001 --count 5
pnpm studio direct comic_001 panel_002 "Put Ari farther left and bring the camera down slightly"
pnpm studio direct comic_001 panel_002 "Background is perfect. Lock it."
pnpm studio state comic_001 panel_002 REVIEW
pnpm studio status comic_001
```

- **Brainstorm** writes a numbered proposals file. `approve` copies the
  numbers you pick into the canon file you name, under a dated heading that
  says where they came from, and ticks them off so they cannot be approved
  twice; `pass` marks the ones you declined.
- **Scene draft** turns an approved direction into `scene_NNN.yaml`: purpose,
  characters, location, start and end moods, beats, continuity changes. Edit
  it freely.
- **Panels plan** breaks a scene into `panel_NNN.yaml` specs in the plan's
  shape: story function, camera, environment, per-character staging, locks,
  state PLANNED. No images.
- **Direct** is the natural-language interface. The instruction becomes a
  patch of dot paths; locked paths are refused and said so; the diff is
  printed; the instruction is kept in the panel's history. "Lock the
  background" locks `environment`; `lock`/`unlock` do it by hand.
- **Continuity** checks a scene or panel against the canon and prints
  warnings with the canon they rest on. It never edits. **Cliches** is the
  critic pass, criticism only.
- **State** is the only way a panel moves; REVIEW → APPROVED is a person.
- **Status** reads the files and answers the plan's questions, including
  the panel directed three times and still not approved.

## What is deliberately not here

Image generation, inpainting, candidates, lettering: `@luma/comic` has the
pieces (Forge render and mask inpaint, plates, seeds and sidecars, QA,
deterministic lettering) and Milestone 4 wires a panel spec to them. Nothing
from the plan's later stages.
