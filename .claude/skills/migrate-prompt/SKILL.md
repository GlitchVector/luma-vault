---
name: migrate-prompt
description: Lift a generated image's prompt and settings onto a newer installed checkpoint and open it in Forge. Use when the user says something like "migrate prompt for image 00166 to deliberate", "redo this one on illustrious", "regenerate <image> with <model>", or asks to bring an old SD1.5 generation onto a current model.
---

# Migrating a generation to a newer model

Run the script. It does the whole thing:

```bash
pnpm migrate-prompt <image-name> <target-model>
pnpm migrate-prompt 00166-3997412987 deliberate
```

Both arguments are substrings. `00166` finds the image, `deliberate` finds the
newest installed checkpoint whose filename contains it. Report the change notes
it prints — they say what was altered and why.

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

Each of these is a silent failure otherwise — Forge raises nothing and the
picture simply comes out different:

| Change | Why |
|---|---|
| LoRA tags removed | SD1.5 LoRAs have the wrong text-encoder dimensions; they are parsed, matched against nothing, dropped |
| SD1.5 embeddings removed | `EasyNegative` on SDXL is not an embedding, it is the words "easy negative" steering the image |
| Danbooru quality tags added | what booru-trained SDXL models were trained to expect |
| Size → nearest SDXL bucket | SDXL trained at ~1MP; an SD1.5 canvas gives distorted anatomy, not a smaller image |
| Hires factor recomputed | keeps the final resolution the original aimed at |
| CFG 5, 28 steps, clip skip 2 | what these models are tuned for |
| Seed → random | a seed is a coordinate in one model's noise space and means nothing in another's |

Sampler, upscaler, ADetailer and denoising are left alone — they are
architecture-agnostic, and changing them would alter the picture for no reason.

Staying on the same architecture changes only the model and the seed.

## Requirements

- Forge running with the `luma-vault-prefill` extension (`pnpm setup:forge`).
  The script needs `/luma/v1/checkpoints` and `/luma/v1/checkpoint`, which
  Forge's own API cannot substitute for — see the extension README.
- `LUMA_FORGE_URL` overrides the default `http://127.0.0.1:7860`.

## Known Forge behaviour worth mentioning to the user

- **Clip skip resets to 1 on every page load.** `on_preset_change` is wired to
  `root_block.load` and every preset sets it to 1. If the block asked for 2,
  check the slider in the top bar after the page settles.
- **"Apply settings" reverts the checkpoint** to whatever the Settings page was
  built with. Re-run the migration, or re-select the model, after using it.

## Editing the rules

The transformation lives in `packages/core/src/migrate.ts` with tests beside it.
Change it there, not in the script — the script is I/O only. `pnpm -r test`
covers it.
