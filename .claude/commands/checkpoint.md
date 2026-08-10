---
description: Move a generation onto a different checkpoint, keeping the picture rather than the tags
argument-hint: <image> [target checkpoint]
---

# The same picture, on a different checkpoint

You have a generation and you want to see it on another model. This changes the
checkpoint and adjusts the prompt so the *result* stays as close as it can —
which is not the same as leaving the prompt alone.

**This is not `/sdxl` with a model typed in.** `/sdxl` migrates a block onto a
newer checkpoint and asks every tuning question on the way: the body ladders,
the framing, the style. It is for changing the picture. This one changes nothing
you asked for and only the thing you did not: which model draws it. One
question, and it is which checkpoint.

**Nor is it a no-op.** Handing the identical prompt to another checkpoint is the
naive move and it does not preserve the picture, because a checkpoint's
rendering style is a floor the tags cannot go below — see "`--style 2.5d`
delivers 3D" in `.claude/shot-tags.md`. `realistic, shiny skin` on hassaku is
soft semi-real anime; the same two tags on perfectdeliberate are plastic. Keep
the tags and you change the look. Keep the look and you must change the tags.

## 1. Read the block

```bash
pnpm migrate-prompt <image> --show
```

Take the **current model** from `Model:` and the whole prompt with it.

**If the image is not in the index, do not stop.** Renders made in the last few
minutes routinely are not — the watcher has not caught up. Find the file in
Forge's outputs and read its parameters directly:

```bash
python -c "from PIL import Image; print(Image.open(r'<path>').info.get('parameters',''))"
```

Forge's own output directory is whatever `outdir_txt2img_samples` says in
`/sdapi/v1/options`, which is **not** necessarily under the webui folder — ask
the API rather than guessing.

## 2. Ask which checkpoint

One `AskUserQuestion`, one question, single-select. Skip it entirely when a
checkpoint was given positionally — `/checkpoint 00128 wai` is an answer already
given.

**List what is actually installed**, from `/luma/v1/checkpoints`, and say what
each one is for rather than only its name. The bands below were measured on one
subject across six full 18-shot sets; treat them as a map, not a law.

| checkpoint | its band, left alone | measured |
|---|---|---|
| `hassakuXLIllustrious_v12Style` | **flat cel anime**. `--style 2.5d` lifts it to soft semi-real; even a hard 3D push stays anime-faced. | yes |
| `waiNSFWIllustrious_v110` | **clean semi-real**, and the best raw quality of the four — natural skin, detailed faces, props intact. 93% of its renders in this vault rate 4+. | yes |
| `perfectdeliberate_v10` | **glossy semi-real**. Will not go flat: `(anime coloring:1.8), (flat color:1.6)` against `(shiny skin:2)` still rendered gradient shading. | yes |
| `noobaiXLNAIXL_vPred10Version` | flat by default and **needs `realistic` in the positive**. Oversaturates at CFG 5; try 4. Its own quality vocabulary — see below. | yes |
| `Illustrious-XL-v1.1` | the base the others are finetuned from. Orange skin, muddy light. Not a production choice. | yes |
| `aniverseXL_v40` | its own CFG 5.5, 30 steps, DPM++ 2M Karras, and the `4n1v3rs3` trigger without which the trained style never engages. | from its card |

Say which band the *source* is in too, so the move is legible: hassaku → wai is
a small step up in realism, hassaku → perfectdeliberate is a large one.

## 3. Adjust the prompt for the target's band

`migrateGeneration` already handles the parts that are mechanical, and you do
not have to do them: the quality block per family, the negative baseline, the
sampler, CFG, steps and clip skip, and AniVerse's trigger. Pass the target as
the second positional argument and it happens.

What it does **not** know is the style axis. Three adjustments, by hand:

**Moving up a band — flatter checkpoint to glossier.** Strip the anti-gloss
terms the source needed, or they fight a model that was never flat.
`(shiny skin:1.3), realistic, photorealistic` in a hassaku negative is doing
useful work there and is pure friction on perfectdeliberate.

**Moving down a band — glossier to flatter.** Add the source's gloss to the
positive, or the target renders flatter than the picture you started from.
Going to hassaku, `realistic, shiny skin` is what keeps it where it was.

**Moving to NoobAI, whichever direction.** Never let `realistic` reach its
negative. NoobAI is flat by default and negating realism turns it into an
oversaturated poster with no shading — measured, and not subtle. Its quality
block is different words rather than a preference:

```
masterpiece, best quality, newest, absurdres, highres
worst quality, low quality, normal quality, old, early, lowres, bad anatomy, ...
```

`migrate-prompt` writes those for you when the target's family is `noob`. The
negative *you* carry over is the part to check.

## 4. Show the diff, then send

Print three short lines before sending — the model, what moved on the style
axis, and nothing else. This command changes little on purpose and the report
should make that obvious:

```
model     hassakuXLIllustrious_v12Style → perfectdeliberate_v10
band      flat → glossy semi-real: dropped `(shiny skin:1.3), realistic,
          photorealistic` from the negative, which was holding hassaku flat
tuning    unchanged — both Illustrious, same sampler, CFG and quality block
```

Then:

```bash
pnpm migrate-prompt <image> <target> --prompt "<the adjusted prompt>"
```

`--prompt` replaces the whole positive, so hand it the complete text. Newlines
are written `\n`. Add `--render "<scratchpad>/<image>-<model>.png"` to generate
in the background instead of opening a tab, and `--queue` to write it down for
`pnpm queue --drain` later.

**The seed is randomised and that is not a loss.** A seed is a coordinate in one
model's noise space and means nothing in another's — the same number on a
different checkpoint does not give you the same composition, so there is nothing
to preserve. What makes the two comparable is the prompt.

## What to say afterwards

- **Which band the move crossed**, and what you changed because of it. That is
  the whole command; everything else was mechanical.
- **Anything the family swap rewrote** — the notes `migrate-prompt` prints. A
  changed sampler or CFG is worth knowing.
- **When the target is NoobAI**, that its quality vocabulary is different, so
  the prompt is not merely retuned but partly retranslated.
- **When the target is `Illustrious-XL-v1.1`**, that it is the base model and
  the finetunes beat it on this vault's own ratings. Say it once; it is their
  choice.
