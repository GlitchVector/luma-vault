---
description: Migrate a generated image's prompt onto a newer checkpoint and open it in Forge
argument-hint: <image> [model — defaults to deliberate]
---

# Migrating a generation to a newer model

Run the script, passing the arguments through untouched. It does the whole
thing:

```bash
pnpm migrate-prompt $ARGUMENTS
```

Both arguments are substrings — `00301` finds the image, `illustrious` finds the
newest installed checkpoint whose filename contains it. **The model is
optional**; the script defaults to `deliberate` on its own, so do not supply one
when the user did not.

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

Sampler, upscaler, ADetailer and denoising are left alone — they are
architecture-agnostic, and changing them would alter the picture for no reason.

Staying on the same architecture changes only the model and the seed.

## Close with these, but only when the migration crossed into SDXL

The notes will say whether it did. On a same-architecture move they are noise.

- **Clip skip resets to 1 on every page load.** `on_preset_change` is wired to
  `root_block.load` and every preset sets it to 1. If the block asked for 2,
  check the slider in the top bar after the page settles.
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
