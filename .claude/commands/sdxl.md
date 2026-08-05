---
description: Migrate a generated image's prompt onto a newer checkpoint and open it in Forge
argument-hint: <image> [model — defaults to deliberate]
---

# Migrating a generation to a newer model

## 1. Ask about body shape and the shot — before running anything

The same questions `/recreate` asks, with the same ladders. **First call,
four questions**, single-select:

| Question | Options |
|---|---|
| Ass | as seen · `big ass` · `huge ass` · `gigantic ass` |
| Breasts | as seen · `large breasts` · `huge breasts` · `gigantic breasts` |
| Thighs | as seen · `thick thighs` · `(thick thighs:1.4)` · `(thick thighs:2)` |
| Hips | as seen · `wide hips` · `(wide hips:1.4)` · maximum |

Here "as seen" means: keep whatever the original prompt says about that axis
— pass nothing for it. Hips **maximum** is not a weight but this exact combo:

```
(wide hips:2), (thick thighs:2), (curvy:2), (narrow waist:2), (hyper hips:2), hip focus
```

When maximum is picked, drop whatever the thighs question answered — the
combo already argues the thighs at 2.

Then a **second call**, which always happens because it carries the shot:

| Question | Options |
|---|---|
| Shot | as-is · `cowboy shot` · `full body` · `wide shot` |
| Ass boost — only if a plain rung was picked | no boost · `:1.3` · `:1.5` · `:2` |
| Breast boost — only if a plain rung was picked | no boost · `:1.3` · `:1.5` · `:2` |

Boosts apply as `(huge ass:1.3)`; `:2` is the tested ceiling. "As-is" keeps
whatever framing the original prompt carries. The ladder has more rungs than
the four buttons — `close-up`, `portrait`, `upper body`, `lower body`,
`very wide shot` — and any of them typed under Other is equally valid; pass
it through as given.

## 2. Run the script

It does the whole thing; pass the arguments through untouched:

```bash
pnpm migrate-prompt $ARGUMENTS
```

Append `--shot "<tag>"` when the shot answer was not as-is, and collect the
body answers — rungs with their boosts applied, or the maximum combo — into
one `--body "..."` argument, omitted entirely when every axis said as seen:

```bash
pnpm migrate-prompt 00301 --shot "full body" --body "(gigantic ass:1.5), (wide hips:1.4)"
```

The rewrite puts both at the front of the prompt where they carry the most
weight, and clears what they replace: every framing rung the prompt already
carried (two rungs in one prompt fight, and the result is neither), and every
size rung of each body axis the override mentions. `full body` and wider go
in weighted — `(full body:1.3)`, because bare they lose to body tags pulling
the camera in — and the negative gains `close-up, cropped, portrait,
upper body` as the backstop against drifting tight. All reported in the
notes.

Both positional arguments are substrings — `00301` finds the image,
`illustrious` finds the newest installed checkpoint whose filename contains
it. **The model is optional**; the script defaults to `deliberate` on its
own, so do not supply one when the user did not.

Then report the change notes it prints. They are the point of the command: each
line says what was altered and why, and every one of them is a silent failure
otherwise — Forge raises nothing and the picture simply comes out different.

## What it does

1. Finds the image in the Luma Vault index (read-only; safe while the app runs).
2. Reads the parameter block **from the file**, not the index. The index keeps
   six display fields; a real block carries schedule type, clip skip, ControlNet
   and every ADetailer setting.
3. Picks the newest installed checkpoint matching the target, by file date.
4. Detects its architecture from the safetensors header — `sd`, `xl`, `flux`.
5. Rewrites the block via `migrateGeneration` in `@luma/core` (tested there).
6. Selects the checkpoint in Forge **before** opening the tab.
7. Opens the tab; the prefill extension fills every field.

## The rewrite, when crossing SD1.5 → SDXL

| Change | Why |
|---|---|
| LoRA tags removed | SD1.5 LoRAs have the wrong text-encoder dimensions; they are parsed, matched against nothing, dropped |
| SD1.5 embeddings removed | `EasyNegative` on SDXL is not an embedding, it is the words "easy negative" steering the image |
| Danbooru quality tags added | what booru-trained SDXL models were trained to expect |
| Size → nearest SDXL bucket | SDXL trained at ~1MP; an SD1.5 canvas gives distorted anatomy, not a smaller image |
| Hires factor recomputed | keeps the final resolution the original aimed at |
| CFG 5, 28 steps, clip skip 2 | what these models are tuned for |
| Seed → random | a seed is a coordinate in one model's noise space and means nothing in another's |

Sampler, upscaler and denoising the block already names are left alone — they
are architecture-agnostic, and changing them would alter the picture for no
reason. What the block *lacks* is topped up on every XL move: a Hires pass
(1.65x, 30 steps, 4xUltrasharp, denoise 0.4) and an ADetailer face pass whose
prompt is built from the face words already in the prompt — identity and
expression, never body or setting. A block that carries its own hires or
ADetailer settings keeps them untouched.

Staying on the same architecture changes only the model and the seed.

## Close with these, but only when the migration crossed into SDXL

The notes will say whether it did. On a same-architecture move they are noise.

- **Clip skip is enforced by the extension.** Forge's `on_preset_change` is
  wired to `root_block.load` and stamps clip skip back to 1, sometimes seconds
  after the paste — the extension now watches for ~12s and puts the block's
  value back, logging `clip skip re-asserted` when it had to. Only mention it
  if the user reports a wrong clip skip anyway (an outdated extension: run
  `pnpm setup:forge` and reload the tab).
- **"Apply settings" reverts the checkpoint** to whatever the Settings page was
  built with. Re-run this, or re-select the model, after using it.

## Requirements

- Forge running with the `luma-vault-prefill` extension (`pnpm setup:forge`).
  The script needs `/luma/v1/checkpoints` and `/luma/v1/checkpoint`, which
  Forge's own API cannot substitute for — see the extension README.
- `LUMA_FORGE_URL` overrides the default `http://127.0.0.1:7860`.

If the script fails because Forge is unreachable, say so plainly rather than
retrying.

## Editing the rules

The transformation lives in `packages/core/src/migrate.ts` with tests beside it.
Change it there, not in the script — the script is I/O only. `pnpm -r test`
covers it.
